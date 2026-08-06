import type { FeatureCollection, Point } from "geojson";
import {
  Map as MapLibreMap,
  ExpressionSpecification,
  Popup,
} from "maplibre-gl";
import type {
  PopupOptions,
  GeoJSONSourceSpecification,
  LineLayerSpecification,
  CircleLayerSpecification,
  SymbolLayerSpecification,
  GeoJSONSource,
  LngLatLike,
} from "maplibre-gl";
import { absUrl } from "./map-utils";
import type { MarkerOptions } from "./map-utils";
import type { AllPaintProperties } from "@maplibre/maplibre-gl-style-spec";

export const SUPPORTED_RASTER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

/** Pixel tolerance around a click point when looking for overlapping point
 * features to merge into a single popup — mirrors the original OpenLayers
 * setup's `markerOptions.hitTolerance`. */
export const popupHitTolerance = 8;

export const popupOptions: PopupOptions = {
  anchor: "bottom-left",
  maxWidth: "none",
};

export interface SetLayerColorOptions {
  readonly paintProperty?: string;
  readonly fallbackColor?: string;
  readonly replace?: boolean;
}

type StyleColorValue = string | ExpressionSpecification;

interface ColorRule {
  readonly tag: FeatureTag;
  readonly color: string;
}

interface ColorOverrideEntry {
  readonly original: StyleColorValue;
  readonly rules: readonly ColorRule[];
}

type LayerOverrideStore = Map<string, ColorOverrideEntry>;
type MapOverrideStore = Map<string, LayerOverrideStore>;

const colorOverrideStores = new WeakMap<MapLibreMap, MapOverrideStore>();

type MapLayer = NonNullable<ReturnType<MapLibreMap["getLayer"]>>;
type MapLayerType = MapLayer["type"];

export type FeatureTagValue = string | number | boolean | null;
export interface FeatureTag {
  name: string;
  value: FeatureTagValue;
}

/* =========================================================================
 * GeoJSON Handling (extracted to avoid side effects)
 * ========================================================================= */

export async function addGeoJSONLayersAndInteractions({
  map,
  geojson,
  cluster,
  marker,
  disabled,
  popup,
}: {
  map: MapLibreMap;
  geojson: FeatureCollection;
  cluster?: boolean;
  marker?: MarkerOptions;
  disabled: boolean;
  popup: boolean;
}): Promise<string[]> {
  const sourceId = "geojson-source";
  const layerIds: string[] = [];

  map.addSource(sourceId, {
    type: "geojson",
    data: geojson,
    cluster: !!cluster,
    clusterRadius: 25,
  } as GeoJSONSourceSpecification);

  if (cluster) {
    layerIds.push(
      `${sourceId}-clusters`,
      `${sourceId}-cluster-count`,
      `${sourceId}-unclustered`,
    );
    addClusterLayers(map, sourceId);
  } else if (marker !== undefined) {
    layerIds.push(
      `${sourceId}-outline`,
      `${sourceId}-line`,
      `${sourceId}-points`,
    );
    await addRouteAndMarkerLayers(map, sourceId, marker);
  } else {
    layerIds.push(`${sourceId}-points`);
    map.addLayer({
      id: `${sourceId}-points`,
      type: "circle",
      source: sourceId,
      paint: { "circle-color": "rgba(51, 153, 204, 0.7)", "circle-radius": 6 },
    } as CircleLayerSpecification);
  }

  if (!disabled && popup) {
    const clickableLayers = cluster
      ? [`${sourceId}-clusters`, `${sourceId}-unclustered`]
      : [`${sourceId}-points`];

    map.on("click", clickableLayers, async (e) => {
      const bufferedBox: [[number, number], [number, number]] = [
        [e.point.x - popupHitTolerance, e.point.y - popupHitTolerance],
        [e.point.x + popupHitTolerance, e.point.y + popupHitTolerance],
      ];
      const features = map.queryRenderedFeatures(bufferedBox, {
        layers: clickableLayers,
      });
      if (features.length === 0) return;

      const clusterFeature = features.find((f) => {
        const props = f.properties as
          Record<string, unknown> | null | undefined;
        return props?.cluster && props?.cluster_id !== undefined;
      });
      if (clusterFeature) {
        const src = map.getSource(sourceId) as GeoJSONSource;
        const props = clusterFeature.properties as Record<string, unknown>;
        const clusterId = props.cluster_id as number;
        const zoom = await src.getClusterExpansionZoom(clusterId);
        const [lng, lat] = (clusterFeature.geometry as Point).coordinates;
        map.easeTo({ center: [lng, lat], zoom });
        return;
      }

      const merged = mergeFeatureProperties(features);
      const lngLat = (features[0].geometry as Point).coordinates as LngLatLike;

      map.easeTo({ center: lngLat, duration: 300 });

      showPopup(map, lngLat, merged.name, merged.popupContent);
    });

    map.on("mouseenter", clickableLayers, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", clickableLayers, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  return layerIds;
}

export async function addRouteAndMarkerLayers(
  map: MapLibreMap,
  sourceId: string,
  marker: MarkerOptions | undefined,
): Promise<void> {
  map.addLayer({
    id: `${sourceId}-outline`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "rgba(0,0,0,1)",
      "line-width": [
        "interpolate",
        ["exponential", 1.5],
        ["zoom"],
        0,
        5,
        20,
        28,
      ],
    },
  } as LineLayerSpecification);

  map.addLayer({
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "rgba(255,255,255,1)",
      "line-width": [
        "interpolate",
        ["exponential", 1.5],
        ["zoom"],
        0,
        1,
        20,
        24,
      ],
    },
  } as LineLayerSpecification);

  if (marker !== undefined) {
    const iconId = `${sourceId}-icon`;
    const loaded = await ensureMarkerImage(map, iconId, marker);
    if (loaded && map.hasImage(iconId)) {
      map.addLayer({
        id: `${sourceId}-points`,
        type: "symbol",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "icon-image": iconId,
          "icon-allow-overlap": true,
        },
      } as SymbolLayerSpecification);
      return;
    }
    console.warn(
      `Falling back to circle markers for points (icon "${iconId}" unavailable).`,
    );
  }

  map.addLayer({
    id: `${sourceId}-points`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-color": "rgba(51, 153, 204, 0.7)", "circle-radius": 6 },
  } as CircleLayerSpecification);
}

export function addClusterLayers(map: MapLibreMap, sourceId: string): void {
  map.addLayer({
    id: `${sourceId}-clusters`,
    type: "circle",
    source: sourceId,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "rgba(51, 153, 204, 0.7)",
      "circle-radius": ["step", ["get", "point_count"], 15, 10, 20, 50, 25],
      "circle-stroke-color": "rgba(255,255,255,0.7)",
      "circle-stroke-width": 2,
    },
  } as CircleLayerSpecification);

  map.addLayer({
    id: `${sourceId}-cluster-count`,
    type: "symbol",
    source: sourceId,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
    },
    paint: { "text-color": "#fff" },
  } as SymbolLayerSpecification);

  map.addLayer({
    id: `${sourceId}-unclustered`,
    type: "circle",
    source: sourceId,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "rgba(51, 153, 204, 0.7)",
      "circle-radius": 8,
      "circle-stroke-color": "rgba(255,255,255,0.7)",
      "circle-stroke-width": 1.25,
    },
  } as CircleLayerSpecification);
}

/**
 * Merges the `name` and `popupContent` properties of multiple overlapping
 * point features into a single combined popup payload — restores the
 * original OpenLayers behavior (`mergeFeatures()`), which combined
 * multiple markers at the same point into one popup instead of only
 * showing the topmost feature.
 */
function mergeFeatureProperties(
  features: Array<{ properties?: Record<string, unknown> | null }>,
): { name?: string; popupContent?: string } {
  const names: string[] = [];
  let popupContent = "";

  features.forEach((feature) => {
    const props = feature.properties ?? {};
    if (props.name !== undefined && props.name !== null && props.name !== "") {
      names.push(String(props.name));
    }
    if (props.popupContent !== undefined && props.popupContent !== null) {
      popupContent += String(props.popupContent);
    }
  });

  return {
    name: names.length > 0 ? names.join(", ") : undefined,
    popupContent: popupContent || undefined,
  };
}

async function ensureMarkerImage(
  map: MapLibreMap,
  id: string,
  marker: MarkerOptions,
): Promise<boolean> {
  if (map.hasImage(id)) return true;
  const src = absUrl(marker.src);
  const isSvg = src.toLowerCase().endsWith(".svg");
  const isSupportedRaster = SUPPORTED_RASTER_EXTENSIONS.some((ext) =>
    src.toLowerCase().endsWith(ext),
  );
  const scale = marker.scale ?? 1;

  try {
    if (isSvg) {
      const { imageData, cssWidth } = await svgUrlToImageData(src, scale);
      const pixelRatio = imageData.width / cssWidth; // = devicePixelRatio, by construction
      if (!map.hasImage(id)) {
        map.addImage(id, imageData, { pixelRatio });
      }
      return true;
    }

    if (!isSupportedRaster) {
      console.warn(
        `Marker image "${src}" has an unrecognized extension. Only PNG/JPEG/WebP are ` +
          `supported by loadImage(); SVGs are rasterized automatically. Attempting to load ` +
          `anyway, but this may fail.`,
      );
    }

    const image = await map.loadImage(src);
    if (!image || !image.data) {
      console.warn(
        `Marker image "${src}" could not be decoded (loadImage() returned no data).`,
      );
      return false;
    }
    // Preserve the raster image's natural pixel size as its CSS display
    // size when scale is 1 (matching the original OL Icon default
    // behavior), scaling proportionally otherwise.
    if (!map.hasImage(id)) {
      map.addImage(id, image.data, { pixelRatio: 1 / scale });
    }
    return true;
  } catch (err) {
    console.warn(`Could not load marker image "${src}":`, err);
    return false;
  }
}

/* =========================================================================
 * Marker / route styling helpers — with SVG detection + rasterization
 * ========================================================================= */

/**
 * Determines an SVG's intrinsic size from its width/height attributes or
 * viewBox, falling back to a reasonable default if none is specified.
 */
function getSvgIntrinsicSize(
  svgText: string,
  fallback = 64,
): { width: number; height: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svgEl = doc.documentElement;

  const widthAttr = svgEl.getAttribute("width");
  const heightAttr = svgEl.getAttribute("height");
  const width = widthAttr ? parseFloat(widthAttr) : NaN;
  const height = heightAttr ? parseFloat(heightAttr) : NaN;
  if (
    !Number.isNaN(width) &&
    !Number.isNaN(height) &&
    width > 0 &&
    height > 0
  ) {
    return { width, height };
  }

  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  return { width: fallback, height: fallback };
}

/**
 * Rasterizes an SVG at its own intrinsic size (times devicePixelRatio for
 * crispness on HiDPI screens), instead of a fixed arbitrary size — so the
 * displayed marker matches the size the SVG was actually designed for.
 */
async function svgUrlToImageData(
  svgUrl: string,
  scale = 1,
): Promise<{ imageData: ImageData; cssWidth: number; cssHeight: number }> {
  const response = await fetch(svgUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch SVG "${svgUrl}": ${response.status} ${response.statusText}`,
    );
  }
  const svgText = await response.text();
  const { width: intrinsicWidth, height: intrinsicHeight } =
    getSvgIntrinsicSize(svgText);

  const cssWidth = intrinsicWidth * scale;
  const cssHeight = intrinsicHeight * scale;
  const dpr = window.devicePixelRatio || 1;
  const rasterWidth = Math.round(cssWidth * dpr);
  const rasterHeight = Math.round(cssHeight * dpr);

  const blob = new Blob([svgText], { type: "image/svg+xml" });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () =>
        reject(new Error(`Could not rasterize SVG "${svgUrl}"`));
      img.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = rasterWidth;
    canvas.height = rasterHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context not available for SVG rasterization.");
    }
    ctx.clearRect(0, 0, rasterWidth, rasterHeight);
    ctx.drawImage(img, 0, 0, rasterWidth, rasterHeight);
    return {
      imageData: ctx.getImageData(0, 0, rasterWidth, rasterHeight),
      cssWidth,
      cssHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function showPopup(
  map: MapLibreMap,
  lngLat: LngLatLike,
  name: string | undefined,
  popupContent: string | undefined,
): void {
  const html = `<h1>${name ?? ""}</h1>${popupContent ?? ""}`;
  new Popup(popupOptions).setLngLat(lngLat).setHTML(html).addTo(map);
}

/* =========================================================================
 * Color manipulation utils
 * ========================================================================= */

function getMapStore(map: MapLibreMap): MapOverrideStore {
  const existing = colorOverrideStores.get(map);

  if (existing) {
    return existing;
  }

  const created = new Map<string, LayerOverrideStore>();
  colorOverrideStores.set(map, created);

  return created;
}

function ensureLayerStore(
  map: MapLibreMap,
  layerName: string,
): LayerOverrideStore {
  const mapStore = getMapStore(map);
  const existing = mapStore.get(layerName);

  if (existing) {
    return existing;
  }

  const created = new Map<string, ColorOverrideEntry>();
  mapStore.set(layerName, created);

  return created;
}

function getDefaultColorPaintProperty(
  layerType: MapLayerType,
): string | undefined {
  switch (layerType) {
    case "fill":
      return "fill-color";

    case "line":
      return "line-color";

    case "circle":
      return "circle-color";

    case "fill-extrusion":
      return "fill-extrusion-color";

    case "symbol":
      // For symbol layers, this is ambiguous.
      // If you need icon color, pass:
      // { paintProperty: "icon-color" }
      return "text-color";

    default:
      return undefined;
  }
}

function isExpressionSpecification(
  value: unknown,
): value is ExpressionSpecification {
  return Array.isArray(value);
}

function isStyleColorValue(value: unknown): value is StyleColorValue {
  return typeof value === "string" || isExpressionSpecification(value);
}

function resolveOriginalColor(
  map: MapLibreMap,
  layerName: string,
  paintProperty: string,
  fallbackColor: string | undefined,
): StyleColorValue {
  const currentValue: unknown = map.getPaintProperty(
    layerName,
    paintProperty as keyof AllPaintProperties,
  );

  if (isStyleColorValue(currentValue)) {
    return currentValue;
  }

  if (fallbackColor !== undefined) {
    return fallbackColor;
  }

  return "rgba(0, 0, 0, 0)";
}

function createTagMatchExpression(tag: FeatureTag): ExpressionSpecification {
  if (tag.value === null) {
    return ["!", ["has", tag.name]];
  }

  return ["==", ["get", tag.name], tag.value];
}

function buildCaseExpression(
  rules: readonly ColorRule[],
  fallback: StyleColorValue,
): StyleColorValue {
  return rules.reduceRight<StyleColorValue>((currentFallback, rule) => {
    return [
      "case",
      createTagMatchExpression(rule.tag),
      rule.color,
      currentFallback,
    ];
  }, fallback);
}

export function setLayerColorByTag(
  map: MapLibreMap,
  layerName: string,
  tag: FeatureTag,
  color: string,
  options: SetLayerColorOptions = {},
): void {
  const layer = map.getLayer(layerName);

  if (!layer) {
    console.warn(`Layer "${layerName}" does not exist.`);
    return;
  }

  const paintProperty =
    options.paintProperty ?? getDefaultColorPaintProperty(layer.type);

  if (!paintProperty) {
    throw new Error(
      `No color paint property could be determined for layer type "${layer.type}". ` +
        `Pass options.paintProperty explicitly.`,
    );
  }

  const layerStore = ensureLayerStore(map, layerName);
  const existing = layerStore.get(paintProperty);

  const original =
    existing?.original ??
    resolveOriginalColor(map, layerName, paintProperty, options.fallbackColor);

  let nextRules: ColorRule[] =
    existing && !options.replace ? [...existing.rules] : [];

  nextRules = nextRules.filter((rule) => {
    return rule.tag.name !== tag.name || rule.tag.value !== tag.value;
  });

  nextRules.push({
    tag,
    color,
  });

  const expression = buildCaseExpression(nextRules, original);

  map.setPaintProperty(
    layerName,
    paintProperty as keyof AllPaintProperties,
    expression,
  );

  layerStore.set(paintProperty, {
    original,
    rules: nextRules,
  });
}

export function clearLayerColorByTag(
  map: MapLibreMap,
  layerName: string,
  paintProperty?: string,
): void {
  const mapStore = colorOverrideStores.get(map);

  if (!mapStore) {
    return;
  }

  const layerStore = mapStore.get(layerName);

  if (!layerStore) {
    return;
  }

  if (paintProperty !== undefined) {
    const entry = layerStore.get(paintProperty);

    if (!entry) {
      return;
    }

    map.setPaintProperty(
      layerName,
      paintProperty as keyof AllPaintProperties,
      entry.original,
    );

    layerStore.delete(paintProperty);

    if (layerStore.size === 0) {
      mapStore.delete(layerName);
    }

    return;
  }

  const entries = Array.from(layerStore.entries());

  for (const [property, entry] of entries) {
    map.setPaintProperty(
      layerName,
      property as keyof AllPaintProperties,
      entry.original,
    );
    layerStore.delete(property);
  }

  mapStore.delete(layerName);
}
