#!/usr/bin/env bash

set -euo pipefail

SOURCE_DIR=./planetiler-data/sources

declare -A SOURCES=(
  ["lake_centerline.shp.zip"]="https://dev.maptiler.download/geodata/omt/lake_centerline.shp.zip"
  ["natural_earth_vector.sqlite.zip"]="https://dev.maptiler.download/geodata/omt/natural_earth_vector.sqlite.zip"
  ["water-polygons-split-3857.zip"]="https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip"
)

mkdir -p "$SOURCE_DIR"

for FILE in "${!SOURCES[@]}"; do
  if test -f "$SOURCE_DIR/$FILE"; then
    echo "$FILE already exists, skipping."
    continue
  fi
  echo "Downloading $FILE from ${SOURCES[$FILE]}"
  curl -fL --retry 10 --retry-all-errors --connect-timeout 60 -C - -o "$SOURCE_DIR/$FILE" "${SOURCES[$FILE]}"
done
