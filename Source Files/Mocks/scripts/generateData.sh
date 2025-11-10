#!/usr/bin/env bash

DOCKER_IMAGE=ghcr.io/cmahnke/map-tools/planetiler:latest
DATA_IMAGE=ghcr.io/cmahnke/map-data/goettingen:latest
TILES_DIR=./public/map
COVERAGE=goettingen
MAX_ZOOM=15
TILE_COMPRESSION=gzip
PLANETILER_OPTS="--use_wikidata=true"


if ! test -d "$TILES_DIR"; then
  mkdir -p $TILES_DIR

  docker pull --platform linux/amd64 "$DATA_IMAGE"
  if [ $? -ne 0 ]; then
    echo
    echo "Failed to get Docker image ($DATA_IMAGE), is the deamon running?"
    exit 1
  fi

  CONTAINER_ID=`docker create $DATAIMAGE`

  #docker export $CONTAINER_ID  tar -xC $TMP_DIR
  docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
  docker rm $CONTAINER_ID
fi

docker pull "$DOCKER_IMAGE"
if [ $? -ne 0 ]; then
  echo
  echo "Failed to get Docker image ($DOCKER_IMAGE), is the deamon running?"
  exit 1
fi

CMD="java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.9.4-SNAPSHOT-with-deps.jar"
#CMD="/opt/planetiler/bin/planetiler"

ARGS="--download=true --languages=de,en --osm-path=$TILES_DIR/${COVERAGE}.osm.pbf --tile_compression=${TILE_COMPRESSION} --maxzoom=${MAX_ZOOM} --building_merge_z13=false --render_maxzoom=${MAX_ZOOM} $PLANETILER_OPTS"

docker run -v "`pwd`:`pwd`" -w "`pwd`" $DOCKER_IMAGE $CMD $ARGS


mb-util --silent --image_format=pbf ./data/output.mbtiles $TILES_DIR/tiles