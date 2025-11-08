import "maplibre-gl";
import { center, points } from "@turf/turf";
import { absUrl, loadOrParse } from "./base-map";
import { updateStyle, defaultSprites } from "./styles";
import "maplibre-gl/dist/maplibre-gl.css";
import { StyleSpecification } from "maplibre-gl";
//import maplibregl from 'maplibre-gl';

const bboxJson = "/map/bbox.json";
const styleJson = "/map-styles/style.json";
const tilesUrl = "/map/tiles/{z}/{x}/{y}.pbf";
const zoom = 14;

export async function getMapMetadata(url: string) {
  const metadataFile = "metadata.json";
  if (url.includes("{")) {
    url = url.substring(0, url.indexOf("{"));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith("/")) {
    url += "/" + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url);
}

const bboxObj = await loadOrParse(bboxJson);
let centerObj: [number, number];
if (bboxObj !== undefined && bboxObj.length !== 0) {
  const c = center(
    points([
      [bboxObj[0], bboxObj[1]],
      [bboxObj[2], bboxObj[3]]
    ])
  );
  centerObj = c.geometry.coordinates as [number, number];
} else {
  console.warn("Can't create center from features or bbox");
  centerObj = [0, 0];
}

const spriteUrl = window.location.origin + defaultSprites;
const baseStyle = await loadOrParse(styleJson);
const url = window.location.origin + tilesUrl;
const style = updateStyle(
  baseStyle,
  url,
  14,
  undefined,
  15,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  spriteUrl
) as StyleSpecification;


/*
style.layers.push({
  "id": "buildings", 
  "source": "openmaptiles", 
  "source-layer": "building", 
  //"filter": ["==", "class", "building"],
  "type": "fill-extrusion",
  "minzoom": 14
})
  */  

style.layers = style.layers.filter(layer => {
  if ("type" in layer && layer.id.startsWith("building")) {
    return false;
  }
  return true;
});

/*
style.layers.forEach((layer, index, object) => {
  if ("type" in layer && layer.id.startsWith("building")) {
    object.splice(index, 1);
  }
});
*/

console.log(bboxJson ,bboxObj, centerObj, style, spriteUrl);

const map = new maplibregl.Map({
  container: "map",
  style: style,
  center: centerObj,
  zoom: zoom,
  pitch: 60, 
  bearing: -60,
  //antialias: true
});

map.on("load", () => {
  const source = "never_built";

  map.addSource(source, {
    type: "vector",
    minzoom: 0,
    maxzoom: 15
  });


  map.addLayer({
      'id': '3d-buildings',
      'source': 'openmaptiles',
      'source-layer': 'building',
      'type': 'fill-extrusion',
      'minzoom': 14,
      'paint': {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'min_height']
      }
  }, 'water');


map.on('click', 'buildings', (e) => {
    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      const properties = feature.properties;
      let description = '<h4>Building Properties</h4>';
      description += '<table>';
      for (const key in properties) {
        description += `<tr><td><strong>${key}</strong></td><td>${properties[key]}</td></tr>`;
      }
      description += '</table>';

      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(description)
        .addTo(map);
    }
  });

  // Change the cursor to a pointer when the mouse is over the buildings layer.
  map.on('mouseenter', '3d-buildings', () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  // Change it back to a pointer when it leaves.
  map.on('mouseleave', '3d-buildings', () => {
    map.getCanvas().style.cursor = '';
  });

});



