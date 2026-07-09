import { Circle as CircleStyle, Style, Fill, Stroke } from 'ol/style.js';
import type { Coordinate } from 'ol/coordinate';

type LayerColorTuple = [string, number, number, number];

const layers: LayerColorTuple[] = [
  // source name, r, g, b
  ["water", 6, 204, 204],
  ["water_name", 2, 44, 91],
  ["waterway", 35, 117, 224],
  ["landcover", 83, 224, 51],
  ["landuse", 229, 180, 4],
  ["park", 132, 234, 91],
  ["boundary", 197, 69, 211],
  ["aeroway", 81, 174, 181],
  ["transportation", 242, 182, 72],
  ["transportation_name", 188, 107, 56],
  ["building", 43, 43, 43],
  ["housenumber", 40, 40, 40],
  ["place", 242, 14, 147],
  ["mountain_peak", 98, 237, 247],
  ["poi", 59, 181, 10],
];

const defaultFonts = "css/{font-family}.css";

export const debugStyle = new Style({
  fill: new Fill({
    color: 'red'
  }),
  stroke: new Stroke({
    color: 'white',
    width: 1.25
  }),
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({
      color: 'red'
    }),
    stroke: new Stroke({
      color: 'white',
      width: 1.25
    })
  })
});

interface VectorSource {
  type: "vector";
  tiles: string[];
  minzoom?: number;
  maxzoom?: number;
  bounds?: number[];
  attribution?: string;
}

interface BackgroundLayer {
  id: string;
  type: "background";
  paint: {
    "background-color": string;
  };
}

interface FillLayer {
  id: string;
  type: "fill";
  source: string;
  "source-layer": string;
  filter: unknown[];
  paint: {
    "fill-color": string;
    "fill-antialias": boolean;
    "fill-outline-color": string;
  };
}

interface LineLayer {
  id: string;
  type: "line";
  source: string;
  "source-layer": string;
  filter: unknown[];
  layout: {
    "line-join": string;
    "line-cap": string;
  };
  paint: {
    "line-color": string;
  };
}

interface CircleLayer {
  id: string;
  type: "circle";
  source: string;
  "source-layer": string;
  filter: unknown[];
  paint: {
    "circle-color": string;
    "circle-radius": number;
  };
}

type DefaultStyleLayer = BackgroundLayer | FillLayer | LineLayer | CircleLayer;

interface DefaultStyle {
  version: number;
  "ol:webfonts": string;
  metadata: {
    inspect: boolean;
  };
  sources: {
    vector_layer_: VectorSource;
  };
  layers: DefaultStyleLayer[];
  center?: Coordinate;
  zoom?: number;
}

const defaultStyle: DefaultStyle = {
  version: 8,
  "ol:webfonts": defaultFonts,
  metadata: {
    inspect: true,
  },
  sources: {
    vector_layer_: {
      type: "vector",
      tiles: [
        "http://localhost:8080/central-europe/tiles/{z}/{x}/{y}.pbf",
      ],
      minzoom: 0,
      maxzoom: 14,
      attribution:
        '&copy; OpenStreetMap contributors and Natural Earth',
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "rgb(250,250,250)",
      },
    },
    ...layers.map(([id, r, g, b]): FillLayer => ({
      id: `vector_layer__${id}_polygon`,
      type: "fill",
      source: "vector_layer_",
      "source-layer": id,
      filter: ["==", "$type", "Polygon"],
      paint: {
        "fill-color": `rgba(${r}, ${g}, ${b}, 0.3)`,
        "fill-antialias": true,
        "fill-outline-color": `rgba(${r}, ${g}, ${b}, 0.3)`,
      },
    })),
    ...layers.map(([id, r, g, b]): LineLayer => ({
      id: `vector_layer__${id}_line`,
      type: "line",
      source: "vector_layer_",
      "source-layer": id,
      filter: ["==", "$type", "LineString"],
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-color": `rgba(${r}, ${g}, ${b}, 0.6)`,
      },
    })),
    ...layers.map(([id, r, g, b]): CircleLayer => ({
      id: `vector_layer__${id}_circle`,
      type: "circle",
      source: "vector_layer_",
      "source-layer": id,
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-color": `rgba(${r}, ${g}, ${b}, 0.8)`,
        "circle-radius": 2,
      },
    })),
  ],
};

export function setupDefaultStyle(
  source: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: Coordinate,
  background?: string,
  fonts?: string
): DefaultStyle {
  const style = defaultStyle;

  style.sources.vector_layer_.tiles = [source];
  if (minzoom !== undefined) {
    style.sources.vector_layer_.minzoom = minzoom;
  }
  if (maxzoom !== undefined) {
    style.sources.vector_layer_.maxzoom = maxzoom;
  }
  if (bounds !== undefined) {
    const flatBounds = bounds.flat().map((e) => Number(e));
    style.sources.vector_layer_.bounds = flatBounds;
  }
  if (center !== undefined) {
    style.center = center;
  }
  if (background !== undefined) {
    (style.layers[0] as BackgroundLayer).paint["background-color"] = background;
  }
  if (initialzoom !== undefined) {
    style.zoom = initialzoom;
  }

  if (fonts !== undefined) {
    style["ol:webfonts"] = fonts;
  }
  return style;
}
