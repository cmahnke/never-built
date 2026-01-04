---
title: "Suche"
layout: search
js:
  - js/search.js
metaPage: true
displayinlist: false
archive: false
news: false
sectionContent: false
sitemap:
  disable: true
cascade:
  - target:
      kind: '{page,section}'
      lang: de
      path: '**'
    params:
      archive: false
      news: false
      sitemap:
        disable: true
---
