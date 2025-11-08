import type { AnySourceData, Style as MBStyle, VectorSourceImpl } from "mapbox-gl";

export const defaultSprites = "/map-styles/sprite";
export const defaultFonts = "/css/fonts/{font-family}.css";

export interface Style extends MBStyle {
  "ol:webfonts"?: string;
  metadata?: {
    "ol:webfonts"?: string;
    [key: string]: any;
  };
}

export function updateStyle(
  style: Style,
  url: string,
  initialzoom: number | undefined = undefined,
  minzoom: number | undefined = undefined,
  maxzoom: number | undefined = undefined,
  bounds: [number, number, number, number] | undefined = undefined,
  center: [number, number] | undefined = undefined,
  bearing: number | undefined = undefined,
  pitch: number | undefined = undefined,
  background: string | undefined = undefined,
  sprites: string | undefined = defaultSprites,
  fontPath: string | undefined = defaultFonts,
  font: string | undefined = undefined
) {
  const sourceKey = Object.keys(style.sources)[0];
  const source: VectorSourceImpl = style.sources[sourceKey] as unknown as VectorSourceImpl;

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
  if (bearing !== undefined) {
    style["bearing"] = bearing;
  }
  if (pitch !== undefined) {
    style["pitch"] = pitch;
  }

  if (bounds !== undefined) {
    //bounds = bounds.flat().map(e => { return Number(e) });
    source["bounds"] = bounds;
  }
  if (center !== undefined) {
    style.center = center;
  }

  if (background !== undefined) {
    style.layers.forEach((layer) => {
      if ("type" in layer && layer.type === "background") {
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
      if (layer.type == "symbol") {
        if ("text-font" in layer.layout) {
          if (Array.isArray(layer.layout["text-font"])) {
            layer.layout["text-font"][0] = font;
          } else if (typeof layer.layout["text-font"] === "object") {
            if ("stops" in layer.layout["text-font"]) {
              layer.layout["text-font"].stops.forEach((stop) => {
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

  style.sources[sourceKey] = source as unknown as AnySourceData;
  return style;
}
