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

from osmium.osm.mutable import create_mutable_node, create_mutable_way, create_mutable_relation
from typing import Set, List, Optional, Any, Tuple, Dict, Union
from shapely.geometry import Polygon

# --- Logger Setup ---
logger = logging.getLogger("osm_filter")

# --- Classses ---
class IDChanger(osmium.SimpleHandler):
    """
    Handler to write OSM objects to a new file, changing their IDs to positive values.
    """
    def __init__(self, writer):
        super(IDChanger, self).__init__()
        self.writer = writer

    def node(self, n):
        new_node = create_mutable_node(n)
        new_node.id = n.id * -1
        logger.debug(f"Changing node ID from {n.id} to {new_node.id}")
        self.writer.add_node(new_node)
        
    def way(self, w):
        new_way = create_mutable_way(w)
        new_way.id = w.id * -1
        new_way.nodes = None
        refs = []
        for r in w.nodes:
            r.ref = r.ref * -1
            refs.append(r)
        new_way.nodes = refs
        logger.debug(f"Changing way ID from {w.id} to {new_way.id}")
        self.writer.add_way(new_way)

    def relation(self, r):
        new_relation = create_mutable_relation(r)
        new_relation.id = r.id * -1
        logger.debug(f"Changing relation ID from {r.id} to {new_relation.id}")
        self.writer.add_relation(new_relation)

class BoundingBoxHandler(osmium.SimpleHandler):
    """Calculates the bounding box of all nodes in an OSM file."""
    def __init__(self):
        super(BoundingBoxHandler, self).__init__()
        self.min_lon, self.min_lat = 180.0, 90.0
        self.max_lon, self.max_lat = -180.0, -90.0

    def node(self, n: osmium.osm.Node) -> None:
        self.min_lon = min(self.min_lon, n.location.lon)
        self.min_lat = min(self.min_lat, n.location.lat)
        self.max_lon = max(self.max_lon, n.location.lon)
        self.max_lat = max(self.max_lat, n.location.lat)

class DependencyCollector(osmium.SimpleHandler):
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

    def is_match(self, elem: osmium.osm.OSMObject) -> bool:
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

    def node(self, n: osmium.osm.Node) -> None:
        """Process a node."""
        if self.is_match(n):
            logger.debug(f"Matching node found: {n.id}")
            self.node_ids.add(n.id)

    def way(self, w: osmium.osm.Way) -> None:
        """Process a way."""
        if self.is_match(w):
            logger.debug(f"Matching way found: {w.id}")
            self.way_ids.add(w.id)
            for node in w.nodes:
                self.node_ids.add(node.ref)

    def relation(self, r: osmium.osm.Relation) -> None:
        """Process a relation."""
        if self.is_match(r):
            logger.debug(f"Matching relation found: {r.id}")
            self._collect_relation_dependencies(r)

    def _collect_relation_dependencies(self, relation: osmium.osm.Relation) -> None:
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


class DataWriter(osmium.SimpleHandler):
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

    def node(self, n: osmium.osm.Node) -> None:
        """Write a node if it's in the dependency list."""
        if n.id in self.needed_node_ids:
            self.writer.add_node(n)

    def way(self, w: osmium.osm.Way) -> None:
        """Write a way if it's in the dependency list, and collect its nodes."""
        if w.id in self.deps.way_ids:
            # This way is needed, so all its nodes are also needed.
            for node in w.nodes:
                self.needed_node_ids.add(node.ref)
            self.writer.add_way(w)

    def relation(self, r: osmium.osm.Relation) -> None:
        """Write a relation if it's in the dependency list."""
        if r.id in self.deps.relation_ids:
            self.writer.add_relation(r)

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

    logger.info("--- Pass 1: Collecting matching objects and their dependencies ---")
    dep_collector = DependencyCollector(args.tag_key, args.tag_value, args.include_actions)
    
    dep_collector.apply_file(input_file, locations=True, idx='flex_mem')

    logger.info(f"Found {len(dep_collector.node_ids)} nodes, {len(dep_collector.way_ids)} ways, and {len(dep_collector.relation_ids)} relations to include.")

    if not any([dep_collector.node_ids, dep_collector.way_ids, dep_collector.relation_ids]):
        logger.warning("No matching objects found. Skipping file write.")
        return

    logger.info(f"--- Pass 2: Writing selected objects to {output_file} ---")
    writer = osmium.SimpleWriter(output_file)
    data_writer = DataWriter(writer, dep_collector)
    data_writer.apply_file(input_file, locations=True, idx='flex_mem')
    writer.close()
    logger.info("--- Filtering complete. ---")


def bbox_tiles_osm(args: argparse.Namespace) -> None:
    """
    This function contains the core logic for the 'tile-info' subcommand.
    It calculates the bounding box of nodes in an OSM file and finds all
    intersecting slippy map tiles up to a given zoom level.
    """
    # --- Logging Setup ---
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    input_file = args.input
    output_file = args.output
    max_zoom = args.max_zoom

    if not os.path.exists(input_file):
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    # --- Step 1: Calculate Bounding Box ---
    logger.info(f"--- Step 1: Calculating bounding box from {input_file} ---")
    bbox_handler = BoundingBoxHandler()
    bbox_handler.apply_file(input_file, locations=True)

    min_lon, min_lat = bbox_handler.min_lon, bbox_handler.min_lat
    max_lon, max_lat = bbox_handler.max_lon, bbox_handler.max_lat

    if min_lon > max_lon:
        logger.error("No nodes found in input file. Cannot calculate bounding box.")
        sys.exit(1)

    logger.info(f"Bounding box found: [{min_lon}, {min_lat}, {max_lon}, {max_lat}]")

    # --- Step 2: Calculate Tiles ---
    logger.info(f"--- Step 2: Calculating tiles up to zoom level {max_zoom} ---")
    tiles = []
    for zoom in range(max_zoom + 1):
        top_left_x, top_left_y = deg_to_tile_num(max_lat, min_lon, zoom)
        bottom_right_x, bottom_right_y = deg_to_tile_num(min_lat, max_lon, zoom)

        for y in range(top_left_y, bottom_right_y + 1):
            # Handle antimeridian crossing
            if top_left_x > bottom_right_x:
                # Bbox crosses the antimeridian, so we have two ranges for x
                # Range 1: from top_left_x to the world edge
                for x in range(top_left_x, 2**zoom):
                    tiles.append([zoom, x, y])
                # Range 2: from the world start to bottom_right_x
                for x in range(0, bottom_right_x + 1):
                    tiles.append([zoom, x, y])
            else:
                # Normal case, single range for x
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

def geojson_to_poly(geojson_input):
    """
    Converts GeoJSON data (either a dictionary or a string) into the 
    Osmosis .poly file format string, handling multiple disjoint polygons correctly.

    Args:
        geojson_input (dict or str): The GeoJSON data as a dictionary or a JSON string.

    Returns:
        str: The contents of the generated .poly file as a string, or None on error.
    """
    
    if not isinstance(geojson_input, dict):
        logger.error("Invalid input type. Must be a dictionary or a string.")
        return None
    geojson_string = json.dumps(geojson_input)
    
    try:
        gdf = geopandas.read_file(io.StringIO(geojson_string), use_arrow=True)
    except Exception as e:
        logger.error(f"Error reading GeoJSON data: {e}")
        return None

    if not gdf.empty:
        exclusion_area_geom = gdf.dissolve(by=None).iloc[0].geometry
    else:
        logger.error("GeoJSON data was empty or contained no valid geometries.")
        return None

    poly_lines = []
    poly_lines.append("ExclusionZone")
    
    def write_poly_coords_to_list(poly_geom, ring_id, lines_list):
        lines_list.append(f"!{ring_id}") 
        for coord in poly_geom.exterior.coords:
            lines_list.append(f"  {coord[0]} {coord[1]}")
        lines_list.append("END")

    # Iterate through polygons if it's a MultiPolygon, or handle a single Polygon
    if exclusion_area_geom.geom_type == 'MultiPolygon':
        for i, poly in enumerate(exclusion_area_geom.geoms):
            # i+1 ensures unique ring IDs for each disjoint polygon
            write_poly_coords_to_list(poly, i + 1, poly_lines)
    elif exclusion_area_geom.geom_type == 'Polygon':
        # Single polygon case
        write_poly_coords_to_list(exclusion_area_geom, 1, poly_lines)
    else:
        print(f"Unsupported geometry type found: {exclusion_area_geom.geom_type}")
        return None
        
    poly_lines.append("END") # Final END marker for the entire file/set
    
    return "\n".join(poly_lines)

def osm_file_to_geojson(input_file_path: str) -> str:
    geojson_factory = osmium.geom.GeoJSONFactory()
    def create_feature(osm_object: Union[osmium.osm.Node, osmium.osm.Way, osmium.osm.Area], geometry_type: str):
        try:
            logger.debug(osm_object)
            if geometry_type == 'point':
                geometry_str = geojson_factory.create_point(osm_object.location)
            elif geometry_type == 'linestring':
                geometry_str = geojson_factory.create_linestring(osm_object.nodes)
            elif geometry_type == 'polygon':
                gjson = json.loads(geojson_factory.create_linestring(o.nodes))
                if (gjson["coordinates"][0] == gjson["coordinates"][-1]):
                    gjson["type"] = "Polygon"
                    gjson["coordinates"] = [gjson["coordinates"]]
            
                envelope = {"type": "Feature",
                            "geometry":gjson,
                            "properties": {}}
                geometry_str = json.dumps(envelope)
            elif geometry_type == 'multipolygon':
                geometry_str = geojson_factory.create_multipolygon(osm_object)
            else:
                return

            geometry = json.loads(geometry_str)
            
            properties = dict(osm_object.tags)
            properties['_id'] = osm_object.id
            
            feature = {
                'type': 'Feature',
                'id': osm_object.id,
                'geometry': geometry,
                'properties': properties
            }
            return feature

        except RuntimeError as e:
            logger.error(f"Failed to create GeoJSON feature: {e}")
            raise e

    logger.debug(f"Starting new JSON file generator")
    features = []

    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf",) as temp:
        with osmium.SimpleWriter(temp.name, overwrite=True) as writer:
            handler = IDChanger(writer)
            osmium.apply(input_file_path, handler)
            writer.close()

        for o in osmium.FileProcessor(temp.name).with_areas().with_locations():
            logger.debug(f"Generating {o.type_str()} filter primitive for {o.type_str()}, id: {o.id}")
            if o.is_node():
                if len(o.tags) > 0:
                    features.append(create_feature(o, 'point'))
            if o.is_way() and not o.is_closed():
                if not o.is_area():
                    features.append(create_feature(o, 'linestring'))
            # if o.is_way() and o.is_closed():
            #     features.append(create_feature(o, 'polygon'))
            elif o.is_area():
                features.append(create_feature(o, 'multipolygon'))
            else:
                continue
            
        geojson_data = {
            'type': 'FeatureCollection',
            'features': features
        }
        return geojson_data

def merge_cmd (args: argparse.Namespace) -> None:
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    base_file = args.input
    patch = args.patch
    output_file = args.output
    overwrite = args.force
    merge (base_file, patch, output_file, overwrite)

def merge (base_file, patch, output_file, overwrite) -> None:

    class IntersectionHandler(osmium.SimpleHandler):
        """
        Handler to identify ways in an OSM file that intersect with a given set of polygons.
        """
        def __init__(self, target_polygons):
            super(IntersectionHandler, self).__init__()
            self.target_polygons = target_polygons
            self.wkbfactory = osmium.geom.WKBFactory()
            self.intersecting_ways = []
            
        #TODO: Check if we also need to remove nodes
        def way(self, w):

            if w.is_closed():
                try:
                    wkb_line = self.wkbfactory.create_linestring(w)
                    shapely_line = shapely.from_wkb(wkb_line)
                    
                    if len(shapely_line.coords) >= 4:
                        closed_way_polygon = Polygon(shapely_line)
                        
                        for target_poly in self.target_polygons:
                            if closed_way_polygon.intersects(target_poly):
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
        A filter class for osmium.FileProcessor to exclude objects based on their IDs, see https://github.com/osmcode/pyosmium/issues/310
        """
        def __init__(self, ids):
            self.ids = ids

        def node(self, n):
            if n.id in self.ids:
                return True
            return False
        
        def way(self, w):
            if w.id in self.ids:
                return True
            return False
            
        def relation(self, r):
            if r.id in self.ids:
                return True
            return False

        def area(self, a):
            if a.id in self.ids:
                return True
            return False

    logger.info("Generating mask and appying it to the input file.")
    # Step 1: Process the patch file to change IDs to positive and extract polygons.
    # This temporary file will hold the patch with inverted IDs.
 
    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf",) as temp:
        with osmium.SimpleWriter(temp.name, overwrite=True) as writer:
            handler = IDChanger(writer)
            osmium.apply(patch, handler)
            writer.close()
        wkbfab = osmium.geom.WKBFactory()
        polygons = []
        # Read the transformed patch file to extract geometries for exclusion.
        with open(temp.name, 'rb') as f:
            patch_buffer = f.read()
            patch_pbf = osmium.io.FileBuffer(patch_buffer, "pbf")
            for o in osmium.FileProcessor(patch_pbf).with_areas():
                logger.debug(f"Generating {o.type_str()} filter primitive for {o.type_str()}, id: {o.id}")
                if o.is_way() and not o.is_closed():
                    wkb = shapely.from_wkb(wkbfab.create_linestring(o.nodes))
                elif o.is_area():
                    logger.debug(f"Area: {o.__dict__}")
                    wkb = shapely.from_wkb(wkbfab.create_multipolygon(o))
                else:
                    wkb = None
                polygons.append(wkb)
    # Filter out any None values from the polygons list (e.g., non-closed ways, nodes, relations)
    polygons = [item for item in polygons if item is not None]
    logger.info(f"Extracted {len(polygons)} polygons to use as filter.")
    # Step 2: Identify ways in the base file that intersect with the extracted polygons.
    handler = IntersectionHandler(polygons)
    handler.apply_file(base_file, locations=True, idx='flex_mem')
    results = handler.intersecting_ways

    # Collect IDs of ways to be excluded from the base file.
    ids = []
    for i in results:
        ids.append(i['id'])
    logger.debug(ids)

    # Step 3: Create a temporary base file with intersecting ways removed.
    with tempfile.NamedTemporaryFile(mode='w+t', delete=True, suffix=".pbf") as temp:
        with osmium.BackReferenceWriter(temp.name, base_file, overwrite=True) as writer:
            for o in osmium.FileProcessor(base_file)\
                .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))\
                .with_filter(ExcludingIdFilter(ids)):
                writer.add(o)
        logger.info(f"Generated masked file. Applying patch. Overwrite: {overwrite}")
        # Step 4: Merge the filtered base file with the transformed patch file.
        with open(temp.name, 'rb') as f:
            with osmium.SimpleWriter(output_file, overwrite=overwrite) as writer:
                reader =  osmium.MergeInputReader()
                reader.add_buffer(patch_buffer, "pbf")
                reader.add_buffer(f.read(), "pbf")
                reader.apply(writer)
                writer.close()
    logger.info(f"Done, {output_file} written")


def ways_to_polygons(args: argparse.Namespace) -> None:
    """
    This function contains the core logic for the 'ways-to-polygons' subcommand.
    It reads an OSM file and converts all closed ways to GeoJSON polygons.
    """
    # --- Logging Setup ---
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format='%(asctime)s - %(levelname)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

    input_file = args.input
    output_file = args.output
    format = args.format

    if not os.path.exists(input_file):
        logger.error(f"Input file not found: {input_file}")
        sys.exit(1)

    geojson = osm_file_to_geojson(input_file)
    if format == 'geojson':
        with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
            json.dump(geojson, f, indent=2)
    elif format == 'poly':
        poly = geojson_to_poly(geojson)
        with open(output_file, 'w') if output_file != '-' else sys.stdout as f:
            f.write(poly)


    logger.info("--- Polygons file created successfully. ---")

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
    filter_parser.add_argument('--tag-key', default="upload", help="The tag key to filter features by (e.g., 'highway').")
    filter_parser.add_argument('--tag-value', default="false", help="The tag value to filter features by (e.g., 'residential').")
    filter_parser.add_argument('--include-actions', help="A comma-separated list of actions to include (e.g., 'modify,create,delete').")
    filter_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    # Add global arguments to the subparser as well, so they can be used anywhere
    filter_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- patch Subcommand Parser ---
    patch_parser = subparsers.add_parser(
        'patch',
        help='Calculates a bounding box and intersecting tiles from an OSM file. Use tile-info for backward compatibility',
        description='Reads an OSM file, calculates the bounding box of all nodes, and outputs a GeoJSON file containing the bbox as a polygon and a list of intersecting slippy map tiles.'
    )
    patch_parser.add_argument('-i', '--input', required=True, help="The input OSM file (e.g., from JOSM).")
    patch_parser.add_argument('-p', '--patch', required=True, help="The path for patch OSM file to be applied.")
    patch_parser.add_argument('-o', '--output', required=True, help="The path for the output file.")
    patch_parser.add_argument('-f', '--force', action='store_true', help="Overwrite output file if it exists.")
    patch_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- tile-info Subcommand Parser ---
    bbox_parser = subparsers.add_parser(
        'tile-info',
        help='Calculates a bounding box and intersecting tiles from an OSM file. Use tile-info for backward compatibility',
        description='Reads an OSM file, calculates the bounding box of all nodes, and outputs a GeoJSON file containing the bbox as a polygon and a list of intersecting slippy map tiles.'
    )
    bbox_parser.add_argument('-i', '--input', required=True, help="The input OSM file (e.g., from JOSM).")
    bbox_parser.add_argument('-o', '--output', required=True, help="The path for the output GeoJSON file.")
    bbox_parser.add_argument('--max-zoom', type=int, default=16, help="Maximum zoom level to calculate tiles for (default: 16).")
    bbox_parser.add_argument('-v', '--verbose', action='store_true', help="Enable verbose (DEBUG) logging.")

    # --- Ways-to-Polygons Subcommand Parser ---
    w2p_parser = subparsers.add_parser(
        'ways-to-polygons',
        help='Converts all closed ways in an OSM file to polygons.',
        description='Reads an OSM file and converts all closed ways into polygons.'
    )
    w2p_parser.add_argument('-i', '--input', required=True, help="The input OSM file (e.g., from JOSM).")
    w2p_parser.add_argument('-o', '--output', required=True, help="The path for the output GeoJSON file. Use '-' for stdout.")
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