const defaultSprites = "/map-styles/sprite";
const defaultFonts = "/css/fonts/{font-family}.css";

export function updateStyle(style, url, initialzoom, minzoom, maxzoom, bounds, center, background, sprites, fontPath, font, attribution) {
  const sourceKey = Object.keys(style.sources)[0]
  const source = style.sources[sourceKey]

  source.tiles = [url];
  if ("url" in source) {
    delete source.url
  }

  if (minzoom !== undefined) {
    source["minzoom"] = minzoom;
  }
  if (maxzoom !== undefined) {
    source["maxzoom"] = maxzoom;
  }
  if (bounds !== undefined) {
    bounds = bounds.flat().map(e => { return Number(e) });
    source["bounds"] = bounds
  }
  if (attribution !== undefined) {
    source["attribution"] = attribution;
  }

  if (center !== undefined) {
    style.center = center;
  }

  if (background !== undefined) {
    style.layers.forEach(layer => {
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
  Object.keys(style.metadata).forEach(key => {
    if (key.startsWith("mapbox") || key.startsWith("openmaptiles")) {
      delete style.metadata[key]
    }
  });

  if (font !== undefined) {
    style.layers.forEach(layer => {
      if (layer.type == "symbol") {
        if ("text-font" in layer.layout) {
          if (Array.isArray(layer.layout["text-font"])) {
            layer.layout["text-font"][0] = font;
          } else if (typeof layer.layout["text-font"] === 'object') {
            if ("stops" in layer.layout["text-font"]) {
              layer.layout["text-font"].stops.forEach(stop => {
                stop.forEach(s => {
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

  style.sources[sourceKey] = source
  return style
}
