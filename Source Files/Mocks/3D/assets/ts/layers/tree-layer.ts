//import maplibregl, { CustomLayerInterface, LngLatLike } from "maplibre-gl";
import "maplibre-gl";

const vertexShaderSource = `
    uniform mat4 u_matrix;
    attribute vec3 a_pos;
    attribute vec3 a_normal;
    uniform vec3 u_light_direction;
    varying float v_light;

    void main() {
        gl_Position = u_matrix * vec4(a_pos, 1.0);
        v_light = max(0.0, dot(normalize(a_normal), u_light_direction)) * 0.5 + 0.5;
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    varying float v_light;
    uniform vec4 u_color;

    void main() {
        gl_FragColor = vec4(u_color.rgb * v_light, u_color.a);
    }
`;

function createSphere(radius: number, segments: number, rings: number) {
    const vertices = [];
    const normals = [];
    const indices = [];

    for (let i = 0; i <= rings; i++) {
        const phi = i * Math.PI / rings;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        for (let j = 0; j <= segments; j++) {
            const theta = j * 2 * Math.PI / segments;
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
            const first = (i * (segments + 1)) + j;
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

export function createTreeLayer(map: maplibregl.Map): maplibregl.CustomLayerInterface {
    const treeLayer: maplibregl.CustomLayerInterface = {
        id: 'tree-layer',
        type: 'custom',
        renderingMode: '3d',

        onAdd: function (map, gl) {
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
            this.a_normal = gl.getAttribLocation(this.program, "a_normal");
            this.u_matrix = gl.getUniformLocation(this.program, "u_matrix");
            this.u_color = gl.getUniformLocation(this.program, "u_color");
            this.u_light_direction = gl.getUniformLocation(this.program, "u_light_direction");

            const sphereGeom = createSphere(4, 16, 16);
            this.sphereVertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereVertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, sphereGeom.vertices, gl.STATIC_DRAW);

            this.sphereNormalBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereNormalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, sphereGeom.normals, gl.STATIC_DRAW);

            this.sphereIndexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sphereIndexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphereGeom.indices, gl.STATIC_DRAW);
            this.sphereIndexCount = sphereGeom.indices.length;

            const trunkGeom = {
                vertices: new Float32Array([0, 0, -5, 0, 0, 5]),
                normals: new Float32Array([1, 0, 0, 1, 0, 0]) // Dummy normals
            };
            this.trunkVertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.trunkVertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, trunkGeom.vertices, gl.STATIC_DRAW);

            this.trunkNormalBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.trunkNormalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, trunkGeom.normals, gl.STATIC_DRAW);
        },

        render: function (gl: WebGLRenderingContext, matrix: number[]) {
            const features = map.querySourceFeatures('openmaptiles', { sourceLayer: 'poi' });
            const trees = features.filter(f => f.properties.class === 'wood' && f.properties.subclass === 'tree');

            gl.useProgram(this.program);

            const lightDirection = map.getLight().position.map(n => n * 1000);
            gl.uniform3f(this.u_light_direction, lightDirection[0], lightDirection[1], lightDirection[2]);

            trees.forEach(tree => {
                const coords = (tree.geometry as GeoJSON.Point).coordinates as [number, number];
                const location = maplibregl.MercatorCoordinate.fromLngLat(coords as maplibregl.LngLatLike, 0);

                // Use the height property from OSM for the tree's height, otherwise default to 10 meters.
                const treeHeight = tree.properties.height ? parseFloat(tree.properties.height) : 10;

                // The trunk will be scaled to the tree's height.
                const trunkHeight = treeHeight * 0.7; // Assume trunk is 70% of the tree height.
                const canopyRadius = treeHeight * 0.3; // Assume canopy is 30% of the tree height.

                const treeMatrix = matrix.slice();
                maplibregl.mat4.translate(treeMatrix, treeMatrix, [location.x, location.y, location.z]);

                // Render trunk
                const trunkMatrix = treeMatrix.slice();
                maplibregl.mat4.scale(trunkMatrix, trunkMatrix, [1, 1, trunkHeight / 10]); // Original trunk is 10 units high

                gl.uniform4f(this.u_color, 0.3, 0.2, 0.1, 1.0);
                gl.uniformMatrix4fv(this.u_matrix, false, trunkMatrix);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.trunkVertexBuffer);
                gl.enableVertexAttribArray(this.a_pos);
                gl.vertexAttribPointer(this.a_pos, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.trunkNormalBuffer);
                gl.vertexAttribPointer(this.a_normal, 3, gl.FLOAT, false, 0, 0);

                gl.lineWidth(2);
                gl.drawArrays(gl.LINES, 0, 2);

                // Render canopy
                const canopyMatrix = treeMatrix.slice();
                maplibregl.mat4.translate(canopyMatrix, canopyMatrix, [0, 0, trunkHeight]); // Position canopy on top of the trunk
                maplibregl.mat4.scale(canopyMatrix, canopyMatrix, [canopyRadius / 4, canopyRadius / 4, canopyRadius / 4]); // Scale canopy based on radius

                gl.uniform4f(this.u_color, 0.1, 0.5, 0.1, 1.0);
                gl.uniformMatrix4fv(this.u_matrix, false, canopyMatrix);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereVertexBuffer);
                gl.enableVertexAttribArray(this.a_pos);
                gl.vertexAttribPointer(this.a_pos, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereNormalBuffer);
                gl.enableVertexAttribArray(this.a_normal);
                gl.vertexAttribPointer(this.a_normal, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sphereIndexBuffer);
                gl.drawElements(gl.TRIANGLES, this.sphereIndexCount, gl.UNSIGNED_SHORT, 0);
            });

            map.triggerRepaint();
        }
    };
    return treeLayer;
}