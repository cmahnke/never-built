Never built Göttingen Mocks
===========================

# 3D Buildings

## TODO

* Fix transition to view from above
  * Remove shader when viewed from above
  * Let buildings and trees shrink
  * Reset focal length
* Wrap in a single function
* Fix linting errors
* Check if tile seperation is still needed
* Remove Open Layers
* Allow multiple input files for patching
* Avoid problems with ID order if IDs get prefixed

## Preview

https://never-built.goettingen.xyz/future/index.html

## Test data

`content/post/staedte-forum-1-71-goettingen/gwz/` is the main post used for testing.
The file `/content/post/staedte-forum-1-71-goettingen/gwz/osm/Blauer-Turm.osm` is linked to `Source Files/Mocks/updates/Blauer-Turm.osm`

## Boundaries

DATA=https://download.geofabrik.de/europe/germany/niedersachsen-latest.osm.pbf

BOUNDS=https://www.openstreetmap.org/api/0.6/relation/191361/full

## Additional boundaries

* Innenstadt 3608625
* Universität 2908106
* Nordstadt 3608412
* Norduni 7021377
* Weende 3730689
* Ostviertel 4554925
* Weststadt 3730690
* Grone 195326

## Geodata processing links

### Topology data

- https://geoportal.geodaten.niedersachsen.de/harvest/srv/api/records/46051444-a528-438d-955b-2855b9b789be
- https://geoportal.geodaten.niedersachsen.de/harvest/srv/api/records/740e33da-3310-4173-bae1-d30c31124b3a

### 3D Buildings

### Tiles to SVG

- [Tile mill](https://github.com/tilemill-project/tilemill/issues)

### Shadows

- https://gist.github.com/yanik-recke/e7d4cd4763adbeff302ad114845e7c78


### Dump tiles

- https://github.com/mapbox/vt2geojson
