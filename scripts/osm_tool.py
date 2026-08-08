#!/usr/bin/env python3
import io
import sys
import argparse
import logging
import os
import math
import json
import tempfile
import geopandas
import osmium
import shapely
import xml.etree.ElementTree as ET
import xml.sax.saxutils as saxutils

from typing import Set, List, Optional, Any, Tuple, Dict, Union
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union

# --- Logger Setup ---
logger = logging.getLogger("osm_tool")

# --- ID Flipping / Collision Handling ---

# Any ID above this is assumed to never collide with a real-world OSM ID.
# Used as a fallback offset when a straight abs()-flip would collide.
ID_OFFSET_FALLBACK = 10 ** 15


class CollisionChecker(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pos_ids = {'node': set(), 'way': set(), 'relation': set()}
        self.neg_ids = {'node': set(), 'way': set(), 'relation': set()}

    def _record(self, kind: str, obj_id: int) -> None:
        if obj_id >= 0:
            self.pos_ids[kind].add(obj_id)
        else:
            self.neg_ids[kind].add(abs(obj_id))

    def node(self, n): self._record('node', n.id)
    def way(self, w): self._record('way', w.id)
    def relation(self, r): self._record('relation', r.id)

    def find_collisions(self) -> Dict[str, Set[int]]:
        collisions = {}
        for kind in ('node', 'way', 'relation'):
            overlap = self.pos_ids[kind] & self.neg_ids[kind]
            if overlap: collisions[kind] = overlap
        return collisions


class _ExternalPositiveIdScanner(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pos_ids = {'node': set(), 'way': set(), 'relation': set()}

    def node(self, n):
        if n.id >= 0: self.pos_ids['node'].add(n.id)
    def way(self, w):
        if w.id >= 0: self.pos_ids['way'].add(w.id)
    def relation(self, r):
        if r.id >= 0: self.pos_ids['relation'].add(r.id)


class IDChanger(osmium.SimpleHandler):
    def __init__(self, writer, offset: int = 0):
        super().__init__()
        self.writer = writer
        self.offset = offset

    def _flip(self, obj_id: int) -> int:
        return obj_id if obj_id > 0 else (self.offset + abs(obj_id))

    def node(self, n):
        new_id = self._flip(n.id)
        self.writer.add_node(n.replace(id=new_id))

    def way(self, w):
        new_id = self._flip(w.id)
        new_node_refs = [self._flip(nr.ref) for nr in w.nodes]
        self.writer.add_way(w.replace(id=new_id, nodes=new_node_refs))

    def relation(self, r):
        new_id = self._flip(r.id)
        new_members = [(m.type, self._flip(m.ref), m.role) for m in r.members]
        self.writer.add_relation(r.replace(id=new_id, members=new_members))


def normalize_ids_to_positive(
    input_path: str, output_path: str, on_collision: str = "offset",
    reference_paths: Optional[List[str]] = None,
) -> None:
    checker = CollisionChecker()
    osmium.apply(input_path, checker)
    collisions = checker.find_collisions()

    external_collisions: Dict[str, Set[int]] = {}
    for ref_path in (reference_paths or []):
        ref_scanner = _ExternalPositiveIdScanner()
        osmium.apply(ref_path, ref_scanner)
        for kind in ('node', 'way', 'relation'):
            overlap = checker.neg_ids[kind] & ref_scanner.pos_ids[kind]
            if overlap:
                external_collisions.setdefault(kind, set())
                external_collisions[kind] |= overlap

    offset = 0
    if collisions:
        for kind, ids in collisions.items():
            sample = sorted(ids)[:20]
            logger.warning(
                f"ID collision risk for {kind}s: abs()-flipping negative IDs "
                f"would collide with {len(ids)} existing positive ID(s) "
                f"within {input_path!r}: {sample}{' ...' if len(ids) > 20 else ''}"
            )
    if external_collisions:
        for kind, ids in external_collisions.items():
            sample = sorted(ids)[:20]
            logger.warning(
                f"ID collision risk for {kind}s: abs()-flipping negative IDs "
                f"in {input_path!r} would collide with {len(ids)} existing "
                f"positive ID(s) in reference file(s) {reference_paths}: "
                f"{sample}{' ...' if len(ids) > 20 else ''}"
            )

    if collisions or external_collisions:
        if on_collision == "abort":
            raise RuntimeError("Aborting: flipping negative IDs would collide with existing positive IDs.")
        elif on_collision == "offset":
            offset = ID_OFFSET_FALLBACK
            logger.warning(f"Falling back to offset-based renumbering (offset={offset}).")
        else:
            raise ValueError(f"Unknown on_collision mode: {on_collision!r}")

    with osmium.SimpleWriter(output_path, overwrite=True) as writer:
        handler = IDChanger(writer, offset=offset)
        osmium.apply(input_path, handler)

# --- Bounding Box ---
class BoundingBoxHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.min_lon, self.min_lat = 180.0, 90.0
        self.max_lon, self.max_lat = -180.0, -90.0

    def node(self, n: osmium.osm.Node) -> None:
        if n.location.valid():
            self.min_lon = min(self.min_lon, n.location.lon)
            self.min_lat = min(self.min_lat, n.location.lat)
            self.max_lon = max(self.max_lon, n.location.lon)
            self.max_lat = max(self.max_lat, n.location.lat)

# --- Tag Parsing ---
def parse_tag_arguments(tag_str: Optional[str]) -> Dict[str, str]:
    tags: Dict[str, str] = {}
    if not tag_str: return tags
    for raw_entry in tag_str.split(','):
        entry = raw_entry.strip()
        if not entry: continue
        if '=' not in entry:
            msg = f"Invalid --tag entry {entry!r}; expected format key=value."
            logger.error(msg)
            raise RuntimeError(msg)
        key, value = entry.split('=', 1)
        key = key.strip()
        value = value.strip()
        if not key:
            msg = f"Invalid --tag entry {entry!r}; tag key must not be empty."
            logger.error(msg)
            raise RuntimeError(msg)
        tags[key] = value
    return tags

def extract_actions_from_xml(filepath: str) -> Dict[str, Dict[int, str]]:
    """
    Fast pre-pass to extract 'action' attributes from JOSM XML or OsmChange files.
    libosmium ignores the 'action' attribute during parsing, so we must extract it
    separately to preserve JOSM semantics.
    """
    actions = {'node': {}, 'way': {}, 'relation': {}}
    if not os.path.exists(filepath):
        return actions

    # Quick check if it's XML
    try:
        with open(filepath, 'rb') as f:
            header = f.read(500)
            if b'<osmChange' in header or b'<osm' in header or b'<?xml' in header:
                pass
            else:
                return actions # Likely PBF or other binary
    except Exception:
        return actions

    current_action = None
    try:
        for event, elem in ET.iterparse(filepath, events=('start', 'end')):
            if event == 'start':
                if elem.tag in ('modify', 'create', 'delete'):
                    current_action = elem.tag
                elif elem.tag in ('node', 'way', 'relation'):
                    action = elem.get('action')
                    if not action and current_action:
                        action = current_action
                    if action:
                        try:
                            actions[elem.tag][int(elem.get('id'))] = action
                        except ValueError:
                            pass
            elif event == 'end':
                if elem.tag in ('modify', 'create', 'delete'):
                    current_action = None
                elif elem.tag in ('node', 'way', 'relation'):
                    elem.clear()
    except ET.ParseError:
        logger.debug(f"Could not parse {filepath} as XML for action extraction.")
    except Exception as e:
        logger.debug(f"Error extracting actions from {filepath}: {e}")

    return actions


class CustomXMLWriter:
    """
    Custom XML serializer that supports the JOSM-specific 'action' attribute.
    libosmium's SimpleWriter cannot write 'action' attributes on elements,
    so we use this when outputting to .osm/.xml formats.
    """
    def __init__(self, filepath: str):
        if filepath == '-':
            self.f = sys.stdout
        else:
            self.f = open(filepath, 'w', encoding='utf-8')
        self.f.write("<?xml version='1.0' encoding='UTF-8'?>\n")
        self.f.write("<osm version='0.6' generator='osm_tool'>\n")

    def escape(self, text: str) -> str:
        return saxutils.escape(str(text))

    def write_obj(self, obj: osmium.osm.OSMObject, obj_type: str, action: Optional[str], extra_tags: Optional[Dict[str, str]] = None):
        # Start with the required ID
        attrs = [f"id='{obj.id}'"]

        # 1. Action (The whole reason we are using this custom writer)
        if action:
            attrs.append(f"action='{action}'")

        # 2. Visible: Standard OSM/JOSM XML omits visible="true".
        # We only write it if the object is explicitly deleted/invisible.
        if not getattr(obj, 'visible', True):
            attrs.append("visible='false'")

        # 3. Version: Omit if 0 or None. JOSM typically omits version for
        # newly created local objects (negative IDs).
        if getattr(obj, 'version', 0) and obj.version > 0:
            attrs.append(f"version='{obj.version}'")

        # 4. Changeset: Omit if 0 or None
        if getattr(obj, 'changeset', 0) and obj.changeset > 0:
            attrs.append(f"changeset='{obj.changeset}'")

        # 5. Timestamp
        if obj.timestamp:
            try:
                # pyosmium returns a datetime object
                ts_str = obj.timestamp.strftime('%Y-%m-%dT%H:%M:%SZ')
            except Exception:
                ts_str = str(obj.timestamp)
            attrs.append(f"timestamp='{ts_str}'")

        # 6. User info: Omit uid if 0/None, omit user if empty
        if getattr(obj, 'uid', 0) and obj.uid > 0:
            attrs.append(f"uid='{obj.uid}'")
        if obj.user:
            attrs.append(f"user='{self.escape(obj.user)}'")

        # 7. Geometry (Nodes only)
        if obj_type == 'node' and obj.location.valid():
            attrs.append(f"lat='{obj.location.lat}'")
            attrs.append(f"lon='{obj.location.lon}'")

        attr_str = " ".join(attrs)

        # Merge tags
        tags = dict(obj.tags)
        if extra_tags:
            tags.update(extra_tags)

        # Determine if we need to open/close tags or just self-close
        has_children = False
        if obj_type == 'node':
            has_children = bool(tags)
        elif obj_type == 'way':
            has_children = bool(obj.nodes) or bool(tags)
        elif obj_type == 'relation':
            has_children = bool(obj.members) or bool(tags)

        if has_children:
            self.f.write(f"  <{obj_type} {attr_str}>\n")
            if obj_type == 'way':
                for nd in obj.nodes:
                    self.f.write(f"    <nd ref='{nd.ref}'/>\n")
            elif obj_type == 'relation':
                for mem in obj.members:
                    self.f.write(f"    <member type='{mem.type}' ref='{mem.ref}' role='{self.escape(mem.role)}'/>\n")

            for k, v in tags.items():
                self.f.write(f"    <tag k='{self.escape(k)}' v='{self.escape(v)}'/>\n")

            self.f.write(f"  </{obj_type}>\n")
        else:
            self.f.write(f"  <{obj_type} {attr_str}/>\n")

    def close(self):
        self.f.write("</osm>\n")
        if self.f is not sys.stdout:
            self.f.close()


# --- Filtering / Dependency Resolution ---

class DependencyCollector(osmium.SimpleHandler):
    def __init__(self, tag_key: Optional[str], tag_value: Optional[str], include_actions: Optional[str], full: bool = False):
        super().__init__()
        self.tag_key = tag_key
        self.tag_value = tag_value
        self.include_actions = include_actions.split(',') if include_actions else []
        self.full = full

        self.node_ids: Set[int] = set()
        self.way_ids: Set[int] = set()
        self.relation_ids: Set[int] = set()

        self.matched_node_ids: Set[int] = set()
        self.matched_way_ids: Set[int] = set()
        self.matched_relation_ids: Set[int] = set()

        # Track objects that explicitly match the --tag-key and --tag-value arguments
        self.tag_matched_node_ids: Set[int] = set()
        self.tag_matched_way_ids: Set[int] = set()
        self.tag_matched_relation_ids: Set[int] = set()

        self.matched_relation_members: Dict[int, List[Tuple[str, int, str]]] = {}
        self.matched_relation_names: Dict[int, Optional[str]] = {}

    def is_match(self, elem: osmium.osm.OSMObject) -> bool:
        if self.full:
            if elem.id < 0:
                return True
            # Check natively exposed deleted/visible properties
            if getattr(elem, 'deleted', False) or not getattr(elem, 'visible', True):
                return True
            if getattr(elem, 'action', None) in ('modify', 'delete'):
                return True
            if elem.tags.get('action') in ('modify', 'delete'):
                return True

        if self.tag_key and elem.tags.get(self.tag_key) == self.tag_value:
            return True
        if self.include_actions and elem.tags.get('action') in self.include_actions:
            return True
        action = getattr(elem, 'action', None)
        if self.include_actions and action and action in self.include_actions:
            return True
        return False

    def is_tag_match(self, elem: osmium.osm.OSMObject) -> bool:
        # Check ONLY for explicit tag match to scope --tag argument updates
        if self.tag_key and elem.tags.get(self.tag_key) == self.tag_value:
            return True
        return False

    def node(self, n: osmium.osm.Node) -> None:
        if self.is_match(n):
            logger.debug(f"Matching node found: {n.id}")
            self.node_ids.add(n.id)
            self.matched_node_ids.add(n.id)
            if self.is_tag_match(n):
                self.tag_matched_node_ids.add(n.id)

    def way(self, w: osmium.osm.Way) -> None:
        if self.is_match(w):
            logger.debug(f"Matching way found: {w.id}")
            self.way_ids.add(w.id)
            self.matched_way_ids.add(w.id)
            if self.is_tag_match(w):
                self.tag_matched_way_ids.add(w.id)
            for node in w.nodes:
                self.node_ids.add(node.ref)

    def relation(self, r: osmium.osm.Relation) -> None:
        if self.is_match(r):
            logger.debug(f"Matching relation found: {r.id}")
            self.relation_ids.add(r.id)
            self.matched_relation_ids.add(r.id)
            if self.is_tag_match(r):
                self.tag_matched_relation_ids.add(r.id)
            self.matched_relation_members[r.id] = [
                (member.type, member.ref, member.role) for member in r.members
            ]
            self.matched_relation_names[r.id] = r.tags.get('name')
            for member in r.members:
                if member.type == 'n':
                    self.node_ids.add(member.ref)
                elif member.type == 'w':
                    self.way_ids.add(member.ref)
                elif member.type == 'r':
                    self.relation_ids.add(member.ref)

class RelationExpander(osmium.SimpleHandler):
    def __init__(self, target_relation_ids: Set[int]):
        super().__init__()
        self.targets = target_relation_ids
        self.relation_ids: Set[int] = set()
        self.way_ids: Set[int] = set()
        self.node_ids: Set[int] = set()

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.targets:
            for member in r.members:
                if member.type == 'n': self.node_ids.add(member.ref)
                elif member.type == 'w': self.way_ids.add(member.ref)
                elif member.type == 'r': self.relation_ids.add(member.ref)


class WayNodeResolver(osmium.SimpleHandler):
    def __init__(self, target_way_ids: Set[int]):
        super().__init__()
        self.way_ids = target_way_ids
        self.node_ids: Set[int] = set()

    def way(self, w: osmium.osm.Way) -> None:
        if w.id in self.way_ids:
            for node in w.nodes:
                self.node_ids.add(node.ref)


class DataWriter(osmium.SimpleHandler):
    def __init__(self, writer: Any, deps: DependencyCollector, extra_tags: Optional[Dict[str, str]] = None, actions_map: Optional[Dict] = None, use_custom_xml: bool = False):
        super().__init__()
        self.writer = writer
        self.deps = deps
        self.extra_tags = extra_tags or {}
        self.actions_map = actions_map or {'node': {}, 'way': {}, 'relation': {}}
        self.use_custom_xml = use_custom_xml

    def _get_action(self, obj: osmium.osm.OSMObject, obj_type: str) -> Optional[str]:
        # 1. Check extracted XML action
        action = self.actions_map.get(obj_type, {}).get(obj.id)
        if action:
            return action

        # 2. Fallback to object properties
        if getattr(obj, 'deleted', False) or not getattr(obj, 'visible', True):
            return 'delete'

        # 3. If full mode, assign default actions
        if self.deps.full:
            if obj.id < 0:
                return 'create'
            return 'modify'

        return None

    def write_obj(self, obj: osmium.osm.OSMObject, obj_type: str, tag_matched_ids: Set[int], matched_ids: Set[int]):
        is_tag_matched = obj.id in tag_matched_ids
        is_matched = obj.id in matched_ids

        merged_tags = dict(obj.tags)
        tags_updated = False

        # FIX: Only apply args given via --tag to objects strictly matching --tag-key and --tag-value
        if self.extra_tags and is_tag_matched:
            for k, v in self.extra_tags.items():
                if merged_tags.get(k) != v:
                    merged_tags[k] = v
                    tags_updated = True

        action = self._get_action(obj, obj_type) if self.use_custom_xml else None

        if self.use_custom_xml:
            self.writer.write_obj(obj, obj_type, action, merged_tags if tags_updated else None)
        else:
            if tags_updated:
                new_obj = obj.replace(tags=merged_tags)
                if obj_type == 'node': self.writer.add_node(new_obj)
                elif obj_type == 'way': self.writer.add_way(new_obj)
                elif obj_type == 'relation': self.writer.add_relation(new_obj)
            else:
                if obj_type == 'node': self.writer.add_node(obj)
                elif obj_type == 'way': self.writer.add_way(obj)
                elif obj_type == 'relation': self.writer.add_relation(obj)

    def node(self, n: osmium.osm.Node) -> None:
        if n.id in self.deps.node_ids:
            self.write_obj(n, 'node', self.deps.tag_matched_node_ids, self.deps.matched_node_ids)

    def way(self, w: osmium.osm.Way) -> None:
        if w.id in self.deps.way_ids:
            self.write_obj(w, 'way', self.deps.tag_matched_way_ids, self.deps.matched_way_ids)

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.deps.relation_ids:
            self.write_obj(r, 'relation', self.deps.tag_matched_relation_ids, self.deps.matched_relation_ids)

class _CopyAllHandler(osmium.SimpleHandler):
    def __init__(self, writer: osmium.io.Writer):
        super().__init__()
        self.writer = writer

    def node(self, n: osmium.osm.Node) -> None: self.writer.add_node(n)
    def way(self, w: osmium.osm.Way) -> None: self.writer.add_way(w)
    def relation(self, r: osmium.osm.Relation) -> None: self.writer.add_relation(r)

class _WayIdCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.way_ids: Set[int] = set()
    def way(self, w: osmium.osm.Way) -> None: self.way_ids.add(w.id)

class _RelationIdCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.relation_ids: Set[int] = set()
    def relation(self, r: osmium.osm.Relation) -> None: self.relation_ids.add(r.id)

class _RelationMemberExclusionResolver(osmium.SimpleHandler):
    def __init__(self, excluded_way_ids: Set[int], excluded_relation_ids: Set[int]):
        super().__init__()
        self.excluded_way_ids = excluded_way_ids
        self.excluded_relation_ids = excluded_relation_ids
        self.newly_excluded_relation_ids: Set[int] = set()

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.excluded_relation_ids: return
        for member in r.members:
            if member.type == 'w' and member.ref in self.excluded_way_ids:
                self.newly_excluded_relation_ids.add(r.id)
                return
            if member.type == 'r' and member.ref in self.excluded_relation_ids:
                self.newly_excluded_relation_ids.add(r.id)
                return

# --- Tile Math Functions ---

def deg_to_tile_num(lat_deg: float, lon_deg: float, zoom: int) -> Tuple[int, int]:
    lat_deg = max(-85.05112877980659, min(85.05112877980659, lat_deg))
    lon_deg = max(-180.0, min(180.0, lon_deg))

    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom

    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)

    max_tile = int(n) - 1
    xtile = max(0, min(max_tile, xtile))
    ytile = max(0, min(max_tile, ytile))

    return (xtile, ytile)

# --- Commands ---

def _log_relations_with_unexpanded_members(dep_collector: DependencyCollector) -> None:
    broken_count = 0
    for rel_id in sorted(dep_collector.matched_relation_ids):
        members = dep_collector.matched_relation_members.get(rel_id, [])
        way_member_ids = [ref for (mtype, ref, role) in members if mtype == 'w']
        relation_member_ids = [ref for (mtype, ref, role) in members if mtype == 'r']

        if not way_member_ids and not relation_member_ids:
            continue

        broken_count += 1
        name = dep_collector.matched_relation_names.get(rel_id)
        logger.warning(
            f"Relation {rel_id}" + (f" (name={name!r})" if name else "") +
            f" will likely be incomplete in the output: --no-expand-relations "
            f"does not resolve {len(way_member_ids)} way member(s)' node lists "
            f"or {len(relation_member_ids)} nested relation member(s)."
        )

    if broken_count:
        logger.warning(
            f"{broken_count} matched relation(s) may be incomplete in the "
            f"output due to --no-expand-relations."
        )


def filter_cmd(args: argparse.Namespace) -> None:
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    if not (args.tag_key and args.tag_value) and not args.include_actions and not args.full:
        msg = "You must specify either a tag/value combination, actions to include, or --full."
        logger.error(msg)
        raise RuntimeError(msg)

    extra_tags = parse_tag_arguments(args.tag)

    raw_input_files = args.patch
    input_files = []
    for p in raw_input_files:
        if isinstance(p, list): input_files.extend(p)
        else: input_files.append(p)

    output_file = args.output

    for input_file in input_files:
        if not os.path.exists(input_file):
            msg = f"Input file not found: {input_file}"
            logger.error(msg)
            raise RuntimeError(msg)

    if os.path.exists(output_file):
        if not args.force:
            logger.warning(f"Output file '{output_file}' already exists. Use -f or --force to overwrite.")
            return
        os.remove(output_file)

    # Extract actions from XML inputs to preserve JOSM semantics
    actions_map = {'node': {}, 'way': {}, 'relation': {}}
    for input_file in input_files:
        if input_file == '-': continue
        file_actions = extract_actions_from_xml(input_file)
        for t in ('node', 'way', 'relation'):
            actions_map[t].update(file_actions[t])

    logger.info("--- Pass 1: Collecting matching objects and their direct dependencies ---")
    dep_collector = DependencyCollector(args.tag_key, args.tag_value, args.include_actions, args.full)
    for input_file in input_files:
        dep_collector.apply_file(input_file, locations=True, idx='flex_mem')

    if args.no_expand_relations:
        logger.info(
            "--- Skipping Pass 2/3 (nested relation expansion, way node resolution): "
            "--no-expand-relations set, restoring legacy behavior. Ways/relations "
            "pulled in only via relation membership may be written without their "
            "own dependencies (nodes/members) present in the output. ---"
        )
        _log_relations_with_unexpanded_members(dep_collector)
    else:
        logger.info("--- Pass 2: Expanding nested relation dependencies (fixed-point) ---")
        while True:
            expander = RelationExpander(dep_collector.relation_ids)
            for input_file in input_files:
                expander.apply_file(input_file, locations=False)

            new_relation_ids = dep_collector.relation_ids | expander.relation_ids
            new_way_ids = dep_collector.way_ids | expander.way_ids
            new_node_ids = dep_collector.node_ids | expander.node_ids

            if (new_relation_ids == dep_collector.relation_ids and
                    new_way_ids == dep_collector.way_ids):
                dep_collector.node_ids = new_node_ids
                break

            dep_collector.relation_ids = new_relation_ids
            dep_collector.way_ids = new_way_ids
            dep_collector.node_ids = new_node_ids

        logger.info("--- Pass 3: Resolving node dependencies of all required ways ---")
        way_node_resolver = WayNodeResolver(dep_collector.way_ids)
        for input_file in input_files:
            way_node_resolver.apply_file(input_file, locations=False)
        dep_collector.node_ids |= way_node_resolver.node_ids

    logger.info(
        f"Found {len(dep_collector.node_ids)} nodes, {len(dep_collector.way_ids)} ways, "
        f"and {len(dep_collector.relation_ids)} relations to include."
    )

    if not any([dep_collector.node_ids, dep_collector.way_ids, dep_collector.relation_ids]):
        logger.warning("No matching objects found. Skipping file write.")
        return

    # Determine if we need to use custom XML writer
    is_xml_output = output_file != '-' and output_file.lower().endswith(('.osm', '.xml'))
    use_custom_xml = is_xml_output

    if not is_xml_output and args.full:
        logger.warning("Output file is not .osm or .xml. The 'action' attribute cannot be preserved in PBF or other binary formats.")

    if extra_tags:
        logger.info(f"--- Pass 4: Writing selected objects to {output_file} (adding tags {extra_tags} to matched objects) ---")
    else:
        logger.info(f"--- Pass 4: Writing selected objects to {output_file} ---")

    if use_custom_xml:
        logger.info("Using Custom XML Writer to preserve 'action' attributes.")
        writer = CustomXMLWriter(output_file)
    else:
        writer = osmium.SimpleWriter(output_file, overwrite=True)

    data_writer = DataWriter(writer, dep_collector, extra_tags=extra_tags, actions_map=actions_map, use_custom_xml=use_custom_xml)
    for input_file in input_files:
        data_writer.apply_file(input_file, locations=True, idx='flex_mem')

    writer.close()
    logger.info("--- Filtering complete. ---")

def tile_info_cmd(args: argparse.Namespace) -> None:
    """
    Core logic for the 'tile-info' subcommand. Calculates the bounding box
    of nodes in an OSM file and finds all intersecting slippy map tiles up
    to a given zoom level.
    """
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    input_file = args.input
    output_file = args.output
    max_zoom = args.max_zoom

    if not os.path.exists(input_file):
        msg = f"Input file not found: {input_file}"
        logger.error(msg)
        raise RuntimeError(msg)

    logger.info(f"--- Step 1: Calculating bounding box from {input_file} ---")
    bbox_handler = BoundingBoxHandler()
    bbox_handler.apply_file(input_file, locations=True)

    min_lon, min_lat = bbox_handler.min_lon, bbox_handler.min_lat
    max_lon, max_lat = bbox_handler.max_lon, bbox_handler.max_lat

    # ROBUST EMPTY CHECK: Latitudes do not wrap around the globe.
    # If min_lat > max_lat, the handler was never updated (e.g., empty file).
    if min_lat > max_lat:
        msg = "No nodes found in input file. Cannot calculate bounding box."
        logger.error(msg)
        raise RuntimeError(msg)

    logger.info(f"Bounding box found: [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")

    # Detect antimeridian crossing (180°/-180° line)
    crosses_antimeridian = (max_lon - min_lon) > 180 or min_lon > max_lon

    if crosses_antimeridian:
        logger.warning("Bounding box crosses the antimeridian. Splitting geometry and tile ranges.")
        if min_lon > max_lon:
            lon_pos_min, lon_neg_max = min_lon, max_lon
        else:
            lon_pos_min, lon_neg_max = max_lon, min_lon

    logger.info(f"--- Step 2: Calculating tiles up to zoom level {max_zoom} ---")
    tiles = []

    for zoom in range(max_zoom + 1):
        _, top_left_y = deg_to_tile_num(max_lat, 0, zoom)
        _, bottom_right_y = deg_to_tile_num(min_lat, 0, zoom)

        if crosses_antimeridian:
            x1_start, _ = deg_to_tile_num(0, lon_pos_min, zoom)
            x1_end, _ = deg_to_tile_num(0, 180.0, zoom)

            x2_start, _ = deg_to_tile_num(0, -180.0, zoom)
            x2_end, _ = deg_to_tile_num(0, lon_neg_max, zoom)

            x_ranges = [
                range(x1_start, x1_end + 1),
                range(x2_start, x2_end + 1)
            ]
        else:
            top_left_x, _ = deg_to_tile_num(0, min_lon, zoom)
            bottom_right_x, _ = deg_to_tile_num(0, max_lon, zoom)
            x_ranges = [range(top_left_x, bottom_right_x + 1)]

        for y in range(top_left_y, bottom_right_y + 1):
            for x_range in x_ranges:
                for x in x_range:
                    tiles.append([zoom, x, y])

    logger.info(f"Found {len(tiles)} tiles.")

    logger.info(f"--- Step 3: Writing GeoJSON to {output_file} ---")

    if crosses_antimeridian:
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[
                    [lon_pos_min, min_lat], [180.0, min_lat],
                    [180.0, max_lat], [lon_pos_min, max_lat],
                    [lon_pos_min, min_lat]
                ]],
                [[
                    [-180.0, min_lat], [lon_neg_max, min_lat],
                    [lon_neg_max, max_lat], [-180.0, max_lat],
                    [-180.0, min_lat]
                ]]
            ]
        }
    else:
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [min_lon, min_lat], [max_lon, min_lat],
                [max_lon, max_lat], [min_lon, max_lat],
                [min_lon, min_lat]
            ]]
        }

    geojson = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "tiles": tiles
            }
        }]
    }

    if output_file == '-':
        json.dump(geojson, sys.stdout, indent=2)
    else:
        with open(output_file, 'w') as f:
            json.dump(geojson, f, indent=2)

    logger.info("--- GeoJSON file created successfully. ---")

def geojson_to_poly(geojson_input: Union[dict, str]) -> Optional[str]:
    """
    Converts GeoJSON data (either a dictionary or a JSON string) into the
    Osmosis .poly file format string, handling multiple disjoint polygons
    and interior rings (holes) correctly.
    """
    if isinstance(geojson_input, str):
        try:
            geojson_input = json.loads(geojson_input)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON string provided: {e}")
            return None

    if not isinstance(geojson_input, dict):
        logger.error("Invalid input type. Must be a dictionary or a JSON string.")
        return None

    geojson_string = json.dumps(geojson_input)

    try:
        gdf = geopandas.read_file(io.StringIO(geojson_string), use_arrow=True)
    except Exception as e:
        logger.error(f"Error reading GeoJSON data: {e}")
        return None

    if gdf.empty:
        logger.error("GeoJSON data was empty or contained no valid geometries.")
        return None

    exclusion_area_geom = gdf.dissolve(by=None).iloc[0].geometry

    poly_lines = ["ExclusionZone"]

    def write_polygon(poly_geom: Polygon, poly_id: Union[int, str], lines_list: List[str]) -> None:
        lines_list.append(f"{poly_id}")
        for coord in poly_geom.exterior.coords:
            lines_list.append(f"  {coord[0]} {coord[1]}")
        lines_list.append("END")
        for j, interior in enumerate(poly_geom.interiors):
            lines_list.append(f"!{poly_id}_hole_{j}")
            for coord in interior.coords:
                lines_list.append(f"  {coord[0]} {coord[1]}")
            lines_list.append("END")

    if exclusion_area_geom.geom_type == 'MultiPolygon':
        for i, poly in enumerate(exclusion_area_geom.geoms):
            write_polygon(poly, i + 1, poly_lines)
    elif exclusion_area_geom.geom_type == 'Polygon':
        write_polygon(exclusion_area_geom, 1, poly_lines)
    else:
        logger.error(f"Unsupported geometry type found: {exclusion_area_geom.geom_type}")
        return None

    poly_lines.append("END")
    return "\n".join(poly_lines)


def osm_file_to_geojson(input_file_path: str) -> dict:
    """
    Converts an OSM file into a GeoJSON FeatureCollection: tagged nodes
    become points, open ways become linestrings, closed ways/areas become
    polygons/multipolygons.
    """
    geojson_factory = osmium.geom.GeoJSONFactory()

    def create_feature(osm_object: Union[osmium.osm.Node, osmium.osm.Way, osmium.osm.Area], geometry_type: str):
        try:
            logger.debug(osm_object)
            if geometry_type == 'point':
                geometry_str = geojson_factory.create_point(osm_object.location)
            elif geometry_type == 'linestring':
                geometry_str = geojson_factory.create_linestring(osm_object.nodes)
            elif geometry_type == 'polygon':
                gjson = json.loads(geojson_factory.create_linestring(osm_object.nodes))
                if gjson["coordinates"][0] == gjson["coordinates"][-1]:
                    gjson["type"] = "Polygon"
                    gjson["coordinates"] = [gjson["coordinates"]]
                envelope = {"type": "Feature", "geometry": gjson, "properties": {}}
                geometry_str = json.dumps(envelope)
            elif geometry_type == 'multipolygon':
                geometry_str = geojson_factory.create_multipolygon(osm_object)
            else:
                return None

            geometry = json.loads(geometry_str)
            properties = dict(osm_object.tags)
            properties['_id'] = osm_object.id

            return {
                'type': 'Feature',
                'id': osm_object.id,
                'geometry': geometry,
                'properties': properties
            }

        except RuntimeError as e:
            logger.error(f"Failed to create GeoJSON feature: {e}")
            raise

    logger.debug("Starting new JSON file generator")
    features = []

    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf") as temp:
        normalize_ids_to_positive(input_file_path, temp.name, on_collision="offset")

        for o in osmium.FileProcessor(temp.name).with_areas().with_locations():
            logger.debug(f"Processing {o.type_str()}, id: {o.id}")
            feature = None
            if o.is_node():
                if len(o.tags) > 0:
                    feature = create_feature(o, 'point')
            elif o.is_way():
                if o.is_area():
                    feature = create_feature(o, 'multipolygon')
                elif o.is_closed():
                    feature = create_feature(o, 'polygon')
                else:
                    feature = create_feature(o, 'linestring')
            elif o.is_area():
                feature = create_feature(o, 'multipolygon')

            if feature is not None:
                features.append(feature)

        return {
            'type': 'FeatureCollection',
            'features': features
        }


def patch_cmd(args: argparse.Namespace) -> None:
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    base_file = args.input

    raw_patch_files = args.patch
    patch_files = []
    for p in raw_patch_files:
        if isinstance(p, list):
            patch_files.extend(p)
        else:
            patch_files.append(p)

    output_file = args.output
    overwrite = args.force
    masked_base_output = args.dump_masked_base
    clean = getattr(args, 'clean', False)
    patch(base_file, patch_files, output_file, overwrite, masked_base_output=masked_base_output, clean=clean)


def patch(base_file, patch_files, output_file, overwrite, masked_base_output: Optional[str] = None, clean: bool = False) -> None:
    """
    Reads a base OSM file and one or more patch OSM files, removes closed
    ways and standalone tagged nodes (point features like trees) in the
    base file that intersect with polygons/areas from the patches, and writes
    a merged result combining all (with patch IDs normalized to avoid
    collisions).

    Besides excluding ways that geometrically intersect the patch, this
    also excludes any relation that (directly or transitively, through
    nested relations) references one of those excluded ways.
    Standalone nodes (e.g. tagged POIs like trees) inside the patch mask
    are also excluded, UNLESS they are vertices of kept ways or members
    of kept relations (to prevent breaking geometries).

    Modifications and deletions from the patch file are also applied:
    - Modified objects in the patch overwrite the corresponding base objects.
    - Deleted objects are removed from the base file and not written to the output.

    If `clean` is True, deleted and modified objects from the patch files are
    discarded entirely before applying (meaning the base file's versions are
    kept, and only creations from the patch are merged). The original patch
    files are never modified.
    """

    class IntersectionHandler(osmium.SimpleHandler):
        """
        Identifies closed ways in the base file that intersect with the
        patch's polygons. Also identifies standalone tagged nodes (e.g. trees)
        that fall inside the patch's polygons as candidates for exclusion.
        """
        def __init__(self, target_polygons, mask_polygon):
            super().__init__()
            self.target_polygons = target_polygons
            self.mask_polygon = mask_polygon
            self.wkbfactory = osmium.geom.WKBFactory()
            self.intersecting_ways = []
            self.candidate_intersecting_nodes = []

        def node(self, n):
            if not n.location.valid():
                return
            # Only consider nodes that have tags (point features like trees)
            if len(n.tags) > 0:
                try:
                    pt = Point(n.location.lon, n.location.lat)
                    if self.mask_polygon.intersects(pt):
                        name = n.tags.get('name')
                        logger.debug(
                            f"Node {n.id} intersects patch polygon, candidate for exclusion"
                            + (f", name={name!r}" if name else "")
                        )
                        self.candidate_intersecting_nodes.append({
                            'id': n.id,
                            'tags': dict(n.tags)
                        })
                except Exception as e:
                    logger.error(f"Could not check geometry for Node {n.id}: {e}")

        def way(self, w):
            if w.is_closed():
                try:
                    wkb_line = self.wkbfactory.create_linestring(w)
                    shapely_line = shapely.from_wkb(wkb_line)

                    if len(shapely_line.coords) >= 4:
                        closed_way_polygon = Polygon(shapely_line)

                        for target_poly in self.target_polygons:
                            #if target_poly is not None and closed_way_polygon.intersects(target_poly):
                            # using intersects() will also be true is one ore more vertices are shared, but interiors don't
                            if target_poly is not None and closed_way_polygon.overlaps(target_poly):
                                name = w.tags.get('name')
                                logger.debug(
                                    f"Way {w.id} intersects patch polygon, will be excluded from base file"
                                    + (f", name={name!r}" if name else "")
                                )
                                self.intersecting_ways.append({
                                    'id': w.id,
                                    'tags': dict(w.tags),
                                    'geometry': closed_way_polygon
                                })
                                break

                except osmium.geom.GeometryError as e:
                    logger.error(f"Could not create geometry for Way {w.id}: {e}")

    class ExcludingIdFilter:
        """
        Filter for osmium.FileProcessor to exclude objects based on ID.
        """
        DESCRIPTIVE_TAGS = ['name', 'service', 'amenity', 'landuse', 'natural', 'building', 'building:part']

        def __init__(self, way_ids: Set[int], relation_ids: Optional[Set[int]] = None, node_ids: Optional[Set[int]] = None):
            self.way_ids = way_ids
            self.relation_ids = relation_ids or set()
            self.node_ids = node_ids or set()
            self.discarded_count = 0
            self.discarded_tagged_count = 0
            self.discarded_way_count = 0
            self.discarded_relation_count = 0
            self.discarded_node_count = 0

        def _log_discard(self, kind: str, obj) -> None:
            val = None
            key = None
            for tag in self.DESCRIPTIVE_TAGS:
                val = obj.tags.get(tag)
                if val:
                    key = tag
                    break

            self.discarded_count += 1
            if val:
                self.discarded_tagged_count += 1
            logger.debug(
                f"{kind.capitalize()} {obj.id} will be excluded from base file "
                f"(replaced by patch or masked)" + (f", {key!r}={val!r}" if val else "")
            )

        def node(self, n):
            matched = n.id in self.node_ids
            if matched:
                self.discarded_node_count += 1
                self._log_discard('node', n)
            return matched

        def way(self, w):
            matched = w.id in self.way_ids
            if matched:
                self.discarded_way_count += 1
                self._log_discard('way', w)
            return matched

        def relation(self, r):
            matched = r.id in self.relation_ids
            if matched:
                self.discarded_relation_count += 1
                self._log_discard('relation', r)
            return matched

        def area(self, a):
            return False

    logger.info("Generating mask and applying it to the input file.")

    normalized_patch_files = []
    temp_filtered_files = []
    filtered_patch_buffers = []

    patch_node_ids: Set[int] = set()
    patch_way_ids: Set[int] = set()
    patch_relation_ids: Set[int] = set()

    # Extract actions from XML files (JOSM/OsmChange files contain action attributes that libosmium ignores)
    patch_actions_map = {'node': {}, 'way': {}, 'relation': {}}
    for pf in patch_files:
        if pf == '-': continue
        file_actions = extract_actions_from_xml(pf)
        for t in ('node', 'way', 'relation'):
            patch_actions_map[t].update(file_actions[t])

    def _should_discard(obj, obj_type: str, clean_mode: bool) -> bool:
        # Deleted checks
        if getattr(obj, 'deleted', False): return True
        if not getattr(obj, 'visible', True): return True
        if getattr(obj, 'action', None) == 'delete': return True
        if obj.tags.get('action') == 'delete': return True
        if patch_actions_map.get(obj_type, {}).get(obj.id) == 'delete': return True

        # Modified checks (only if clean_mode is True)
        if clean_mode:
            if getattr(obj, 'action', None) == 'modify': return True
            if obj.tags.get('action') == 'modify': return True
            if patch_actions_map.get(obj_type, {}).get(obj.id) == 'modify': return True

        return False

    class PatchScanner(osmium.SimpleHandler):
        def node(self, n):
            if not _should_discard(n, 'node', clean): patch_node_ids.add(n.id)
        def way(self, w):
            if not _should_discard(w, 'way', clean): patch_way_ids.add(w.id)
        def relation(self, r):
            if not _should_discard(r, 'relation', clean): patch_relation_ids.add(r.id)

    try:
        for pf in patch_files:
            temp = tempfile.NamedTemporaryFile(mode='w+t', delete=False, suffix=".pbf")
            temp.close()
            normalize_ids_to_positive(
                pf, temp.name, on_collision="offset",
                reference_paths=[base_file] + normalized_patch_files
            )
            normalized_patch_files.append(temp.name)

            scanner = PatchScanner()
            scanner.apply_file(temp.name, locations=False)

        # Filter out deleted/modified objects from patch files before merging
        for norm_path in normalized_patch_files:
            temp_filt = tempfile.NamedTemporaryFile(mode='w+t', delete=False, suffix=".pbf")
            temp_filt.close()
            temp_filtered_files.append(temp_filt.name)

            class FilterWriter(osmium.SimpleHandler):
                def __init__(self, writer):
                    super().__init__()
                    self.writer = writer
                def node(self, n):
                    if not _should_discard(n, 'node', clean): self.writer.add_node(n)
                def way(self, w):
                    if not _should_discard(w, 'way', clean): self.writer.add_way(w)
                def relation(self, r):
                    if not _should_discard(r, 'relation', clean): self.writer.add_relation(r)

            with osmium.SimpleWriter(temp_filt.name, overwrite=True) as writer:
                fw = FilterWriter(writer)
                fw.apply_file(norm_path, locations=False)

            with open(temp_filt.name, 'rb') as f:
                filtered_patch_buffers.append(f.read())

        wkbfab = osmium.geom.WKBFactory()
        polygons = []
        for temp_name in temp_filtered_files:
            with open(temp_name, 'rb') as f:
                patch_buffer = f.read()
                patch_pbf = osmium.io.FileBuffer(patch_buffer, "pbf")
                try:
                    for o in osmium.FileProcessor(patch_pbf).with_areas():
                        logger.debug(f"Generating filter primitive for {o.type_str()}, id: {o.id}")
                        wkb = None
                        if o.is_way() and not o.is_closed():
                            wkb = shapely.from_wkb(wkbfab.create_linestring(o.nodes))
                        elif o.is_area():
                            wkb = shapely.from_wkb(wkbfab.create_multipolygon(o))
                        polygons.append(wkb)
                except RuntimeError as e:
                    if "two points" in str(e):
                        logger.error(f"Input file ({temp_name}) contains deleted nodes!", exc_info=True)
                    else:
                        logger.error(f"IDs in input file ({temp_name}) are not in order, this can currently happen if IDs will be dublicated by sign flipping and get prefixed", exc_info=True)
                    raise e

        polygons = [item for item in polygons if item is not None]
        logger.info(f"Extracted {len(polygons)} polygons to use as filter.")

        if polygons:
            mask_polygon = unary_union(polygons)
        else:
            mask_polygon = shapely.geometry.Polygon()

        handler = IntersectionHandler(polygons, mask_polygon)
        handler.apply_file(base_file, locations=True, idx='flex_mem')
        results_ways = handler.intersecting_ways
        candidate_node_dicts = handler.candidate_intersecting_nodes

        excluded_way_ids: Set[int] = set(i['id'] for i in results_ways)
        candidate_node_ids: Set[int] = set(i['id'] for i in candidate_node_dicts)

        # Add patch IDs to exclusions so that modifications overwrite base objects
        # and deletions remove base objects.
        excluded_way_ids |= patch_way_ids

        # Any relation that references an excluded way -- directly, or via a
        # chain of nested relations -- is excluded too.
        excluded_relation_ids: Set[int] = set()
        while True:
            resolver = _RelationMemberExclusionResolver(excluded_way_ids, excluded_relation_ids)
            resolver.apply_file(base_file, locations=False)
            if not resolver.newly_excluded_relation_ids:
                break
            excluded_relation_ids |= resolver.newly_excluded_relation_ids

        excluded_relation_ids |= patch_relation_ids

        if excluded_relation_ids:
            logger.info(
                f"Also excluding {len(excluded_relation_ids)} relation(s) that "
                f"(directly or transitively) reference an excluded way, or are explicitly in the patch."
            )
            logger.debug(f"Excluded relation IDs: {sorted(excluded_relation_ids)}")

        if candidate_node_ids:
            logger.info("Checking if candidate excluded nodes are dependencies of kept ways/relations...")

            class KeptObjectDependencyCollector(osmium.SimpleHandler):
                def __init__(self, excluded_way_ids: Set[int], excluded_relation_ids: Set[int]):
                    super().__init__()
                    self.excluded_way_ids = excluded_way_ids
                    self.excluded_relation_ids = excluded_relation_ids
                    self.kept_node_ids: Set[int] = set()

                def way(self, w):
                    if w.id not in self.excluded_way_ids:
                        for n in w.nodes:
                            self.kept_node_ids.add(n.ref)

                def relation(self, r):
                    if r.id not in self.excluded_relation_ids:
                        for m in r.members:
                            if m.type == 'n':
                                self.kept_node_ids.add(m.ref)

            dep_collector = KeptObjectDependencyCollector(excluded_way_ids, excluded_relation_ids)
            dep_collector.apply_file(base_file, locations=False)

            excluded_node_ids = candidate_node_ids - dep_collector.kept_node_ids
            rescued_count = len(candidate_node_ids) - len(excluded_node_ids)
            if rescued_count > 0:
                logger.info(
                    f"Rescued {rescued_count} node(s) from exclusion because they are "
                    f"vertices of kept ways or members of kept relations."
                )
        else:
            excluded_node_ids = set()

        # Add patch nodes to exclusions. If a node is explicitly in the patch file,
        # it represents a creation, modification, or deletion, and MUST take precedence
        # over the base file's version (even if it's a vertex of a kept way).
        excluded_node_ids |= patch_node_ids

        with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf") as masked_base_temp:
            masked_base_path = masked_base_temp.name

            excluding_filter = ExcludingIdFilter(
                way_ids=excluded_way_ids,
                relation_ids=excluded_relation_ids,
                node_ids=excluded_node_ids
            )
            with osmium.BackReferenceWriter(masked_base_path, base_file, overwrite=True) as writer:
                for o in osmium.FileProcessor(base_file).with_filter(excluding_filter):
                    writer.add(o)

            logger.info(
                f"Excluded {excluding_filter.discarded_way_count} way(s), "
                f"{excluding_filter.discarded_relation_count} relation(s), and "
                f"{excluding_filter.discarded_node_count} node(s) from base file "
                f"({excluding_filter.discarded_tagged_count} had a notable descriptive tag "
                f"[name/service/amenity/landuse/natural/building/building:part]). "
                f"Unrelated relations and non-excluded vertices are preserved."
            )

            # --- Consistency check ---
            logger.info("Verifying masked base file consistency...")
            all_base_ways = _WayIdCollector()
            all_base_ways.apply_file(base_file, locations=False)

            masked_ways = _WayIdCollector()
            masked_ways.apply_file(masked_base_path, locations=False)

            expected_way_ids = all_base_ways.way_ids - excluded_way_ids
            unexpectedly_missing = expected_way_ids - masked_ways.way_ids
            unexpectedly_present = masked_ways.way_ids - expected_way_ids

            logger.info(
                f"Consistency check: {len(expected_way_ids)} way(s) expected in masked "
                f"base file, {len(masked_ways.way_ids)} found."
            )
            if unexpectedly_missing:
                sample = sorted(unexpectedly_missing)[:20]
                logger.warning(
                    f"{len(unexpectedly_missing)} way(s) are missing from the masked base "
                    f"file even though they were NOT marked for exclusion: "
                    f"{sample}{' ...' if len(unexpectedly_missing) > 20 else ''}"
                )
                logger.warning(
                    "This usually means base_file is not sorted by type/ID (try "
                    "'osmium sort'), or these ways reference node(s) not present in "
                    "base_file (dangling refs, common in bbox-clipped extracts, check "
                    "with 'osmium check-refs')."
                )
            if unexpectedly_present:
                sample = sorted(unexpectedly_present)[:20]
                logger.warning(
                    f"{len(unexpectedly_present)} way(s) unexpectedly present in the "
                    f"masked base file (should have been excluded): "
                    f"{sample}{' ...' if len(unexpectedly_present) > 20 else ''}"
                )

            all_base_relations = _RelationIdCollector()
            all_base_relations.apply_file(base_file, locations=False)

            masked_relations = _RelationIdCollector()
            masked_relations.apply_file(masked_base_path, locations=False)

            expected_relation_ids = all_base_relations.relation_ids - excluded_relation_ids
            relations_unexpectedly_missing = expected_relation_ids - masked_relations.relation_ids
            relations_unexpectedly_present = masked_relations.relation_ids - expected_relation_ids

            logger.info(
                f"Consistency check: {len(expected_relation_ids)} relation(s) expected "
                f"in masked base file, {len(masked_relations.relation_ids)} found."
            )
            if relations_unexpectedly_missing:
                sample = sorted(relations_unexpectedly_missing)[:20]
                logger.warning(
                    f"{len(relations_unexpectedly_missing)} relation(s) are missing from "
                    f"the masked base file even though they were NOT marked for exclusion: "
                    f"{sample}{' ...' if len(relations_unexpectedly_missing) > 20 else ''}"
                )
            if relations_unexpectedly_present:
                sample = sorted(relations_unexpectedly_present)[:20]
                logger.warning(
                    f"{len(relations_unexpectedly_present)} relation(s) unexpectedly "
                    f"present in the masked base file (should have been excluded): "
                    f"{sample}{' ...' if len(relations_unexpectedly_present) > 20 else ''}"
                )

            if (not unexpectedly_missing and not unexpectedly_present
                    and not relations_unexpectedly_missing and not relations_unexpectedly_present):
                logger.info("Consistency check passed: masked base file matches expectations.")

            if masked_base_output:
                with osmium.SimpleWriter(masked_base_output, overwrite=True) as dump_writer:
                    copy_handler = _CopyAllHandler(dump_writer)
                    copy_handler.apply_file(masked_base_path, locations=False)
                logger.info(
                    f"Masked base file dumped to {masked_base_output} "
                    f"(format determined by file extension, kept for debugging via --dump-masked-base)."
                )

            logger.info(f"Generated masked file. Applying patch. Overwrite: {overwrite}")

            with open(masked_base_path, 'rb') as f:
                with osmium.SimpleWriter(output_file, overwrite=overwrite) as writer:
                    reader = osmium.MergeInputReader()
                    for pb in filtered_patch_buffers:
                        reader.add_buffer(pb, "pbf")
                    reader.add_buffer(f.read(), "pbf")
                    reader.apply(writer)
                    writer.close()

    finally:
        for pf in normalized_patch_files:
            try:
                os.unlink(pf)
            except OSError:
                pass
        for pf in temp_filtered_files:
            try:
                os.unlink(pf)
            except OSError:
                pass

    logger.info(f"Done, {output_file} written")


def ways_to_polygons(args: argparse.Namespace) -> None:
    """
    Core logic for the 'ways-to-polygons' subcommand. Reads an OSM file and
    converts closed ways/areas to GeoJSON polygons, optionally further
    converting to Osmosis .poly format.
    """
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    input_file = args.input
    output_file = args.output
    fmt = args.format

    if not os.path.exists(input_file):
        msg = f"Input file not found: {input_file}"
        logger.error(msg)
        raise RuntimeError(msg)

    geojson = osm_file_to_geojson(input_file)

    if fmt == 'geojson':
        with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
            json.dump(geojson, f, indent=2)
    elif fmt == 'poly':
        poly = geojson_to_poly(geojson)
        if poly is None:
            msg = "Failed to convert GeoJSON to .poly format."
            logger.error(msg)
            raise RuntimeError(msg)
        with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
            f.write(poly)

    logger.info("--- Polygons file created successfully. ---")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="A tool for filtering and manipulating OSM files.",
        formatter_class=argparse.RawTextHelpFormatter
    )

    subparsers = parser.add_subparsers(dest='command', help='Available subcommands', required=True)

    # --- Filter Subcommand Parser ---
    filter_parser = subparsers.add_parser(
        'filter',
        help='Filters an OSM file to extract objects and their dependencies.',
        description='Extracts objects from an OSM file based on specific criteria (tags or actions) and includes all their dependent objects (e.g., nodes for ways, members for relations, recursively).',
        add_help=False
    )
    filter_parser.add_argument('-p', '--patch', action='append', nargs='+', required=True, help="The input OSM file(s) (e.g., from JOSM). Can be .osm (XML) or .pbf.")
    filter_parser.add_argument('-o', '--output', required=True, help="The path for the output .osm file.")
    filter_parser.add_argument('--tag-key', default="upload", help="The tag key to filter features by (e.g., 'highway').")
    filter_parser.add_argument('--tag-value', default="false", help="The tag value to filter features by (e.g., 'residential').")
    filter_parser.add_argument('--include-actions', help="A comma-separated list of actions to include (e.g., 'modify,create,delete').")
    filter_parser.add_argument('--no-expand-relations', action='store_true',
                                help="Restore legacy behavior: skip recursive resolution of nested "
                                     "relation members and of node lists for ways discovered only via "
                                     "relation membership. Only Pass 1's direct matches and their "
                                     "immediate dependencies are written. May produce ways/relations "
                                     "with dangling references in the output; affected relations are "
                                     "logged as warnings.")
    filter_parser.add_argument('--tag', help="Comma-separated list of tag=value pairs to add to each object that "
                                              "directly matches the filter criteria (not to its pulled-in "
                                              "dependencies), e.g. --tag tag1=value1,tag2=value2")
    filter_parser.add_argument('--full', action='store_true',
                                help="Include all modifications, deletions and all items with a negative id in the output.")
    filter_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    filter_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- patch Subcommand Parser ---
    patch_parser = subparsers.add_parser(
        'patch',
        help='Merges a patch OSM file into a base OSM file, replacing intersecting geometry.',
        description='Reads a base OSM file and one or more patch OSM files, removes closed ways in the base file '
                     '(and any relation referencing them, e.g. multipolygons) that intersect with '
                     'polygons/areas from the patches, and writes a merged result combining all (with '
                     'patch IDs normalized to avoid collisions). Standalone point features (trees, etc.) inside '
                     'the mask are also removed, UNLESS they are vertices of kept ways or members of kept relations.'
    )
    patch_parser.add_argument('-i', '--input', required=True, help="The base OSM file to merge into.")
    patch_parser.add_argument('-p', '--patch', action='append', nargs='+', required=True, help="The path(s) for the patch OSM file(s) to be applied.")
    patch_parser.add_argument('-o', '--output', required=True, help="The path for the output file.")
    patch_parser.add_argument('--dump-masked-base', metavar='FILE',
                               help="Optional, for debugging: write the intermediate masked base file "
                                    "(base file with intersecting closed ways and dependent relations "
                                    "removed, before the patch is merged in) to FILE, in the format "
                                    "implied by FILE's extension (e.g. '.osm' for XML, '.pbf' for PBF).")
    patch_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    patch_parser.add_argument('--clean', action='store_true', help="Discard deleted and modified objects from the patch before applying it (does not modify the original patch file).")
    patch_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- tile-info Subcommand Parser ---
    bbox_parser = subparsers.add_parser(
        'tile-info',
        help='Calculates a bounding box and intersecting tiles from an OSM file.',
        description='Reads an OSM file, calculates the bounding box of all nodes, and outputs a GeoJSON file containing the bbox as a polygon and a list of intersecting slippy map tiles.'
    )
    bbox_parser.add_argument('-i', '--input', required=True, help="The input OSM file (e.g., from JOSM).")
    bbox_parser.add_argument('-o', '--output', required=True, help="The path for the output GeoJSON file.")
    bbox_parser.add_argument('--max-zoom', type=int, default=16, help="Maximum zoom level to calculate tiles for (default: 16).")
    bbox_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- Ways-to-Polygons Subcommand Parser ---
    w2p_parser = subparsers.add_parser(
        'ways-to-polygons',
        help='Converts all closed ways/areas in an OSM file to polygons.',
        description='Reads an OSM file and converts all closed ways/areas into GeoJSON or Osmosis .poly polygons.'
    )
    w2p_parser.add_argument('-i', '--input', required=True, help="The input OSM file (e.g., from JOSM).")
    w2p_parser.add_argument('-o', '--output', required=True, help="The path for the output file. Use '-' for stdout.")
    w2p_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")
    w2p_parser.add_argument('-f', '--format', choices=['geojson', 'poly'], default='geojson', help="Output format (default: geojson).")

    args = parser.parse_args()

    try:
        if args.command == 'filter':
            filter_cmd(args)
        elif args.command == 'tile-info':
            tile_info_cmd(args)
        elif args.command == 'patch':
            patch_cmd(args)
        elif args.command == 'ways-to-polygons':
            ways_to_polygons(args)
        else:
            parser.print_help()
    except RuntimeError as e:
        sys.exit(1)


if __name__ == "__main__":
    main()
