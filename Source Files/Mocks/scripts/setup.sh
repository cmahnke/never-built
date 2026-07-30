#!/usr/bin/env bash

SCRIPT_PATH=$(realpath $0)
CTX_DIR=$(dirname "$SCRIPT_PATH")

cd "$CTX_DIR/../../../scripts/"

./get-map-tiles.sh
./generate-3d-map.sh
