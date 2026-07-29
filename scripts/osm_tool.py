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

from typing import Set, List, Optional, Any, Tuple, Dict, Union
from shapely.geometry import Polygon

# --- Logger Setup ---
logger = logging.getLogger("osm_filter")

# --- ID Flipping / Collision Handling ---

# Any ID above this is assumed to never collide with a real-world OSM ID.
# Used as a fallback offset when a straight abs()-flip would collide.
ID_OFFSET_FALLBACK = 10 ** 15


class CollisionChecker(osmium.SimpleHandler):
    """
    Pass 0: Scans a file and records which positive and (absolute-valued)
    negative IDs exist, per object type. Node/way/relation ID spaces are
    independent namespaces in OSM, so each is tracked separately.

    Used to detect whether flipping negative IDs via abs() would collide
    with an already-existing positive ID of the same type.
    """
    def __init__(self):
        super().__init__()
        self.pos_ids = {'node': set(), 'way': set(), 'relation': set()}
        self.neg_ids = {'node': set(), 'way': set(), 'relation': set()}

    def _record(self, kind: str, obj_id: int) -> None:
        if obj_id >= 0:
            self.pos_ids[kind].add(obj_id)
        else:
            self.neg_ids[kind].add(abs(obj_id))

    def node(self, n):
        self._record('node', n.id)

    def way(self, w):
        self._record('way', w.id)

    def relation(self, r):
        self._record('relation', r.id)

    def find_collisions(self) -> Dict[str, Set[int]]:
        """Returns {kind: overlapping_ids} for any type where a collision would occur."""
        collisions = {}
        for kind in ('node', 'way', 'relation'):
            overlap = self.pos_ids[kind] & self.neg_ids[kind]
            if overlap:
                collisions[kind] = overlap
        return collisions


class _ExternalPositiveIdScanner(osmium.SimpleHandler):
    """
    Lightweight scan of a *second* file's existing positive IDs only.
    Used to check whether normalizing one file's negative IDs (e.g. a
    JOSM patch) would collide with another file's namespace (e.g. the
    base file it's about to be merged into), without needing to track
    that second file's own negative IDs (which normalize_ids_to_positive
    is not responsible for and does not touch).
    """
    def __init__(self):
        super().__init__()
        self.pos_ids = {'node': set(), 'way': set(), 'relation': set()}

    def node(self, n):
        if n.id >= 0:
            self.pos_ids['node'].add(n.id)

    def way(self, w):
        if w.id >= 0:
            self.pos_ids['way'].add(w.id)

    def relation(self, r):
        if r.id >= 0:
            self.pos_ids['relation'].add(r.id)


class IDChanger(osmium.SimpleHandler):
    def __init__(self, writer, offset: int = 0):
        super().__init__()
        self.writer = writer
        self.offset = offset

    def _flip(self, obj_id: int) -> int:
        return obj_id if obj_id > 0 else (self.offset + abs(obj_id))

    def node(self, n):
        new_id = self._flip(n.id)
        logger.debug(f"Node ID {n.id} -> {new_id}")
        self.writer.add_node(n.replace(id=new_id))

    def way(self, w):
        new_id = self._flip(w.id)
        new_node_refs = [self._flip(nr.ref) for nr in w.nodes]
        logger.debug(f"Way ID {w.id} -> {new_id}")
        self.writer.add_way(w.replace(id=new_id, nodes=new_node_refs))

    def relation(self, r):
        new_id = self._flip(r.id)
        new_members = [(m.type, self._flip(m.ref), m.role) for m in r.members]
        logger.debug(f"Relation ID {r.id} -> {new_id}")
        self.writer.add_relation(r.replace(id=new_id, members=new_members))

def normalize_ids_to_positive(
    input_path: str,
    output_path: str,
    on_collision: str = "offset",
    reference_paths: Optional[List[str]] = None,
) -> None:
    """
    Runs a cheap collision-check pass, then rewrites `input_path` to
    `output_path` with all negative IDs flipped to positive.

    on_collision:
        'offset' (default) - if a plain abs()-flip would collide with an
                              existing positive ID, transparently fall back
                              to an offset-based scheme that can't collide.
        'abort'             - raise an exception instead of falling back.

    reference_paths:
        Optional list of additional OSM file paths whose *existing positive
        IDs* should also be treated as off-limits for the abs()-flip, even
        though those files aren't being normalized themselves. Use this when
        the normalized output will later be merged/combined with another
        file (e.g. the base file in the `patch` subcommand) so that a
        newly-flipped ID from `input_path` can't collide with an unrelated,
        pre-existing object of the same type in that other file.
    """
    checker = CollisionChecker()
    osmium.apply(input_path, checker)
    collisions = checker.find_collisions()

    # Cross-file collision check: does abs()-flipping input_path's negative
    # IDs collide with positive IDs that already exist in a reference file?
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
                f"within {input_path!r}: "
                f"{sample}{' ...' if len(ids) > 20 else ''}"
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
            raise RuntimeError(
                "Aborting: flipping negative IDs would collide with existing "
                "positive IDs (in the input file and/or a reference file). "
                "Re-run with on_collision='offset' to auto-resolve, or clean "
                "up the input file."
            )
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
    """Calculates the bounding box of all nodes in an OSM file."""
    def __init__(self):
        super().__init__()
        self.min_lon, self.min_lat = 180.0, 90.0
        self.max_lon, self.max_lat = -180.0, -90.0

    def node(self, n: osmium.osm.Node) -> None:
        self.min_lon = min(self.min_lon, n.location.lon)
        self.min_lat = min(self.min_lat, n.location.lat)
        self.max_lon = max(self.max_lon, n.location.lon)
        self.max_lat = max(self.max_lat, n.location.lat)


# --- Tag Parsing ---

def parse_tag_argument(tag_str: Optional[str]) -> Dict[str, str]:
    """
    Parses a --tag argument string of the form 'key1=value1,key2=value2'
    into a dict. Values may contain '=' characters (only the first '=' in
    each comma-separated entry is treated as the key/value separator).

    Returns an empty dict if tag_str is None/empty. Exits the process with
    an error if any entry is malformed (missing '=' or an empty key).
    """
    tags: Dict[str, str] = {}
    if not tag_str:
        return tags

    for raw_entry in tag_str.split(','):
        entry = raw_entry.strip()
        if not entry:
            continue
        if '=' not in entry:
            logger.error(f"Invalid --tag entry {entry!r}; expected format key=value.")
            sys.exit(1)
        key, value = entry.split('=', 1)
        key = key.strip()
        value = value.strip()
        if not key:
            logger.error(f"Invalid --tag entry {entry!r}; tag key must not be empty.")
            sys.exit(1)
        tags[key] = value

    return tags


# --- Filtering / Dependency Resolution ---

class DependencyCollector(osmium.SimpleHandler):
    """
    Pass 1: Collects all objects that match the filter criteria, plus their
    *direct* dependencies (nodes for matched ways; member refs for matched
    relations). Nested relation expansion and way->node resolution for
    relation-referenced ways are handled by separate passes afterwards
    (see RelationExpander / WayNodeResolver and filter_osm()).

    Tracks two levels of ID sets per type:
      - node_ids / way_ids / relation_ids: everything that needs to be
        written to the output (matches + all their dependencies).
      - matched_node_ids / matched_way_ids / matched_relation_ids: only the
        objects that *directly* matched the filter criteria themselves, as
        opposed to being pulled in solely as a dependency. Used to scope
        --tag additions (see filter_osm()) to just the matched objects,
        so e.g. tagging a matched way doesn't also tag every one of its
        vertex nodes.
    """

    def __init__(self, tag_key: Optional[str], tag_value: Optional[str], include_actions: Optional[str]):
        super().__init__()
        self.tag_key = tag_key
        self.tag_value = tag_value
        self.include_actions = include_actions.split(',') if include_actions else []

        self.node_ids: Set[int] = set()
        self.way_ids: Set[int] = set()
        self.relation_ids: Set[int] = set()

        self.matched_node_ids: Set[int] = set()
        self.matched_way_ids: Set[int] = set()
        self.matched_relation_ids: Set[int] = set()

    def is_match(self, elem: osmium.osm.OSMObject) -> bool:
        if self.tag_key and elem.tags.get(self.tag_key) == self.tag_value:
            return True
        if self.include_actions and elem.tags.get('action') in self.include_actions:
            return True
        action = getattr(elem, 'action', None)
        if self.include_actions and action and action in self.include_actions:
            return True
        return False

    def node(self, n: osmium.osm.Node) -> None:
        if self.is_match(n):
            logger.debug(f"Matching node found: {n.id}")
            self.node_ids.add(n.id)
            self.matched_node_ids.add(n.id)

    def way(self, w: osmium.osm.Way) -> None:
        if self.is_match(w):
            logger.debug(f"Matching way found: {w.id}")
            self.way_ids.add(w.id)
            self.matched_way_ids.add(w.id)
            for node in w.nodes:
                self.node_ids.add(node.ref)

    def relation(self, r: osmium.osm.Relation) -> None:
        if self.is_match(r):
            logger.debug(f"Matching relation found: {r.id}")
            self.relation_ids.add(r.id)
            self.matched_relation_ids.add(r.id)
            for member in r.members:
                if member.type == 'n':
                    self.node_ids.add(member.ref)
                elif member.type == 'w':
                    self.way_ids.add(member.ref)
                elif member.type == 'r':
                    self.relation_ids.add(member.ref)


class RelationExpander(osmium.SimpleHandler):
    """
    Given a set of relation IDs, finds those relations and collects the IDs
    of their members. Intended to be called repeatedly (fixed-point
    iteration) to fully resolve relations-of-relations, since a single pass
    can't know in advance whether a newly-discovered relation itself
    contains further relation members.
    """
    def __init__(self, target_relation_ids: Set[int]):
        super().__init__()
        self.targets = target_relation_ids
        self.relation_ids: Set[int] = set()
        self.way_ids: Set[int] = set()
        self.node_ids: Set[int] = set()

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.targets:
            for member in r.members:
                if member.type == 'n':
                    self.node_ids.add(member.ref)
                elif member.type == 'w':
                    self.way_ids.add(member.ref)
                elif member.type == 'r':
                    self.relation_ids.add(member.ref)


class WayNodeResolver(osmium.SimpleHandler):
    """
    Given a set of way IDs, collects the node IDs referenced by those ways.
    Needed because ways discovered only as relation members don't have
    their node lists available at relation-processing time.
    """
    def __init__(self, target_way_ids: Set[int]):
        super().__init__()
        self.way_ids = target_way_ids
        self.node_ids: Set[int] = set()

    def way(self, w: osmium.osm.Way) -> None:
        if w.id in self.way_ids:
            for node in w.nodes:
                self.node_ids.add(node.ref)


class DataWriter(osmium.SimpleHandler):
    """
    Pass N: Writes all objects whose IDs were fully resolved by the
    preceding dependency-collection passes.

    If extra_tags is given, those tags are merged into (and override any
    same-named existing tags on) objects that *directly matched* the filter
    criteria (dep_collector.matched_*_ids) -- not onto objects that were
    only pulled in as dependencies (e.g. a matched way's nodes).
    """
    def __init__(self, writer: osmium.io.Writer, deps: DependencyCollector, extra_tags: Optional[Dict[str, str]] = None):
        super().__init__()
        self.writer = writer
        self.deps = deps
        self.extra_tags = extra_tags or {}

    def _with_extra_tags(self, obj: osmium.osm.OSMObject, matched_ids: Set[int]):
        if not self.extra_tags or obj.id not in matched_ids:
            return obj
        merged_tags = dict(obj.tags)
        merged_tags.update(self.extra_tags)
        logger.debug(f"Adding tags {self.extra_tags} to {obj.id}")
        return obj.replace(tags=merged_tags)

    def node(self, n: osmium.osm.Node) -> None:
        if n.id in self.deps.node_ids:
            self.writer.add_node(self._with_extra_tags(n, self.deps.matched_node_ids))

    def way(self, w: osmium.osm.Way) -> None:
        if w.id in self.deps.way_ids:
            self.writer.add_way(self._with_extra_tags(w, self.deps.matched_way_ids))

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.deps.relation_ids:
            self.writer.add_relation(self._with_extra_tags(r, self.deps.matched_relation_ids))


# --- Tile Math Functions ---

def deg_to_tile_num(lat_deg: float, lon_deg: float, zoom: int) -> Tuple[int, int]:
    """Converts geographic coordinates to tile numbers."""
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)


# --- Commands ---

def filter_osm(args: argparse.Namespace) -> None:
    """
    Core logic for the 'filter' subcommand. Reads an OSM file, filters
    objects based on tags or actions, and writes the result including all
    dependencies (recursively for nested relations, and node refs for
    ways discovered via relation membership).

    If --tag is given, its key=value pairs are added to (and override any
    same-named tags on) objects that directly matched the filter criteria.
    """
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    if not (args.tag_key and args.tag_value) and not args.include_actions:
        logger.error("You must specify either a tag/value combination or actions to include.")
        sys.exit(1)

    extra_tags = parse_tag_argument(args.tag)

    input_file = args.patch
    output_file = args.output

    if not os.path.exists(input_file):
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    if os.path.exists(output_file):
        if not args.force:
            logger.warning(f"Output file '{output_file}' already exists. Use -f or --force to overwrite.")
            return
        os.remove(output_file)

    logger.info("--- Pass 1: Collecting matching objects and their direct dependencies ---")
    dep_collector = DependencyCollector(args.tag_key, args.tag_value, args.include_actions)
    dep_collector.apply_file(input_file, locations=True, idx='flex_mem')

    logger.info("--- Pass 2: Expanding nested relation dependencies (fixed-point) ---")
    while True:
        expander = RelationExpander(dep_collector.relation_ids)
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
    way_node_resolver.apply_file(input_file, locations=False)
    dep_collector.node_ids |= way_node_resolver.node_ids

    logger.info(
        f"Found {len(dep_collector.node_ids)} nodes, {len(dep_collector.way_ids)} ways, "
        f"and {len(dep_collector.relation_ids)} relations to include."
    )

    if not any([dep_collector.node_ids, dep_collector.way_ids, dep_collector.relation_ids]):
        logger.warning("No matching objects found. Skipping file write.")
        return

    if extra_tags:
        logger.info(f"--- Pass 4: Writing selected objects to {output_file} (adding tags {extra_tags} to matched objects) ---")
    else:
        logger.info(f"--- Pass 4: Writing selected objects to {output_file} ---")
    writer = osmium.SimpleWriter(output_file)
    data_writer = DataWriter(writer, dep_collector, extra_tags=extra_tags)
    data_writer.apply_file(input_file, locations=True, idx='flex_mem')
    writer.close()
    logger.info("--- Filtering complete. ---")


def bbox_tiles_osm(args: argparse.Namespace) -> None:
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
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    logger.info(f"--- Step 1: Calculating bounding box from {input_file} ---")
    bbox_handler = BoundingBoxHandler()
    bbox_handler.apply_file(input_file, locations=True)

    min_lon, min_lat = bbox_handler.min_lon, bbox_handler.min_lat
    max_lon, max_lat = bbox_handler.max_lon, bbox_handler.max_lat

    if min_lon > max_lon:
        logger.error("No nodes found in input file. Cannot calculate bounding box.")
        sys.exit(1)

    logger.info(f"Bounding box found: [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")

    logger.info(f"--- Step 2: Calculating tiles up to zoom level {max_zoom} ---")
    tiles = []
    for zoom in range(max_zoom + 1):
        top_left_x, top_left_y = deg_to_tile_num(max_lat, min_lon, zoom)
        bottom_right_x, bottom_right_y = deg_to_tile_num(min_lat, max_lon, zoom)

        for y in range(top_left_y, bottom_right_y + 1):
            if top_left_x > bottom_right_x:
                # Bbox crosses the antimeridian, so we have two ranges for x
                for x in range(top_left_x, 2 ** zoom):
                    tiles.append([zoom, x, y])
                for x in range(0, bottom_right_x + 1):
                    tiles.append([zoom, x, y])
            else:
                for x in range(top_left_x, bottom_right_x + 1):
                    tiles.append([zoom, x, y])

    logger.info(f"Found {len(tiles)} tiles.")

    logger.info(f"--- Step 3: Writing GeoJSON to {output_file} ---")
    geojson = {
        "type": "FeatureCollection",
        "properties": {
            "tiles": tiles
        },
        "features": [{
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [min_lon, min_lat], [max_lon, min_lat],
                    [max_lon, max_lat], [min_lon, max_lat],
                    [min_lon, min_lat]
                ]]
            },
            "properties": {}
        }]
    }

    with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
        json.dump(geojson, f, indent=2)

    logger.info("--- GeoJSON file created successfully. ---")


def geojson_to_poly(geojson_input: Union[dict, str]) -> Optional[str]:
    """
    Converts GeoJSON data (either a dictionary or a JSON string) into the
    Osmosis .poly file format string, handling multiple disjoint polygons
    and interior rings (holes) correctly.

    Osmosis .poly format convention used here:
      - each polygon's exterior ring is a plain-named section
      - each polygon's interior rings (holes) are '!'-prefixed sections

    Returns:
        str: The contents of the generated .poly file, or None on error.
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
        # Exterior ring
        lines_list.append(f"{poly_id}")
        for coord in poly_geom.exterior.coords:
            lines_list.append(f"  {coord[0]} {coord[1]}")
        lines_list.append("END")
        # Interior rings (holes)
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

    poly_lines.append("END")  # Final END marker for the entire file/set
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
        # Normalize IDs (JOSM-style negative temp IDs -> positive), collision-safe.
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


def merge_cmd(args: argparse.Namespace) -> None:
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    base_file = args.input
    patch = args.patch
    output_file = args.output
    overwrite = args.force
    merge(base_file, patch, output_file, overwrite)


def merge(base_file, patch, output_file, overwrite) -> None:

    class IntersectionHandler(osmium.SimpleHandler):
        """
        Identifies closed ways in the base file that intersect with the
        patch's polygons.

        NOTE: only *closed* ways are checked. Open ways (roads, paths, etc.)
        that fall inside the patched area are currently never removed, so
        merging will append rather than replace overlapping linear data.
        If that matters for your use case, extend this to also test open
        ways (as linestrings) against the target polygons.
        """
        def __init__(self, target_polygons):
            super().__init__()
            self.target_polygons = target_polygons
            self.wkbfactory = osmium.geom.WKBFactory()
            self.intersecting_ways = []

        def way(self, w):
            if w.is_closed():
                try:
                    wkb_line = self.wkbfactory.create_linestring(w)
                    shapely_line = shapely.from_wkb(wkb_line)

                    if len(shapely_line.coords) >= 4:
                        closed_way_polygon = Polygon(shapely_line)

                        for target_poly in self.target_polygons:
                            if target_poly is not None and closed_way_polygon.intersects(target_poly):
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
        See https://github.com/osmcode/pyosmium/issues/310

        Also logs (debug) each object it discards, including its name tag
        if present, and keeps simple counters so callers can log a summary
        once the filter pass is complete.
        """
        def __init__(self, ids):
            self.ids = ids
            self.discarded_count = 0
            self.discarded_named_count = 0

        def _log_discard(self, kind: str, obj) -> None:
            name = obj.tags.get('name')
            self.discarded_count += 1
            if name:
                self.discarded_named_count += 1
            logger.debug(
                f"Discarding {kind} {obj.id} from base file "
                f"(replaced by patch)" + (f", name={name!r}" if name else "")
            )

        def node(self, n):
            matched = n.id in self.ids
            if matched:
                self._log_discard('node', n)
            return matched

        def way(self, w):
            matched = w.id in self.ids
            if matched:
                self._log_discard('way', w)
            return matched

        def relation(self, r):
            matched = r.id in self.ids
            if matched:
                self._log_discard('relation', r)
            return matched

        def area(self, a):
            matched = a.id in self.ids
            if matched:
                self._log_discard('area', a)
            return matched

    logger.info("Generating mask and applying it to the input file.")

    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf") as temp:
        # Normalize the patch file's IDs (collision-safe), checking both
        # against itself and against the base file it will be merged into,
        # so a flipped negative ID from the patch can't silently collide
        # with an unrelated, pre-existing object in the base file.
        normalize_ids_to_positive(
            patch, temp.name, on_collision="offset", reference_paths=[base_file]
        )

        wkbfab = osmium.geom.WKBFactory()
        polygons = []
        with open(temp.name, 'rb') as f:
            patch_buffer = f.read()
            patch_pbf = osmium.io.FileBuffer(patch_buffer, "pbf")
            for o in osmium.FileProcessor(patch_pbf).with_areas():
                logger.debug(f"Generating filter primitive for {o.type_str()}, id: {o.id}")
                wkb = None
                if o.is_way() and not o.is_closed():
                    wkb = shapely.from_wkb(wkbfab.create_linestring(o.nodes))
                elif o.is_area():
                    wkb = shapely.from_wkb(wkbfab.create_multipolygon(o))
                polygons.append(wkb)

    polygons = [item for item in polygons if item is not None]
    logger.info(f"Extracted {len(polygons)} polygons to use as filter.")

    handler = IntersectionHandler(polygons)
    handler.apply_file(base_file, locations=True, idx='flex_mem')
    results = handler.intersecting_ways

    ids = [i['id'] for i in results]
    logger.debug(ids)

    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf") as temp:
        excluding_filter = ExcludingIdFilter(ids)
        with osmium.BackReferenceWriter(temp.name, base_file, overwrite=True) as writer:
            for o in osmium.FileProcessor(base_file) \
                    .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY)) \
                    .with_filter(excluding_filter):
                writer.add(o)

        logger.info(
            f"Discarded {excluding_filter.discarded_count} way(s) from base file "
            f"({excluding_filter.discarded_named_count} had a name tag)."
        )

        logger.info(f"Generated masked file. Applying patch. Overwrite: {overwrite}")

        with open(temp.name, 'rb') as f:
            with osmium.SimpleWriter(output_file, overwrite=overwrite) as writer:
                reader = osmium.MergeInputReader()
                reader.add_buffer(patch_buffer, "pbf")
                reader.add_buffer(f.read(), "pbf")
                reader.apply(writer)
                writer.close()

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
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    geojson = osm_file_to_geojson(input_file)

    if fmt == 'geojson':
        with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
            json.dump(geojson, f, indent=2)
    elif fmt == 'poly':
        poly = geojson_to_poly(geojson)
        if poly is None:
            logger.error("Failed to convert GeoJSON to .poly format.")
            sys.exit(1)
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
    filter_parser.add_argument('-p', '--patch', required=True, help="The input OSM file (e.g., from JOSM). Can be .osm (XML) or .pbf.")
    filter_parser.add_argument('-o', '--output', required=True, help="The path for the output .osm file.")
    filter_parser.add_argument('--tag-key', default="upload", help="The tag key to filter features by (e.g., 'highway').")
    filter_parser.add_argument('--tag-value', default="false", help="The tag value to filter features by (e.g., 'residential').")
    filter_parser.add_argument('--include-actions', help="A comma-separated list of actions to include (e.g., 'modify,create,delete').")
    filter_parser.add_argument('--tag', help="Comma-separated list of tag=value pairs to add to each object that "
                                              "directly matches the filter criteria (not to its pulled-in "
                                              "dependencies), e.g. --tag tag1=value1,tag2=value2")
    filter_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    filter_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- patch Subcommand Parser ---
    patch_parser = subparsers.add_parser(
        'patch',
        help='Merges a patch OSM file into a base OSM file, replacing intersecting geometry.',
        description='Reads a base OSM file and a patch OSM file, removes closed ways in the base file '
                     'that intersect with polygons/areas from the patch, and writes a merged result '
                     'combining both (with patch IDs normalized to avoid collisions).'
    )
    patch_parser.add_argument('-i', '--input', required=True, help="The base OSM file to merge into.")
    patch_parser.add_argument('-p', '--patch', required=True, help="The path for the patch OSM file to be applied.")
    patch_parser.add_argument('-o', '--output', required=True, help="The path for the output file.")
    patch_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
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

    if args.command == 'filter':
        filter_osm(args)
    elif args.command == 'tile-info':
        bbox_tiles_osm(args)
    elif args.command == 'patch':
        merge_cmd(args)
    elif args.command == 'ways-to-polygons':
        ways_to_polygons(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
