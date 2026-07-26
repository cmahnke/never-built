#!/usr/bin/env bash

set -e

TILES_DIR=./public/map/

PROJECT_ROOT=$(realpath "`pwd`/..")

echo "Using '$PROJECT_ROOT' as root"

#docker run -v "$PROJECT_ROOT:$PROJECT_ROOT" -w "$PROJECT_ROOT/scripts" --entrypoint="" ghcr.io/mapproxy/mapproxy/mapproxy:6.0.1 /mapproxy/.local/bin/mapproxy-seed -s $PROJECT_ROOT/config/seed.yaml -f $PROJECT_ROOT/config/mapproxy.yaml

mapproxy-seed -s ./conf/seed.yaml -f ./conf/mapproxy.yaml

rm -rf $TILES_DIR/../topo-map/tile-locks
cp -r $TILES_DIR/../topo-map/* $TILES_DIR/tiles/

rm -rf $TILES_DIR/../topo-map
