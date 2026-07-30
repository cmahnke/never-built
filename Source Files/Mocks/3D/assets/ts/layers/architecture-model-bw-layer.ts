// assets/ts/layers/architecture-model-bw-layer.ts

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const VERTEX_SRC = /* glsl */ `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SRC = /* glsl */ `
  precision mediump float;

  uniform sampler2D u_scene;
  uniform vec2  u_resolution;
  uniform float u_time;

  uniform float u_contrast;
  uniform float u_brightness;
  uniform float u_grainAmount;
  uniform float u_grainSize;
  uniform float u_vignetteStrength;
  uniform float u_vignetteInner;
  uniform float u_vignetteOuter;
  uniform float u_edgeStrength;
  uniform float u_blurStrength;
  uniform float u_antialias;
  uniform vec3  u_paperTone;
  uniform vec3  u_shadowTone;

  varying vec2 v_uv;

  const vec3 LUMA = vec3(0.299, 0.587, 0.114);

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453 + u_time);
  }

  float luma(vec2 uv) {
    return dot(texture2D(u_scene, uv).rgb, LUMA);
  }

  // ── FXAA (edge-directed anti-aliasing) ─────────────────────────────────
  // Standard NVIDIA-style FXAA "lite": detects the direction of highest
  // local contrast and blends along it. Cheap (5–9 taps), no extra
  // render targets needed, works great as a pre-pass before B/W tone
  // mapping and edge-darkening, which would otherwise amplify jaggies
  // coming from vector-rendered building/road geometry.
  vec3 fxaa(sampler2D tex, vec2 uv, vec2 texel) {
    vec3 rgbNW = texture2D(tex, uv + vec2(-1.0, -1.0) * texel).rgb;
    vec3 rgbNE = texture2D(tex, uv + vec2( 1.0, -1.0) * texel).rgb;
    vec3 rgbSW = texture2D(tex, uv + vec2(-1.0,  1.0) * texel).rgb;
    vec3 rgbSE = texture2D(tex, uv + vec2( 1.0,  1.0) * texel).rgb;
    vec3 rgbM  = texture2D(tex, uv).rgb;

    float lumaNW = dot(rgbNW, LUMA);
    float lumaNE = dot(rgbNE, LUMA);
    float lumaSW = dot(rgbSW, LUMA);
    float lumaSE = dot(rgbSE, LUMA);
    float lumaM  = dot(rgbM,  LUMA);

    float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

    vec2 dir;
    dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
    dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));

    const float FXAA_REDUCE_MIN = 1.0 / 128.0;
    const float FXAA_REDUCE_MUL = 1.0 / 8.0;
    const float FXAA_SPAN_MAX   = 8.0;

    float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
    float rcpDirMin  = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * texel;

    vec3 rgbA = 0.5 * (
      texture2D(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
      texture2D(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb
    );
    vec3 rgbB = rgbA * 0.5 + 0.25 * (
      texture2D(tex, uv + dir * (0.0 / 3.0 - 0.5)).rgb +
      texture2D(tex, uv + dir * (3.0 / 3.0 - 0.5)).rgb
    );

    float lumaB = dot(rgbB, LUMA);
    return (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
  }

  // Cheap weighted box blur, radius in texels. Used only for the
  // fake tilt-shift effect (radius scales with distance from the
  // horizontal center band, like a miniature/macro photo).
  vec3 blurredColor(vec2 uv, vec2 texel, float radius) {
    if (radius < 0.001) {
      return u_antialias > 0.5 ? fxaa(u_scene, uv, texel) : texture2D(u_scene, uv).rgb;
    }
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        vec2 o = vec2(float(x), float(y));
        float w = max(1.0 - length(o) / 3.0, 0.0);
        sum += texture2D(u_scene, uv + o * texel * radius).rgb * w;
        total += w;
      }
    }
    return sum / max(total, 0.0001);
  }

  void main() {
    vec2 texel = 1.0 / u_resolution;
    vec2 centered = v_uv - 0.5;

    // ── Fake tilt-shift (sharp band across the middle, blurred top/bottom) ──
    float bandDist = abs(centered.y) * 2.0;
    float blurRadius = u_blurStrength * bandDist * 4.0;
    vec3 color = blurredColor(v_uv, texel, blurRadius);

    // ── Grayscale ──
    float lum = dot(color, LUMA);

    // ── Contrast (S-curve around mid-grey) + brightness ──
    float c = (lum - 0.5) * u_contrast + 0.5 + u_brightness;
    c = clamp(c, 0.0, 1.0);

    // ── Sobel edge detection → darken silhouette / cut-lines ──
    float tl = luma(v_uv + texel * vec2(-1.0,  1.0));
    float t  = luma(v_uv + texel * vec2( 0.0,  1.0));
    float tr = luma(v_uv + texel * vec2( 1.0,  1.0));
    float l  = luma(v_uv + texel * vec2(-1.0,  0.0));
    float r  = luma(v_uv + texel * vec2( 1.0,  0.0));
    float bl = luma(v_uv + texel * vec2(-1.0, -1.0));
    float b  = luma(v_uv + texel * vec2( 0.0, -1.0));
    float br = luma(v_uv + texel * vec2( 1.0, -1.0));

    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
    float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
    float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);

    c = mix(c, c * (1.0 - u_edgeStrength), edge);

    // ── Tone-map toward "matte plaster" palette instead of pure 0..1 grey ──
    vec3 toned = mix(u_shadowTone, u_paperTone, c);

    // ── Film grain ──
    vec2 grainUv = floor(v_uv * u_resolution / u_grainSize);
    toned += (rand(grainUv) - 0.5) * u_grainAmount;

    // ── Vignette ──
    float dist = length(centered);
    float vig = smoothstep(u_vignetteInner, u_vignetteOuter, dist);
    toned *= (1.0 - vig * u_vignetteStrength);

    gl_FragColor = vec4(clamp(toned, 0.0, 1.0), 1.0);
  }
`;

function compileShader(gl: GL, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function linkProgram(gl: GL, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export class ArchitectureModelBWLayer implements CustomLayerInterface {
  id = "architecture-model-bw";
  type = "custom" as const;
  renderingMode = "2d" as const;

  // ── Tunable look parameters ────────────────────────────────────────────
  enabled = true;
  antialias = true; // toggle FXAA on/off at runtime
  contrast = 1.35;
  brightness = 0.03;
  grainAmount = 0.045;
  grainSize = 1.6;
  vignetteStrength = 0.35;
  vignetteInner = 0.35;
  vignetteOuter = 0.78;
  edgeStrength = 0.35;
  blurStrength = 0.0; // 0 = off, try 0.6–1.2 for a tilt-shift model look
  paperTone: [number, number, number] = [0.98, 0.97, 0.94];
  shadowTone: [number, number, number] = [0.05, 0.05, 0.06];

  private gl!: GL;
  private program!: WebGLProgram;
  private quadBuffer!: WebGLBuffer;
  private posLoc = 0;
  private sceneTexture!: WebGLTexture;
  private texWidth = 0;
  private texHeight = 0;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private startTime = performance.now();

  onAdd(_map: MapLibreMap, gl: GL): void {
    this.gl = gl;
    this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);

    this.posLoc = gl.getAttribLocation(this.program, "a_position");
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.sceneTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const names = [
      "u_scene",
      "u_resolution",
      "u_time",
      "u_contrast",
      "u_brightness",
      "u_grainAmount",
      "u_grainSize",
      "u_vignetteStrength",
      "u_vignetteInner",
      "u_vignetteOuter",
      "u_edgeStrength",
      "u_blurStrength",
      "u_antialias",
      "u_paperTone",
      "u_shadowTone"
    ];
    for (const name of names) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  onRemove(_map: MapLibreMap, gl: GL): void {
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteTexture(this.sceneTexture);
  }

  render(gl: GL, _matrix: number[]): void {
    if (!this.enabled) return;

    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    // ── Grab whatever has been rendered so far into a texture ───────────
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    if (width !== this.texWidth || height !== this.texHeight) {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, width, height, 0);
      this.texWidth = width;
      this.texHeight = height;
    } else {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    }

    // ── Save state we're about to touch ──────────────────────────────────
    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);
    const prevBlend = gl.getParameter(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(false);

    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.uniform1i(this.uniforms.u_scene, 0);

    gl.uniform2f(this.uniforms.u_resolution, width, height);
    gl.uniform1f(this.uniforms.u_time, (performance.now() - this.startTime) / 1000);

    gl.uniform1f(this.uniforms.u_contrast, this.contrast);
    gl.uniform1f(this.uniforms.u_brightness, this.brightness);
    gl.uniform1f(this.uniforms.u_grainAmount, this.grainAmount);
    gl.uniform1f(this.uniforms.u_grainSize, this.grainSize);
    gl.uniform1f(this.uniforms.u_vignetteStrength, this.vignetteStrength);
    gl.uniform1f(this.uniforms.u_vignetteInner, this.vignetteInner);
    gl.uniform1f(this.uniforms.u_vignetteOuter, this.vignetteOuter);
    gl.uniform1f(this.uniforms.u_edgeStrength, this.edgeStrength);
    gl.uniform1f(this.uniforms.u_blurStrength, this.blurStrength);
    gl.uniform1f(this.uniforms.u_antialias, this.antialias ? 1.0 : 0.0);
    gl.uniform3f(this.uniforms.u_paperTone, ...this.paperTone);
    gl.uniform3f(this.uniforms.u_shadowTone, ...this.shadowTone);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // ── Restore state ─────────────────────────────────────────────────
    gl.depthMask(true);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
  }
}
