#!/usr/bin/env bash

set -e

echo "Set SKIP_IIIF to something to disable generation of IIIF derivates"
./scripts/iiif.sh

# Get models
./scripts/models.sh

echo "Calling theme scripts"
for SCRIPT in $PWD/themes/projektemacher-base/scripts/init/*.sh ; do
    echo "Running $SCRIPT"
    bash "$SCRIPT"
done

# Get map
./scripts/get-map-tiles.sh
./scripts/generate-3d-map.sh

python ./scripts/extract-images.py -d

python scripts/bibtex2html.py -d -l

./scripts/svgo.sh

# Generate Previews
TARGETFORMAT=png ./themes/projektemacher-base/scripts/preview.sh

# Favicons
SOURCE="static/images/favicon.svg" OPTIONS="-background none" ./themes/projektemacher-base/scripts/favicon.sh

# Generate Previews
./themes/projektemacher-base/scripts/preview.sh

# Favicons
#SOURCE="themes/projektemacher-base/static/images/cm.svg" OPTIONS="-transparent white static/images/favicon-128.png" ./themes/projektemacher-base/scripts/favicon.sh

./scripts/map.sh

./themes/projektemacher-base/scripts/json-lint.sh

echo "Make sure './scripts/post-build/index.sh' is executed"
if [ -d ./scripts/post-build ] ; then
    echo "Don't forget to run post build scripts after 'hugo'!"
fi
