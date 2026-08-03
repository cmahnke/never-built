//import type { AnySourceData, Style as MBStyle, VectorSourceImpl } from "mapbox-gl";
import type {
  LngLatLike,
  StyleSpecification,
  VectorSourceSpecification,
  BackgroundLayerSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  CircleLayerSpecification,
  LayerSpecification,
} from 'maplibre-gl';

import { absUrl } from './base-map';

export const defaultSprites = "/map-styles/sprite";
export const defaultFonts = "/css/fonts/{font-family}.css";
export const defaultAttribution =
  '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';

interface StyleSource {
  tiles?: string[];
  url?: string;
  minzoom?: number;
  maxzoom?: number;
  bounds?: number[];
  attribution?: string;
  [key: string]: unknown;
}

interface LayerPaint {
  "background-color"?: string;
  [key: string]: unknown;
}

/**
 * A single zoom→font-name stop pair, e.g. `[12, "Noto Sans Regular"]`.
 * Using a concrete tuple type instead of `unknown[]` lets us avoid any
 * `Array.isArray()` narrowing-to-`any[]` tricks later on.
 */
type ZoomFontStop = [number, string];

interface LayerLayout {
  "text-font"?: string[] | { stops?: ZoomFontStop[] };
  [key: string]: unknown;
}

interface StyleLayer {
  type?: string;
  paint?: LayerPaint;
  layout?: LayerLayout;
  [key: string]: unknown;
}

interface StyleMetadata {
  "ol:webfonts"?: string;
  [key: string]: unknown;
}

interface Style {
  sources: Record<string, StyleSource>;
  layers: StyleLayer[];
  metadata?: StyleMetadata;
  center?: [number, number] | number[];
  zoom?: number;
  glyphs?: string;
  sprite?: string | null;
  "ol:webfonts"?: string;
  [key: string]: unknown;
}

export function updateStyle(
  style: Style,
  url: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: LngLatLike,
  background?: string,
  sprites?: string,
  fontPath?: string,
  font?: string,
  attribution?: string
): Style {
  const sourceKey = Object.keys(style.sources)[0];
  const source = style.sources[sourceKey];

  source.tiles = [url];
  if ("url" in source) {
    delete source.url;
  }

  if (minzoom !== undefined) source.minzoom = minzoom;
  if (maxzoom !== undefined) source.maxzoom = maxzoom;
  if (bounds !== undefined) {
    source.bounds = bounds.flat().map((e: number) => Number(e));
  }

  // Defensive: only ever write a real string into `attribution`, and strip
  // out any pre-existing invalid (e.g. boolean) value from the loaded style.
  if (attribution !== undefined && typeof attribution === "string") {
    source.attribution = attribution;
  } else if (typeof source.attribution !== "string") {
    if (attribution !== undefined) {
      console.warn(
        `updateStyle(): "attribution" must be a string, got ${typeof attribution} ` +
          `(${JSON.stringify(attribution)}). Falling back to default attribution. ` +
          `Check the call site — arguments may be shifted/mismatched.`
      );
      source.attribution = defaultAttribution;
    } else {
      delete source.attribution;
    }
  }

  if (center !== undefined) {
    style.center = center as [number, number];
  }
  if (initialzoom !== undefined) {
    style.zoom = initialzoom;
  }

  if (background !== undefined) {
    style.layers.forEach((layer: StyleLayer) => {
      if (layer.type === "background") {
        layer.paint = { ...layer.paint, "background-color": background };
      }
    });
  }

  if ("glyphs" in style) {
    delete style.glyphs;
  }

  if (style.sprite !== undefined) {
    style.sprite = sprites === undefined ? undefined : sprites;
  }

  if (style.metadata) {
    const metadata: StyleMetadata = style.metadata;
    Object.keys(metadata).forEach((key: string) => {
      if (key.startsWith("mapbox") || key.startsWith("openmaptiles")) {
        delete metadata[key];
      }
    });
  }

  if (font !== undefined) {
    style.layers.forEach((layer: StyleLayer) => {
      if (layer.type === "symbol" && layer.layout && "text-font" in layer.layout) {
        const textFont = layer.layout["text-font"];
        if (Array.isArray(textFont)) {
          textFont[0] = font;
        } else if (textFont && typeof textFont === "object" && "stops" in textFont) {
          const stops: ZoomFontStop[] = textFont.stops ?? [];
          stops.forEach((stop: ZoomFontStop) => {
            stop[1] = [font];
          });
        }
      }
    });
  }

  style.metadata = {
    ...(style.metadata ?? {}),
    "projektemacher:fontPath": fontPath ?? defaultFonts,
  };

  style.sources[sourceKey] = source;
  return style;
}

/**
 * MapLibre's official `VectorSourceSpecification` types `bounds` as a
 * strict 4-tuple (`[number, number, number, number]`), but here we build
 * it from a flattened, arbitrary-length array — so we widen it locally
 * instead of reaching for `any`.
 */
type ExtendedVectorSource = VectorSourceSpecification & {
  bounds?: number[];
};

export function setupDefaultStyle(
  source: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: LngLatLike,
  background?: string
): StyleSpecification {
  const style: StyleSpecification = buildDefaultStyle(source);
  const src = style.sources.vector_layer_ as ExtendedVectorSource;

  src.tiles = [source];
  if (minzoom !== undefined) src.minzoom = minzoom;
  if (maxzoom !== undefined) src.maxzoom = maxzoom;
  if (bounds !== undefined) {
    src.bounds = bounds.flat().map((e: number) => Number(e));
  }
  if (background !== undefined) {
    const bgLayer = style.layers[0] as BackgroundLayerSpecification;
    bgLayer.paint = {
      ...bgLayer.paint,
      "background-color": background,
    };
  }

  if (center !== undefined) {
    style.center = center as [number, number];
  }
  if (initialzoom !== undefined) {
    style.zoom = initialzoom;
  }

  return style;
}


type LayerColorTuple = [string, number, number, number];

export const defaultStyleLayers: LayerColorTuple[] = [
  ['water', 6, 204, 204],
  ['water_name', 2, 44, 91],
  ['waterway', 35, 117, 224],
  ['landcover', 83, 224, 51],
  ['landuse', 229, 180, 4],
  ['park', 132, 234, 91],
  ['boundary', 197, 69, 211],
  ['aeroway', 81, 174, 181],
  ['transportation', 242, 182, 72],
  ['transportation_name', 188, 107, 56],
  ['building', 43, 43, 43],
  ['housenumber', 40, 40, 40],
  ['place', 242, 14, 147],
  ['mountain_peak', 98, 237, 247],
  ['poi', 59, 181, 10],
];

export function buildDefaultStyle(source: string): StyleSpecification {
  const backgroundLayer: BackgroundLayerSpecification = {
    id: 'background',
    type: 'background',
    paint: { 'background-color': 'rgb(250,250,250)' },
  };

  const fillLayers: FillLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_polygon`,
    type: 'fill',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': `rgba(${r}, ${g}, ${b}, 0.3)`,
      'fill-antialias': true,
      'fill-outline-color': `rgba(${r}, ${g}, ${b}, 0.3)`,
    },
  }));

  const lineLayers: LineLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_line`,
    type: 'line',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': `rgba(${r}, ${g}, ${b}, 0.6)` },
  }));

  const circleLayers: CircleLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_circle`,
    type: 'circle',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': `rgba(${r}, ${g}, ${b}, 0.8)`, 'circle-radius': 2 },
  }));

  const vectorSource: VectorSourceSpecification = {
    type: 'vector',
    tiles: [source],
    minzoom: 0,
    maxzoom: 14,
    attribution: '&copy; OpenStreetMap contributors and Natural Earth',
  };

  const layers: LayerSpecification[] = [backgroundLayer, ...fillLayers, ...lineLayers, ...circleLayers];

  // NOTE: no `glyphs` key set at all — the default style has no symbol/text
  // layers, and custom styles that DO have text layers rely on local
  // web-font rendering via `preloadStyleFonts()` instead of a PBF endpoint.
  return {
    version: 8,
    metadata: { inspect: true },
    sources: { vector_layer_: vectorSource },
    layers,
  } as StyleSpecification;
}

export function getSourceName (style: StyleSpecification): string {
  return Object.keys(style.sources)[0];
}

/** Collects every distinct font-family name referenced in `text-font`
 * arrays across all symbol layers of a style. */
export function collectFontFamilies(style: StyleSpecification): string[] {
  const families = new Set<string>();
  style.layers.forEach((layer) => {
    if (layer.type === 'symbol' && layer.layout && 'text-font' in layer.layout) {
      const textFont = (layer.layout)['text-font'];
      if (Array.isArray(textFont)) {
        textFont.forEach((f) => {
          if (typeof f === 'string') families.add(f);
        });
      }
    }
  });
  return Array.from(families);
}

/** ===============
 *   Font handling
 *  =============== */

/**
 * Converts a CSS font-family name into a URL-safe, filename-style slug:
 * lowercase, spaces replaced with hyphens. E.g. "Roboto Mono Variable"
 * becomes "roboto-mono-variable".
 */
export function fontFamilyToSlug(fontFamily: string): string {
  return fontFamily.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Injects a <link rel="stylesheet"> for a given font-family's CSS template
 * (containing @font-face rules), if not already present.
 */
export function loadFontCss(fontFamily: string, template: string): Promise<void> {
  const slug = fontFamilyToSlug(fontFamily);
  const href = absUrl(template.replace('{font-family}', slug));
  const existing = document.querySelector(`link[data-font-family="${CSS.escape(fontFamily)}"]`);
  if (existing) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.fontFamily = fontFamily;
    link.onload = () => resolve();
    link.onerror = () =>
      reject(new Error(`Could not load font CSS for "${fontFamily}" from ${href}`));
    document.head.appendChild(link);
  });
}

/**
 * Ensures every font-family referenced by the style's symbol layers is
 * loaded via CSS (@font-face) and preloaded via the Font Loading API,
 * BEFORE the map is created — mirroring the pattern from MapLibre's own
 * web-font example (`document.fonts.load("24px 'Font Name'")`).
 */
export async function preloadStyleFonts(
  style: StyleSpecification,
  fontCssTemplate: string
): Promise<void> {
  const families = collectFontFamilies(style);
  if (families.length === 0) return;

  await Promise.all(
    families.map(async (family) => {
      try {
        await loadFontCss(family, fontCssTemplate);
        if ('fonts' in document) {
          await document.fonts.load(`24px '${family}'`);
        }
      } catch (err) {
        console.warn(`Could not preload web font "${family}":`, err);
      }
    })
  );

  if ('fonts' in document) {
    await document.fonts.ready;
  }
}
