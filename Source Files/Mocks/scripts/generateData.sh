#!/usr/bin/env bash

set -e

DOCKER_IMAGE=ghcr.io/cmahnke/map-tools/planetiler:latest
DATA_IMAGE=ghcr.io/cmahnke/map-data/goettingen:latest
TILES_DIR=./3d/public/map
COVERAGE=goettingen
MAX_ZOOM=15
TILE_COMPRESSION=none
PLANETILER_OPTS="--use_wikidata=true"
BBOX="9.7 51.45 10.1 51.6"
PBF=$TILES_DIR/${COVERAGE}.osm.pbf

# go install github.com/lmikolajczak/wms-tiles-downloader@v0.3.2

if ! test -r "$PBF"; then
  mkdir -p $TILES_DIR

  docker pull --platform linux/amd64 "$DATA_IMAGE"
  if [ $? -ne 0 ]; then
    echo
    echo "Failed to get Docker image ($DATA_IMAGE), is the deamon running?"
    exit 1
  fi

  CONTAINER_ID=`docker create $DATA_IMAGE`

  #docker export $CONTAINER_ID  tar -xC $TMP_DIR
  docker cp "$CONTAINER_ID:data/." "$TILES_DIR"
  docker rm $CONTAINER_ID
  rm -r $TILES_DIR/tiles
  for file in $(find $TILES_DIR/ -name "*.osm.pbf");
  do
    mv $file $(dirname $file)/$(basename $file | cut -d. -f1).osm.pbf
  done
  python scripts/osm_tool.py  filter -v  -p updates/Blauer-Turm.osm -o 3d/public/Blauer-Turm.osm -f -v
  python scripts/osm_tool.py patch -i $TILES_DIR/goettingen.osm.pbf -p 3d/public/Blauer-Turm.osm -o $TILES_DIR/goettingen-nb.osm.pbf -v -f
  PBF=$TILES_DIR/goettingen-nb.osm.pbf
fi

if ! test -r "$PBF"; then
  echo "No input file!"
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

CMD="java -Xmx4g -jar /opt/planetiler/planetiler-dist-0.9.4-SNAPSHOT-with-deps.jar"
#CMD="/opt/planetiler/bin/planetiler"
BBOX=$(echo $BBOX| tr ' ' ',')

echo "Using $PBF"
ARGS="--download=true --languages=de,en --osm-path=$PBF --osm_parse_node_bounds=true --tile_compression=${TILE_COMPRESSION} --maxzoom=${MAX_ZOOM} --building_merge_z13=false --render_maxzoom=${MAX_ZOOM} $PLANETILER_OPTS --force --bounds=${BBOX} --exclude-layers=building"

docker run -v "`pwd`:`pwd`" -w "`pwd`" $DOCKER_IMAGE $CMD $ARGS
if [ $? -ne 0 ]; then
  echo
  echo "Failed process Tiles, is the Docker deamon running?"
  exit 1
fi

rm -rf $TILES_DIR/tiles
mb-util --silent --image_format=pbf ./data/output.mbtiles $TILES_DIR/tiles

docker run -v "`pwd`:`pwd`" -w "`pwd`" --entrypoint="" ghcr.io/mapproxy/mapproxy/mapproxy:6.0.1 /mapproxy/.local/bin/mapproxy-seed -s conf/seed.yaml -f conf/mapproxy.yaml

rm -rf $TILES_DIR/../topo-map/tile-locks
cp -r $TILES_DIR/../topo-map/* $TILES_DIR/tiles/

rm -rf $TILES_DIR/../topo-map