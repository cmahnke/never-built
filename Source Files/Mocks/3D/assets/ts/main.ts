// assets/ts/main.ts

import * as maplibregl from "maplibre-gl";
import { center, points } from "@turf/turf";
import { loadOrParse, absUrl } from "./base-map";
import { TreeLayer } from "./layers/tree-layer";
import { ArchitectureModelBWLayer } from "./layers/architecture-model-bw-layer";
import { updateStyle, setupDefaultStyle, defaultSprites, getSouceName } from "./styles";
import "maplibre-gl/dist/maplibre-gl.css";
import { NavigationControl, FullscreenControl, AttributionControl } from "maplibre-gl";
import chroma from "chroma-js";
import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { UAParser } from 'ua-parser-js';


import type { LngLatLike, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

const debug = false;
const tileSource = "Blauer-Turm"; //"Klinikum", "Gemeindezentrum-Grone";
const metaJson = `/map/${tileSource}/metadata.json`;
const styleJson = "/map-styles/style.json";
const tilesUrl = `/map/${tileSource}/{z}/{x}/{y}.pbf`;
const topoRasterTiles = "/map/tiles/{z}/{x}/{y}.png";
const buildingLayerName = "projektemacher-building";
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
let canvasContextAttributes = { antialias: true };
const marker = {
  anchor: [0.5, 1],
  anchorXUnits: "fraction",
  anchorYUnits: "fraction",
  scale: 0.075,
  src: "/images/marker.svg"
};

if (new UAParser().getOS() === "iOS") {
  canvasContextAttributes = {};
}


const translations = {
  en: {
    map: {
      hideBuildings: "Show only never-built buildings"
    }
  },
  de: {
    map: {
      hideBuildings: "Nur nicht gebaute Gebäude zeigen"
    }
  }
};

i18next.use(LanguageDetector).init({
  debug: false,
  fallbackLng: "en",
  resources: translations,
  supportedLngs: ["en", "de"]
});

// ─── Building color scheme ──────────────────────────────────────────────────
//
// Debug mode keeps real per-building colors (useful for inspecting data).
// Normal mode uses a flat greyscale tone instead — keeps the "physical
// architecture model" look consistent even when the BW post-process layer
// is faded out (e.g. in the overhead/flat view — see applyTweenValue).


//TODO: Check is this is needed before remofing the shader when looked from above
//const BUILDING_COLOR_DEBUG: maplibregl.DataDrivenPropertyValueSpecification<string> = ["case", ["has", "color"], ["get", "color"], "#aaa"];
//const BUILDING_COLOR_GREYSCALE = "#c9c9c9";
//const buildingFillColor = debug ? BUILDING_COLOR_DEBUG : BUILDING_COLOR_GREYSCALE;
const buildingFillColor = ["case", ["has", "color"], ["get", "color"], "#aaa"];

const CAMERA_FOCAL_LENGTH_MM = 50; // use 0 to use default
const CAMERA_SENSOR_HEIGHT_MM = 24; // standard full-frame sensor height

function focalLengthToVerticalFovDeg(focalLengthMm: number, sensorHeightMm = CAMERA_SENSOR_HEIGHT_MM): number {
  const fovRad = 2 * Math.atan(sensorHeightMm / (2 * focalLengthMm));
  return (fovRad * 180) / Math.PI;
}

const CAMERA_VERTICAL_FOV_DEG = focalLengthToVerticalFovDeg(CAMERA_FOCAL_LENGTH_MM);

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
  console.error("Can't create center from features or bbox");
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

//Rename the source for 'projektemacher-building'
if (buildingLayerName !== undefined && buildingLayerName != "") {
  style.layers.forEach((layer) => {
    if (layer["source-layer"] === "building") {
      layer["source-layer"] = "projektemacher-building";
    }
  });
}

if (debug) {
  console.log(style);
}

const sourceName = getSourceName(style);

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
  canvasContextAttributes: canvasContextAttributes
});

if (CAMERA_FOCAL_LENGTH_MM != 0) {
  map.setVerticalFieldOfView(CAMERA_VERTICAL_FOV_DEG);
  if (debug) {
    console.log(`[camera] focal length ${CAMERA_FOCAL_LENGTH_MM}mm -> vertical FOV ${CAMERA_VERTICAL_FOV_DEG.toFixed(2)}°`);
  }
}

// ─── Loading screen cross-fade ──────────────────────────────────────────────
//
// The map container (.map-3d, opacity 0 by default via CSS) and the
// rotating-square overlay (#map-loading, opacity 1 by default) are
// cross-faded via a CSS `transition` on their opacity, toggled by adding/
// removing classes here — NOT via an auto-running CSS animation, since we
// need to trigger this at a specific moment (once tiles are actually
// rendered, not just once the style JSON is parsed) rather than
// immediately when the elements are created. See revealMapWhenReady().

const mapContainerEl = map.getContainer();
const loadingEl = document.getElementById("map-loading");

function revealMapWhenReady(m: maplibregl.Map): void {
  const POLL_INTERVAL_MS = 100;
  const MAX_WAIT_MS = 8000;
  const startTime = performance.now();

  const reveal = (): void => {
    mapContainerEl.classList.add("map-3d-visible");
    loadingEl?.classList.add("map-loading-hidden");
  };

  const poll = (): void => {
    if (m.areTilesLoaded()) {
      reveal();
      return;
    }
    if (performance.now() - startTime >= MAX_WAIT_MS) {
      if (debug) {
        console.warn("[loading] areTilesLoaded() never returned true within timeout — revealing map anyway.");
      }
      reveal();
      return;
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
}

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

const treeLayer = new TreeLayer();

// ─── "Show only never-built" checkbox control ──────────────────────────────

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

  treeLayer.setOpacity(onlyNeverBuilt ? 0 : 1);
}

const neverBuiltControlEl = document.createElement("div");
neverBuiltControlEl.id = "never-built-toggle";

const neverBuiltCheckbox = document.createElement("input");
neverBuiltCheckbox.type = "checkbox";
neverBuiltCheckbox.id = "never-built-checkbox";
neverBuiltCheckbox.style.cursor = "pointer";

const neverBuiltLabel = document.createElement("label");
neverBuiltLabel.htmlFor = "never-built-checkbox";
neverBuiltLabel.textContent = i18next.t("map:hideBuildings");
neverBuiltLabel.style.cursor = "pointer";

neverBuiltControlEl.appendChild(neverBuiltCheckbox);
neverBuiltControlEl.appendChild(neverBuiltLabel);
map.getContainer().appendChild(neverBuiltControlEl);

neverBuiltCheckbox.addEventListener("change", () => {
  applyBuildingFilter(map, neverBuiltCheckbox.checked);
});

// Declared at module scope (not inside map.on("load", ...)) so
// applyTweenValue() below — which also runs outside that block — can
// reference it to fade its opacity, same pattern as treeLayer.
const architectureModelBWLayer = new ArchitectureModelBWLayer();

// ─── Building popup tracking ────────────────────────────────────────────────

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

const BASE_TERRAIN_EXAGGERATION = 1;

function easeCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function applyTweenValue(m: maplibregl.Map, v: number): void {
  if (m.getLayer("3d-buildings")) {
    m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
  }

  // Tree custom layer
  treeLayer.setOpacity(v);

  // Architecture-model post-process (grain/contrast/edge-darkening) layer —
  // faded in lockstep with buildings/trees, using the same tween value, so
  // the overhead view drops the "physical model" look along with the 3D
  // geometry it was designed to accentuate.
  architectureModelBWLayer.opacity = v;

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

/** Hides the "show only never-built buildings" control while looking
 *  straight down — the flat/overhead view has no visible 3D building
 *  extrusions to distinguish, so the toggle has nothing meaningful to
 *  affect at that pitch. Reuses the same overhead threshold already
 *  driving the 3D-fade tween, so both stay in sync. */
function updateNeverBuiltControlVisibility(m: maplibregl.Map): void {
  neverBuiltControlEl.style.display = isOverhead(m) ? "none" : "flex";
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
  treeLayer.terrainExaggeration = flattened ? FLAT_EXAGGERATION : BASE_TERRAIN_EXAGGERATION;

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
    "source-layer": buildingLayerName, //"building",
    type: "fill-extrusion",
    minzoom: 13, // was 13
    filter: BASE_BUILDING_FILTER,
    paint: {
      "fill-extrusion-color": buildingFillColor,
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
    "source-layer": buildingLayerName,
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
  treeLayer.terrainExaggeration = BASE_TERRAIN_EXAGGERATION;
  treeLayer.minzoom = 13; // matches "3d-buildings"' own minzoom
  //treeLayer.addTo(map, "building-outline"); // insert before this layer, adjust as desired
  treeLayer.enableSanityTriangle = true;
  treeLayer.addTo(map);

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
  updateNeverBuiltControlVisibility(map);

  // Only now (after every layer above has actually been added) do we
  // start waiting for "idle" to reveal the map — see revealMapWhenReady().
  // revealMapWhenReady(map);
  map.once("idle", () => {
    revealMapWhenReady(map);
  });

  // ── React to pitch changes ────────────────────────────────────────────────
  map.on("pitch", () => {
    sync3DVisibility(map);
    updateNeverBuiltControlVisibility(map);
  });

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
if (debug) {
  console.log(camPos, map);
  (window as any).treeLayer = treeLayer;
  (window as any).map = map;
}

export default map;
