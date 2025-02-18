#!/bin/sh

hugo --disableKinds=pages,taxonomyTerm,category,sitemap,RSS,404,robotsTXT,home
python themes/projektemacher-base/scripts/bbox.py -f docs/post/map.geojson -j -m 100000 > assets/js/bbox.json
