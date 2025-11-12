import requests
import os
import math
import argparse
import logging
import json
from xml.etree import ElementTree
import pyproj

edge = 256
default_crs = "EPSG:3857"

# --- Logger Setup ---
logger = logging.getLogger(__name__)

# --- Constants ---
INITIAL_RESOLUTION = 156543.03392804097 # for 256x256 tiles at zoom 0

def get_resolution(zoom):
    """Calculates the resolution for a given zoom level."""
    return INITIAL_RESOLUTION / (2 ** zoom)

def scale_to_zoom(scale_denominator):
    """Approximates a zoom level from a WMS scale denominator."""
    return math.log2(INITIAL_RESOLUTION / (scale_denominator * 0.00028))


# --- Tile Math Functions ---

def deg_to_tile_num(lat_deg, lon_deg, zoom):
    """Converts geographic coordinates to tile numbers."""
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)

def tile_num_to_deg(xtile, ytile, zoom):
    """Converts tile numbers to the longitude/latitude of the top-left corner."""
    n = 2.0 ** zoom
    lon_deg = xtile / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * ytile / n)))
    lat_deg = math.degrees(lat_rad)
    return (lat_deg, lon_deg)

def get_wms_capabilities(base_url):
    """Fetches and parses the WMS GetCapabilities XML."""
    params = {
        'SERVICE': 'WMS',
        'REQUEST': 'GetCapabilities',
        'VERSION': '1.3.0' # Request a common version
    }
    try:
        response = requests.get(base_url, params=params, timeout=30)
        response.raise_for_status()
        logger.debug("WMS Capabilities XML:\n%s", response.text)
        return ElementTree.fromstring(response.content)
    except requests.exceptions.RequestException as e:
        logger.error(f"Error fetching capabilities: {e}")
        return None

def find_path_to_node(root, target_node, current_path=None):
    """
    Recursively finds the path from the root Element to the target_node.
    Returns a list of Elements representing the path (including root and target_node)
    if found, otherwise None.
    """
    if current_path is None:
        current_path = []
    
    # If the current root is the target node, we've found it.
    if root == target_node:
        return current_path + [root]
    
    # Recursively search in children
    for child in root:
        path = find_path_to_node(child, target_node, current_path + [root])
        if path:
            return path
    return None # Target not found in this branch or its children

def list_wms_layers(wms_url):
    """Fetches and lists all layers from a WMS endpoint for debugging."""
    logger.info(f"Fetching layers from {wms_url}...")
    capabilities_root = get_wms_capabilities(wms_url)
    if capabilities_root is None:
        return

    # Namespace handling for parsing WMS capabilities
    ns = {
        'wms': capabilities_root.tag.split('}')[0][1:]
    }

    # Get the default supported CRS from the service capabilities
    default_supported_crss = []
    for crs_node in capabilities_root.findall('.//wms:Capability/wms:Layer/wms:CRS', ns):
        default_supported_crss.append(crs_node.text)

    default_supported_crss = list(set(default_supported_crss)) # Remove duplicates

    # Find all layer elements, including nested ones
    layers = capabilities_root.findall('.//wms:Layer', ns)

    if not layers:
        logger.warning("No layers found at the specified endpoint.")
        return

    print("\nAvailable Layers:")
    print("-----------------------------------")
    for layer in layers:
        name_node = layer.find('wms:Name', ns)
        title_node = layer.find('wms:Title', ns)
        if name_node is not None and name_node.text:
            name = name_node.text
            title = title_node.text if title_node is not None and title_node.text else "No title"
            print(f"  - Name: {name}\n    Title: {title}\n")

def get_min_max_zoom_from_capabilities(layer_node, ns):
    """
    Approximates min/max zoom levels from the layer's scale denominators.
    Returns a tuple (min_zoom, max_zoom) or (None, None) if not found.
    """
    min_scale_node = layer_node.find('wms:MinScaleDenominator', ns)
    max_scale_node = layer_node.find('wms:MaxScaleDenominator', ns)

    min_zoom = None
    max_zoom = None

    # Note: MaxScaleDenominator corresponds to min_zoom (most zoomed out)
    # and MinScaleDenominator corresponds to max_zoom (most zoomed in).
    if max_scale_node is not None and max_scale_node.text:
        try:
            min_zoom = int(round(scale_to_zoom(float(max_scale_node.text))))
        except (ValueError, TypeError):
            logger.warning("Could not parse MaxScaleDenominator.")
    if min_scale_node is not None and min_scale_node.text:
        try:
            max_zoom = int(round(scale_to_zoom(float(min_scale_node.text))))
        except (ValueError, TypeError):
            logger.warning("Could not parse MinScaleDenominator.")

    return (min_zoom, max_zoom)

def create_tilejson_from_context(output_filename, layer_name, bbox, zoom_levels):
    """Creates a TileJSON file from the given context, pointing to local files."""
    logger.info(f"Creating TileJSON file...")

    # Construct the local tile URL template
    # Assuming the TileJSON file is at the root of the tile directory structure
    tile_url = f"/{{z}}/{{x}}/{{y}}.png"

    min_zoom, max_zoom = zoom_levels if zoom_levels else (None, None)

    tilejson = {
        "tilejson": "2.2.0",
        "name": layer_name,
        "tiles": [tile_url],
        "scheme": "xyz"
    }

    if bbox:
        tilejson["bounds"] = bbox
    if min_zoom is not None:
        tilejson["minzoom"] = min_zoom
    if max_zoom is not None:
        tilejson["maxzoom"] = max_zoom

    # Ensure the output directory exists
    output_dir = os.path.dirname(output_filename)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    with open(output_filename, 'w') as f:
        json.dump(tilejson, f, indent=2)
    logger.info(f"TileJSON file created at '{output_filename}'")


def download_wms_tiles(wms_url, layer_name, bbox, output_dir, zoom_levels):
    """Downloads WMS tiles for a given layer, bbox, and zoom levels."""
    logger.info("Fetching WMS capabilities...")
    capabilities_root = get_wms_capabilities(wms_url)
    if capabilities_root is None:
        return

    # Namespace handling for parsing WMS capabilities
    ns = {
        'wms': capabilities_root.tag.split('}')[0][1:]
    }

    # Find the requested layer
    layer_node = capabilities_root.find(f".//wms:Layer[wms:Name='{layer_name}']", ns)
    if layer_node is None:
        logger.error(f"Error: Layer '{layer_name}' not found in capabilities.")
        return

    # If zoom levels are not provided, try to discover them.
    if zoom_levels is None:
        logger.info("Zoom levels not specified. Attempting to discover from capabilities...")
        min_zoom_cap, max_zoom_cap = get_min_max_zoom_from_capabilities(layer_node, ns)

        if min_zoom_cap is not None and max_zoom_cap is not None:
            zoom_levels = (min_zoom_cap, max_zoom_cap)
            logger.info(f"Discovered zoom range: {min_zoom_cap}-{max_zoom_cap}")
        else:
            # Fallback to a default range if discovery fails
            zoom_levels = (0, 18)
            logger.warning(f"Could not determine zoom range from capabilities. Defaulting to {zoom_levels[0]}-{zoom_levels[1]}.")
            logger.warning("You can specify a range with the --zoom-levels flag (e.g., --zoom-levels 5-12).")

    
    # Check if the requested CRS is supported by the layer, inheriting from queryable parent layers.
    supported_crss = []
    
    supported_crss.extend([crs.text for crs in layer_node.findall('wms:CRS', ns)])

    # 2. Collect CRSs from queryable ancestors
    path_to_layer = find_path_to_node(capabilities_root, layer_node)
    if path_to_layer:
        # Iterate through ancestors (excluding the capabilities_root and the layer_node itself)
        for ancestor in path_to_layer[1:-1]:
            if ancestor.tag == f"{{{ns['wms']}}}Layer" and ancestor.get('queryable') == '1':
                crs_nodes = ancestor.findall('wms:CRS', ns)
                if crs_nodes:
                    supported_crss.extend([crs.text for crs in crs_nodes])
                    logger.debug(f"Found CRSs in queryable ancestor '{ancestor.find('wms:Name', ns).text if ancestor.find('wms:Name', ns) is not None else 'Unnamed'}'")
    

    # Remove duplicates and ensure unique CRSs
    supported_crss = list(set(supported_crss))
    logger.debug(f"Available CRSs: {', '.join(supported_crss)}")
    
    if args.crs not in supported_crss:
        logger.error(f"Error: CRS '{args.crs}' is not supported by layer '{layer_name}'.")
        logger.info(f"Supported CRS for this layer are: {', '.join(supported_crss)}")
        return
    logger.info(f"Proceeding with CRS: {args.crs}")

    # Create base output directory
    os.makedirs(output_dir, exist_ok=True)

    # Bounding box for filtering
    min_lon, min_lat, max_lon, max_lat = bbox

    # Reproject the bounding box to target CRS if needed
    # if args.crs != default_crs:
    #     transformer = pyproj.Transformer.from_crs(default_crs, args.crs, always_xy=True)
    #     min_lon, min_lat = transformer.transform(min_lon, min_lat)
    #     max_lon, max_lat = transformer.transform(max_lon, max_lat)
    #     logger.info(f"Reprojected bounding box to {args.crs}: {min_lon}, {min_lat}, {max_lon}, {max_lat}")

    # Loop through each specified zoom level
    for zoom in range(zoom_levels[0], zoom_levels[1] + 1):

        logger.info(f"Processing zoom level: {zoom}")

        # Calculate the tile range for the given bounding box at the current zoom level
        min_xtile, max_ytile = deg_to_tile_num(min_lat, min_lon, zoom)
        max_xtile, min_ytile = deg_to_tile_num(max_lat, max_lon, zoom)

        zoom_dir = os.path.join(output_dir, str(zoom))
        os.makedirs(zoom_dir, exist_ok=True)

        total_tiles = (max_xtile - min_xtile + 1) * (max_ytile - min_ytile + 1)
        logger.info(f"Found {total_tiles} tiles to download for this zoom level.")
        
        count = 0
        # Loop through the calculated tile range and download each tile
        for x in range(min_xtile, max_xtile + 1):
            x_dir = os.path.join(zoom_dir, str(x))
            os.makedirs(x_dir, exist_ok=True)
            for y in range(min_ytile, max_ytile + 1):
                count += 1
                # Calculate the bounding box for the current tile
                top_lat, left_lon = tile_num_to_deg(x, y, zoom)
                bottom_lat, right_lon = tile_num_to_deg(x + 1, y + 1, zoom)

                tile_bbox_str = f"{left_lon},{bottom_lat},{right_lon},{top_lat}"

                # Construct the GetMap request URL
                get_map_params = {
                    'SERVICE': 'WMS', 'VERSION': '1.3.0',
                    'REQUEST': 'GetMap',
                    'LAYERS': layer_name,
                    'STYLES': '',
                    'BBOX': tile_bbox_str,
                    'WIDTH': edge,
                    'HEIGHT': edge,
                    'FORMAT': 'image/png',
                    'CRS': args.crs
                }

                try:
                    # Prepare the request to log the full URL
                    prepared_request = requests.Request('GET', wms_url, params=get_map_params).prepare()
                    logger.info("Requesting tile URL: %s", prepared_request.url)

                    tile_response = requests.get(wms_url, params=get_map_params, timeout=15)
                    tile_response.raise_for_status()

                    # Save the tile
                    tile_path = os.path.join(x_dir, f"{y}.png")
                    with open(tile_path, 'wb') as f:
                        f.write(tile_response.content)
                    logger.debug(f"  ({count}/{total_tiles}) Downloaded tile: z={zoom}, x={x}, y={y} to {tile_path}")

                except requests.exceptions.RequestException as e:
                    logger.error(f"Error downloading tile z={zoom}, x={x}, y={y}: {e}")
        logger.info(f"Finished zoom level {zoom}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Download tiles from a WMS server for a given layer and bounding box.")
    parser.add_argument("wms_url", help="The base URL of the WMS endpoint (e.g., 'https://server.com/wms?').")
    parser.add_argument("--layer-name", type=str,
                        help="The name of the layer to download. (Not required if --list-layers is used)")
    parser.add_argument("--bbox", type=float, nargs=4, metavar=('MIN_LON', 'MIN_LAT', 'MAX_LON', 'MAX_LAT'),
                        help="The bounding box in decimal degrees: min_lon min_lat max_lon max_lat.")
    parser.add_argument("-o", "--output", default="tiles",
                        help="The output directory to save tiles. Default is 'tiles/'.")
    parser.add_argument("--list-layers", action="store_true",
                        help="List all available layers from the WMS endpoint and exit.")
    parser.add_argument("-f", "--force", action="store_true",
                        help="Force overwrite existing tiles.")
    parser.add_argument("--zoom-levels", type=str, default=None,
                        help="The range of zoom levels to download (e.g., '5-12'). If not specified, all available levels are downloaded.")
    parser.add_argument("--crs", type=str, default=default_crs,
                        help="The Coordinate Reference System (CRS) to use for GetMap requests. Default is 'EPSG:3857'.")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable verbose (DEBUG) logging.")
    parser.add_argument("--create-tilejson", nargs='?', const=True, default=None,
                        help="Create a TileJSON file for the specified layer and exit. If no filename is provided, 'tile.json' will be created in the output directory.")

    args = parser.parse_args()

    # Configure logging
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
    else:
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

    if args.list_layers:
        list_wms_layers(args.wms_url)
    elif args.layer_name and args.bbox: # args.bbox will be a list of 4 floats if provided
        zoom_levels = None
        if args.zoom_levels:
            try:
                min_zoom, max_zoom = map(int, args.zoom_levels.split('-'))
                if min_zoom > max_zoom:
                    raise ValueError("Min zoom must not be greater than max zoom.")
                zoom_levels = (min_zoom, max_zoom)
            except (ValueError, TypeError) as e:
                parser.error(f"Invalid zoom-levels format. Please use 'min-max'. Error: {e}")
        download_wms_tiles(args.wms_url, args.layer_name, args.bbox, args.output, zoom_levels)

        if args.create_tilejson is not None:
            if args.create_tilejson is True:
                # No filename provided, use default in output directory
                output_filename = os.path.join(args.output, 'tile.json')
            else:
                output_filename = args.create_tilejson
            if not args.layer_name:
                parser.error("--layer-name is required when using --create-tilejson.")
            zoom_levels = None
            if args.zoom_levels:
                try:
                    min_zoom, max_zoom = map(int, args.zoom_levels.split('-'))
                    if min_zoom > max_zoom:
                        raise ValueError("Min zoom must not be greater than max zoom.")
                    zoom_levels = (min_zoom, max_zoom)
                except (ValueError, TypeError) as e:
                    parser.error(f"Invalid zoom-levels format. Please use 'min-max'. Error: {e}")
            create_tilejson_from_context(output_filename, args.layer_name, args.bbox, zoom_levels)

        logger.info("Download complete.")


    else:
        parser.error("The following arguments are required for downloading: --layer-name and --bbox, or use --list-layers or --create-tilejson.")
