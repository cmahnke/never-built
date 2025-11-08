import 'maplibre-gl';
import {center , points} from '@turf/turf';
import {absUrl, loadOrParse} from './base-map';
import {updateStyle, defaultSprites} from './styles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { StyleSpecification } from 'maplibre-gl';
//import maplibregl from 'maplibre-gl';

const bboxJson = "/map/bbox.json";
const styleJson = "/map-styles/style.json";
const tilesUrl = '/map/tiles/{z}/{x}/{y}.pbf';
const zoom = 14;

export async function getMapMetadata(url: string) {
  const metadataFile = "metadata.json";
  if (url.includes("{")) {
    url = url.substring(0, url.indexOf("{"));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith('/')) {
    url += '/' + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url);
}

const bboxObj = await loadOrParse(bboxJson);
let centerObj: [number, number];
if (bboxObj !== undefined && bboxObj.length !== 0) {
  const c = center(points([[bboxObj[0], bboxObj[1]], [bboxObj[2], bboxObj[3]]]));
  centerObj = c.geometry.coordinates as [number, number];
} else {
  console.warn("Can't create center from features or bbox")
  centerObj = [0, 0]
}

const spriteUrl = window.location.href + defaultSprites.substring(1);
const baseStyle = await loadOrParse(styleJson)
const url = window.location.href + tilesUrl.substring(1);
const style = updateStyle(baseStyle, url, 14, undefined, undefined, undefined, undefined, undefined, undefined, undefined, spriteUrl) as StyleSpecification;

console.log(bboxObj, centerObj, style, spriteUrl )

const map = new maplibregl.Map({
    container: 'map',
    style: style,
    center: centerObj,
    zoom: zoom
});


map.on('load', () => {
    const source= 'never_built';

    map.addSource(source, {
        'type': 'vector',
        'tiles': [
            'https://never-built.goettingen.xyz/map/tiles/{z}/{x}/{y}.pbf'
        ],
        'minzoom': 0,
        'maxzoom': 15,
    });

});


/*
map.addLayer({
    'id': '3d-buildings',
    'source': 'https://never-built.goettingen.xyz/map/tiles/{x}/{y}/{z}.pbf',
    'source-layer': 'building',
    'type': 'fill-extrusion',
    'minzoom': 15,
    'paint': {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'min_height']
    }
}, 'water');
*/
