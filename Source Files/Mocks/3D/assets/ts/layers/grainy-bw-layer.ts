import "maplibre-gl";

export const grainyBWLayer: maplibregl.CustomLayerInterface = {
    id: 'grainy-bw',
    type: 'custom',
    renderingMode: '2d',

    // Configurable properties with default values
    grainAmount: 0.06,
    blurIntensity: 0.7,
    halftoneSize: 0.0,
    halftoneAngle: 45.0,

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
            uniform vec2 u_resolution;
            uniform float u_grain_amount;
            uniform float u_blur_intensity;
            uniform float u_halftone_size;
            uniform float u_halftone_angle;

            float random(vec2 st) {
                return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
            }

            void main() {
                vec2 onePixel = vec2(1.0, 1.0) / u_resolution;
                vec4 blurred_color = vec4(0.0);

                // 3x3 box blur
                for (int x = -1; x <= 1; x++) {
                    for (int y = -1; y <= 1; y++) {
                        vec2 sample_coord = v_tex_pos + vec2(float(x), float(y)) * onePixel * u_blur_intensity;
                        vec4 color = texture2D(u_texture, sample_coord);

                        // Add grain to the sampled color before blurring
                        float grain = (random(sample_coord) - 0.5) * u_grain_amount;
                        color.rgb += grain;

                        blurred_color += color;
                    }
                }
                blurred_color /= 9.0;
            
                // Convert to grayscale
                float luma = dot(blurred_color.rgb, vec3(0.299, 0.587, 0.114));
                vec3 final_color = vec3(luma);

                if (u_halftone_size > 0.0) {
                    // AM Halftone effect
                    float gray = pow(luma, 1.0 / 2.2); // Apply gamma correction for better visual brightness
                    float angle_rad = u_halftone_angle * 3.14159265359 / 180.0;
                    mat2 rotation = mat2(cos(angle_rad), -sin(angle_rad), sin(angle_rad), cos(angle_rad));
                    vec2 rotated_coords = rotation * gl_FragCoord.xy;
                    vec2 grid_uv = rotated_coords / u_halftone_size;
                    float dot_radius = sqrt(1.0 - gray) * 0.707; // Invert the gray value
                    float dist = distance(fract(grid_uv), vec2(0.5));
                    float dot_value = smoothstep(dot_radius, dot_radius + 0.01, dist);
                    final_color = vec3(dot_value);
                }

                gl_FragColor = vec4(final_color, blurred_color.a);
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
        this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
        this.u_grain_amount = gl.getUniformLocation(this.program, "u_grain_amount");
        this.u_blur_intensity = gl.getUniformLocation(this.program, "u_blur_intensity");
        this.u_halftone_size = gl.getUniformLocation(this.program, "u_halftone_size");
        this.u_halftone_angle = gl.getUniformLocation(this.program, "u_halftone_angle");

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        this.buffer = buf;

        // Create a texture to hold the map's content
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    },
    render: function(gl, matrix) {
        // Copy the map's content to the texture
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.drawingBufferWidth, gl.drawingBufferHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, 0);

        gl.useProgram(this.program);

        // Set uniforms
        gl.uniform2f(this.u_resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.uniform1i(this.u_texture, 0); // texture unit 0
        gl.uniform1f(this.u_grain_amount, this.grainAmount);
        gl.uniform1f(this.u_blur_intensity, this.blurIntensity);
        gl.uniform1f(this.u_halftone_size, this.halftoneSize);
        gl.uniform1f(this.u_halftone_angle, this.halftoneAngle);

        // Bind the vertex buffer and set the attribute pointer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a_pos);
        gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);

        // Draw the fullscreen quad
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}