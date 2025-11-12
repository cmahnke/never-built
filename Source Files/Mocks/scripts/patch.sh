#!/usr/bin/env bash

python scripts/filter_osm.py  filter -v  -p updates/Blauer-Turm.osm -o 3d/public/Blauer-Turm.osm --tag-key meta --tag-value update
python scripts/osm_patcher.py merge --base 3d/public/map/goettingen.osm.pbf --patch 3d/public/Blauer-Turm.osm -o 3d/public/map/goe-patched.pbf -v -f