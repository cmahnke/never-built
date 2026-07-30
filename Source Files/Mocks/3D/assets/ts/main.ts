// never-built/Source Files/Mocks/3d/assets/ts/main.ts

import * as maplibregl from "maplibre-gl";
import { center, points } from "@turf/turf";
import { loadOrParse, absUrl } from "./base-map";
import { TreeLayer } from "./layers/tree-layer";
import { ArchitectureModelBWLayer } from "./layers/architecture-model-bw-layer";
import { updateStyle, setupDefaultStyle, defaultSprites, getSouceName } from "./styles";
import "maplibre-gl/dist/maplibre-gl.css";
import { NavigationControl, FullscreenControl, AttributionControl } from "maplibre-gl";
import chroma from "chroma-js";

import type { LngLatLike, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

const debug = true;
const tileSource = "Blauer-Turm";
const metaJson = `/map/${tileSource}/metadata.json`;
const styleJson = "/map-styles/style.json";
const tilesUrl = `/map/${tileSource}/{z}/{x}/{y}.pbf`;
const topoRasterTiles = "/map/tiles/{z}/{x}/{y}.png";
const zoom = 17;
const defaultCenter: [number, number] = [9.9365, 51.5395];
const bboxUrl = "/map/bbox.json";
const minZoom = 12;
const initialZoom = 14;
const maxZoom = 16;
const maxPitch = 75;
const font = "Roboto Mono Variable";
const fontPath = "/css/fonts/{font-family}.css";
const background = "#eee";
const attribution = '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const marker = {
  anchor: [0.5, 1],
  anchorXUnits: "fraction",
  anchorYUnits: "fraction",
  scale: 0.075,
  src: "/images/marker.svg"
};

const fog = "#dcdbdf";
const sky = "#87ceeb";
const blend = 0.5;

const initialPos = {
  cameraLngLat: defaultCenter,
  cameraAlt: 100,
  bearing: -10,
  pitch: 75,
  roll: 0
};

const skyColors = chroma.scale([fog, sky]).mode("lab").colors(6);

// ─── Meta / style loading ─────────────────────────────────────────────────────

const metaObj = await loadOrParse(metaJson);
let centerObj: LngLatLike;
//let centerObj: [number, number] = metaObj.center.split(",").slice(0, 2).map(Number) as [number, number];

if (metaObj?.bounds) {
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

//const spriteUrl = window.location.origin + defaultSprites;
//const url        = window.location.origin + tilesUrl;

let bboxObj: number[][] | undefined;
if (bboxUrl !== undefined) {
  const raw = (await loadOrParse(bboxUrl as string)) as number[] | number[][];
  if ((raw as number[]).length === 4) {
    const flat = raw as number[];
    bboxObj = [
      [flat[0], flat[1]],
      [flat[2], flat[3]]
    ];
  } else {
    bboxObj = raw as number[][];
  }
} else {
  throw new Error("No BBox URL!");
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
  anchor: "viewport",
  color: "#fff",
  intensity: 0.4,
  position: [1.15, 210, 30]
};

style.layers = style.layers.filter((layer) => {
  //if ("type" in layer && layer.id.startsWith("building")) return false;
  if (layer.id.includes("label") || layer.id.includes("admin") || layer.id === "housenumber") return false;
  return true;
});

const terrainSourceDef: RasterDEMSourceSpecification = {
  type: "raster-dem",
  tiles: [topoRasterTiles],
  tileSize: 256,
  minzoom: 11,
  maxzoom: 16,
  encoding: "custom",
  baseShift: 0,
  redFactor: 0.4,
  greenFactor: 0.4,
  blueFactor: 0.4
};

// ─── Map ──────────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: "map",
  style,
  center: defaultCenter,
  maxBounds: bboxObj,
  zoom,
  minZoom,
  maxPitch: maxPitch,
  pitch: initialPos.pitch,
  bearing: initialPos.bearing,
  attributionControl: false,
  calculateTileZoomFunction: (requestedZoom) => {
    return Math.min(requestedZoom, 15);
  },
  canvasContextAttributes: { antialias: true }
});

const attributionControl = new AttributionControl({ compact: true, customAttribution: attribution });

map.addControl(attributionControl);
map.addControl(new NavigationControl({}), "top-left");
map.addControl(new FullscreenControl(), "top-right");

if (debug) {
  const debugEl = document.createElement("div");
  debugEl.id = "debug-overlay";
  Object.assign(debugEl.style, {
    position: "absolute",
    left: "8px",
    bottom: "8px",
    zIndex: "1000",
    padding: "4px 8px",
    background: "rgba(0, 0, 0, 0.65)",
    color: "#fff",
    font: "12px/1.4 monospace",
    whiteSpace: "pre",
    pointerEvents: "none",
    borderRadius: "3px"
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

// ─── "Show only never-built" checkbox control ──────────────────────────────
//
// Filters "3d-buildings" (and its matching "building-outline" line layer)
// down to only features tagged meta === "never-built", on top of the
// existing hide_3d exclusion — so unchecking always restores the normal
// full building set, not just "no filter at all".
//
// ⚠️ ASSUMPTION NOT YET VERIFIED: this project's own metadata.json
// (building source-layer field list) did not list a "meta" field as of
// the last time it was checked in this conversation — only architect,
// color, height, levels, material, name, render_height,
// render_min_height, roof*, type, wikidata, windows, etc. Either the
// tileset has since been rebuilt with this field added, or the actual
// property name/value differs. Confirm via the existing debug building
// popup (click a building with debug=true) before trusting this filter
// to do anything — if the field name is wrong, the checkbox will simply
// hide ALL buildings (since none will match), which would be an obvious
// giveaway that the property name/value needs adjusting below.

const BASE_BUILDING_FILTER: maplibregl.FilterSpecification = ["!=", ["get", "hide_3d"], true];

const NEVER_BUILT_FILTER: maplibregl.FilterSpecification = ["==", ["get", "meta"], "never-built"];

function applyBuildingFilter(m: maplibregl.Map, onlyNeverBuilt: boolean): void {
  const filter: maplibregl.FilterSpecification = onlyNeverBuilt ? ["all", BASE_BUILDING_FILTER, NEVER_BUILT_FILTER] : BASE_BUILDING_FILTER;

  if (m.getLayer("3d-buildings")) {
    m.setFilter("3d-buildings", filter);
  }
  if (m.getLayer("building-outline")) {
    m.setFilter("building-outline", filter);
  }
}

const neverBuiltControlEl = document.createElement("div");
neverBuiltControlEl.id = "never-built-toggle";

const neverBuiltCheckbox = document.createElement("input");
neverBuiltCheckbox.type = "checkbox";
neverBuiltCheckbox.id = "never-built-checkbox";
neverBuiltCheckbox.style.cursor = "pointer";

const neverBuiltLabel = document.createElement("label");
neverBuiltLabel.htmlFor = "never-built-checkbox";
neverBuiltLabel.textContent = "Show only never-built buildings";
neverBuiltLabel.style.cursor = "pointer";

neverBuiltControlEl.appendChild(neverBuiltCheckbox);
neverBuiltControlEl.appendChild(neverBuiltLabel);
map.getContainer().appendChild(neverBuiltControlEl);

neverBuiltCheckbox.addEventListener("change", () => {
  applyBuildingFilter(map, neverBuiltCheckbox.checked);
});

const treeLayer = new TreeLayer();

// ─── Building popup tracking ────────────────────────────────────────────────
//
// Kept as a module-level reference so it can be closed programmatically —
// e.g. the moment the view starts transitioning to overhead (see
// startTween below), since the building it's anchored to is about to fade
// out and leaving the popup open looks orphaned/disconnected.

let activePopup: maplibregl.Popup | undefined;

function closeActivePopup(): void {
  if (activePopup) {
    activePopup.remove();
    activePopup = undefined;
  }
}

// ─── 3D transition ────────────────────────────────────────────────────────────

const OVERHEAD_THRESHOLD = 5;
const TRANSITION_MS = 600;

const tween = {
  value: 1, // 0 = flat/overhead, 1 = full 3D
  target: 1,
  startVal: 1,
  startTime: 0,
  raf: 0
};

// ── Terrain config ─────────────────────────────────────────────────────────

const BASE_TERRAIN_EXAGGERATION = 2;

function easeCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function applyTweenValue(m: maplibregl.Map, v: number): void {
  if (m.getLayer("3d-buildings")) {
    m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
  }

  // Tree custom layer
  treeLayer.setOpacity(v);

  m.triggerRepaint();
}

/**
 * Called once when the tween finishes.
 * Safe to toggle visibility/geometry here because we are fully faded.
 */
function onTweenComplete(m: maplibregl.Map, flat: boolean): void {
  // Show/hide hillshade only when buildings are already invisible
  // so the pop-in is not visible.
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", flat ? "none" : "visible");
  }

  setTerrainFlattened(m, flat);
}

function startTween(m: maplibregl.Map, target: number): void {
  if (tween.target === target) return;

  if (target === 0) {
    closeActivePopup();
    prewarmFlatTerrainTile(m);
  }

  cancelAnimationFrame(tween.raf);
  tween.target = target;
  tween.startVal = tween.value;
  tween.startTime = performance.now();

  // When going 3D→flat, show hills immediately so they fade with buildings.
  // When going flat→3D, show hills immediately too.
  if (m.getLayer("hills")) {
    m.setLayoutProperty("hills", "visibility", "visible");
  }

  const tick = (now: number) => {
    const elapsed = now - tween.startTime;
    const progress = Math.min(elapsed / TRANSITION_MS, 1);
    const eased = easeCubic(progress);
    tween.value = Math.min(1, Math.max(0, tween.startVal + (target - tween.startVal) * eased));

    applyTweenValue(m, tween.value);

    if (progress < 1) {
      tween.raf = requestAnimationFrame(tick);
    } else {
      tween.value = target; // exact target, no floating point residue at the very end
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

const FLAT_SOURCE_ID = "terrainSourceFlat";
const FLAT_EXAGGERATION = 2;
const DEM_RED_FACTOR = 0.4;
const DEM_GREEN_FACTOR = 0.4;
const DEM_BLUE_FACTOR = 0.4;
const DEM_BASE_SHIFT = 0;

function quantizeElevation(elevationMeters: number): {
  rgb: [number, number, number];
  actualElevation: number;
} {
  const totalFactor = DEM_RED_FACTOR + DEM_GREEN_FACTOR + DEM_BLUE_FACTOR;
  const raw = (elevationMeters - DEM_BASE_SHIFT) / totalFactor;
  const channel = Math.max(0, Math.min(255, Math.round(raw)));
  const actualElevation = channel * totalFactor + DEM_BASE_SHIFT;
  return { rgb: [channel, channel, channel], actualElevation };
}

const flatTileBufferCache = new Map<string, Promise<ArrayBuffer>>();

function getFlatTileBuffer(roundedElevationMeters: number): Promise<ArrayBuffer> {
  const key = String(roundedElevationMeters);
  let cached = flatTileBufferCache.get(key);
  if (!cached) {
    cached = generateFlatTilePNG(roundedElevationMeters);
    flatTileBufferCache.set(key, cached);
  }
  return cached;
}

async function generateFlatTilePNG(elevationMeters: number): Promise<ArrayBuffer> {
  const { rgb } = quantizeElevation(elevationMeters);

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  ctx.fillRect(0, 0, size, size);

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
  );

  return blob.arrayBuffer();
}

/** Registered once, globally. Reads the target elevation out of the
 *  tile URL's `?e=` query param (so changing elevation means changing
 *  the URL, which naturally busts MapLibre's tile cache — see below). */
maplibregl.addProtocol("flatdem", async (params) => {
  const match = params.url.match(/[?&]e=(-?\d+)/);
  const elevationMeters = match ? Number(match[1]) : 0;
  const buffer = await getFlatTileBuffer(elevationMeters);
  return { data: buffer };
});

/** Adds (or replaces) the flat terrain source at a specific elevation.
 *  Removing + re-adding is cheap here since tiles are generated
 *  synchronously in-memory — no real network request involved.
 *
 *  maxzoom is deliberately 0 (see the big comment block above this
 *  section) — every pixel of every tile is identical, so MapLibre only
 *  ever needs to fetch ONE tile total, oversampled to cover whatever's
 *  visible, instead of many tiles across a full zoom range. */
function setFlatTerrainSource(map: maplibregl.Map, elevationMeters: number): void {
  if (map.getSource(FLAT_SOURCE_ID)) {
    map.removeSource(FLAT_SOURCE_ID);
  }

  map.addSource(FLAT_SOURCE_ID, {
    type: "raster-dem",
    tiles: [`flatdem://{z}/{x}/{y}.png?e=${elevationMeters}`],
    tileSize: 256,
    minzoom: minZoom,
    maxzoom: maxZoom,
    encoding: "custom",
    baseShift: DEM_BASE_SHIFT,
    redFactor: DEM_RED_FACTOR,
    greenFactor: DEM_GREEN_FACTOR,
    blueFactor: DEM_BLUE_FACTOR
  });
}

function prewarmFlatTerrainTile(map: maplibregl.Map): void {
  if (!map.getSource("terrainSource")) return;
  const estimate = Math.round(map.getCameraTargetElevation() / FLAT_EXAGGERATION);
  void getFlatTileBuffer(estimate);
}

function setTerrainFlattened(map: maplibregl.Map, flattened: boolean): void {
  const wasClamped = map.getCenterClampedToGround();
  map.setCenterClampedToGround(false); // prevent auto re-clamp during the swap below

  // Elevation currently being displayed — already includes whichever
  // exaggeration is active on the CURRENT terrain — queried BEFORE we
  // touch anything.
  const beforeElevation = map.getCameraTargetElevation();

  let afterElevation: number;

  if (flattened) {
    const roundedTarget = Math.round(beforeElevation / FLAT_EXAGGERATION);
    const { actualElevation } = quantizeElevation(roundedTarget);
    setFlatTerrainSource(map, roundedTarget);
    map.setTerrain({ source: FLAT_SOURCE_ID, exaggeration: FLAT_EXAGGERATION });
    afterElevation = actualElevation * FLAT_EXAGGERATION; // known analytically — no tile-load wait needed
  } else {
    map.setTerrain({ source: "terrainSource", exaggeration: BASE_TERRAIN_EXAGGERATION });
    afterElevation = beforeElevation;
  }

  map.setCenterElevation(afterElevation);
  map.once("idle", () => {
    map.setCenterClampedToGround(wasClamped);
    // Trees bake ground elevation into a static GPU buffer at build time —
    // they won't automatically follow the new elevation unless refreshed.
    treeLayer.refresh();
  });
}

// ─── Load ─────────────────────────────────────────────────────────────────────

map.on("load", () => {
  map.addSource("terrainSource", terrainSourceDef);
  map.addSource("hillshadeSource", terrainSourceDef);

  map.setTerrain({ source: "terrainSource", exaggeration: BASE_TERRAIN_EXAGGERATION });

  map.addLayer({
    id: "hills",
    type: "hillshade",
    source: "hillshadeSource",
    layout: { visibility: "visible" },
    paint: {
      "hillshade-shadow-color": "#473B24",
      "hillshade-exaggeration": 0.4
    }
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
    source: sourceName,
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 13, // was 13
    filter: BASE_BUILDING_FILTER,
    paint: {
      "fill-extrusion-color": ["case", ["has", "color"], ["get", "color"], "#aaa"],
      "fill-extrusion-opacity": 1,
      "fill-extrusion-vertical-gradient": true,
      "fill-extrusion-height": ["get", "render_height"],
      "fill-extrusion-base": ["get", "render_min_height"]
    }
  });

  map.addLayer({
    id: "building-outline",
    type: "line",
    source: sourceName,
    "source-layer": "building",
    minzoom: 13,
    filter: BASE_BUILDING_FILTER,
    paint: { "line-color": "#333", "line-width": 0.6, "line-opacity": 0.8 }
  });

  // Re-apply based on the checkbox's current state (harmless no-op if it
  // hasn't been touched — both layers were just created with
  // BASE_BUILDING_FILTER above, which matches the unchecked default).
  applyBuildingFilter(map, neverBuiltCheckbox.checked);

  treeLayer.source = sourceName;
  treeLayer.sourceLayers = ["tree", "tree_row"];
  treeLayer.heightProperty = "height";
  treeLayer.baseHeightMeters = 6;
  treeLayer.treeRowSpacing = 3;
  treeLayer.debug = debug;
  treeLayer.minzoom = 13; // matches "3d-buildings"' own minzoom
  treeLayer.addTo(map, "building-outline"); // insert before this layer, adjust as desired
  //treeLayer.addTo(map);

  if (debug) {
    console.log("treeLayer.opacity:", treeLayer.opacity);
  }

  const architectureModelBWLayer = new ArchitectureModelBWLayer();
  map.addLayer(architectureModelBWLayer);
  architectureModelBWLayer.contrast = 1.5;
  architectureModelBWLayer.edgeStrength = 0.2; // stronger "cut edges"
  architectureModelBWLayer.grainAmount = 0.04; // rougher matte texture
  architectureModelBWLayer.paperTone = [1, 1, 1]; // pure white plaster
  architectureModelBWLayer.shadowTone = [0.03, 0.03, 0.05]; // cool shadow tint
  architectureModelBWLayer.antialias = true;
  map.triggerRepaint();

  // ── Apply initial state without animating ─────────────────────────────────
  const startFlat = isOverhead(map);
  tween.value = startFlat ? 0 : 1;
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
        closeActivePopup();
        activePopup = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
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

if (debug) {
  (window as any).treeLayer = treeLayer;
  (window as any).map = map;
}

export default map;
