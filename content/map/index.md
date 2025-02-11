---
title: "Kartenansicht"
metaPage: true
displayinlist: false
---

Auf dieser Seite werden die Einträge mit (rekonstruierten) Geo-Informationen auf eine Karte angezeigt. Die Kartenanzeige nutzt den externen Dienst [OpenStreetmap](https://www.openstreetmap.org/), daher muss der Nutzung zugestimmt werden.

{{< html/iframe-consent >}}
    {{< maps/osm src="/post/map.geojson" cluster=true marker="{src: '/images/svgs/geomarker.svg', scale: 0.1, anchorXUnits: 'fraction', anchorYUnits: 'fraction', anchor: [0.9, 1]}" >}}
{{< /html/iframe-consent >}}

{{< html/link file="/post/map.geojson" content="Download GeoJSON" >}}
