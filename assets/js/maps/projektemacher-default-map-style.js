var layers = [
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

export const default_style = {
  version: 8,
  "ol:webfonts": "assets/{font-family}/{fontweight}{-fontstyle}.css",
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
      maxzoom: 13,
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
    ...layers.map(([id, r, g, b]) => ({
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
    ...layers.map(([id, r, g, b]) => ({
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
    ...layers.map(([id, r, g, b]) => ({
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
