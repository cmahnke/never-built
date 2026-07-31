#!/usr/bin/env bash

SCRIPT_PATH=$(realpath $0)
CTX_DIR=$(dirname "$SCRIPT_PATH")

echo "Make sur to install required Python packages"
echo "pip install -r $CTX_DIR/../../../requirements.txt"
echo "pip install -r $CTX_DIR/../../../themes/projektemacher-base/requirements.txt"

cd "$CTX_DIR/../../../scripts/"

./get-map-tiles.sh
./generate-3d-map.sh

cd "$CTX_DIR/../"
npm i
