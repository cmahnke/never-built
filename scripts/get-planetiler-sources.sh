#!/usr/bin/env bash

set -euo pipefail

SOURCE_DIR=./planetiler-data/sources

#declare -A SOURCES=(
#  ["lake_centerline.shp.zip"]="https://dev.maptiler.download/geodata/omt/lake_centerline.shp.zip"
#  ["natural_earth_vector.sqlite.zip"]="https://dev.maptiler.download/geodata/omt/natural_earth_vector.sqlite.zip"
#  ["water-polygons-split-3857.zip"]="https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip"
#)

declare -A SOURCES=(
  ["lake_centerline.shp.zip"]="https://github.com/acalcutt/osm-lakelines/releases/download/v12/lake_centerline.shp.zip"
  ["natural_earth_vector.sqlite.zip"]="https://naciscdn.org/naturalearth/packages/natural_earth_vector.sqlite.zip"
  ["water-polygons-split-3857.zip"]="https://ftp.uni-erlangen.de/pub/openstreetmapdata.com-archive/2026-05-25/water-polygons-split-3857.zip"
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
