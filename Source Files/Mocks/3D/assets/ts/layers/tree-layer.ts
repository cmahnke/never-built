//import maplibregl, { CustomLayerInterface, LngLatLike } from "maplibre-gl";
import "maplibre-gl";
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
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); // Red
    }
`;

function createSphere(radius: number, segments: number, rings: number) {
  const vertices = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i <= rings; i++) {
    const phi = (i * Math.PI) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let j = 0; j <= segments; j++) {
      const theta = (j * 2 * Math.PI) / segments;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const x = cosTheta * sinPhi;
      const y = sinTheta * sinPhi;
      const z = cosPhi;

      vertices.push(radius * x, radius * y, radius * z);
      normals.push(x, y, z);
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const first = i * (segments + 1) + j;
      const second = first + segments + 1;
      indices.push(first, second, first + 1);
      indices.push(second, second + 1, first + 1);
    }
  }

  return {
    vertices: new Float32Array(vertices),
    normals: new Float32Array(normals),
    indices: new Uint16Array(indices)
  };
}

export const treeLayer: maplibregl.CustomLayerInterface & { source: string; sourceLayer: string } = {
  id: "tree-layer",
  type: "custom",
  renderingMode: "3d",

  // Configurable properties
  source: "openmaptiles",
  sourceLayer: "tree",

  onAdd: function (map, gl) {
    this.map = map;

    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);

    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);

    this.a_pos = gl.getAttribLocation(this.program, "a_pos");
    this.u_matrix = gl.getUniformLocation(this.program, "u_matrix");
    this.dotBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW);
  },

  render: function (gl: WebGLRenderingContext, matrix: number[]) {
    const features = this.map.querySourceFeatures(this.source, { sourceLayer: this.sourceLayer });

    gl.useProgram(this.program);

    features.forEach((tree) => {
      // Ensure the geometry is a Point type and has valid coordinates
      if (
        tree.geometry &&
        tree.geometry.type === "Point" &&
        Array.isArray(tree.geometry.coordinates) &&
        tree.geometry.coordinates.length >= 2
      ) {
        const coords = tree.geometry.coordinates as [number, number];
        if (isNaN(coords[0]) || isNaN(coords[1])) {
          console.warn("Invalid coordinates for tree feature:", tree);
          return; // Skip this feature if coordinates are NaN
        }

        const location = maplibregl.MercatorCoordinate.fromLngLat(coords as maplibregl.LngLatLike, 0);

        const modelMatrix = mat4.create();
        mat4.translate(modelMatrix, modelMatrix, [location.x, location.y, location.z]);
        mat4.multiply(modelMatrix, matrix as mat4, modelMatrix);

        gl.uniformMatrix4fv(this.u_matrix, false, modelMatrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.dotBuffer);
        gl.enableVertexAttribArray(this.a_pos);
        gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, 1);
      } else {
        console.warn("Skipping feature with non-Point geometry or invalid coordinates:", tree);
      }
    });

    this.map.triggerRepaint();
  }
};
