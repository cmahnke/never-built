import * as maplibregl from 'maplibre-gl'
import { center, points } from "@turf/turf";
import { loadOrParse } from "./base-map";
import { grainyBWLayer } from "./layers/grainy-bw-layer";
import { updateStyle, defaultSprites } from "./styles";
import { treeLayer } from "./layers/tree-layer";
import "maplibre-gl/dist/maplibre-gl.css";
import { StyleSpecification } from "maplibre-gl";
import chroma from "chroma-js";

const tileSource      = "Blauer-Turm";
const metaJson        = `/map/${tileSource}/metadata.json`;
const styleJson       = "/map-styles/style.json";
const tilesUrl        = `/map/${tileSource}/{z}/{x}/{y}.pbf`;
const topoRasterTiles = "/map/tiles/{z}/{x}/{y}.png";
const zoom            = 17;
const minZoom         = 4;
const defaultCenter: [number, number] = [9.935793, 51.5404];

const fog   = "#dcdbdf";
const sky   = "#87ceeb";
const blend = 0.5;

const initialPos = {
  cameraLngLat: defaultCenter,
  cameraAlt:    100,
  bearing:      -10,
  pitch:        75,
  roll:         0,
};

const skyColors = chroma.scale([fog, sky]).mode("lab").colors(6);

// ─── Meta / style loading ─────────────────────────────────────────────────────

const metaObj = await loadOrParse(metaJson);
let centerObj: [number, number] = metaObj.center
  .split(",").slice(0, 2).map(Number) as [number, number];

if (metaObj?.bounds) {
  const bboxObj = metaObj.bounds.split(",").slice(0, 4).map(Number);
  const c = center(points([
    [bboxObj[0], bboxObj[1]],
    [bboxObj[2], bboxObj[3]],
  ]));
  centerObj = c.geometry.coordinates as [number, number];
} else {
  console.warn("Can't create center from features or bbox");
  centerObj = [0, 0];
}

const spriteUrl = window.location.origin + defaultSprites;
const baseStyle  = await loadOrParse(styleJson);
const url        = window.location.origin + tilesUrl;

const style = updateStyle(
  baseStyle, url, 14, minZoom, 15,
  undefined, undefined, undefined, undefined, undefined,
  spriteUrl
) as StyleSpecification;

style.light = {
  anchor:    "viewport",
  color:     "#fff",
  intensity: 0.4,
  position:  [1.15, 210, 30],
};

style.layers = style.layers.filter((layer) => {
  if ("type" in layer && layer.id.startsWith("building")) return false;
  if (layer.id.includes("label") || layer.id.includes("admin") || layer.id === "housenumber") return false;
  return true;
});

const terrainSourceDef = {
  type:        "raster-dem",
  tiles:       [topoRasterTiles],
  tileSize:    256,
  minzoom:     11,
  maxzoom:     16,
  encoding:    "custom",
  baseShift:   0,
  redFactor:   0.4,
  greenFactor: 0.4,
  blueFactor:  0.4,
};

// ─── Map ──────────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style,
  center:   defaultCenter,
  zoom,
  minZoom,
  maxPitch: 65,
  pitch:    initialPos.pitch,
  bearing:  initialPos.bearing,
});

// ─── 3D transition ────────────────────────────────────────────────────────────

const OVERHEAD_THRESHOLD = 5;
const TRANSITION_MS      = 600;

const tween = {
  value:     1,   // 0 = flat/overhead, 1 = full 3D
  target:    1,
  startVal:  1,
  startTime: 0,
  raf:       0,
};

function easeCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Apply interpolated value v ∈ [0,1] to all animated properties.
 *
 * Rules:
 *  - Only touch paint properties that are DECLARED in addLayer paint blocks.
 *  - NEVER call setTerrain here — it recalculates camera and causes z-rotation.
 *  - Hills layer uses visibility toggle at tween end, not opacity
 *    (hillshade has no opacity paint property).
 */
function applyTweenValue(m: maplibregl.Map, v: number): void {
  if (m.getLayer("3d-buildings")) {
    m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
  }

  // Tree custom layer
  treeLayer.opacity = v;

  m.triggerRepaint();
}

/**
 * Called once when the tween finishes.
 * Safe to toggle visibility here because we are fully faded.
 */
function onTweenComplete(m: maplibregl.Map, flat: boolean): void {
  // Show/hide hillshade only when buildings are already invisible
  // so the pop-in is not visible.
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", flat ? "none" : "visible");
  }
}

function startTween(m: maplibregl.Map, target: number): void {
  if (tween.target === target) return;

  cancelAnimationFrame(tween.raf);
  tween.target    = target;
  tween.startVal  = tween.value;
  tween.startTime = performance.now();

  // When going 3D→flat, show hills immediately so they fade with buildings.
  // When going flat→3D, show hills immediately too.
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", "visible");
  }

  const tick = (now: number) => {
    const elapsed  = now - tween.startTime;
    const progress = Math.min(elapsed / TRANSITION_MS, 1);
    tween.value    = tween.startVal +
                     (target - tween.startVal) * easeCubic(progress);

    applyTweenValue(m, tween.value);

    if (progress < 1) {
      tween.raf = requestAnimationFrame(tick);
    } else {
      tween.value = target;
      applyTweenValue(m, target);
      onTweenComplete(m, target === 0);
    }
  };

  tween.raf = requestAnimationFrame(tick);
}

function isOverhead(m: maplibregl.Map): boolean {
  return m.getPitch() < OVERHEAD_THRESHOLD;
}

function sync3DVisibility(m: maplibregl.Map): void {
  startTween(m, isOverhead(m) ? 0 : 1);
}

// ─── Load ─────────────────────────────────────────────────────────────────────

map.on("load", () => {
  map.addSource("never_built", { type: "vector", minzoom: 9, maxzoom: 15 });
  map.addSource("terrainSource", terrainSourceDef);
  map.addSource("hillshadeSource", terrainSourceDef);

  // Terrain exaggeration is set ONCE and never touched again.
  // Changing it mid-session causes camera z-rotation in MapLibre.
  map.setTerrain({ source: "terrainSource", exaggeration: 1 });

  map.addLayer({
    id:     "hills",
    type:   "hillshade",
    source: "hillshadeSource",
    layout: { visibility: "visible" },
    paint: {
      // hillshade-exaggeration controls intensity (0–1), this is the
      // only numeric paint property hillshade layers support.
      // Do NOT add hillshade-opacity — it does not exist.
      "hillshade-shadow-color":    "#473B24",
      "hillshade-exaggeration":    0.5,
    },
  });

  map.setSky({
    "sky-color":         skyColors[0],
    "sky-horizon-blend": blend,
    "horizon-color":     skyColors[2],
    "horizon-fog-blend": blend,
    "fog-color":         skyColors[5],
    "fog-ground-blend":  0,
  });

  map.addLayer({
    id:             "3d-buildings",
    source:         "openmaptiles",
    "source-layer": "building",
    type:           "fill-extrusion",
    minzoom:        13,
    paint: {
      "fill-extrusion-color":   ["case", ["has", "color"], ["get", "color"], "#aaa"],
      "fill-extrusion-height":  ["get", "render_height"],
      "fill-extrusion-base":    ["get", "min_height"],
      "fill-extrusion-opacity": 1,   // declared here so setPaintProperty works
    },
  });

  treeLayer.source      = "openmaptiles";
  treeLayer.sourceLayer = "tree";
  treeLayer.debug       = true;
  treeLayer.opacity     = 1;
  map.addLayer(treeLayer);

  map.addLayer(grainyBWLayer);

  // ── Apply initial state without animating ─────────────────────────────────
  const startFlat = isOverhead(map);
  tween.value  = startFlat ? 0 : 1;
  tween.target = startFlat ? 0 : 1;
  applyTweenValue(map, tween.value);
  onTweenComplete(map, startFlat);

  // ── React to pitch changes ────────────────────────────────────────────────
  map.on("pitch", () => sync3DVisibility(map));

  // ── Building popup ────────────────────────────────────────────────────────
  map.on("click", "3d-buildings", (e) => {
    if (e.features?.length) {
      const props = e.features[0].properties;
      let html = "<h4>Building Properties</h4><table>";
      for (const key in props) {
        html += `<tr><td><strong>${key}</strong></td><td>${props[key]}</td></tr>`;
      }
      html += "</table>";
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    }
  });

  map.on("mouseenter", "3d-buildings", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "3d-buildings", () => {
    map.getCanvas().style.cursor = "";
  });
});

// ─── Initial camera ───────────────────────────────────────────────────────────

const camPos = map.calculateCameraOptionsFromCameraLngLatAltRotation(
  initialPos.cameraLngLat,
  initialPos.cameraAlt,
  initialPos.bearing,
  initialPos.pitch,
  initialPos.roll
);
console.log(camPos, map);

export default map;
