#!/usr/bin/env bash
STYLE_URL=https://github.com/openmaptiles/maptiler-toner-gl-style/archive/refs/tags/v1.0.tar.gz
STYLE_DIR=./assets/map-styles
TILES_DIR=./static/map

if ! test -d "$TILES_DIR"; then
  mkdir -p $TILES_DIR

  IMAGE="ghcr.io/cmahnke/map-data/goettingen:latest"

  docker pull --platform linux/amd64 "$IMAGE"

  CONTAINER_ID=`docker create $IMAGE`

  #docker export $CONTAINER_ID  tar -xC $TMP_DIR
  docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
  docker rm $CONTAINER_ID
else
  echo "Directory $TILES_DIR exists."
fi

if ! test -d "STYLE_DIR"; then
  mkdir -p $STYLE_DIR
  wget -O $STYLE_DIR/`basename $STYLE_URL` $STYLE_URL
  tar xzf $STYLE_DIR/`basename $STYLE_URL` -C $STYLE_DIR/
  rm $STYLE_DIR/*.tar.gz
  mv $STYLE_DIR/*/* $STYLE_DIR/
else
  echo "Directory $STYLE_DIR exists."
fi
