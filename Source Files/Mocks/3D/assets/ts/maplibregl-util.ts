// assets/ts/maplibregl-util.ts

import type { Map as MapLibreMap, ExpressionSpecification } from "maplibre-gl";
import type { FeatureTag, FeatureTagValue } from "./3d-map";

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

function getMapStore(map: MapLibreMap): MapOverrideStore {
  const existing = colorOverrideStores.get(map);

  if (existing) {
    return existing;
  }

  const created = new Map<string, LayerOverrideStore>();
  colorOverrideStores.set(map, created);

  return created;
}

function getLayerStore(map: MapLibreMap, layerName: string): LayerOverrideStore | undefined {
  const mapStore = getMapStore(map);
  return mapStore.get(layerName);
}

function ensureLayerStore(map: MapLibreMap, layerName: string): LayerOverrideStore {
  const mapStore = getMapStore(map);
  const existing = mapStore.get(layerName);

  if (existing) {
    return existing;
  }

  const created = new Map<string, ColorOverrideEntry>();
  mapStore.set(layerName, created);

  return created;
}

function getDefaultColorPaintProperty(layerType: MapLayerType): string | undefined {
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

function isExpressionSpecification(value: unknown): value is ExpressionSpecification {
  return Array.isArray(value);
}

function isStyleColorValue(value: unknown): value is StyleColorValue {
  return typeof value === "string" || isExpressionSpecification(value);
}

function resolveOriginalColor(
  map: MapLibreMap,
  layerName: string,
  paintProperty: string,
  fallbackColor: string | undefined
): StyleColorValue {
  const currentValue: unknown = map.getPaintProperty(layerName, paintProperty);

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

function buildCaseExpression(rules: readonly ColorRule[], fallback: StyleColorValue): StyleColorValue {
  return rules.reduceRight<StyleColorValue>((currentFallback, rule) => {
    return ["case", createTagMatchExpression(rule.tag), rule.color, currentFallback];
  }, fallback);
}

export function setLayerColorByTag(
  map: MapLibreMap,
  layerName: string,
  tag: FeatureTag,
  color: string,
  options: SetLayerColorOptions = {}
): void {
  const layer = map.getLayer(layerName);

  if (!layer) {
    console.warn(`Layer "${layerName}" does not exist.`);
    return;
  }

  const paintProperty = options.paintProperty ?? getDefaultColorPaintProperty(layer.type);

  if (!paintProperty) {
    throw new Error(
      `No color paint property could be determined for layer type "${layer.type}". ` + `Pass options.paintProperty explicitly.`
    );
  }

  const layerStore = ensureLayerStore(map, layerName);
  const existing = layerStore.get(paintProperty);

  const original = existing?.original ?? resolveOriginalColor(map, layerName, paintProperty, options.fallbackColor);

  let nextRules: ColorRule[] = existing && !options.replace ? [...existing.rules] : [];

  nextRules = nextRules.filter((rule) => {
    return rule.tag.name !== tag.name || rule.tag.value !== tag.value;
  });

  nextRules.push({
    tag,
    color
  });

  const expression = buildCaseExpression(nextRules, original);

  map.setPaintProperty(layerName, paintProperty, expression);

  layerStore.set(paintProperty, {
    original,
    rules: nextRules
  });
}

export function clearLayerColorByTag(map: MapLibreMap, layerName: string, paintProperty?: string): void {
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

    map.setPaintProperty(layerName, paintProperty, entry.original);

    layerStore.delete(paintProperty);

    if (layerStore.size === 0) {
      mapStore.delete(layerName);
    }

    return;
  }

  const entries = Array.from(layerStore.entries());

  for (const [property, entry] of entries) {
    map.setPaintProperty(layerName, property, entry.original);
    layerStore.delete(property);
  }

  mapStore.delete(layerName);
}
