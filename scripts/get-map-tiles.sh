#!/usr/bin/env bash

set -euo pipefail

STYLE_URL=https://github.com/openmaptiles/maptiler-basic-gl-style/archive/refs/tags/v1.10.tar.gz
STYLE_DIR=./static/map-styles
TILES_DIR=./static/map

declare -a SPRITES=("https://openmaptiles.github.io/maptiler-toner-gl-style/sprite.json" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite@2x.json" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite.png" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite@2x.png")

declare -a IMAGES=("ghcr.io/cmahnke/map-data/goettingen:latest" "ghcr.io/cmahnke/map-data/goettingen:topo")


if ! test -d "$TILES_DIR"; then
  mkdir -p $TILES_DIR

  for IMAGE in "${IMAGES[@]}"
  do

    echo "Getting data from $IMAGE"
    docker pull --platform linux/amd64 "$IMAGE"
    if [ $? -ne 0 ]; then
      echo
      echo "Failed to get Docker image ($IMAGE), is the deamon running?"
      exit 1
    fi

    CONTAINER_ID=`docker create $IMAGE`

    docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
    docker rm $CONTAINER_ID
  done
else
  echo "Directory $TILES_DIR exists."
fi

mv $TILES_DIR/goettingen*.osm.pbf $TILES_DIR/goettingen.osm.pbf 2>/dev/null || true

if ! test -d "STYLE_DIR"; then
  mkdir -p $STYLE_DIR
  wget -O $STYLE_DIR/`basename $STYLE_URL` $STYLE_URL
  tar xzf $STYLE_DIR/`basename $STYLE_URL` -C $STYLE_DIR/
  rm $STYLE_DIR/*.tar.gz
  mv $STYLE_DIR/*/* $STYLE_DIR/
  rm $STYLE_DIR/*.md
  for SPRITE in "${SPRITES[@]}"
  do
    wget -P $STYLE_DIR/ "$SPRITE"
  done
else
  echo "Directory $STYLE_DIR exists."
fi
