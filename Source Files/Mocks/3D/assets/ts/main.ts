import * as maplibregl from 'maplibre-gl'
import type {
  StyleSpecification,
  RasterDEMSourceSpecification,
  VectorSourceSpecification,
  MapMouseEvent,
  MapGeoJSONFeature,
  LayerSpecification,
} from "maplibre-gl";
import { center, points } from "@turf/turf";
import { loadOrParse } from "./base-map";
import { grainyBWLayer } from "./layers/grainy-bw-layer";
import { updateStyle, setupDefaultStyle, defaultSprites } from './styles';
import { treeLayer } from "./layers/tree-layer";
import "maplibre-gl/dist/maplibre-gl.css";
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

interface InitialCameraPosition {
  cameraLngLat: [number, number];
  cameraAlt:    number;
  bearing:      number;
  pitch:        number;
  roll:         number;
}

const initialPos: InitialCameraPosition = {
  cameraLngLat: defaultCenter,
  cameraAlt:    100,
  bearing:      -10,
  pitch:        75,
  roll:         0,
};

const skyColors: string[] = chroma.scale([fog, sky]).mode("lab").colors(6);

// ─── Meta / style loading ─────────────────────────────────────────────────────

interface MetaObj {
  center:  string;
  bounds?: string;
  [key: string]: unknown;
}

const metaObj = (await loadOrParse(metaJson)) as MetaObj;

let centerObj: [number, number] = metaObj.center
  .split(",").slice(0, 2).map(Number) as [number, number];

if (metaObj.bounds) {
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

const spriteUrl       = window.location.origin + defaultSprites;
const loadedStyleJson = (await loadOrParse(styleJson)) as StyleSpecification;
const url             = window.location.origin + tilesUrl;

function cloneStyle(s: StyleSpecification): StyleSpecification {
  return JSON.parse(JSON.stringify(s)) as StyleSpecification;
}

/**
 * Layers that should be hidden (not removed) while in 3D mode, because
 * they're visually replaced by dynamic 3D equivalents (e.g. the flat
 * building fill is replaced by the extruded `3d-buildings` layer).
 */
const HIDDEN_IN_3D = new Set<string>(["building_fill"]);

/**
 * "flatStyle" is the plain `styleJson`, only with the tile source URL /
 * sprite wired up. Buildings, labels, admin boundaries etc. all stay as
 * declared in the original style — this is what we show when the camera
 * looks straight down and 3D is disabled.
 */
const flatStyle: StyleSpecification = updateStyle(
  cloneStyle(loadedStyleJson), url, 14, minZoom, 15,
  undefined, undefined, undefined, undefined, undefined,
  spriteUrl
) as StyleSpecification;

/**
 * "style3D" is the customized version used while tilted:
 *  - labels/admin boundaries are removed entirely
 *  - `building_fill` is hidden via layout.visibility (not removed) since
 *    the extruded `3d-buildings` layer replaces it visually
 *  - a custom light is applied
 */
function buildStyle3D(): StyleSpecification {
  const s: StyleSpecification = updateStyle(
    cloneStyle(loadedStyleJson), url, 14, minZoom, 15,
    undefined, undefined, undefined, undefined, undefined,
    spriteUrl
  ) as StyleSpecification;

  s.light = {
    anchor:    "viewport",
    color:     "#fff",
    intensity: 0.4,
    position:  [1.15, 210, 30],
  };

  s.layers = s.layers
    .filter((layer: LayerSpecification) => {
      if (layer.id.includes("label") || layer.id.includes("admin") || layer.id === "housenumber") return false;
      return true;
    })
    .map((layer: LayerSpecification): LayerSpecification => {
      if (HIDDEN_IN_3D.has(layer.id)) {
        return {
          ...layer,
          layout: {
            ...("layout" in layer ? layer.layout : {}),
            visibility: "none",
          },
        } as LayerSpecification;
      }
      return layer;
    });

  return s;
}

const style3D: StyleSpecification = buildStyle3D();

/**
 * MapLibre's official `RasterDEMSourceSpecification` doesn't know about
 * `baseShift` (custom decoding parameter used by our terrain encoder),
 * so we extend the type instead of casting to `any`.
 */
type CustomRasterDemSource = RasterDEMSourceSpecification & {
  baseShift: number;
};

const terrainSourceDef: CustomRasterDemSource = {
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

const neverBuiltSource: VectorSourceSpecification = {
  type:    "vector",
  minzoom: 9,
  maxzoom: 15,
};

// ─── Map ──────────────────────────────────────────────────────────────────────

const OVERHEAD_THRESHOLD = 5;
const TRANSITION_MS      = 600;

type ViewMode = "3D" | "flat";

let currentMode: ViewMode =
  initialPos.pitch < OVERHEAD_THRESHOLD ? "flat" : "3D";

const map = new maplibregl.Map({
  container: "map",
  style: currentMode === "3D" ? style3D : flatStyle,
  center:   defaultCenter,
  zoom,
  minZoom,
  maxPitch: 65,
  pitch:    initialPos.pitch,
  bearing:  initialPos.bearing,
});

// ─── 3D transition ────────────────────────────────────────────────────────────

interface Tween {
  value:     number;
  target:    number;
  startVal:  number;
  startTime: number;
  raf:       number;
}

const tween: Tween = {
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
 * Only meaningful while `currentMode === "3D"` (the flat style doesn't
 * have these layers at all).
 */
function applyTweenValue(m: maplibregl.Map, v: number): void {
  if (m.getLayer("3d-buildings")) {
    m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
  }

  treeLayer.opacity = v;

  m.triggerRepaint();
}

/**
 * Called once when the tween finishes.
 */
function onTweenComplete(m: maplibregl.Map, flat: boolean): void {
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", flat ? "none" : "visible");
  }

  if (flat && currentMode === "3D") {
    switchToFlat(m);
  }
}

function startTween(m: maplibregl.Map, target: number): void {
  if (tween.target === target && tween.value === target) return;

  cancelAnimationFrame(tween.raf);
  tween.target    = target;
  tween.startVal  = tween.value;
  tween.startTime = performance.now();

  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", "visible");
  }

  const tick = (now: number): void => {
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
  const target = isOverhead(m) ? 0 : 1;

  if (target === 1 && currentMode === "flat") {
    switchTo3D(m, () => startTween(m, target));
    return;
  }

  startTween(m, target);
}

// ─── Style switching ──────────────────────────────────────────────────────────

/**
 * Adds all the sources/layers that only make sense in 3D mode.
 * Safe to call multiple times (guards against duplicates), needed after
 * every `setStyle(style3D)` since that resets sources/layers.
 */
function attachDynamicLayers(m: maplibregl.Map): void {
  if (!m.getSource("never_built")) {
    m.addSource("never_built", neverBuiltSource);
  }
  if (!m.getSource("terrainSource")) {
    m.addSource("terrainSource", terrainSourceDef);
  }
  if (!m.getSource("hillshadeSource")) {
    m.addSource("hillshadeSource", terrainSourceDef);
  }

  // Terrain exaggeration is set ONCE per style-load and never touched again.
  m.setTerrain({ source: "terrainSource", exaggeration: 1 });

  if (!m.getLayer("hills")) {
    m.addLayer({
      id:     "hills",
      type:   "hillshade",
      source: "hillshadeSource",
      layout: { visibility: "visible" },
      paint: {
        "hillshade-shadow-color": "#473B24",
        "hillshade-exaggeration": 0.5,
      },
    });
  }

  m.setSky({
    "sky-color":         skyColors[0],
    "sky-horizon-blend": blend,
    "horizon-color":     skyColors[2],
    "horizon-fog-blend": blend,
    "fog-color":         skyColors[5],
    "fog-ground-blend":  0,
  });

  if (!m.getLayer("3d-buildings")) {
    m.addLayer({
      id:             "3d-buildings",
      source:         "openmaptiles",
      "source-layer": "building",
      type:           "fill-extrusion",
      minzoom:        13,
      paint: {
        "fill-extrusion-color":   ["case", ["has", "color"], ["get", "color"], "#aaa"],
        "fill-extrusion-height":  ["get", "render_height"],
        "fill-extrusion-base":    ["get", "min_height"],
        "fill-extrusion-opacity": tween.value,
      },
    });
  }

  if (!m.getLayer(treeLayer.id)) {
    treeLayer.source      = "openmaptiles";
    treeLayer.sourceLayer = "tree";
    treeLayer.debug       = true;
    treeLayer.opacity     = tween.value;
    m.addLayer(treeLayer);
  }

  if (!m.getLayer(grainyBWLayer.id)) {
    m.addLayer(grainyBWLayer);
  }
}

function switchTo3D(m: maplibregl.Map, after?: () => void): void {
  if (currentMode === "3D") {
    after?.();
    return;
  }
  currentMode = "3D";
  m.setStyle(cloneStyle(style3D), { diff: false });
  m.once("style.load", () => {
    attachDynamicLayers(m);
    after?.();
  });
}

function switchToFlat(m: maplibregl.Map): void {
  if (currentMode === "flat") return;
  currentMode = "flat";
  m.setTerrain(null);
  m.setStyle(cloneStyle(flatStyle), { diff: false });
}

// ─── Load ─────────────────────────────────────────────────────────────────────

map.on("load", () => {
  if (currentMode === "3D") {
    attachDynamicLayers(map);
  }

  const startFlat = isOverhead(map);
  tween.value  = startFlat ? 0 : 1;
  tween.target = startFlat ? 0 : 1;
  applyTweenValue(map, tween.value);
  if (currentMode === "3D" && map.getLayer("hills")) {
    map.setLayoutProperty("hills", "visibility", startFlat ? "none" : "visible");
  }

  map.on("pitch", () => sync3DVisibility(map));
});

// ── Building popup / hover (style-agnostic, layer existence checked) ─────────

map.on("click", (e: MapMouseEvent) => {
  if (!map.getLayer("3d-buildings")) return;

  const features: MapGeoJSONFeature[] = map.queryRenderedFeatures(e.point, {
    layers: ["3d-buildings"],
  });
  if (!features.length) return;

  const props = features[0].properties ?? {};
  let html = "<h4>Building Properties</h4><table>";
  for (const key of Object.keys(props)) {
    html += `<tr><td><strong>${key}</strong></td><td>${String(props[key])}</td></tr>`;
  }
  html += "</table>";
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(html)
    .addTo(map);
});

map.on("mousemove", (e: MapMouseEvent) => {
  if (!map.getLayer("3d-buildings")) {
    map.getCanvas().style.cursor = "";
    return;
  }
  const features: MapGeoJSONFeature[] = map.queryRenderedFeatures(e.point, {
    layers: ["3d-buildings"],
  });
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
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
