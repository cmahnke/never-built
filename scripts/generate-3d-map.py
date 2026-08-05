#!/usr/bin/env python3

import os
import sys
import subprocess
import shutil
import json
import argparse
from pathlib import Path
import docker
from json import dumps
import tarfile
import io
from mbutil import mbtiles_to_disk
from typing import List, Tuple, Union


SCRIPT_DIR = Path(__file__).resolve().parent
import_paths = [str((SCRIPT_DIR / "../themes/projektemacher-base/scripts/").resolve()), str(SCRIPT_DIR)]
print("Import paths: " + ", ".join(import_paths))

for p in import_paths:
    if p not in sys.path:
        sys.path.append(p)

from osm_tool import patch_cmd, bbox_tiles_osm, filter_osm
from PyHugo import Content, Config, Post

# Configuration
DEBUG = len(sys.argv) > 1
if DEBUG:
    print("Debug mode enabled")

DOCKER_IMAGE = "ghcr.io/cmahnke/map-tools/planetiler:latest"
DATA_IMAGE = "ghcr.io/cmahnke/map-data/goettingen:latest"
TILES_DIR = (SCRIPT_DIR / "../static/map/").resolve()
CONTENT_DIR = (SCRIPT_DIR / "../content/").resolve()
COVERAGE = "goettingen"
MAX_ZOOM = 16
BUILDING_LEVEL = 13
TILE_COMPRESSION = "none"
PLANETILER_OPTS = [
    "--fetch-wikidata",
    "--use_wikidata=true",
    "--osm_parse_node_bounds=true",
    "--exclude-layers=building,housenumber,aeroway"
]
PBF = TILES_DIR / f"{COVERAGE}.osm.pbf"
MAP_DIR = Path("./static/map/tiles/")
MASTER_TILE_DIR = MAP_DIR.resolve()
DEFAULT_BBOX = "9.7,51.45,10.1,51.6"

# Initialize Docker client
if not os.environ.get("DOCKER_HOST"):
    rancher_sock = Path.home() / ".rd" / "docker.sock"
    if sys.platform == "darwin" and rancher_sock.exists():
        os.environ["DOCKER_HOST"] = f"unix://{rancher_sock}"

try:
    client = docker.from_env()
except Exception as e:
    print(f"Failed to initialize Docker client, is the daemon running?: {e}", file=sys.stderr)
    sys.exit(1)

class GeoJSONProcessor:
    def __init__(self, path: Union[str, Path]):
        self.path = Path(path)
        with open(self.path, "r", encoding="utf-8") as f:
            self._data = json.load(f)

        self._feature = self._data["features"][0]

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        """Extracts (min_lon, min_lat, max_lon, max_lat) from Feature[0].geometry.coordinates."""
        coordinates = self._feature["geometry"]["coordinates"]

        # Flatten ring coordinates to extract longitudes and latitudes
        lons = [pt[0] for ring in coordinates for pt in ring]
        lats = [pt[1] for ring in coordinates for pt in ring]

        return (min(lons), min(lats), max(lons), max(lats))

    @property
    def tiles(self) -> List[List[int]]:
        """Returns tiles from Feature[0].properties with zoom level >= 13."""
        raw_tiles = self._feature.get("properties", {}).get("tiles", [])
        return [tile for tile in raw_tiles if tile[0] >= BUILDING_LEVEL]

    def paths(self):
        raw_tiles = self._feature.get("properties", {}).get("tiles", [])
        for tile in raw_tiles:
            print("/".join(map(str, tile)))

def get_bbox() -> str:
    """Reads bounds from TILES_DIR/metadata.json and formats as comma-separated string."""
    metadata_path = TILES_DIR / "metadata.json"
    if not metadata_path.is_file():
        print(f"Warning: {metadata_path} not found, using fallback bbox.", file=sys.stderr)
        return DEFAULT_BBOX

    try:
        with open(metadata_path, "r") as f:
            data = json.load(f)
            bounds_str = data.get("bounds")
            if bounds_str:
                # bounds in metadata.json are typically min_lon,min_lat,max_lon,max_lat separated by commas
                # ensure they match expected comma-separated format
                parts = [p.strip() for p in bounds_str.split(",")]
                if len(parts) == 4:
                    return ",".join(parts)
    except Exception as e:
        if DEBUG:
            print(f"Error reading metadata.json bbox: {e}")

    return DEFAULT_BBOX

def find_index_dir(file_path: Path) -> Path | None:
    """Searches upwards from a file's parent directory for Hugo index files.

    Looks for index.md, _index.md, index.*.md, or _index.*.md.
    Returns the Path of the directory where the file was found, or None.
    """
    current = file_path.resolve()
    if current.is_file():
        current = current.parent

    while current != current.parent:
        # Check standard and numbered index variants
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
    """Helper to run shell commands with debug printing."""
    if DEBUG:
        print(f"RUN: {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=check)

def main():
    processing_results = []
    if not CONTENT_DIR.exists():
        print("Content directory not found.", file=sys.stderr)
        sys.exit(1)

    files = list(CONTENT_DIR.glob("**/osm/*.osm.pbf")) + list(CONTENT_DIR.glob("**/osm/*.osm"))

    if not files:
        print("No OSM patch files found.")
        return
    else:
        try:
            client.images.pull(DATA_IMAGE, platform="linux/amd64")
        except docker.errors.DockerException:
            print(f"\nFailed to get Docker image ({DATA_IMAGE}), is the daemon running?", file=sys.stderr)
            sys.exit(1)
            sys.exit(1)

    print("Processing files: ", files)

    for osm_patch in files:
        content = load_content(osm_patch)
        post = content.posts[0]
        metadata = post.getMetadata()
        title = post.getParam('title')
        path = post.path
        year = post.getParam('year')
        display3D = post.getParam('3d')

        if display3D:
            print(f"Read metadata for {path} (title: {title}), year {year}")
        else:
            print(f"Read metadata for {path} - not configured for 3D!!")
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

        print(f"Processing {osm_patch} (dir '{post_dir}', file '{file_name}', '{file_base_name}') saving to '{map_file}', tiles will go to {post_tiles}")

        if not map_file.is_file():
            tmp_dir.mkdir(parents=True, exist_ok=True)
            TILES_DIR.mkdir(parents=True, exist_ok=True)

            container = client.containers.create(DATA_IMAGE)
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

            patch_file_name = f"{file_base_name}-patch.osm"
            outline_file_name = f"{file_base_name}-meta.geojson"
            print(f"Writing patch to {tmp_dir / patch_file_name}")

            run_cmd([sys.executable, "scripts/osm_tool.py", "filter", "-v", "-p", str(osm_patch), "-o", str(tmp_dir / patch_file_name), "--tag", "meta=never-built", "-f", "-v"])
            run_cmd([sys.executable, "scripts/osm_tool.py", "tile-info", "-v", "-i", str(tmp_dir / patch_file_name), "-o", str(tmp_dir / outline_file_name)])

            patch_cmd_list = [sys.executable, "scripts/osm_tool.py", "patch", "-i", str(PBF), "-p", str(tmp_dir / patch_file_name), "-o", str(map_file), "-v", "-f"]
            if DEBUG:
                print(f"DEBUG: Keeping masked file: {tmp_dir / f'{file_base_name}-masked.osm'}")
                patch_cmd_list.extend(["--dump-masked-base", str(tmp_dir / f"{file_base_name}-masked.osm")])

            run_cmd(patch_cmd_list)

        if not map_file.is_file():
            print("No input file, generation might have failed!", file=sys.stderr)
            sys.exit(1)

        try:
            client.images.get(DOCKER_IMAGE)
        except docker.errors.ImageNotFound:
            try:
                client.images.pull(DOCKER_IMAGE)
            except docker.errors.DockerException:
                print(f"\nFailed to get Docker image ({DOCKER_IMAGE}), is the daemon running?", file=sys.stderr)
                sys.exit(1)

        cmd_planetiler = "java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.*-SNAPSHOT-with-deps.jar"
        output_file = tmp_dir / "output.mbtiles"
        print(f"Using {map_file}")

        bbox = get_bbox()

        args = [
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

        command = ["sh", "-c", f'{cmd_planetiler} "$@"'] + ["--"] + args

        if DEBUG:
            print(f"RUN DOCKER MODULE: Image={DOCKER_IMAGE}, Command={' '.join(command)}")

        try:
            container_logs = client.containers.run(
                DOCKER_IMAGE,
                command=command,
                volumes={str(current_pwd): {'bind': str(current_pwd), 'mode': 'rw'}},
                working_dir=str(current_pwd),
                tty=DEBUG,
                stdin_open=DEBUG,
                remove=True,
                stream=True
            )
            for chunk in container_logs:
                sys.stdout.write(chunk.decode('utf-8', errors='replace'))
                sys.stdout.flush()

        except docker.errors.ContainerError as e:
            print(f"\nFailed process Tiles, container exited with error: {e}", file=sys.stderr)
            sys.exit(1)
        except docker.errors.APIError as e:
            print(f"\nDocker API error, is the daemon running?: {e}", file=sys.stderr)
            sys.exit(1)

        #if not post_tiles.is_dir():
        #    run_cmd(["mb-util", "--silent", "--image_format=pbf", str(output_file), str(post_tiles)])
        if post_tiles.is_dir():
            shutil.rmtree(post_tiles, ignore_errors=True)
        mbtiles_to_disk(str(output_file), str(post_tiles), format="pbf")


        shutil.move(str(tmp_dir / patch_file_name), str(post_tiles / patch_file_name))
        shutil.move(str(tmp_dir / outline_file_name), str(post_tiles / outline_file_name))

        if not DEBUG:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            print(f"DEBUG: Keeping temporary directory: {tmp_dir}")

        print(f"Relevant tiles in {post_tiles}/ (not filtered by min zoom level - usually 13)")

        geojson_path = post_tiles / outline_file_name
        geoMeta = GeoJSONProcessor(geojson_path)

        if display3D:
            result = {"path": path, "year": year, "bbox": geoMeta.bbox, "tile_levels": geoMeta.tiles, "input": osm_patch, "tile_dir": post_tiles}
            results.append(result)

        print(f"Done processing {osm_patch}")

if __name__ == "__main__":
    main()
