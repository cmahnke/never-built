#!/usr/bin/env bash

#mapproxy-util create -t base-config ./
cd "$(dirname "$(realpath "$0")")" || exit 1
mapproxy-util serve-develop ../config/mapproxy.yaml
