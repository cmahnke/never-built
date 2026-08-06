// assets/ts/3d-map.ts

import * as maplibregl from "maplibre-gl";
import { center as turfCenter } from "@turf/turf";
import { loadOrParse, absUrl } from "./base-map";
import { setLayerColorByTag } from "./maplibregl-util";
import { TreeLayer } from "./layers/tree-layer";
import { ArchitectureModelBWLayer } from "./layers/architecture-model-bw-layer";
import { updateStyle, setupDefaultStyle, defaultSprites, getSourceName } from "./styles";
import "maplibre-gl/dist/maplibre-gl.css";
import { NavigationControl, FullscreenControl, AttributionControl } from "maplibre-gl";
import chroma from "chroma-js";
import i18next from "i18next";
import { getMaplibreGLLocale, translations } from "./base-map";
import { addGeoJSONLayersAndInteractions } from "./map";
import LanguageDetector from "i18next-browser-languagedetector";
import { UAParser } from "ua-parser-js";
import type { GeoJSON } from "geojson";

import type { MapOptions, LngLatLike, RasterDEMSourceSpecification, StyleSpecification } from "maplibre-gl";

export interface CameraPositionConfig {
  cameraLngLat: LngLatLike;
  cameraAlt: number;
  bearing: number;
  pitch: number;
  roll: number;
  zoom?: number;
}

type BBoxInput = number[] | number[][] | string;
interface MarkerOptions {
  src: string;
  scale?: number;
  anchor?: [number, number];
}

export type FeatureTagValue = string | number | boolean | null;
export interface FeatureTag {
  name: string;
  value: FeatureTagValue;
}

interface MaplibreMapWithLegacyShim extends Map {
  /** @deprecated Use resize() instead. Kept for legacy call-site compatibility. */
  updateSize?: () => void;
}

interface FreeCameraOptionsShim {
  position?: {
    toAltitude(): number;
  };
}

interface MaplibreMapInternal extends maplibregl.Map {
  transform?: {
    cameraToCenterDistance?: number;
    worldSize?: number;
  };
  getFreeCameraOptions?: () => FreeCameraOptionsShim;
}

/* Defaults */
export const BUILDING_LAYER_NAME = "projektemacher-building";
export const MARKER_TAG: FeatureTag = { name: "meta", value: "never-built" };
const HIGHLIGHT_COLOR = "#ff00ff";
// Camera settings
const CAMERA_FOCAL_LENGTH_MM = 50;
const CAMERA_SENSOR_HEIGHT_MM = 24;
// Overhead / map mode
const OVERHEAD_THRESHOLD = 5;
const TRANSITION_MS = 600;
// Terrain
const BASE_TERRAIN_EXAGGERATION = 1;

export async function projektemacher3DMap(
  container: string | HTMLElement,
  geojson?: string | GeoJSON.FeatureCollection,
  source?: string,
  styleJson?: string | StyleSpecification,
  bbox?: string | BBoxInput,
  centerPoint?: string | LngLatLike,
  initialZoom = 14,
  minZoom = 12,
  maxZoom = 16,
  cluster?: boolean,
  disabled?: boolean,
  popup?: boolean,
  background = "#eee",
  debug?: boolean,
  marker?: MarkerOptions,
  font?: string,
  attribution = '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  fontPath = "/css/fonts/{font-family}.css",
  initialPos?: CameraPositionConfig,
  topoRasterTiles?: string
): Promise<maplibregl.Map> {
  let zoom: number = initialZoom;
  const maxPitch = disabled ? 0 : 75;

  // Background
  const fog = "#dcdbdf";
  const sky = "#87ceeb";
  const blend = 0.2;

  const hasTerrain = topoRasterTiles !== undefined;

  let mapOptions: MapOptions = {
    container: container,
    canvasContextAttributes: { antialias: true }
  };

  if (new UAParser().getOS().is("iOS")) {
    mapOptions.canvasContextAttributes.antialias = false;
  }

  if (initialPos !== undefined) {
    mapOptions = { ...mapOptions, pitch: initialPos.pitch, bearing: initialPos.bearing };
    if ("zoom" in initialPos) {
      zoom = initialPos.zoom;
    }
  }

  if(!i18next.isInitialized) {
    i18next.use(LanguageDetector).init({
      debug: false,
      fallbackLng: "en",
      resources: translations,
      supportedLngs: ["en", "de"]
    });
  }

  const buildingFillColor: maplibregl.ExpressionSpecification = ["case", ["has", "color"], ["get", "color"], "#aaa"];

  function focalLengthToVerticalFovDeg(focalLengthMm: number, sensorHeightMm = CAMERA_SENSOR_HEIGHT_MM): number {
    const fovRad = 2 * Math.atan(sensorHeightMm / (2 * focalLengthMm));
    return (fovRad * 180) / Math.PI;
  }

  const CAMERA_VERTICAL_FOV_DEG = focalLengthToVerticalFovDeg(CAMERA_FOCAL_LENGTH_MM);
  const DEFAULT_VERTICAL_FOV_DEG = 36.86989764584402; // MapLibre default FOV

  const skyColors = chroma.scale([fog, sky]).mode("lab").colors(6);

  let centerObj: LngLatLike;

  let geojsonObj: GeoJSON;
  if (geojson !== undefined) {
    geojsonObj = typeof geojson === "string" ? ((await loadOrParse(geojson as string)) as GeoJSON) : (geojson as GeoJSON);
  }
  let geojsonLayerNames;

  if (centerPoint !== undefined) {
    centerObj = (await loadOrParse(centerPoint as string)) as LngLatLike;
  } else if (geojsonObj !== undefined && geojsonObj.features?.length !== 0) {
    centerObj = turfCenter(geojsonObj as GeoJSON.FeatureCollection).geometry.coordinates as [number, number];
  } else {
    centerObj = [0, 0];
  }

  let bboxObj: number[][] | undefined;
  if (bbox !== undefined) {
    const raw = (await loadOrParse(bbox as string)) as number[] | number[][];
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

  if (centerObj[0] === 0 && centerObj[1] === 0 && bboxObj.length !== 0) {
    const [[w, s], [e, n]] = bboxObj;
    centerObj = [(w + e) / 2, (s + n) / 2];
  }

  if (initialPos === undefined || disabled) {
    initialPos = {
      cameraLngLat: initialPos?.cameraLngLat || centerObj,
      cameraAlt: initialPos?.cameraAlt || 500,
      bearing: 0,
      pitch: 0,
      roll: 0
    };
  }

  let style: StyleSpecification;
  if (styleJson !== undefined) {
    const styleDef = (await loadOrParse(styleJson as string)) as StyleSpecification;
    style = updateStyle(
      styleDef,
      source,
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
    style = setupDefaultStyle(source, initialZoom, minZoom, maxZoom, bboxObj, centerObj, background);
  }

  if (BUILDING_LAYER_NAME !== undefined && BUILDING_LAYER_NAME != "") {
    style.layers.forEach((layer) => {
      if (layer["source-layer"] === "building") {
        layer["source-layer"] = BUILDING_LAYER_NAME;
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
    if (layer.id.includes("admin") || layer.id === "housenumber") return false;
    return true;
  });

  style.layers = style.layers.map((layer) => {
    if (layer.id.includes("label")) {
      layer.paint = layer.paint || {};

      if (layer.type === "symbol") {
        layer.paint["text-opacity"] = 0;
        layer.paint["icon-opacity"] = 0;
      } else {
        layer.paint["opacity"] = 0;
      }
    }
    return layer;
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

  const map = new maplibregl.Map({
    container: container,
    style,
    center: centerObj,
    maxBounds: bboxObj,
    zoom,
    minZoom,
    maxPitch: maxPitch,
    dragRotate: !disabled,
    touchPitch: !disabled,
    pitchWithRotate: !disabled,
    attributionControl: false,
    locale: getMaplibreGLLocale(),
    calculateTileZoomFunction: (requestedZoom) => {
      return Math.min(requestedZoom, 15);
    },
    ...mapOptions
  });

  // @ts-expect-error This will report an error since TS handles `const` like a type decleration
  if (CAMERA_FOCAL_LENGTH_MM != 0) {
    map.setVerticalFieldOfView(CAMERA_VERTICAL_FOV_DEG);
    if (debug) {
      console.log(`[camera] focal length ${CAMERA_FOCAL_LENGTH_MM}mm -> vertical FOV ${CAMERA_VERTICAL_FOV_DEG.toFixed(2)}°`);
    }
  }

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

    function getCurrentCameraPosition(m: maplibregl.Map): CameraPositionConfig {
      const mapInternal = m as unknown as MaplibreMapInternal;
      const transform = mapInternal.transform;
      const pitch = m.getPitch();
      let altitude = 0;

      if (transform && transform.cameraToCenterDistance !== undefined && transform.worldSize !== undefined) {
        const pitchInRadians = pitch * (Math.PI / 180);
        const altitudeWithoutScaling = Math.cos(pitchInRadians) * transform.cameraToCenterDistance;
        const earthCircAtLat = 2 * Math.PI * 6378137 * Math.abs(Math.cos(m.getCenter().lat * (Math.PI / 180)));
        const verticalScaleConstant = transform.worldSize / earthCircAtLat;
        altitude = altitudeWithoutScaling / verticalScaleConstant;
      } else if (mapInternal.getFreeCameraOptions) {
        const camera = mapInternal.getFreeCameraOptions();
        if (camera && camera.position) {
          altitude = camera.position.toAltitude();
        }
      }

      const roll = typeof m.getRoll === "function" ? m.getRoll() : 0;

      return {
        cameraLngLat: [m.getCenter().lng, m.getCenter().lat],
        cameraAlt: altitude,
        pitch,
        bearing: m.getBearing(),
        roll
      };
    }

    const updateDebugOverlay = (): void => {
      const c = map.getCenter();
      const camPos = getCurrentCameraPosition(map);
      debugEl.textContent =
        `zoom:    ${map.getZoom().toFixed(2)}\n` +
        `pitch:   ${map.getPitch().toFixed(1)}\n` +
        `bearing: ${map.getBearing().toFixed(1)}\n` +
        `center:  ${c.lng.toFixed(5)}, ${c.lat.toFixed(5)}\n` +
        `camPos: ${JSON.stringify(camPos)}`;
    };

    updateDebugOverlay();
    map.on("move", updateDebugOverlay);
  }

  const treeLayer = new TreeLayer();

  const BASE_BUILDING_FILTER: maplibregl.FilterSpecification = ["!=", ["get", "hide_3d"], true];
  const NEVER_BUILT_FILTER: maplibregl.FilterSpecification = ["==", ["get", MARKER_TAG.name], MARKER_TAG.value];

  function applyBuildingFilter(m: maplibregl.Map, onlyNeverBuilt: boolean): void {
    const filter: maplibregl.FilterSpecification = onlyNeverBuilt
      ? ["all", BASE_BUILDING_FILTER, NEVER_BUILT_FILTER]
      : BASE_BUILDING_FILTER;

    if (m.getLayer("3d-buildings")) {
      m.setFilter("3d-buildings", filter);
    }
    if (m.getLayer("building-fill")) {
      m.setFilter("building-fill", filter);
    }
    if (m.getLayer("building-outline")) {
      m.setFilter("building-outline", filter);
    }

    const treeOpacity = onlyNeverBuilt ? 0 : tween.value;
    treeLayer.setOpacity(treeOpacity);
    m.triggerRepaint();
  }

  function applyHighlight(m: maplibregl.Map, enabled: boolean): void {
    if (m.getLayer("3d-buildings")) {
      const color = enabled
        ? [
            "case",
            ["==", ["get", MARKER_TAG.name], MARKER_TAG.value],
            HIGHLIGHT_COLOR,
            ["case", ["has", "color"], ["get", "color"], "#aaa"]
          ]
        : buildingFillColor;
      m.setPaintProperty("3d-buildings", "fill-extrusion-color", color as maplibregl.ColorSpecification);
    }

    // In top-down view, the fill only applies to highlighted buildings.
    // Non-highlighted buildings remain transparent (no fill, only outlines).
    if (m.getLayer("building-fill")) {
      const fillColor = enabled
        ? ["case", ["==", ["get", MARKER_TAG.name], MARKER_TAG.value], HIGHLIGHT_COLOR, "rgba(0, 0, 0, 0)"]
        : "rgba(0, 0, 0, 0)";
      m.setPaintProperty("building-fill", "fill-color", fillColor as maplibregl.ColorSpecification);
    }

    if (m.getLayer("building-outline")) {
      const outlineColor = enabled ? ["case", ["==", ["get", MARKER_TAG.name], MARKER_TAG.value], HIGHLIGHT_COLOR, "#333"] : "#333";
      m.setPaintProperty("building-outline", "line-color", outlineColor as maplibregl.ColorSpecification);
    }
    m.triggerRepaint();
  }

  const neverBuiltControlEl = document.createElement("div");
  neverBuiltControlEl.id = "never-built-toggle";
  neverBuiltControlEl.style.display = "flex";
  neverBuiltControlEl.style.flexDirection = "column";
  neverBuiltControlEl.style.gap = "4px";

  const neverBuiltCheckbox = document.createElement("input");
  neverBuiltCheckbox.type = "checkbox";
  neverBuiltCheckbox.id = "never-built-checkbox";
  neverBuiltCheckbox.style.cursor = "pointer";

  const neverBuiltLabel = document.createElement("label");
  neverBuiltLabel.htmlFor = "never-built-checkbox";
  neverBuiltLabel.textContent = i18next.t("3d:hideBuildings");
  neverBuiltLabel.style.cursor = "pointer";

  const row1 = document.createElement("div");
  row1.style.display = "flex";
  row1.style.alignItems = "center";
  row1.appendChild(neverBuiltCheckbox);
  row1.appendChild(neverBuiltLabel);

  const highlightCheckbox = document.createElement("input");
  highlightCheckbox.type = "checkbox";
  highlightCheckbox.id = "highlight-checkbox";
  highlightCheckbox.style.cursor = "pointer";

  const highlightLabel = document.createElement("label");
  highlightLabel.htmlFor = "highlight-checkbox";
  highlightLabel.textContent = i18next.t("3d:highlightBuildings");
  highlightLabel.style.cursor = "pointer";

  const row2 = document.createElement("div");
  row2.style.display = "flex";
  row2.style.alignItems = "center";
  row2.appendChild(highlightCheckbox);
  row2.appendChild(highlightLabel);

  neverBuiltControlEl.appendChild(row1);
  neverBuiltControlEl.appendChild(row2);
  map.getContainer().appendChild(neverBuiltControlEl);

  neverBuiltCheckbox.addEventListener("change", () => {
    applyBuildingFilter(map, neverBuiltCheckbox.checked);
  });

  highlightCheckbox.addEventListener("change", () => {
    applyHighlight(map, highlightCheckbox.checked);
  });

  const architectureModelBWLayer = new ArchitectureModelBWLayer();

  let activePopup: maplibregl.Popup | undefined;

  function closeActivePopup(): void {
    if (activePopup) {
      activePopup.remove();
      activePopup = undefined;
    }
  }

  const tween = {
    value: 1,
    target: 1,
    startVal: 1,
    startTime: 0,
    raf: 0
  };

  const labelLayerIds: { id: string; type: string }[] = [];

  function easeCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function applyTweenValue(m: maplibregl.Map, v: number): void {
    // v goes from 1 (side-view / 3D) to 0 (top-down / flat)

    // 1. Fade out 3D buildings (leave building-outline visible for top-down view)
    if (m.getLayer("3d-buildings")) {
      m.setPaintProperty("3d-buildings", "fill-extrusion-opacity", v);
    }
    // Fade in building fill for top-down view
    if (m.getLayer("building-fill")) {
      m.setPaintProperty("building-fill", "fill-opacity", 1 - v);
    }

    // Combine tween value with the never-built checkbox state for trees
    const treeOpacity = neverBuiltCheckbox?.checked ? 0 : v;
    treeLayer.setOpacity(treeOpacity);

    // 2. Phase out the architecture-model-bw-layer shader layer
    architectureModelBWLayer.opacity = v <= 0.01 ? 0 : v;

    // Toggle visibility to ensure the layer is completely disabled at top-down view
    if (architectureModelBWLayer.id && m.getLayer(architectureModelBWLayer.id)) {
      m.setLayoutProperty(architectureModelBWLayer.id, "visibility", v <= 0.01 ? "none" : "visible");
    }

    // 3. Fade in street names (labels)
    const labelOpacity = 1 - v;
    for (const { id, type } of labelLayerIds) {
      if (m.getLayer(id)) {
        if (type === "symbol") {
          m.setPaintProperty(id, "text-opacity", labelOpacity);
          m.setPaintProperty(id, "icon-opacity", labelOpacity);
        } else {
          m.setPaintProperty(id, "opacity", labelOpacity);
        }
      }
    }

    // 4. Reset focal length to default (MapLibre default is ~36.87 degrees)
    const currentFov = CAMERA_VERTICAL_FOV_DEG + (DEFAULT_VERTICAL_FOV_DEG - CAMERA_VERTICAL_FOV_DEG) * (1 - v);
    m.setVerticalFieldOfView(currentFov);

    m.triggerRepaint();
  }

  function onTweenComplete(m: maplibregl.Map, flat: boolean): void {
    if (hasTerrain) {
      if (m.getLayer("hills")) {
        m.setLayoutProperty("hills", "visibility", flat ? "none" : "visible");
      }
      setTerrainFlattened(m, flat);
    }
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

    if (hasTerrain && m.getLayer("hills")) {
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

  function updateNeverBuiltControlVisibility(m: maplibregl.Map): void {
    // Keep control visible from above for highlight functionality
    neverBuiltControlEl.style.display = "flex";
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

  maplibregl.addProtocol("flatdem", async (params) => {
    const match = params.url.match(/[?&]e=(-?\d+)/);
    const elevationMeters = match ? Number(match[1]) : 0;
    const buffer = await getFlatTileBuffer(elevationMeters);
    return { data: buffer };
  });

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
    if (!hasTerrain || !map.getSource("terrainSource")) return;
    const estimate = Math.round(map.getCameraTargetElevation() / FLAT_EXAGGERATION);
    void getFlatTileBuffer(estimate);
  }

  function setTerrainFlattened(map: maplibregl.Map, flattened: boolean): void {
    if (!hasTerrain) return;

    const wasClamped = map.getCenterClampedToGround();
    map.setCenterClampedToGround(false);

    const beforeElevation = map.getCameraTargetElevation();

    let afterElevation: number;
    treeLayer.terrainExaggeration = flattened ? FLAT_EXAGGERATION : BASE_TERRAIN_EXAGGERATION;

    if (flattened) {
      const roundedTarget = Math.round(beforeElevation / FLAT_EXAGGERATION);
      const { actualElevation } = quantizeElevation(roundedTarget);
      setFlatTerrainSource(map, roundedTarget);
      map.setTerrain({ source: FLAT_SOURCE_ID, exaggeration: FLAT_EXAGGERATION });
      afterElevation = actualElevation * FLAT_EXAGGERATION;
    } else {
      map.setTerrain({ source: "terrainSource", exaggeration: BASE_TERRAIN_EXAGGERATION });
      afterElevation = beforeElevation;
    }

    map.setCenterElevation(afterElevation);
    map.once("idle", () => {
      map.setCenterClampedToGround(wasClamped);
      treeLayer.refresh();
    });
  }

  map.on("load", () => {
    if (hasTerrain) {
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
    }

    map.setSky({
      "sky-color": skyColors[0],
      "sky-horizon-blend": blend,
      "horizon-color": skyColors[2],
      "horizon-fog-blend": blend,
      "fog-color": skyColors[5],
      "fog-ground-blend": 0
    });

    map.addLayer({
      id: "building-fill",
      type: "fill",
      source: sourceName,
      "source-layer": BUILDING_LAYER_NAME,
      minzoom: 13,
      filter: BASE_BUILDING_FILTER,
      paint: {
        "fill-color": "rgba(0, 0, 0, 0)",
        "fill-opacity": 0 // hidden in 3D view, fades in on top-down
      }
    });

    map.addLayer({
      id: "3d-buildings",
      source: sourceName,
      "source-layer": BUILDING_LAYER_NAME,
      type: "fill-extrusion",
      minzoom: 13,
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
      "source-layer": BUILDING_LAYER_NAME,
      minzoom: 14,
      filter: BASE_BUILDING_FILTER,
      paint: { "line-color": "#333", "line-width": 0.6, "line-opacity": 0.8 }
    });

    applyBuildingFilter(map, neverBuiltCheckbox.checked);
    applyHighlight(map, highlightCheckbox.checked);

    treeLayer.source = sourceName;
    treeLayer.sourceLayers = ["tree", "tree_row"];
    treeLayer.heightProperty = "height";
    treeLayer.baseHeightMeters = 6;
    treeLayer.treeRowSpacing = 3;
    treeLayer.debug = debug;
    treeLayer.terrainExaggeration = BASE_TERRAIN_EXAGGERATION;
    treeLayer.minzoom = 13;
    treeLayer.addTo(map);

    map.addLayer(architectureModelBWLayer);
    architectureModelBWLayer.contrast = 1.5;
    architectureModelBWLayer.edgeStrength = 0.2;
    architectureModelBWLayer.grainAmount = 0.04;
    architectureModelBWLayer.paperTone = [1, 1, 1];
    architectureModelBWLayer.shadowTone = [0.03, 0.03, 0.05];
    architectureModelBWLayer.antialias = true;
    architectureModelBWLayer.addHighlightColor(HIGHLIGHT_COLOR);
    map.triggerRepaint();

    // Populate label IDs for street names fading logic
    style.layers.forEach((layer) => {
      if (layer.id.includes("label")) {
        labelLayerIds.push({ id: layer.id, type: layer.type });
      }
    });

    const startFlat = isOverhead(map);
    tween.value = startFlat ? 0 : 1;
    tween.target = startFlat ? 0 : 1;
    applyTweenValue(map, tween.value);
    onTweenComplete(map, startFlat);
    updateNeverBuiltControlVisibility(map);

    /* TODO: Fix this
    if (geojsonObj !== undefined) {
      // Add layers and get their names
      geojsonLayerNames = await addGeoJSONLayersAndInteractions({
        map,
        geojson: geojsonObj,
        cluster,
        marker,
        disabled,
        popup,
      });

      if (debug) {
        console.log('Created GeoJSON Layers:', geojsonLayerNames);
      }

      // TODO: only apply this in overhead mode
      if (geojsonObj.features.length) {
        const box = turfBbox(geojsonObj as GeoJSON) as [number, number, number, number];
        const geojsonBounds: LngLatBoundsLike = [
          [box[0], box[1]],
          [box[2], box[3]],
        ];
        map.fitBounds(geojsonBounds, { padding: defaultPadding });
      }
    }
    */

    map.once("idle", () => {
      revealMapWhenReady(map);
    });

    map.on("pitch", () => {
      sync3DVisibility(map);
      updateNeverBuiltControlVisibility(map);
    });

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

  if (initialPos !== undefined) {
    const camPos = map.calculateCameraOptionsFromCameraLngLatAltRotation(
      initialPos.cameraLngLat,
      initialPos.cameraAlt,
      initialPos.bearing,
      initialPos.pitch,
      initialPos.roll
    );
    map.jumpTo(camPos);
  }

  (map as MaplibreMapWithLegacyShim).updateSize = () => map.resize();

  return map;
}

export function highlight(map: maplibregl.Map) {
  setLayerColorByTag(map, BUILDING_LAYER_NAME, MARKER_TAG, HIGHLIGHT_COLOR);
  if (map.getLayer("building-outline")) {
    map.setPaintProperty("building-outline", "line-color", [
      "case",
      ["==", ["get", MARKER_TAG.name], MARKER_TAG.value],
      HIGHLIGHT_COLOR,
      "#333"
    ] as maplibregl.ExpressionSpecification);
  }
  if (map.getLayer("building-fill")) {
    map.setPaintProperty("building-fill", "fill-color", [
      "case",
      ["==", ["get", MARKER_TAG.name], MARKER_TAG.value],
      HIGHLIGHT_COLOR,
      "rgba(0, 0, 0, 0)"
    ] as maplibregl.ExpressionSpecification);
  }
}

export default projektemacher3DMap;
