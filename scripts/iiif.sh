#!/usr/bin/env bash

IMAGES=$(find content -maxdepth 6 -name '*.jxl' -and -not -name '*.hdr.jxl') ./themes/projektemacher-base/scripts/iiif.sh
