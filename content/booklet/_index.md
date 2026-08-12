---
title: "Katalog"
metaPage: true
displayinlist: false
archive: false
news: false
sectionContent: false
sitemap:
  disable: true
build:
  list: never
  publishResources: false
cascade:
  - target:
      kind: '{page,section}'
      sites:
        matrix:
          languages: [de]
      path: '**'
    outputs:
      - print
    params:
      archive: false
      news: false
      metaPage: true
      displayinlist: false
      sitemap:
        disable: true
      build:
        publishResources: true
---
