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
  fbo?: WebGLFramebuffer | null;
  texWidth?: number;
  texHeight?: number;
};

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  src: string
): WebGLShader {
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
        v_tex_pos   = a_pos;
        gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;

      varying vec2 v_tex_pos;

      uniform sampler2D u_texture;
      uniform vec2      u_resolution;
      uniform float     u_grain_amount;
      uniform float     u_blur_intensity;
      uniform float     u_halftone_size;
      uniform float     u_halftone_angle;

      float random(vec2 st) {
        return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
      }

      float luma(vec3 c) {
        return dot(c, vec3(0.299, 0.587, 0.114));
      }

      // Luminance-based FXAA lite — blends the current pixel with its
      // 4 axis-aligned neighbours when a sharp luma edge is detected.
      vec3 fxaa(vec2 uv, vec3 centre, vec2 px) {
        float lumaC = luma(centre);
        float lumaN = luma(texture2D(u_texture, uv + vec2( 0.0,  px.y)).rgb);
        float lumaS = luma(texture2D(u_texture, uv + vec2( 0.0, -px.y)).rgb);
        float lumaE = luma(texture2D(u_texture, uv + vec2( px.x,  0.0)).rgb);
        float lumaW = luma(texture2D(u_texture, uv + vec2(-px.x,  0.0)).rgb);

        float rangeMax = max(max(lumaN, lumaS), max(lumaE, lumaW));
        float rangeMin = min(min(lumaN, lumaS), min(lumaE, lumaW));
        float range    = rangeMax - rangeMin;

        // Skip smooth regions
        if (range < max(0.0625, rangeMax * 0.125)) {
          return centre;
        }

        float filter = abs((lumaN + lumaS + lumaE + lumaW) * 0.25 - lumaC);
        float blend  = smoothstep(0.0, 1.0, clamp(filter / range, 0.0, 1.0));

        float lumaAvg = (lumaN + lumaS + lumaE + lumaW) * 0.25;
        return mix(centre, vec3(lumaAvg), blend * 0.75);
      }

      void main() {
        vec2 px = vec2(1.0) / u_resolution;

        // 1. 3x3 box-blur with per-tap grain
        vec4 blurred = vec4(0.0);
        for (int x = -1; x <= 1; x++) {
          for (int y = -1; y <= 1; y++) {
            vec2  offset = vec2(float(x), float(y)) * px * u_blur_intensity;
            vec2  coord  = v_tex_pos + offset;
            vec4  s      = texture2D(u_texture, coord);
            float grain  = (random(coord) - 0.5) * u_grain_amount;
            s.rgb += grain;
            blurred += s;
          }
        }
        blurred /= 9.0;

        // 2. Greyscale
        float lumaVal = luma(blurred.rgb);
        vec3  grey    = vec3(lumaVal);

        // 3. Halftone (optional)
        if (u_halftone_size > 0.0) {
          float grey_gamma = pow(lumaVal, 1.0 / 2.2);

          float angle_rad = u_halftone_angle * 3.14159265359 / 180.0;
          float cosA      = cos(angle_rad);
          float sinA      = sin(angle_rad);

          vec2 fc       = gl_FragCoord.xy;
          vec2 rotated  = vec2(cosA * fc.x - sinA * fc.y,
                               sinA * fc.x + cosA * fc.y);
          vec2 cell_uv  = fract(rotated / u_halftone_size);

          float dot_radius = sqrt(1.0 - grey_gamma) * 0.707;

          // AA edge = 1 pixel in cell-UV space
          float aa        = 1.0 / u_halftone_size;
          float dist      = distance(cell_uv, vec2(0.5));
          float dot_value = smoothstep(dot_radius - aa,
                                       dot_radius + aa,
                                       dist);
          grey = vec3(dot_value);
        }

        // 4. FXAA-lite on the greyscale result
        vec3 antialiased = fxaa(v_tex_pos, grey, px);

        gl_FragColor = vec4(antialiased, 1.0);
      }
    `;

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = program;

    this.a_pos            = gl.getAttribLocation(program, "a_pos");
    this.u_texture        = gl.getUniformLocation(program, "u_texture");
    this.u_resolution     = gl.getUniformLocation(program, "u_resolution");
    this.u_grain_amount   = gl.getUniformLocation(program, "u_grain_amount");
    this.u_blur_intensity = gl.getUniformLocation(program, "u_blur_intensity");
    this.u_halftone_size  = gl.getUniformLocation(program, "u_halftone_size");
    this.u_halftone_angle = gl.getUniformLocation(program, "u_halftone_angle");

    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    this.buffer = buf;

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.texture = tex;

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fbo = fbo;

    this.texWidth  = 0;
    this.texHeight = 0;
  },

  onRemove(_map, gl) {
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer)  gl.deleteBuffer(this.buffer);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.fbo)     gl.deleteFramebuffer(this.fbo);
  },

  render(gl) {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    // Snapshot the current backbuffer into our texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture!);

    if (w !== this.texWidth || h !== this.texHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA,
        w, h, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null
      );
      this.texWidth  = w;
      this.texHeight = h;
    }

    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);

    // Post-process pass onto the default framebuffer
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(this.program!);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture!);

    gl.uniform1i(this.u_texture!,         0);
    gl.uniform2f(this.u_resolution!,      w, h);
    gl.uniform1f(this.u_grain_amount!,    this.grainAmount);
    gl.uniform1f(this.u_blur_intensity!,  this.blurIntensity);
    gl.uniform1f(this.u_halftone_size!,   this.halftoneSize);
    gl.uniform1f(this.u_halftone_angle!,  this.halftoneAngle);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
    gl.enableVertexAttribArray(this.a_pos!);
    gl.vertexAttribPointer(this.a_pos!, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Restore state
    gl.disableVertexAttribArray(this.a_pos!);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  },
};
