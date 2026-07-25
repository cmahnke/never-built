import "maplibre-gl";

type GrainyBWLayer = maplibregl.CustomLayerInterface & {
  grainAmount: number;
  blurIntensity: number;
  halftoneSize: number;
  halftoneAngle: number;
  program?: WebGLProgram;
  a_pos?: number;
  u_texture?: WebGLUniformLocation | null;
  u_resolution?: WebGLUniformLocation | null;
  u_grain_amount?: WebGLUniformLocation | null;
  u_blur_intensity?: WebGLUniformLocation | null;
  u_halftone_size?: WebGLUniformLocation | null;
  u_halftone_angle?: WebGLUniformLocation | null;
  buffer?: WebGLBuffer | null;
  texture?: WebGLTexture | null;
  texWidth?: number;
  texHeight?: number;
};

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

export const grainyBWLayer: GrainyBWLayer = {
  id: "grainy-bw",
  type: "custom",
  renderingMode: "2d",

  grainAmount: 0.06,
  blurIntensity: 0.7,
  halftoneSize: 0.0,
  halftoneAngle: 45.0,

  onAdd(map, gl) {
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

        for (int x = -1; x <= 1; x++) {
          for (int y = -1; y <= 1; y++) {
            vec2 sample_coord = v_tex_pos + vec2(float(x), float(y)) * onePixel * u_blur_intensity;
            vec4 color = texture2D(u_texture, sample_coord);
            float grain = (random(sample_coord) - 0.5) * u_grain_amount;
            color.rgb += grain;
            blurred_color += color;
          }
        }
        blurred_color /= 9.0;

        float luma = dot(blurred_color.rgb, vec3(0.299, 0.587, 0.114));
        vec3 final_color = vec3(luma);

        if (u_halftone_size > 0.0) {
          float gray = pow(luma, 1.0 / 2.2);
          float angle_rad = u_halftone_angle * 3.14159265359 / 180.0;
          mat2 rotation = mat2(cos(angle_rad), -sin(angle_rad), sin(angle_rad), cos(angle_rad));
          vec2 rotated_coords = rotation * gl_FragCoord.xy;
          vec2 grid_uv = rotated_coords / u_halftone_size;
          float dot_radius = sqrt(1.0 - gray) * 0.707;
          float dist = distance(fract(grid_uv), vec2(0.5));
          float dot_value = smoothstep(dot_radius, dot_radius + 0.01, dist);
          final_color = vec3(dot_value);
        }

        // Force opaque output — backbuffer alpha isn't reliable for compositing.
        gl_FragColor = vec4(final_color, 1.0);
      }
    `;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;

    this.a_pos = gl.getAttribLocation(program, "a_pos");
    this.u_texture = gl.getUniformLocation(program, "u_texture");
    this.u_resolution = gl.getUniformLocation(program, "u_resolution");
    this.u_grain_amount = gl.getUniformLocation(program, "u_grain_amount");
    this.u_blur_intensity = gl.getUniformLocation(program, "u_blur_intensity");
    this.u_halftone_size = gl.getUniformLocation(program, "u_halftone_size");
    this.u_halftone_angle = gl.getUniformLocation(program, "u_halftone_angle");

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.buffer = buf;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Allocate storage once; resized lazily in render() if needed.
    this.texWidth = 0;
    this.texHeight = 0;
  },

  onRemove(_map, gl) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.texture) gl.deleteTexture(this.texture);
  },

  render(gl) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture!);

    if (w !== this.texWidth || h !== this.texHeight) {
      // Reallocate storage only when size actually changes.
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
      this.texWidth = w;
      this.texHeight = h;
    } else {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    }

    // Ensure state left by other layers doesn't affect this fullscreen pass.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(this.program!);
    gl.uniform2f(this.u_resolution!, w, h);
    gl.uniform1i(this.u_texture!, 0);
    gl.uniform1f(this.u_grain_amount!, this.grainAmount);
    gl.uniform1f(this.u_blur_intensity!, this.blurIntensity);
    gl.uniform1f(this.u_halftone_size!, this.halftoneSize);
    gl.uniform1f(this.u_halftone_angle!, this.halftoneAngle);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
    gl.enableVertexAttribArray(this.a_pos!);
    gl.vertexAttribPointer(this.a_pos!, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
};
