#!/usr/bin/env python3

import os
import sys
import subprocess
import shutil
import json
import argparse
from argparse import Namespace
import logging
from pathlib import Path
import docker
from json import dumps
import tarfile
import io
import sqlite3
import gzip
import atexit
from typing import List, Tuple, Union, Dict, Any
from itertools import combinations

# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------
DOCKER_IMAGE = "ghcr.io/cmahnke/map-tools/planetiler:latest"
DATA_IMAGE = "ghcr.io/cmahnke/map-data/goettingen:latest"
MAX_ZOOM = 16
BUILDING_LEVEL = 13
TILE_COMPRESSION = "none"
PLANETILER_OPTS = [
    "--fetch-wikidata",
    "--use_wikidata=true",
    "--osm_parse_node_bounds=true",
    "--exclude-layers=building,housenumber,aeroway"
]
DEFAULT_BBOX = "9.7,51.45,10.1,51.6"

# Directory settings
MAP_BASE_DIR = "./static/map"
COVERAGE = "goettingen"
COMPLETE_MAP_NAME = "never-built"
MASTER_TILE_NAME = "tiles"
CONTENT_PATH = "./content"

# Other fle stuff
PATCH_SUFFIX = "-patch.osm"

# Convert directories to Path objects
SCRIPT_DIR = Path(__file__).resolve().parent
TILES_DIR = (SCRIPT_DIR / ".." / MAP_BASE_DIR).resolve()
CONTENT_DIR = (SCRIPT_DIR / ".." / CONTENT_PATH).resolve()
MASTER_TILE_DIR = (SCRIPT_DIR / ".." / MAP_BASE_DIR / MASTER_TILE_NAME).resolve()
COMPLETE_MAP_DIR = (SCRIPT_DIR / ".." / MAP_BASE_DIR / COMPLETE_MAP_NAME).resolve()
MASTER_PBF = TILES_DIR / f"{COVERAGE}.osm.pbf"

logger = logging.getLogger("generate-3d-map")
import_paths = [str((SCRIPT_DIR / "../themes/projektemacher-base/scripts/").resolve()), str(SCRIPT_DIR)]
logger.info(f"Import paths: {', '.join(import_paths)}")

for p in import_paths:
    if p not in sys.path:
        sys.path.append(p)

from osm_tool import patch_cmd, tile_info_cmd, filter_cmd
from PyHugo import Content, Config, Post

# Initialize Docker client
if not os.environ.get("DOCKER_HOST"):
    rancher_sock = Path.home() / ".rd" / "docker.sock"
    if sys.platform == "darwin" and rancher_sock.exists():
        os.environ["DOCKER_HOST"] = f"unix://{rancher_sock}"

try:
    client = docker.from_env()
except Exception as e:
    logger.critical(f"Failed to initialize Docker client, is the daemon running?: {e}")
    sys.exit(1)

class GeoJSONProcessor:
    def __init__(self, path: Union[str, Path]):
        self.path = Path(path)
        with open(self.path, "r", encoding="utf-8") as f:
            self._data = json.load(f)
        self._feature = self._data["features"][0]

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        coordinates = self._feature["geometry"]["coordinates"]
        lons = [pt[0] for ring in coordinates for pt in ring]
        lats = [pt[1] for ring in coordinates for pt in ring]
        return (min(lons), min(lats), max(lons), max(lats))

    @property
    def all_tiles(self) -> List[List[int]]:
        return self._feature.get("properties", {}).get("tiles", [])

    @property
    def tiles(self) -> List[List[int]]:
        return [tile for tile in self.all_tiles if tile[0] >= BUILDING_LEVEL]

    def paths(self, level=BUILDING_LEVEL):
        tiles = [tile for tile in self.all_tiles if tile[0] >= level]
        for tile in tiles:
            logger.debug(f"Tile path: {'/'.join(map(str, tile))}")

def parse_year_arg(year_str: str) -> tuple[int, int]:
    """Parses a 4-digit year or year range 'YYYY-YYYY' into a (min_year, max_year) tuple."""
    if "-" in year_str:
        parts = year_str.split("-")
        if len(parts) != 2 or not (parts[0].isdigit() and parts[1].isdigit()):
            raise ValueError(f"Invalid year range format: '{year_str}'. Expected YYYY-YYYY.")
        start, end = int(parts[0]), int(parts[1])
        return (min(start, end), max(start, end))
    elif year_str.isdigit() and len(year_str) == 4:
        y = int(year_str)
        return (y, y)
    else:
        raise ValueError(f"Invalid year format: '{year_str}'. Expected 4-digit year or range YYYY-YYYY.")

def filter_results_by_year(results: List[Dict[str, Any]], year_arg: str) -> List[Dict[str, Any]]:
    """Filters processing results matching a single year or overlapping a year range."""
    target_min, target_max = parse_year_arg(year_arg)
    filtered = []

    for r in results:
        res_year = r.get("year")
        if res_year is None:
            continue

        try:
            # Result year can be int, string, or range string
            if isinstance(res_year, int):
                r_min = r_max = res_year
            else:
                r_min, r_max = parse_year_arg(str(res_year))

            # Check range overlap: max(start1, start2) <= min(end1, end2)
            if max(target_min, r_min) <= min(target_max, r_max):
                filtered.append(r)
        except ValueError as e:
            logger.warning(f"Skipping entry {r.get('path')} due to invalid year format: {e}")

    return filtered

def compact_generated_tiles(generated_dir: Path, master_dir: Path, valid_tiles: List[List[int]]):
    """
    Checks the generated tiles. If they are in valid_tiles, keep them.
    If not, remove them and create a relative symlink from the equivalent
    tile in master_dir to the position in the generated directory.
    """
    valid_set = {tuple(t) for t in valid_tiles}

    for root, _, files in os.walk(generated_dir):
        root_path = Path(root)
        for file in files:
            if file.endswith((".json", ".osm", ".geojson")):
                continue

            file_path = root_path / file

            try:
                # Assuming standard structure {z}/{x}/{y}.pbf
                y = int(file_path.stem)
                x = int(file_path.parent.name)
                z = int(file_path.parent.parent.name)
            except ValueError:
                continue

            if (z, x, y) not in valid_set:
                file_path.unlink()
                master_file = master_dir / str(z) / str(x) / file

                if master_file.exists():
                    rel_target = os.path.relpath(master_file, root_path)
                    file_path.symlink_to(rel_target)

def validate_and_extract_tiles(processing_results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # 1. Check for bounding box overlaps
    for r1, r2 in combinations(processing_results, 2):
        b1, b2 = r1["bbox"], r2["bbox"]

        if (b1[0] < b2[2] and b1[2] > b2[0] and
            b1[1] < b2[3] and b1[3] > b2[1]):
            raise RuntimeError(
                f"Bounding box overlap detected between {r1['path']} and {r2['path']}\n"
                f"Bbox 1: {b1}\nBbox 2: {b2}"
            )

    # 2. Extract tiles, check for overlaps, and attach tile_dir
    seen_tiles: Dict[Tuple, str] = {}
    output_tiles = []

    for result in processing_results:
        tile_dir = result.get("tile_dir")
        current_path = result.get("path")

        for tile in result.get("tile_levels", []):
            if tile[0] >= BUILDING_LEVEL:
                tile_key = tuple(tile)
                if tile_key in seen_tiles:
                    raise RuntimeError(
                        f"Tile overlap detected for tile {tile_key} between "
                        f"'{seen_tiles[tile_key]}' and '{current_path}'."
                    )

                seen_tiles[tile_key] = current_path
                output_tiles.append({
                    "tile": tile,
                    "tile_dir": tile_dir
                })

    return output_tiles

def merge_and_copy_tiles(
    extracted_tiles: List[Dict[str, Any]],
    master_tile_dir: Path,
    dest_dir: Path
) -> Path:
    if not master_tile_dir.exists():
        raise FileNotFoundError(f"Master tile directory not found: {master_tile_dir}")
    shutil.copytree(master_tile_dir, dest_dir, dirs_exist_ok=True)

    for item in extracted_tiles:
        tile_dir = Path(item["tile_dir"])
        z, x, y = item["tile"]

        for ext in [".pbf", "", ".mvt"]:
            patch_file = tile_dir / str(z) / str(x) / f"{y}{ext}"
            logger.debug(f"Checking file {str(patch_file)}")
            if patch_file.is_file() or patch_file.is_symlink():
                dest_file = dest_dir / str(z) / str(x) / f"{y}{ext}"
                dest_file.parent.mkdir(parents=True, exist_ok=True)

                logger.debug(f"Copy/Link file {patch_file} to {dest_file}")

                # Resolve destination appropriately if the source is a symlink
                if patch_file.is_symlink():
                    if dest_file.exists():
                        dest_file.unlink()
                    shutil.copy2(patch_file, dest_file, follow_symlinks=False)
                else:
                    shutil.copy2(patch_file, dest_file)

                for other_ext in [".pbf", "", ".mvt"]:
                    if other_ext != ext:
                        stale_file = dest_dir / str(z) / str(x) / f"{y}{other_ext}"
                        if stale_file.exists() or stale_file.is_symlink():
                            stale_file.unlink()
                break

    return dest_dir

def extract_mbtiles_to_xyz(mbtiles_file: Path, output_dir: Path, decompress: bool = False):
    output_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(mbtiles_file)
    metadata = dict(conn.execute('select name, value from metadata;').fetchall())
    json.dump(metadata, open(os.path.join(output_dir, 'metadata.json'), 'w'), indent=4)

    cursor = conn.cursor()
    logger.debug(f"Extracting {str(mbtiles_file)} to {str(output_dir)}")

    cursor.execute("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles")

    for zoom, x, tms_y, data in cursor:
        xyz_y = (1 << zoom) - 1 - tms_y

        tile_dir = output_dir / str(zoom) / str(x)
        tile_dir.mkdir(parents=True, exist_ok=True)
        tile_path = tile_dir / f"{xyz_y}.pbf"

        if decompress and data[:2] == b'\x1f\x8b':
            data = gzip.decompress(data)
        logger.debug(f"Writing tile to {str(tile_path)}")
        with open(tile_path, "wb") as f:
            f.write(data)

    conn.close()

def get_bbox() -> str:
    metadata_path = MASTER_TILE_DIR / "metadata.json"
    if not metadata_path.is_file():
        logger.warning(f"{metadata_path} not found, using fallback bbox.")
        return DEFAULT_BBOX
    try:
        with open(metadata_path, "r") as f:
            data = json.load(f)
            bounds_str = data.get("bounds")
            if bounds_str:
                parts = [p.strip() for p in bounds_str.split(",")]
                if len(parts) == 4:
                    return ",".join(parts)
    except Exception as e:
        logger.error(f"Error reading metadata.json bbox: {e}")
    return DEFAULT_BBOX

def find_index_dir(file_path: Path) -> Path | None:
    current = file_path.resolve()
    if current.is_file():
        current = current.parent
    while current != current.parent:
        for pattern in ["index.md", "_index.md", "index.*.md", "_index.*.md"]:
            if list(current.glob(pattern)):
                return current
        current = current.parent
    return None

def load_content(file_path):
    subdir = find_index_dir(file_path)
    if not subdir:
        return None
    conf = Config(CONTENT_DIR.parent)
    rel_sub_path = subdir.relative_to(CONTENT_DIR) if subdir.is_relative_to(CONTENT_DIR) else subdir
    content = Content(str(CONTENT_DIR), sub_path=str(rel_sub_path), config=conf, sections=False)
    return content

def run_cmd(cmd, check=True):
    logger.debug(f"RUN: {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=check)

def prepare_osm_patch(osm_patch: Path, docker_client) -> tuple[Path, Path]:
    content = load_content(osm_patch)
    post = content.posts[0]
    title = post.getParam('title')
    path = post.path
    year = post.getParam('year')
    display3D = post.getParam('3d')

    if display3D:
        logger.info(f"Read metadata for {path} (title: {title}), year {year}")
    else:
        logger.info(f"Read metadata for {path} - not configured for 3D!!")

    osm_patch = osm_patch.resolve()
    post_dir = osm_patch.parent.parent
    tmp_dir = post_dir / "tmp"
    file_name = osm_patch.name

    if file_name.endswith(".osm.pbf"):
        file_base_name = file_name[:-8]
    elif file_name.endswith(".osm"):
        file_base_name = file_name[:-4]
    else:
        file_base_name = osm_patch.stem

    map_file = TILES_DIR / f"{file_base_name}.osm.pbf"
    post_tiles = TILES_DIR / file_base_name

    logger.info(f"Processing {osm_patch} (dir '{post_dir}', file '{file_name}', '{file_base_name}') saving to '{map_file}', tiles will go to {post_tiles}")

    patch_file_name = f"{file_base_name}{PATCH_SUFFIX}"
    patch_file_path = tmp_dir / patch_file_name

    if not map_file.is_file() or not patch_file_path.is_file():
        tmp_dir.mkdir(parents=True, exist_ok=True)
        TILES_DIR.mkdir(parents=True, exist_ok=True)

        container = docker_client.containers.create(DATA_IMAGE)
        try:
            bits, stat = container.get_archive("data/.")
            stream = io.BytesIO()
            for chunk in bits:
                stream.write(chunk)
            stream.seek(0)

            with tarfile.open(fileobj=stream) as tar:
                tar.extractall(path=TILES_DIR)
        finally:
            container.remove()

        for file_path in TILES_DIR.glob("*.osm.pbf"):
            new_name = TILES_DIR / f"{file_path.name.split('.')[0]}.osm.pbf"
            if file_path != new_name:
                try:
                    file_path.rename(new_name)
                except OSError:
                    pass


        outline_file_name = f"{file_base_name}-meta.geojson"
        logger.info(f"Writing patch to {tmp_dir / patch_file_name}")

        run_cmd([sys.executable, "scripts/osm_tool.py", "filter", "-v", "-p", str(osm_patch), "-o", str(patch_file_path), "--tag", "meta=never-built", "-f", "--full", "--include-actions", "modify,create,delete"])
        run_cmd([sys.executable, "scripts/osm_tool.py", "tile-info", "-v", "-i", str(patch_file_path), "-o", str(tmp_dir / outline_file_name)])

        filter_args = Namespace(subcommand="filter", patch=str(osm_patch), output=str(patch_file_path), tag="meta=never-built", force=True, verbose=1, full=True, include_actions="modify,create,delete")
        #filter_cmd(filter_args)

        tile_info_args = Namespace(subcommand="tile-info", input=str(patch_file_path), output=str(tmp_dir / outline_file_name), verbose=1, max_zoom=16)
        #tile_info_cmd(tile_info_args)

    else:
        logger.error(f"{map_file} already exists, build might fail!")

    return patch_file_path, file_base_name, tmp_dir


def execute_osm_patch_processing(patch_file_path: Path | list[Path], file_base_name, tmp_dir: Path, docker_client, cleanup = True) -> dict | None:
    if isinstance(patch_file_path, Path):
        patches= [patch_file_path]
    else:
        patches = patch_file_path
    patch_file_name = f"{file_base_name}{PATCH_SUFFIX}"
    patchArgs = [arg for path in patches for arg in ("--patch", str(path))]

    output_file = tmp_dir / "output.mbtiles"
    map_file = TILES_DIR / f"{file_base_name}.osm.pbf"
    post_tiles = TILES_DIR / file_base_name
    outline_file_name = f"{file_base_name}-meta.geojson"

    if not map_file.is_file():
        patch_cmd_list = [sys.executable, "scripts/osm_tool.py", "patch", "-i", str(MASTER_PBF), *patchArgs, "-o", str(map_file), "-v", "-f"]

        kwargs = {}
        for i in range(0, len(patchArgs), 2):
            key = patchArgs[i].lstrip("-").replace("-", "_")
            val = patchArgs[i + 1]
            kwargs[key] = val
        #patch_args = Namespace(subcommand="patch", input=str(MASTER_PBF), output=str(map_file), verbose=1, force=True, **kwargs)

        if DEBUG:
            logger.debug(f"Keeping masked file: {tmp_dir / f'{file_base_name}-masked.osm'}")
            patch_cmd_list.extend(["--dump-masked-base", str(tmp_dir / f"{file_base_name}-masked.osm")])

        run_cmd(patch_cmd_list)

    if not map_file.is_file():
        logger.error("No input file, generation might have failed!")
        sys.exit(1)

    try:
        docker_client.images.get(DOCKER_IMAGE)
    except docker.errors.ImageNotFound:
        try:
            docker_client.images.pull(DOCKER_IMAGE)
        except docker.errors.DockerException as e:
            logger.error(f"Failed to get Docker image ({DOCKER_IMAGE}), is the daemon running? Error: {e}")
            sys.exit(1)

    cmd_planetiler = "java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.*-SNAPSHOT-with-deps.jar"

    bbox = get_bbox()
    logger.info(f"Using {map_file}, using BBox {bbox}")

    args_list = [
        "--download_dir=planetiler-data/sources",
        "--tmpdir=planetiler-data/tmp",
        "--tile_weights=planetiler-data/tile_weights.tsv.gz",
        "--download=true",
        "--languages=de,en",
        f"--osm-path={map_file}",
        f"--tile_compression={TILE_COMPRESSION}",
        f"--maxzoom={MAX_ZOOM}",
        f"--render_maxzoom={MAX_ZOOM}",
        f"--bounds={bbox}",
        "--force",
        f"--output={output_file}"
    ] + PLANETILER_OPTS

    current_pwd = Path.cwd().resolve()
    command = ["sh", "-c", f'{cmd_planetiler} "$@"'] + ["--"] + args_list

    logger.debug(f"RUN DOCKER MODULE: Image={DOCKER_IMAGE}, Command={' '.join(command)}")

    try:
        container_logs = docker_client.containers.run(
            DOCKER_IMAGE,
            command=command,
            volumes={str(current_pwd): {'bind': str(current_pwd), 'mode': 'rw'}},
            working_dir=str(current_pwd),
            tty=False,
            remove=True,
            stream=True
        )

        if DEBUG:
            buffer = ""
            for chunk in container_logs:
                buffer += chunk.decode('utf-8', errors='replace')
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if line.strip():
                        logger.debug(f"Docker: {line.strip()}")
            if buffer.strip():
                logger.debug(f"Docker: {buffer.strip()}")

    except docker.errors.ContainerError as e:
        logger.error(f"Failed process Tiles, container exited with error: {e}")
        sys.exit(1)
    except docker.errors.APIError as e:
        logger.error(f"Docker API error, is the daemon running?: {e}")
        sys.exit(1)

    if post_tiles.is_dir():
        shutil.rmtree(post_tiles, ignore_errors=True)

    extract_mbtiles_to_xyz(
        mbtiles_file=output_file,
        output_dir=post_tiles,
        decompress=False
    )

    for p in patches:
        shutil.copy(str(p), str(post_tiles))

    if isinstance(patch_file_path, Path):
        shutil.copy(str(tmp_dir / outline_file_name), str(post_tiles / outline_file_name))

    if cleanup:
        atexit.register(shutil.rmtree, path=tmp_dir, ignore_errors=True)
    else:
        logger.debug(f"Keeping temporary directory: {tmp_dir}")

    if not (post_tiles / "metadata.json").is_file():
        shutil.copy((MASTER_TILE_DIR / "metadata.json"), post_tiles)


    #logger.info(f"Relevant tiles in {post_tiles}/ (not filtered by min zoom level - usually {BUILDING_LEVEL})")
    #geoMeta.paths()

    result = None
    if isinstance(patch_file_path, Path):
        geojson_path = post_tiles / outline_file_name
        geoMeta = GeoJSONProcessor(geojson_path)

        if COMPACT:
            logger.info(f"Compacting output directory by symlinking against MASTER_TILE_DIR: {MASTER_TILE_DIR}")
            compact_generated_tiles(post_tiles, MASTER_TILE_DIR, geoMeta.all_tiles)

        content = load_content(patch_file_path)
        post = content.posts[0]
        display3D = post.getParam('3d')

        if display3D:
            result = {
                "path": post.path,
                "year": post.getParam('year'),
                "bbox": geoMeta.bbox,
                "tile_levels": geoMeta.tiles,
                "tile_dir": post_tiles,
                "patch": patch_file_path
            }

    logger.info(f"Done processing {', '.join(map(str, patches))}")
    return result


def process_osm_patch(osm_patch: Path, docker_client) -> dict | None:
    patch_file_path, file_base_name, tmp_dir = prepare_osm_patch(osm_patch, docker_client)
    logger.debug(f"Patch created for {file_base_name}")
    if DEBUG:
        result = execute_osm_patch_processing(patch_file_path, file_base_name, tmp_dir, docker_client, False)
    else:
        result = execute_osm_patch_processing(patch_file_path, file_base_name, tmp_dir, docker_client, True)
    if result is not None:
        result["input"] = osm_patch
    return result

def patch_merge(processing_results, docker_client):
    dir_name = COMPLETE_MAP_DIR.name
    tmp_dir = (COMPLETE_MAP_DIR / ".." / f"{dir_name}-tmp").resolve()
    tmp_dir.mkdir(parents=True, exist_ok=True)
    if not DEBUG:
        atexit.register(shutil.rmtree, path=tmp_dir, ignore_errors=True)
    patches = []
    for result in processing_results:
        patches.append(result["patch"])

    execute_osm_patch_processing(patches, dir_name, tmp_dir, docker_client, cleanup = True)

def tile_merge(processing_results):
    all_changes = validate_and_extract_tiles(processing_results)
    merge_and_copy_tiles(all_changes, MASTER_TILE_DIR, COMPLETE_MAP_DIR)
    shutil.copy((MASTER_TILE_DIR / "metadata.json"), COMPLETE_MAP_DIR)

def main():
    parser = argparse.ArgumentParser(description="Process OSM patches and generate map tiles.")
    parser.add_argument("-d", "--debug", action="store_true", help="Enable debug logging and behavior.")
    parser.add_argument("-c", "--compact", action="store_true", help="Compact generated output by symlinking unmodified tiles to the master directory.")
    parser.add_argument(
        "-m", "--merge",
        choices=["none", "tile", "patch"],
        default="tile",
        type=str,
        help="Merge strategy: 'none' or 'tile' (default: 'tile')",
    )
    parser.add_argument(
        "-y", "--year",
        type=str,
        default=None,
        help="Filter results by a single 4-digit year (e.g. 1950) or a range (e.g. 1950-1980) before merging.",
    )
    args = parser.parse_args()

    global DEBUG, COMPACT
    DEBUG = args.debug
    COMPACT = args.compact
    MERGE = args.merge

    # Configure logging format and level based on parsed arguments
    log_level = logging.DEBUG if DEBUG else logging.INFO
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
        force=True
    )

    if DEBUG:
        logger.debug("Debug mode enabled")

    processing_results = []

    if not CONTENT_DIR.exists():
        logger.error("Content directory not found.")
        sys.exit(1)

    files = list(CONTENT_DIR.glob("**/osm/*.osm.pbf")) + list(CONTENT_DIR.glob("**/osm/*.osm"))

    if not files:
        logger.warning("No OSM patch files found.")
        return
    else:
        try:
            client.images.pull(DATA_IMAGE, platform="linux/amd64")
        except docker.errors.DockerException as e:
            logger.error(f"Failed to get Docker image ({DATA_IMAGE}), is the daemon running? Error: {e}")
            sys.exit(1)

    logger.info(f"Processing {len(files)} files: {[str(f) for f in files]}")

    for osm_patch in files:
        try:
            result = process_osm_patch(osm_patch, client)
            if result:
                processing_results.append(result)
        except (RuntimeError, subprocess.CalledProcessError) as e:
            logger.error(f"Processing of {osm_patch} failed: {e}")

    # Filter results by year prior to merging if requested
    if args.year:
        try:
            processing_results = filter_results_by_year(processing_results, args.year)
            global COMPLETE_MAP_DIR
            COMPLETE_MAP_DIR = (SCRIPT_DIR / ".." / MAP_BASE_DIR / f"{COMPLETE_MAP_NAME}-{args.year}").resolve()
            logger.info(f"Filtered down to {len(processing_results)} result(s) matching year criteria '{args.year}'")
        except ValueError as e:
            logger.error(f"Failed to filter by year: {e}")
            sys.exit(1)

    logger.info(f"Finishing, creating map with all changes into {COMPLETE_MAP_DIR} (based on {MASTER_TILE_DIR})")
    if MERGE == "tile":
        tile_merge(processing_results)
    elif MERGE == "patch":
        patch_merge(processing_results, client)
    logger.info("Map generation complete.")


if __name__ == "__main__":
    main()
