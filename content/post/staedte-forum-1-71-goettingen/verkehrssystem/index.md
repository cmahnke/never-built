---
title: "Das Verkehrssystem der Göttinger Innenstadt"
date: 2025-03-15T17:15:07+02:00
tags:
- transport
outputs:
  - iiif-manifest
  - html
draft: true
params:
#  iiifContext: http://iiif.io/api/image/2/context.json
#  cover: model-planned.jpg
  geojson:
    coordinates:
    -  9.942461
    - 51.537681
#resources:
#- src: "page136.jxl"
#  name: preview
#  params:
#    iiif: page136/info.json
#- src: "page137.jxl"
#  name: page
#  params:
#    iiif: page137/info.json
---

{{< maps/projektemacher geojson="ostring.geojson" cluster=false minZoom=12 initialZoom=14 maxZoom=16 >}}
