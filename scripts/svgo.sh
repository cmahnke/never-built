#!/usr/bin/env bash

set -e

IMAGES=$(find "Source Files" -name '*.svg')

if [ -n "$IMAGES" ] ; then
  IMAGES=$IMAGES ./themes/projektemacher-base/scripts/svgo.sh static/images
else
  echo "No SVG Files found!"
fi
