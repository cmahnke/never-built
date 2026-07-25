import * as maplibregl from 'maplibre-gl';
import { mat4 } from "gl-matrix";

const vertexShaderSource = `
    uniform mat4 u_matrix;
    attribute vec2 a_pos;

    void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        gl_PointSize = 10.0;
    }
`;

const fragmentShaderSource = `
    precision mediump float;

    void main() {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    }
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

type TreeLayer = maplibregl.CustomLayerInterface & {
  source: string;
  sourceLayer: string;
  map?: maplibregl.Map;
  program?: WebGLProgram;
  a_pos?: number;
  u_matrix?: WebGLUniformLocation | null;
  dotBuffer?: WebGLBuffer | null;
  cachedFeatures?: GeoJSON.Feature[];
};

export const treeLayer: TreeLayer = {
  id: "tree-layer",
  type: "custom",
  renderingMode: "3d",
  source: "openmaptiles",
  sourceLayer: "tree",

  onAdd(map, gl) {
    this.map = map;
    this.cachedFeatures = [];

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.a_pos = gl.getAttribLocation(program, "a_pos");
    this.u_matrix = gl.getUniformLocation(program, "u_matrix");

    this.dotBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW);

    // Refresh cached features only when data actually changes / view settles,
    // instead of every animation frame.
    const refresh = () => {
      this.cachedFeatures = map.querySourceFeatures(this.source, {
        sourceLayer: this.sourceLayer
      });
    };
    map.on("sourcedata", refresh);
    map.on("moveend", refresh);
  },

  onRemove(_map, gl) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.dotBuffer) gl.deleteBuffer(this.dotBuffer);
  },

  render(gl, matrix) {
    if (!this.program || !this.cachedFeatures) return;

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuffer);
    gl.enableVertexAttribArray(this.a_pos!);
    gl.vertexAttribPointer(this.a_pos!, 2, gl.FLOAT, false, 0, 0);

    for (const tree of this.cachedFeatures) {
      const geom = tree.geometry;
      if (geom?.type !== "Point") continue;

      const [lng, lat] = geom.coordinates;
      if (isNaN(lng) || isNaN(lat)) continue;

      const location = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], 0);

      const modelMatrix = mat4.create();
      mat4.translate(modelMatrix, modelMatrix, [location.x, location.y, location.z]);
      mat4.multiply(modelMatrix, matrix as unknown as mat4, modelMatrix);

      gl.uniformMatrix4fv(this.u_matrix, false, modelMatrix);
      gl.drawArrays(gl.POINTS, 0, 1);
    }
    // Only call this if you actually need continuous animation.
    // this.map!.triggerRepaint();
  }
};
