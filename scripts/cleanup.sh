#!/usr/bin/env bash

./themes/projektemacher-base/scripts/cleanup.sh
rm -f static/images/*.svg
find content/ -name "ogPreview*.*" -exec rm {} \;
find content -name '*-boxed.jpg' -print -exec rm {} \;
find content/post/ -name "page[[:digit:]]*-[[:digit:]]*" -print -exec rm {} \;
find content -name manifest-enriched.json -exec rm {} \;
rm -rf ./models ./weights
rm -rf ./static/map

#./scripts/cleanup-generated.sh
