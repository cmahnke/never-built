import "maplibre-gl";
import { center, points } from "@turf/turf";
import { absUrl, loadOrParse } from "./base-map";
import { updateStyle, defaultSprites } from "./styles";
import { createTreeLayer} from "./layers/tree-layer";
import "maplibre-gl/dist/maplibre-gl.css";
import { StyleSpecification } from "maplibre-gl";
//import maplibregl from 'maplibre-gl';

const bboxJson = "/map/bbox.json";
const styleJson = "/map-styles/style.json";
const tilesUrl = "/map/tiles/{z}/{x}/{y}.pbf";
const zoom = 14;
const minZoom = 14;

export async function getMapMetadata(url: string) {
  const metadataFile = "metadata.json";
  if (url.includes("{")) {
    url = url.substring(0, url.indexOf("{"));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith("/")) {
    url += "/" + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url);
}

const bboxObj = await loadOrParse(bboxJson);
let centerObj: [number, number];
if (bboxObj !== undefined && bboxObj.length !== 0) {
  const c = center(
    points([
      [bboxObj[0], bboxObj[1]],
      [bboxObj[2], bboxObj[3]]
    ])
  );
  centerObj = c.geometry.coordinates as [number, number];
} else {
  console.warn("Can't create center from features or bbox");
  centerObj = [0, 0];
}

const spriteUrl = window.location.origin + defaultSprites;
const baseStyle = await loadOrParse(styleJson);
const url = window.location.origin + tilesUrl;
const style = updateStyle(
  baseStyle,
  url,
  14,
  minZoom,
  15,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  spriteUrl
) as StyleSpecification;

style.light = {
  anchor: 'viewport',
  color: '#fff',
  intensity: 0.4,
  position: [1.15, 210, 30]
};

style.layers = style.layers.filter(layer => {
  if ("type" in layer && layer.id.startsWith("building")) {
    return false;
  }
  return true;
});

console.log(bboxJson ,bboxObj, centerObj, style, spriteUrl);

const map = new maplibregl.Map({
  container: "map",
  style: style,
  center: centerObj,
  zoom: zoom,
  minZoom: minZoom,
  pitch: 60, 
  bearing: -60,
  //antialias: true
});

map.on("load", () => {
  const source = "never_built";

  map.addSource(source, {
    type: "vector",
    minzoom: 0,
    maxzoom: 15
  });

  const layers = map.getStyle().layers;

map.addLayer({
      'id': '3d-buildings',
      'source': 'openmaptiles',
      'source-layer': 'building',
      'type': 'fill-extrusion',
      'minzoom': 14,
      'paint': {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-base': ['get', 'min_height']
      }
  });

  const grainyBWLayer: maplibregl.CustomLayerInterface = {
      id: 'grainy-bw',
      type: 'custom',
      renderingMode: '2d',
      onAdd: function(map, gl) {
          const vertexSource = `
              attribute vec2 a_pos;
              varying vec2 v_tex_pos;
              void main() {
                  v_tex_pos = a_pos;
                  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
              }
          `;

          const fragmentSource = `
              precision mediump float;
              varying vec2 v_tex_pos;
              uniform sampler2D u_texture;
              uniform float u_time;
              uniform vec2 u_resolution;

              float random(vec2 st) {
                  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
              }

              void main() {
                  vec4 color = texture2D(u_texture, v_tex_pos);
                  
                  // Convert to grayscale
                  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
                  vec3 grayscale = vec3(gray);
                  
                  // Add grain
                  float grainAmount = 0.15;
                  float grain = (random(v_tex_pos * u_time) - 0.5) * grainAmount;
                  
                  gl_FragColor = vec4(grayscale + grain, color.a);
              }
          `;

          const vertexShader = gl.createShader(gl.VERTEX_SHADER);
          gl.shaderSource(vertexShader, vertexSource);
          gl.compileShader(vertexShader);

          const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
          gl.shaderSource(fragmentShader, fragmentSource);
          gl.compileShader(fragmentShader);

          this.program = gl.createProgram();
          gl.attachShader(this.program, vertexShader);
          gl.attachShader(this.program, fragmentShader);
          gl.linkProgram(this.program);

          this.a_pos = gl.getAttribLocation(this.program, "a_pos");
          this.u_texture = gl.getUniformLocation(this.program, "u_texture");
          this.u_time = gl.getUniformLocation(this.program, "u_time");
          this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");

          const buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
          this.buffer = buf;
      },
      render: function(gl, matrix) {
          gl.useProgram(this.program);
          gl.uniform1f(this.u_time, performance.now() / 1000);
          gl.uniform2f(this.u_resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
          map.triggerRepaint();
      }
  };
  map.addLayer(createTreeLayer(map));
  map.addLayer(grainyBWLayer);

map.on('click', 'buildings', (e) => {
    if (e.features?.length) {
      const feature = e.features[0];
      const properties = feature.properties;
      let description = '<h4>Building Properties</h4>';
      description += '<table>';
      for (const key in properties) {
        description += `<tr><td><strong>${key}</strong></td><td>${properties[key]}</td></tr>`;
      }
      description += '</table>';

      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(description)
        .addTo(map);
    }
  });

  // Change the cursor to a pointer when the mouse is over the buildings layer.
  map.on('mouseenter', '3d-buildings', () => {
    map.getCanvas().style.cursor = 'pointer';
  });

  // Change it back to a pointer when it leaves.
  map.on('mouseleave', '3d-buildings', () => {
    map.getCanvas().style.cursor = '';
  });

});

console.log(map);

export default map;