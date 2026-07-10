const defaultSprites = "/map-styles/sprite";
const defaultFonts = "/css/fonts/{font-family}.css";

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

interface LayerLayout {
  "text-font"?: string[] | { stops?: Array<Array<string | unknown>> } | unknown;
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
  metadata: StyleMetadata;
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
  center?: [number, number] | number[],
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

  if (minzoom !== undefined) {
    source["minzoom"] = minzoom;
  }
  if (maxzoom !== undefined) {
    source["maxzoom"] = maxzoom;
  }
  if (bounds !== undefined) {
    const flatBounds = bounds.flat().map((e) => Number(e));
    source["bounds"] = flatBounds;
  }
  if (attribution !== undefined) {
    source["attribution"] = attribution;
  }

  if (typeof source["attribution"] == "boolean") {
    delete source["attribution"];
  }

  if (center !== undefined) {
    style.center = center;
  }

  if (background !== undefined) {
    style.layers.forEach((layer) => {
      if ("type" in layer && layer.type === "background" && layer.paint) {
        layer.paint["background-color"] = background;
      }
    });
  }

  if (fontPath !== undefined) {
    style["ol:webfonts"] = fontPath;
    style.metadata["ol:webfonts"] = fontPath;
  } else {
    style["ol:webfonts"] = defaultFonts;
    style.metadata["ol:webfonts"] = defaultFonts;
  }
  if (initialzoom !== undefined) {
    style.zoom = initialzoom;
  }

  if ("glyphs" in style) {
    delete style.glyphs;
  }

  if ("sprite" in style) {
    if (sprites === undefined) {
      //delete style.sprite;
      style.sprite = null;
    } else {
      style.sprite = sprites;
    }
  }
  Object.keys(style.metadata).forEach((key) => {
    if (key.startsWith("mapbox") || key.startsWith("openmaptiles")) {
      delete style.metadata[key];
    }
  });

  if (font !== undefined) {
    style.layers.forEach((layer) => {
      if (layer.type === "symbol" && layer.layout) {
        if ("text-font" in layer.layout) {
          const textFont = layer.layout["text-font"];
          if (Array.isArray(textFont)) {
            textFont[0] = font;
          } else if (typeof textFont === "object" && textFont !== null) {
            if ("stops" in textFont) {
              const stopsObj = textFont as { stops: Array<Array<unknown>> };
              stopsObj.stops.forEach((stop) => {
                stop.forEach((s) => {
                  if (Array.isArray(s)) {
                    s[0] = font;
                  }
                });
              });
            }
          }
        }
      }
    });
  }

  style.sources[sourceKey] = source;
  return style;
}
