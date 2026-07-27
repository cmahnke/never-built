//import type { AnySourceData, Style as MBStyle, VectorSourceImpl } from "mapbox-gl";
import type {
  LngLatLike,
  StyleSpecification,
  VectorSourceSpecification,
  BackgroundLayerSpecification,
} from 'maplibre-gl';

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
