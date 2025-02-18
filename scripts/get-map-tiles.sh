#!/usr/bin/env bash

TILES_DIR=./static/map

if test -d "$TILES_DIR"; then
  echo "Directory $TILES_DIR exists."
  exit 0
fi

mkdir -p $TILES_DIR

IMAGE="ghcr.io/cmahnke/map-data/goettingen:latest"

docker pull --platform linux/amd64 "$IMAGE"

CONTAINER_ID=`docker create $IMAGE`

#docker export $CONTAINER_ID  tar -xC $TMP_DIR
docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
docker rm $CONTAINER_ID
