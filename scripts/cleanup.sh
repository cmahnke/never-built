#!/usr/bin/env bash

./themes/projektemacher-base/scripts/cleanup.sh
rm static/images/*.svg
rm static/images/bill*.png
rm static/images/red-lether.jpg
find content/ -name "ogPreview*.*" -exec rm {} \;
find content -name '*-boxed.jpg' -print -exec rm {} \;
find content/post/ -name "page[[:digit:]]*-[[:digit:]]*" -print -exec rm {} \;
find content/iiif/ -name index.en.md -print -exec rm {} \;
find content/@cmahnke/ -name index.en.md -print -exec rm {} \;
find content -name manifest-enriched.json -exec rm {} \;
