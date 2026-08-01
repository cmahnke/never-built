#!/usr/bin/env bash

DEBUG=false
if [ $# -gt 0 ]; then
  DEBUG=true
  set -x
fi

set -euo pipefail

DOCKER_IMAGE=ghcr.io/cmahnke/map-tools/planetiler:latest
DATA_IMAGE=ghcr.io/cmahnke/map-data/goettingen:latest
TILES_DIR="$(dirname "$(realpath "$0")")/../static/map/"
COVERAGE=goettingen
MAX_ZOOM=16
TILE_COMPRESSION=none
PLANETILER_OPTS="--fetch-wikidata --use_wikidata=true --osm_parse_node_bounds=true --exclude-layers=building,housenumber,aeroway"
BBOX="9.7 51.45 10.1 51.6"
PBF=$TILES_DIR/${COVERAGE}.osm.pbf
MAP_DIR=./static/map/tiles/
MASTER_TILE_DIR="$(cd "$MAP_DIR" && pwd)"

# https://wiki.openstreetmap.org/wiki/JOSM_file_format

FILES=$(find ./content -path '*/osm/*' \( -name "*.osm.pbf" -o -name "*.osm" \))
for OSM_PATCH in $FILES
do

  POST_DIR=$(realpath $(dirname "$OSM_PATCH")/..)
  TMP_DIR="$POST_DIR/tmp"
  FILE_NAME="$(basename "$OSM_PATCH")"
  FILE_BASE_NAME="$(basename $FILE_NAME .osm)"
  MAP_FILE="$TILES_DIR/$FILE_BASE_NAME.osm.pbf"
  POST_TILES="$TILES_DIR/$FILE_BASE_NAME"

  echo "Processing ${OSM_PATCH} (dir '${POST_DIR}', file '${FILE_NAME}', '${FILE_BASE_NAME}') saving to '${MAP_FILE}', tiles will go to ${POST_TILES}"

  if ! test -r "$MAP_FILE"; then
    mkdir -p $TMP_DIR $TILES_DIR

    docker pull --platform linux/amd64 "$DATA_IMAGE"
    if [ $? -ne 0 ]; then
      echo
      echo "Failed to get Docker image ($DATA_IMAGE), is the deamon running?"
      exit 1
    fi

    CONTAINER_ID=`docker create $DATA_IMAGE`

    docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
    docker rm $CONTAINER_ID

    for file in $(find $TILES_DIR/ -name "*.osm.pbf");
    do
      mv $file $(dirname $file)/$(basename $file | cut -d. -f1).osm.pbf 2>/dev/null || true
    done

    PATCH_FILE_NAME="$FILE_BASE_NAME-patch.osm"
    OUTLINE_FILE_NAME="$FILE_BASE_NAME-meta.geojson"
    echo "Writing patch to $TMP_DIR/$PATCH_FILE_NAME"
    python scripts/osm_tool.py filter -v -p "$OSM_PATCH" -o "$TMP_DIR/$PATCH_FILE_NAME" --tag meta=never-built -f -v
    python scripts/osm_tool.py tile-info -v -i "$TMP_DIR/$PATCH_FILE_NAME" -o "$TMP_DIR/$OUTLINE_FILE_NAME"

    if [ "$DEBUG" = false ]; then
      python scripts/osm_tool.py patch -i $PBF -p "$TMP_DIR/$PATCH_FILE_NAME" -o "$MAP_FILE" -v -f
    else
      echo "DEBUG: Keeping masked file: $TMP_DIR/$FILE_BASE_NAME-masked.osm"
      python scripts/osm_tool.py patch -i $PBF -p "$TMP_DIR/$PATCH_FILE_NAME" -o "$MAP_FILE" --dump-masked-base "$TMP_DIR/$FILE_BASE_NAME-masked.osm" -v -f
    fi

  fi

  if ! test -r "$MAP_FILE"; then
    echo "No input file, generation might have failed!"
    exit 1
  fi

  if [ -z "$(docker images -q "$DOCKER_IMAGE" 2> /dev/null)" ]; then
    docker pull "$DOCKER_IMAGE"
    if [ $? -ne 0 ]; then
      echo
      echo "Failed to get Docker image ($DOCKER_IMAGE), is the deamon running?"
      exit 1
    fi
  fi

  # TODO
  # create output dir

  # This path only works for the original mockup since thedev version was around 0.9.4
  #CMD="java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.9.4-SNAPSHOT-with-deps.jar"
  CMD="java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.*-SNAPSHOT-with-deps.jar"

  #CMD="/opt/planetiler/bin/planetiler"
  BBOX=$(echo $BBOX| tr ' ' ',')

  OUTPUT_FILE="$TMP_DIR/output.mbtiles"
  echo "Using $MAP_FILE"
  ARGS="--download_dir=planetiler-data/sources --tmpdir=planetiler-data/tmp --tile_weights=planetiler-data/tile_weights.tsv.gz --download=true --languages=de,en --osm-path=$MAP_FILE  --tile_compression=${TILE_COMPRESSION} --maxzoom=${MAX_ZOOM} --render_maxzoom=${MAX_ZOOM} $PLANETILER_OPTS --bounds=${BBOX} --force --output=$OUTPUT_FILE"

  #docker run -v "`pwd`:`pwd`" -w "`pwd`" $DOCKER_IMAGE $CMD $ARGS
  docker run -v "$(pwd):$(pwd)" -w "$(pwd)" "$DOCKER_IMAGE" sh -c "$CMD \"\$@\"" -- $ARGS

  if [ $? -ne 0 ]; then
    echo
    echo "Failed process Tiles, is the Docker deamon running?"
    exit 1
  fi

  if [ ! -d "$POST_TILES" ]; then
    mb-util --silent --image_format=pbf "$OUTPUT_FILE" "$POST_TILES"
  fi

  mv "$TMP_DIR/$PATCH_FILE_NAME" "$POST_TILES/"
  mv "$TMP_DIR/$OUTLINE_FILE_NAME" "$POST_TILES/"
  if [ "$DEBUG" = false ]; then
    rm -r -f "$TMP_DIR"
  else
    echo "DEBUG: Keeping temporary directory: $TMP_DIR"
  fi

  # TODO: This won't work this way.
  # if test -r "$MASTER_TILE_DIR"; then
  #   POST_TILES="$(cd "$POST_TILES" && pwd)"
  #   while IFS= read -r -d '' file_b; do
  #     rel_path="${file_b#"$POST_TILES"/}"
  #     file_a="$MASTER_TILE_DIR/$rel_path"
  #
  #     if [[ -f "$file_a" ]] && cmp -s "$file_a" "$file_b"; then
  #         rm -f "$file_b"
  #         ln -s "$file_a" "$file_b"
  #         echo "Linked: $file_b -> $file_a"
  #     fi
  #   done < <(find "$POST_TILES" -type f -print0)
  # fi

  echo "Relevant tiles in $POST_TILES/ (not filtered by min zoom level - usually 13)"
  jq -r '.features[].properties.tiles[] | map(tostring) | join("/")' "$POST_TILES/$OUTLINE_FILE_NAME"
  echo "Done processing $OSM_PATCH"

done
