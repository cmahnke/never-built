#!/usr/bin/env python3
import osmium as osm
import osmium.io
import osmium.geom
import sys
import argparse
import logging
import os
import subprocess
from typing import Set, List, Optional, Any

from shapely.wkt import loads
from shapely.prepared import prep
from shapely.ops import unary_union
from shapely.geometry.base import BaseGeometry
# --- Logger Setup ---
logger = logging.getLogger("osm_filter")


class DependencyCollector(osm.SimpleHandler):
    """
    First pass handler: Collects all objects that match the filter criteria
    and recursively finds all their dependencies (nodes for ways, members for relations).
    """

    def __init__(self, tag_key: Optional[str], tag_value: Optional[str], include_actions: Optional[str]):
        super(DependencyCollector, self).__init__()
        self.tag_key = tag_key
        self.tag_value = tag_value
        self.include_actions = include_actions.split(',') if include_actions else []

        # Sets to store the IDs of all objects to be included in the final output
        self.node_ids: Set[int] = set()
        self.way_ids: Set[int] = set()
        self.relation_ids: Set[int] = set()

    def is_match(self, elem: osm.osm.OSMObject) -> bool:
        """Check if an element matches the filter criteria."""
        if self.tag_key and elem.tags.get(self.tag_key) == self.tag_value:
            return True
        if self.include_actions and elem.tags.get('action') in self.include_actions:
            return True
        # JOSM uses 'modify', 'create', 'delete' in the action tag for changesets,
        # but for objects it uses attributes on the object itself.
        action = getattr(elem, 'action', None)
        if self.include_actions and action and action in self.include_actions:
            return True
        return False

    def node(self, n: osm.osm.Node) -> None:
        """Process a node."""
        if self.is_match(n):
            logger.debug(f"Matching node found: {n.id}")
            self.node_ids.add(n.id)

    def way(self, w: osm.osm.Way) -> None:
        """Process a way."""
        if self.is_match(w):
            logger.debug(f"Matching way found: {w.id}")
            self.way_ids.add(w.id)
            for node in w.nodes:
                self.node_ids.add(node.ref)

    def relation(self, r: osm.osm.Relation) -> None:
        """Process a relation."""
        if self.is_match(r):
            logger.debug(f"Matching relation found: {r.id}")
            self._collect_relation_dependencies(r)

    def _collect_relation_dependencies(self, relation: osm.osm.Relation) -> None:
        """Recursively collect all dependencies for a relation."""
        if relation.id in self.relation_ids:
            return # Already processed
        self.relation_ids.add(relation.id)
        logger.debug(f"Collecting dependencies for relation: {relation.id}")

        for member in relation.members:
            if member.type == 'n':
                self.node_ids.add(member.ref)
            elif member.type == 'w':
                self.way_ids.add(member.ref)
                # A way's nodes are not directly available here, they will be
                # picked up by the DataWriter pass which has access to the full data.
            elif member.type == 'r':
                # This member is a relation, but we can't get its members here.
                # We add its ID and it will be processed when the DataWriter pass finds it.
                self.relation_ids.add(member.ref)


class DataWriter(osm.SimpleHandler):
    """
    Second pass handler: Writes all objects collected in the first pass
    to the output file.
    """

    def __init__(self, writer: osmium.io.Writer, deps: DependencyCollector):
        super(DataWriter, self).__init__()
        self.writer = writer
        self.deps = deps
        # Keep track of nodes needed by ways we've decided to write.
        self.needed_node_ids: Set[int] = set(deps.node_ids)

    def node(self, n: osm.osm.Node) -> None:
        """Write a node if it's in the dependency list."""
        if n.id in self.needed_node_ids:
            self.writer.add_node(n)

    def way(self, w: osm.osm.Way) -> None:
        """Write a way if it's in the dependency list, and collect its nodes."""
        if w.id in self.deps.way_ids:
            # This way is needed, so all its nodes are also needed.
            for node in w.nodes:
                self.needed_node_ids.add(node.ref)
            self.writer.add_way(w)

    def relation(self, r: osm.osm.Relation) -> None:
        """Write a relation if it's in the dependency list."""
        if r.id in self.deps.relation_ids:
            self.writer.add_relation(r)


class AreaMaskBuilder(osm.SimpleHandler):
    """
    Builds a geometry mask from all closed ways and areas in a file.
    """
    def __init__(self):
        super(AreaMaskBuilder, self).__init__()
        self.wkt_factory = osmium.geom.WKTFactory()
        self.geometries: List[BaseGeometry] = []

    def way(self, w: osm.osm.Way) -> None:
        if w.is_closed():
            try:
                geom = loads(self.wkt_factory.create_multipolygon(w))
                self.geometries.append(geom)
            except Exception:
                logger.debug(f"Could not create geometry for way {w.id}")

    def area(self, a: osm.osm.Area) -> None:
        try:
            geom = loads(self.wkt_factory.create_multipolygon(a))
            self.geometries.append(geom)
        except Exception:
            logger.debug(f"Could not create geometry for area {a.id}")


class AreaFilter(osm.SimpleHandler):
    """
    Filters OSM data, removing areas that intersect with a given mask.
    """
    def __init__(self, writer: osmium.io.Writer, mask: Any):
        super(AreaFilter, self).__init__()
        self.writer = writer
        self.mask = prep(mask)
        self.wkt_factory = osmium.geom.WKTFactory()

    def node(self, n: osm.osm.Node) -> None:
        self.writer.add_node(n)

    def way(self, w: osm.osm.Way) -> None:
        # Only write ways that are not closed (i.e., not areas)
        # Closed ways will be handled by the area handler.
        if not w.is_closed():
            self.writer.add_way(w)

    def relation(self, r: osm.osm.Relation) -> None:
        # Only write relations that are not multipolygons
        if r.tags.get('type') != 'multipolygon':
            self.writer.add_relation(r)

    def area(self, a: osm.osm.Area) -> None:
        try:
            geom = loads(self.wkt_factory.create_multipolygon(a))
            if not self.mask.intersects(geom):
                # This is a bit of a workaround. The area object `a` doesn't
                # contain the original way/relation, so we have to write its
                # members. Osmium writer will reconstruct the object.
                if a.from_way():
                    self.writer.add_way(a.orig_way())
                else:
                    self.writer.add_relation(a.orig_relation())
        except Exception:
            logger.debug(f"Could not create geometry for area based on object {a.orig_id()}, skipping mask check.")


def filter_osm(args: argparse.Namespace) -> None:
    """
    This function contains the core logic for the 'filter' subcommand.
    It reads an OSM file, filters objects based on tags or actions, and writes the result.
    """

    # --- Logging Setup ---
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    if not (args.tag_key and args.tag_value) and not args.include_actions:
        logger.error("You must specify either a tag/value combination or actions to include.")
        sys.exit(1)

    input_file = args.patch
    output_file = args.output

    if not os.path.exists(input_file):
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    if os.path.exists(output_file):
        if not args.force:
            logger.warn(f"Output file '{output_file}' already exists. Use -f or --force to overwrite.")
            return
        os.remove(output_file)

    # --- Pass 1: Collect Dependencies ---
    logger.info("--- Pass 1: Collecting matching objects and their dependencies ---")
    dep_collector = DependencyCollector(args.tag_key, args.tag_value, args.include_actions)
    
    # Use an index to handle dependencies. 'flex_mem' is a good default.
    # locations=True is needed to access node locations for ways/relations.
    dep_collector.apply_file(input_file, locations=True, idx='flex_mem')

    logger.info(f"Found {len(dep_collector.node_ids)} nodes, {len(dep_collector.way_ids)} ways, and {len(dep_collector.relation_ids)} relations to include.")

    if not any([dep_collector.node_ids, dep_collector.way_ids, dep_collector.relation_ids]):
        logger.warning("No matching objects found. Skipping file write.")
        return

    # --- Pass 2: Write Filtered Data ---
    logger.info(f"--- Pass 2: Writing selected objects to {output_file} ---")
    
    # Create a writer. The file format is determined from the file extension.
    writer = osm.SimpleWriter(output_file)

    # The DataWriter handler will write the collected objects.
    data_writer = DataWriter(writer, dep_collector)

    # Apply the writer handler to the input file again.
    # locations=True is needed again to reconstruct geometries.
    data_writer.apply_file(input_file, locations=True, idx='flex_mem')

    writer.close()
    logger.info("--- Filtering complete. ---")


def merge_osm(args: argparse.Namespace) -> None:
    """
    This function contains the core logic for the 'merge' subcommand.
    It removes areas from a base file that are covered by a patch file.
    """
    # --- Logging Setup ---
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    if not os.path.exists(args.patch):
        logger.error(f"Patch file not found: {args.patch}")
        sys.exit(1)
    if not os.path.exists(args.base):
        logger.error(f"Base file not found: {args.base}")
        sys.exit(1)
    if os.path.exists(args.output) and not args.force:
        logger.error(f"Output file '{args.output}' already exists. Use -f or --force to overwrite.")
        sys.exit(1)

    # --- Step 1: Build mask from patch file ---
    logger.info(f"--- Step 1: Building mask from {args.patch} ---")
    mask_builder = AreaMaskBuilder()
    mask_builder.apply_file(args.patch, locations=True, idx='flex_mem')

    if not mask_builder.geometries:
        logger.warning("No closed ways or areas found in patch file to build a mask. The base file will not be filtered.")
        mask = unary_union([]) # empty geometry
    else:
        logger.info(f"Found {len(mask_builder.geometries)} areas/closed ways in patch file.")
        mask = unary_union(mask_builder.geometries)

    # --- Step 2: Filter base file ---
    logger.info(f"--- Step 2: Filtering areas from {args.base} ---")
    filtered_base_path = "filtered_base_temp.osm.pbf"
    writer = osmium.io.Writer(filtered_base_path)
    area_filter = AreaFilter(writer, mask)
    area_filter.apply_file(args.base, locations=True, idx='flex_mem')
    writer.close()
    logger.info(f"Filtered base file written to {filtered_base_path}")

    # --- Step 3: Merge patch and filtered base ---
    logger.info(f"--- Step 3: Merging patch and filtered base into {args.output} ---")
    merge_command = [
        "osmium", "merge",
        args.patch,
        filtered_base_path,
        "-o", args.output, "--overwrite"
    ]
    try:
        subprocess.run(merge_command, check=True, capture_output=True, text=True)
        logger.info("Merge complete.")
    except subprocess.CalledProcessError as e:
        logger.error(f"Osmium merge failed: {e.stderr}")
    finally:
        if os.path.exists(filtered_base_path):
            os.remove(filtered_base_path)


def main() -> None:
    # --- Main Argument Parser ---
    parser = argparse.ArgumentParser(
        description="A tool for filtering and manipulating OSM files.",
        formatter_class=argparse.RawTextHelpFormatter
    )

    subparsers = parser.add_subparsers(dest='command', help='Available subcommands', required=True)

    # --- Filter Subcommand Parser ---
    filter_parser = subparsers.add_parser(
        'filter',
        help='Filters an OSM file to extract objects and their dependencies.',
        description='Extracts objects from an OSM file based on specific criteria (tags or actions) and includes all their dependent objects (e.g., nodes for ways, members for relations).',
        add_help=False
    )
    filter_parser.add_argument('-p', '--patch', required=True, help="The input OSM file (e.g., from JOSM). Can be .osm (XML) or .pbf.")
    filter_parser.add_argument('-o', '--output', required=True, help="The path for the output .osm file.")
    filter_parser.add_argument('--tag-key', help="The tag key to filter features by (e.g., 'highway').")
    filter_parser.add_argument('--tag-value', help="The tag value to filter features by (e.g., 'residential').")
    filter_parser.add_argument('--include-actions', help="A comma-separated list of actions to include (e.g., 'modify,create,delete').")
    filter_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    # Add global arguments to the subparser as well, so they can be used anywhere
    filter_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")
    filter_parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help='Show this help message and exit.')

    # --- Merge Subcommand Parser ---
    merge_parser = subparsers.add_parser('merge', help='Merges a patch into a base file, removing overlapping areas.')
    merge_parser.add_argument('--patch', required=True, help="The patch file containing new/updated features.")
    merge_parser.add_argument('--base', required=True, help="The base file to be filtered. Can be .osm, .pbf, etc.")
    merge_parser.add_argument('-o', '--output', required=True, help="The path for the final merged output file.")
    merge_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    merge_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")
    merge_parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help='Show this help message and exit.')

    args = parser.parse_args()

    if args.command == 'filter':
        filter_osm(args)
    elif args.command == 'merge':
        merge_osm(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()