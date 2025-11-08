import osmium as osm
from shapely.geometry import shape, mapping
from shapely.prepared import prep
from shapely.wkt import loads
import subprocess
from shapely.ops import unary_union # Used for combining geometries
from shapely.geometry import Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon

# --- Configuration ---
TARGET_TAG_KEY = "meta"
TARGET_TAG_VALUE = "update" # <--- The tag to filter by
FILE1_PATH = "file1_dump.osm" # The original full dump to be filtered
FILE2_PATH = "file2_authoritative.osm" # The authoritative full dump (mask)
OUTPUT_FILTERED_FEATURES_PATH = "file1_filtered_features_temp.osm" # Temp output: ONLY non-overlapping meta=update features from file 1
OUTPUT_FINAL_MERGED_PATH = "final_merged.osm" # Final merged result

# --- Helper Function for Geometry Extraction ---

def get_geometry_from_feature(feature, wkt_factory):
    """Safely extracts geometry for any feature type."""
    geom = None
    try:
        if isinstance(feature, osm.Node):
            # Nodes are points
            wkt = wkt_factory.create_point(feature)
        elif isinstance(feature, osm.Way):
            # Ways can be lines or polygons (areas)
            if feature.is_area():
                wkt = wkt_factory.create_multipolygon(feature)
            else:
                wkt = wkt_factory.create_linestring(feature)
        elif isinstance(feature, osm.Relation):
            # Relations can also be areas (multipolygons)
            if 'type' in feature.tags and feature.tags['type'] == 'multipolygon':
                wkt = wkt_factory.create_multipolygon(feature)
            else:
                 # Skip other relation types for simple spatial filtering
                return None
        else:
            return None

        geom = loads(wkt)
    except Exception:
        # Handle invalid geometries
        return None
    return geom

# --- Step 1: Handler to build the "Erase Mask" from File 2 ---

class MaskBuilder(osm.SimpleHandler):
    """Reads File 2 and extracts geometries with the target tag."""
    def __init__(self, geom_list, tag_key, tag_value):
        super(MaskBuilder, self).__init__()
        self.geom_list = geom_list
        self.wkt_factory = osm.geom.WKTFactory()
        self.tag_key = tag_key
        self.tag_value = tag_value

    def filter_and_process(self, f):
        if f.tags.get(self.tag_key) == self.tag_value:
            geom = get_geometry_from_feature(f, self.wkt_factory)
            if geom:
                self.geom_list.append(geom)

    def node(self, n): self.filter_and_process(n)
    def way(self, w): self.filter_and_process(w)
    def relation(self, r): self.filter_and_process(r)
    # Area features are processed via the original Way/Relation calls
    def area(self, a): pass

# --- Step 2: Handler to filter File 1 using the Mask ---

class ConflationFilter(osm.SimpleHandler):
    """Reads File 1 and writes features only if they DON'T intersect with the mask."""
    def __init__(self, mask, writer, tag_key, tag_value):
        super(ConflationFilter, self).__init__()
        self.mask = prep(mask) # Use prep for faster intersection checks
        self.writer = writer
        self.wkt_factory = osm.geom.WKTFactory()
        self.tag_key = tag_key
        self.tag_value = tag_value

    def filter_and_process(self, f):
        # 1. Check if the feature has the target tag
        if f.tags.get(self.tag_key) == self.tag_value:

            # 2. Get geometry and perform spatial check
            geom = get_geometry_from_feature(f, self.wkt_factory)

            if geom:
                # 3. If it intersects the mask, skip writing it (i.e., remove it)
                if self.mask.intersects(geom):
                    return

            # 4. If it doesn't overlap or is a simple relation, KEEP it
            self.writer.add_item(f)

        # 5. All other features (without the target tag) are IGNORED by this handler
        # and will be handled by the Osmium filtering step later.

    def node(self, n): self.filter_and_process(n)
    def way(self, w): self.filter_and_process(w)
    def relation(self, r): self.filter_and_process(r)
    def area(self, a): pass # Area features are processed via the original Way/Relation calls


# --- Main Execution ---

if __name__ == "__main__":

    # Stage 1: Build the Erase Mask
    print(f"--- Stage 1: Building Erase Mask from {FILE2_PATH} (filtering for {TARGET_TAG_KEY}={TARGET_TAG_VALUE}) ---")

    geom_list = []
    builder = MaskBuilder(geom_list, TARGET_TAG_KEY, TARGET_TAG_VALUE)
    builder.apply(FILE2_PATH)

    # Combine all geometries into a single object for fast checking
    if not geom_list:
        print("No target features found in File 2. Cannot perform conflation.")
        exit(1)

    merged_mask = unary_union(geom_list)
    print(f"Found {len(geom_list)} features in File 2 for the mask.")

    # Stage 2: Filter File 1
    print(f"\n--- Stage 2: Filtering {FILE1_PATH} features ---")

    writer = osm.pbf.Writer(OUTPUT_FILTERED_FEATURES_PATH)
    conflator = ConflationFilter(merged_mask, writer, TARGET_TAG_KEY, TARGET_TAG_VALUE)
    conflator.apply(FILE1_PATH)
    writer.close()

    print(f"Non-conflicting features from File 1 saved to {OUTPUT_FILTERED_FEATURES_PATH}.")

    # Stage 3: Collision-Free Merge using Osmium (No ID Offsetting Required)

    # Step 3a: Filter out ALL features from the original File 1 that have the target tag.
    # We do this because the Python script's output *is* the filtered subset of these features.
    FILE1_NON_TARGET_FEATURES_PATH = "file1_non_target_features_temp.osm"

    # Note the use of "!=" to get everything that *does not* have the target tag.
    filter_command = [
        "osmium", "tags-filter", FILE1_PATH,
        f"n/{TARGET_TAG_KEY}!={TARGET_TAG_VALUE}",
        f"w/{TARGET_TAG_KEY}!={TARGET_TAG_VALUE}",
        f"r/{TARGET_TAG_KEY}!={TARGET_TAG_VALUE}",
        "-o", FILE1_NON_TARGET_FEATURES_PATH, "--overwrite"
    ]

    # Step 3b: Merge all three components:
    # 1. Original File 2 (authoritative)
    # 2. Filtered features from File 1 (non-overlapping meta=update)
    # 3. All non-target features from File 1 (everything else, safe from ID conflict with #2)
    merge_command = [
        "osmium", "merge",
        FILE2_PATH,
        OUTPUT_FILTERED_FEATURES_PATH,
        FILE1_NON_TARGET_FEATURES_PATH,
        "-o", OUTPUT_FINAL_MERGED_PATH, "--overwrite"
    ]

    try:
        print("\n--- Stage 3a: Isolating non-target features from File 1 using Osmium ---")
        subprocess.run(filter_command, check=True)
        print(f"Isolated non-target features saved to {FILE1_NON_TARGET_FEATURES_PATH}.")

        print("\n--- Stage 3b: Merging all components using Osmium ---")
        subprocess.run(merge_command, check=True)
        print(f"Successfully merged files into {OUTPUT_FINAL_MERGED_PATH}. Conflation complete.")

    except FileNotFoundError:
        print("\nERROR: 'osmium' command not found. Please install the Osmium command line tool.")
    except subprocess.CalledProcessError as e:
        print(f"ERROR during Osmium step: {e}")
