#!/usr/bin/env bash

set -e

cd "$(dirname "$(realpath "$0")")" || exit 1

mapproxy-util serve-develop ../../../config/mapproxy.yaml
