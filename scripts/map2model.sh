#!/usr/bin/env bash

TILES_DIR=./static/map
BASE_MAP=goettingen.osm.pbf

IMAGE="ghcr.io/cmahnke/map-tools/osm2world:latest"

docker pull "$IMAGE"
if [ $? -ne 0 ]; then
  echo
  echo "Failed to get Docker image ($IMAGE), is the deamon running?"
  exit 1
fi

if ! test -d "$TILES_DIR/$BASE_MAP"; then
  echo "Map data missing, run './scripts/get-map-tiles.sh' first"
  exit 2
fi

FILES=$(find ./content -name "*.osm.pbf" -o -name "*.osm")
for MAP in $FILES
do
  echo "Processing ${MAP}"
done

#docker run -it -v `pwd`:`pwd` -w `pwd` ghcr.io/cmahnke/map-tools/osm2world:latest 
