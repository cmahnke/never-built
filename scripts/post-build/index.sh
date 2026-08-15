#!/usr/bin/env bash

PYTHON=`which python3.13`

if [ -z "$PYTHON" ] ; then
  PYTHON=`which python`
fi

LOG_LEVEL=INFO
export LOG_LEVEL

pagefind-indexer -c pagefind-index.yaml
#$PYTHON themes/projektemacher-base/scripts/indexer.py -c pagefind-index.yaml
