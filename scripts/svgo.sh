#!/usr/bin/env bash

set -e

IMAGES=$(find "Source Files" -name '*.svg') ./themes/projektemacher-base/scripts/svgo.sh static/images
