// never-built/Source Files/Mocks/3d/assets/ts/main.ts

import * as maplibregl from 'maplibre-gl'
import { center, points } from "@turf/turf";
import { loadOrParse, absUrl } from "./base-map";
import { TreeLayer } from "./layers/tree-layer";
import { ArchitectureModelBWLayer } from "./layers/architecture-model-bw-layer";
import { updateStyle, setupDefaultStyle, defaultSprites, getSouceName } from "./styles";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  NavigationControl,
  FullscreenControl,
  AttributionControl } from "maplibre-gl";
import chroma from "chroma-js";

import type { LngLatLike, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

const debug           = true;
const tileSource      = "Blauer-Turm";
const metaJson        = `/map/${tileSource}/metadata.json`;
const styleJson       = "/map-styles/style.json";
const tilesUrl        = `/map/${tileSource}/{z}/{x}/{y}.pbf`;
const topoRasterTiles = "/map/tiles/{z}/{x}/{y}.png";
const zoom            = 17;
const defaultCenter: [number, number] = [9.9365, 51.5395];
const bboxUrl = "/map/bbox.json";
const minZoom = 12;
const initialZoom = 14;
const maxZoom = 16;
const maxPitch = 75;
const font = 'Roboto Mono Variable';
const fontPath = "/css/fonts/{font-family}.css"
const background = "#eee";
const attribution = '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const marker = {
  "anchor": [
    0.5,
    1
  ],
  "anchorXUnits": "fraction",
  "anchorYUnits": "fraction",
  "scale": 0.075,
  "src": "/images/marker.svg"
};

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
let centerObj: LngLatLike;
//let centerObj: [number, number] = metaObj.center.split(",").slice(0, 2).map(Number) as [number, number];

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
const url        = window.location.origin + tilesUrl;

let bboxObj: number[][] | undefined;
if (bboxUrl !== undefined) {
  const raw = (await loadOrParse(bboxUrl as string)) as number[] | number[][];
  if ((raw as number[]).length === 4) {
    const flat = raw as number[];
    bboxObj = [
      [flat[0], flat[1]],
      [flat[2], flat[3]],
    ];
  } else {
    bboxObj = raw as number[][];
  }
} else {
  throw new Error("No BBox URL!");;
}

let style: StyleSpecification;
if (styleJson !== undefined) {
  const styleDef = (await loadOrParse(styleJson as string)) as StyleSpecification;
  style = updateStyle(
    styleDef,
    tilesUrl,
    initialZoom,
    minZoom,
    maxZoom,
    bboxObj,
    centerObj,
    background,
    absUrl(defaultSprites),
    fontPath,
    font,
    attribution
  );
} else {
  style = setupDefaultStyle(tilesUrl, initialZoom, minZoom, maxZoom, bboxObj, centerObj, background);
}

console.log(style);
const sourceName = getSouceName(style);

style.light = {
  anchor:    "viewport",
  color:     "#fff",
  intensity: 0.4,
  position:  [1.15, 210, 30],
};

style.layers = style.layers.filter((layer) => {
  //if ("type" in layer && layer.id.startsWith("building")) return false;
  if (layer.id.includes("label") || layer.id.includes("admin") || layer.id === "housenumber") return false;
  return true;
});

const terrainSourceDef: RasterDEMSourceSpecification = {
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
  maxBounds: bboxObj,
  zoom,
  minZoom,
  maxPitch: maxPitch,
  pitch:    initialPos.pitch,
  bearing:  initialPos.bearing,
  attributionControl: false,
  calculateTileZoomFunction: (requestedZoom) => {
    return Math.min(requestedZoom, 15);
  },
  canvasContextAttributes: {antialias: true}
});

const attributionControl = new AttributionControl({ compact: true, customAttribution: attribution })

map.addControl(attributionControl);
map.addControl(new NavigationControl({}), 'top-left');
map.addControl(new FullscreenControl(), 'top-right');

if (debug) {
  const debugEl = document.createElement("div");
  debugEl.id = "debug-overlay";
  Object.assign(debugEl.style, {
    position:      "absolute",
    left:          "8px",
    bottom:        "8px",
    zIndex:        "1000",
    padding:       "4px 8px",
    background:    "rgba(0, 0, 0, 0.65)",
    color:         "#fff",
    font:          "12px/1.4 monospace",
    whiteSpace:    "pre",
    pointerEvents: "none",
    borderRadius:  "3px",
  } as CSSStyleDeclaration);

  map.getContainer().appendChild(debugEl);

  const updateDebugOverlay = (): void => {
    const c = map.getCenter();
    debugEl.textContent =
      `zoom:    ${map.getZoom().toFixed(2)}\n` +
      `pitch:   ${map.getPitch().toFixed(1)}\n` +
      `bearing: ${map.getBearing().toFixed(1)}\n` +
      `center:  ${c.lng.toFixed(5)}, ${c.lat.toFixed(5)}`;
  };

  updateDebugOverlay();
  map.on("move", updateDebugOverlay);
}

const treeLayer = new TreeLayer();

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

// ── Terrain exaggeration tween config ──────────────────────────────────────

const BASE_TERRAIN_EXAGGERATION = 2;
const FLAT_TERRAIN_EXAGGERATION = 0;

/**
 * ⚠️ EXPERIMENTAL / RISKY:
 * Set to `true` to interpolate terrain `exaggeration` continuously, every
 * animation frame, alongside building/tree opacity — so the DEM mesh
 * genuinely flattens as you tilt to overhead, instead of staying bumpy.
 *
 * The rest of this file's tween logic deliberately avoids calling
 * map.setTerrain() at all during animation, because doing so can cause
 * MapLibre to recompute camera placement relative to the terrain surface —
 * which has been observed elsewhere in this project to introduce unwanted
 * bearing/roll drift ("z-rotation") when called repeatedly mid-animation.
 *
 * This has NOT been exhaustively verified safe in your specific installed
 * MapLibre version when only `exaggeration` (not source/center) changes
 * frame-to-frame. Test this thoroughly (fast pitch drags, mid-transition
 * pitch reversals, etc.).
 *
 * If you observe ANY camera jitter/rotation while pitching:
 *   1. Set this to `false`.
 *   2. Terrain will instead snap (not tween) to flat, but only at the
 *      exact moment buildings/trees have already faded to 0 opacity —
 *      same trick already used for the "hills" hillshade layer toggle —
 *      so the abrupt geometry change is far less noticeable.
 */
const TWEEN_TERRAIN_LIVE = true;

/** Skip redundant setTerrain calls when the value barely changed —
 *  reduces call frequency even in "live" mode. */
const TERRAIN_UPDATE_EPSILON = 0.02;
let lastAppliedExaggeration: number | undefined;

function applyTerrainExaggeration(m: maplibregl.Map, v: number): void {
  if (!m.getSource("terrainSource")) return;

  const targetExaggeration =
    FLAT_TERRAIN_EXAGGERATION + (BASE_TERRAIN_EXAGGERATION - FLAT_TERRAIN_EXAGGERATION) * v;

  if (
    lastAppliedExaggeration !== undefined &&
    Math.abs(lastAppliedExaggeration - targetExaggeration) < TERRAIN_UPDATE_EPSILON
  ) {
    return;
  }

  m.setTerrain({ source: "terrainSource", exaggeration: targetExaggeration });
  lastAppliedExaggeration = targetExaggeration;
}

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
 *  - setTerrain() is ONLY called here if TWEEN_TERRAIN_LIVE is true — see
 *    the warning above applyTerrainExaggeration().
 *  - Hills layer uses visibility toggle at tween end, not opacity
 *    (hillshade has no opacity paint property).
 */
function applyTweenValue(m: maplibregl.Map, v: number): void {
  if (m.getLayer("3d-buildings")) {
    m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
  }

  // Tree custom layer
  treeLayer.opacity = v;

  if (TWEEN_TERRAIN_LIVE) {
    applyTerrainExaggeration(m, v);
  }

  m.triggerRepaint();
}

function onTweenComplete(m: maplibregl.Map, flat: boolean): void {
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", flat ? "none" : "visible");
  }

  if (flat) {
    const avgElevation = getAverageViewportElevation(m);
    setFlatTerrainSource(m, avgElevation);
    m.setTerrain({ source: "terrainSourceFlat", exaggeration: 1 });
  } else {
    m.setTerrain({ source: "terrainSource", exaggeration: BASE_TERRAIN_EXAGGERATION });
  }

  // Trees bake ground elevation into a static GPU buffer at build time —
  // they won't automatically follow the new flat elevation unless refreshed.
  treeLayer.refresh();
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

// ─── Synthetic flat-elevation terrain source ───────────────────────────────

// Must match terrainSourceDef's encoding exactly, or decoded elevation
// will be wrong.
const DEM_RED_FACTOR   = 0.4;
const DEM_GREEN_FACTOR = 0.4;
const DEM_BLUE_FACTOR  = 0.4;
const DEM_BASE_SHIFT   = 0;

/** Inverse of: elevation = R*redFactor + G*greenFactor + B*blueFactor + baseShift
 *  Distributes the target elevation evenly across R/G/B since all three
 *  factors are equal in this project's encoding. */
function elevationToRGB(elevationMeters: number): [number, number, number] {
  const totalFactor = DEM_RED_FACTOR + DEM_GREEN_FACTOR + DEM_BLUE_FACTOR;
  const raw = (elevationMeters - DEM_BASE_SHIFT) / totalFactor;
  const channel = Math.max(0, Math.min(255, Math.round(raw)));
  return [channel, channel, channel];
}

/** Registered once, globally. Reads the target elevation out of the
 *  tile URL's `?e=` query param (so changing elevation means changing
 *  the URL, which naturally busts MapLibre's tile cache — see below). */
maplibregl.addProtocol("flatdem", async (params) => {
  const match = params.url.match(/[?&]e=(-?\d+(?:\.\d+)?)/);
  const elevationMeters = match ? Number(match[1]) : 0;

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const [r, g, b] = elevationToRGB(elevationMeters);
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, size, size);

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );

  return { data: await blob.arrayBuffer() };
});

/** Adds (or replaces) the flat terrain source at a specific elevation.
 *  Removing + re-adding is cheap here since tiles are generated
 *  synchronously in-memory — no real network request involved. */
function setFlatTerrainSource(map: maplibregl.Map, elevationMeters: number): void {
  const sourceId = "terrainSourceFlat";

  // Only safe to remove if it's not the currently-active terrain source.
  // Since we only call this right before activating it (never while it's
  // already active), this is safe in practice — but see caveat below.
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }

  map.addSource(sourceId, {
    type:        "raster-dem",
    tiles:       [`flatdem://{z}/{x}/{y}.png?e=${elevationMeters.toFixed(1)}`],
    tileSize:    256,
    minzoom:     0,
    maxzoom:     16,
    encoding:    "custom",
    baseShift:   DEM_BASE_SHIFT,
    redFactor:   DEM_RED_FACTOR,
    greenFactor: DEM_GREEN_FACTOR,
    blueFactor:  DEM_BLUE_FACTOR,
  });
}

function getAverageViewportElevation(map: maplibregl.Map): number {
  if (!map.getTerrain()) return 0;

  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Center + 4 corners, inset slightly so we don't sample right at the
  // very edge where tiles are more likely to be unloaded.
  const samplePointsPx: Array<[number, number]> = [
    [w * 0.5, h * 0.5],
    [w * 0.1, h * 0.1],
    [w * 0.9, h * 0.1],
    [w * 0.1, h * 0.9],
    [w * 0.9, h * 0.9],
  ];

  let sum = 0;
  let count = 0;

  for (const [x, y] of samplePointsPx) {
    const lngLat = map.unproject([x, y]);
    const elevation = map.queryTerrainElevation(lngLat);
    if (elevation !== null && Number.isFinite(elevation)) {
      sum += elevation;
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

map.on("load", () => {
  map.addSource("terrainSource", terrainSourceDef);
  map.addSource("hillshadeSource", terrainSourceDef);

  map.setTerrain({ source: "terrainSource", exaggeration: BASE_TERRAIN_EXAGGERATION });
  lastAppliedExaggeration = BASE_TERRAIN_EXAGGERATION;

  map.addLayer({
    id:     "hills",
    type:   "hillshade",
    source: "hillshadeSource",
    layout: { visibility: "visible" },
    paint: {
      "hillshade-shadow-color":    "#473B24",
      "hillshade-exaggeration":    0.4,
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
    source:         sourceName,
    "source-layer": "building",
    type:           "fill-extrusion",
    minzoom:        13, // was 13
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: {
      "fill-extrusion-color":   ["case", ["has", "color"], ["get", "color"], "#aaa"],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-vertical-gradient": true,
      "fill-extrusion-height":  ["get", "render_height"],
      "fill-extrusion-base":    ["get", "render_min_height"],
    },
  });

  map.addLayer({
    id: "building-outline",
    type: "line",
    source: sourceName,
    "source-layer": "building",
    minzoom: 13,
    paint: { "line-color": "#333", "line-width": 0.6, "line-opacity": 0.8 },
  });

  treeLayer.source           = sourceName;
  treeLayer.sourceLayers     = ["tree", "tree_row"];
  treeLayer.heightProperty   = "height";
  treeLayer.baseHeightMeters = 6;
  treeLayer.treeRowSpacing   = 3;
  treeLayer.debug            = debug;
  treeLayer.opacity          = 1;
  map.addLayer(treeLayer);

  const architectureModelBWLayer = new ArchitectureModelBWLayer();
  map.addLayer(architectureModelBWLayer);
  architectureModelBWLayer.contrast = 1.5;
  architectureModelBWLayer.edgeStrength = 0.2;      // stronger "cut edges"
  architectureModelBWLayer.grainAmount = 0.04;      // rougher matte texture
  architectureModelBWLayer.paperTone = [1, 1, 1];   // pure white plaster
  architectureModelBWLayer.shadowTone = [0.03, 0.03, 0.05]; // cool shadow tint
  architectureModelBWLayer.antialias = true;
  map.triggerRepaint();

  // ── Apply initial state without animating ─────────────────────────────────
  const startFlat = isOverhead(map);
  tween.value  = startFlat ? 0 : 1;
  tween.target = startFlat ? 0 : 1;
  applyTweenValue(map, tween.value);
  onTweenComplete(map, startFlat);

  // ── React to pitch changes ────────────────────────────────────────────────
  map.on("pitch", () => sync3DVisibility(map));

  // ── Building popup ────────────────────────────────────────────────────────
  if (debug) {
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
  }
});

// ─── Initial camera ───────────────────────────────────────────────────────────

const camPos = map.calculateCameraOptionsFromCameraLngLatAltRotation(
  initialPos.cameraLngLat,
  initialPos.cameraAlt,
  initialPos.bearing,
  initialPos.pitch,
  initialPos.roll
);
map.jumpTo(camPos);
console.log(camPos, map);

export default map;
