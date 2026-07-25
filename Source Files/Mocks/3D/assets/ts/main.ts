import * as maplibregl from 'maplibre-gl'
import { center, points } from "@turf/turf";
import { absUrl, loadOrParse } from "./base-map";
import { grainyBWLayer } from "./layers/grainy-bw-layer";
import { updateStyle, defaultSprites } from "./styles";
import { treeLayer } from "./layers/tree-layer";
import "maplibre-gl/dist/maplibre-gl.css";
import { StyleSpecification } from "maplibre-gl";
import chroma from "chroma-js";

const metaJson = "/map/tiles/metadata.json";
const styleJson = "/map-styles/style.json";
const tilesUrl = "/map/tiles/{z}/{x}/{y}.pbf";
const zoom = 17; // 17
const minZoom = 4;
const defaultCenter = [9.935793, 51.5404];


const fog = "#dcdbdf";
const sky = "#87ceeb";
const blend = 0.5;

const initialPos = {
  //cameraLngLat: new maplibregl.LngLat(...defaultCenter),
  cameraLngLat: defaultCenter,
  //cameraLngLat: [9.7, 51.3],
  cameraAlt: 100,
  bearing: -10,
  pitch: 75,
  roll: 0
};

//const skyColors = chroma.scale([fog, sky]).domain([1, 100000], 7, 'log').colors(6);

const skyColors = chroma.scale([fog, sky]).mode("lab").colors(6);

const metaObj = await loadOrParse(metaJson);
let centerObj: [number, number];
centerObj = metaObj.center.split(",").slice(0, 2).map(Number) as [number, number];
//
console.log(centerObj, initialPos);
if (metaObj !== undefined && metaObj.length !== 0) {
  const bboxObj = metaObj.bounds.split(",").slice(0, 4).map(Number);
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
  minZoom,
  15,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  spriteUrl
) as StyleSpecification;

style.light = {
  anchor: "viewport",
  color: "#fff",
  intensity: 0.4,
  position: [1.15, 210, 30]
};

style.layers = style.layers.filter((layer) => {
  if ("type" in layer && layer.id.startsWith("building")) {
    return false;
  }
  if (layer.id.includes("label") || layer.id.includes("admin") || layer.id == "housenumber") {
    return false;
  }
  return true;
});

console.log(metaObj, centerObj, style, spriteUrl);

const terrainSource = {
  type: "raster-dem",
  tiles: ["/map/tiles/{z}/{x}/{y}.png"],
  tileSize: 256,
  minzoom: 11,
  maxzoom: 16,
  encoding: "custom",
  baseShift: 0,
  redFactor: 0.4,
  greenFactor: 0.4,
  blueFactor: 0.4,
  //antialias: true
  /*
    paint: {
      "raster-resampling": "linear"
    }
    */
};

const map = new maplibregl.Map({
  container: "map",
  style: style,
  center: defaultCenter,
  zoom: zoom,
  minZoom: minZoom,
  maxPitch: 65,

  pitch: initialPos.pitch,
  bearing: initialPos.bearing
});
// See https://github.com/onthegomap/planetiler/discussions/1389#discussioncomment-14924016
//map.setVerticalFieldOfView(35);

map.on("load", () => {
  const source = "never_built";

  map.addSource(source, {
    type: "vector",
    minzoom: 9,
    maxzoom: 15
  });

  const layers = map.getStyle().layers;

  map.addSource("terrainSource", terrainSource);
  map.addSource("hillshadeSource", terrainSource);

  map.setTerrain({
    source: "terrainSource",
    exaggeration: 1
  });

  map.addLayer({
    id: "hills",
    type: "hillshade",
    source: "hillshadeSource",
    layout: { visibility: "visible" },
    paint: { "hillshade-shadow-color": "#473B24" }
  });

  map.setSky({
    "sky-color": skyColors[0],
    "sky-horizon-blend": blend,
    "horizon-color": skyColors[2],
    "horizon-fog-blend": blend,
    "fog-color": skyColors[5],
    "fog-ground-blend": 0
  });

  map.addLayer({
    id: "3d-buildings",
    source: "openmaptiles",
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 14,
    paint: {
      "fill-extrusion-color": ["case", ["has", "color"], ["get", "color"], "#aaa"],
      "fill-extrusion-height": ["get", "render_height"],
      "fill-extrusion-base": ["get", "min_height"]
    }
  });

  // Configure and add the tree layer
  treeLayer.source = "openmaptiles";
  treeLayer.sourceLayer = "tree";
  //map.addLayer(treeLayer);

  map.addLayer(grainyBWLayer);

  map.on("click", "3d-buildings", (e) => {
    if (e.features?.length) {
      const feature = e.features[0];
      const properties = feature.properties;
      let description = "<h4>Building Properties</h4>";
      description += "<table>";
      for (const key in properties) {
        description += `<tr><td><strong>${key}</strong></td><td>${properties[key]}</td></tr>`;
      }
      description += "</table>";

      new maplibregl.Popup().setLngLat(e.lngLat).setHTML(description).addTo(map);
    }
  });

  // Change the cursor to a pointer when the mouse is over the buildings layer.
  map.on("mouseenter", "3d-buildings", () => {
    map.getCanvas().style.cursor = "pointer";
  });

  // Change it back to a pointer when it leaves.
  map.on("mouseleave", "3d-buildings", () => {
    map.getCanvas().style.cursor = "";
  });

});

const camPos = map.calculateCameraOptionsFromCameraLngLatAltRotation(initialPos.cameraLngLat, initialPos.cameraAlt, initialPos.bearing, initialPos.pitch, initialPos.roll);
console.log(camPos);
//map.jumpTo(camPos);

console.log(map);

export default map;
