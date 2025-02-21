---
title: "Städte Forum 1977"
date: 2025-03-01T17:15:07+02:00
tags:
- book
draft: true
worldcat: https://search.worldcat.org/de/title/74413723
outputs:
  - iiif-manifest
  - html
params:
  iiifContext: http://iiif.io/api/image/2/context.json
  type: book
resources:
- src: "front.jxl"
  name: front
  params:
    iiif: front/info.json
cascade:
  - _target:
      kind: "{page,section}"
      lang: de
      path: '**'
    params:
      draft: true
---
