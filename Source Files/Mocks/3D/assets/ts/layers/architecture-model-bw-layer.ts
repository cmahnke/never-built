// assets/ts/layers/architecture-model-bw-layer.ts

import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

// Add pure red and pure blue to the highlight list (normalized 0.0 to 1.0)
/*
bwLayer.highlightColors = [
  [1.0, 0.0, 0.0],
  [0.0, 0.0, 1.0]
];
*/

const VERTEX_SRC = /* glsl */ `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SRC = /* glsl */ `
  precision highp float;

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

  // ── Highlighting Uniforms ──
  const int MAX_HIGHLIGHT_COLORS = 8;
  uniform vec3 u_highlightColors[MAX_HIGHLIGHT_COLORS];
  uniform int u_highlightCount;
  uniform float u_highlightThreshold;

  varying vec2 v_uv;

  const vec3 LUMA = vec3(0.299, 0.587, 0.114);

  float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453 + u_time);
  }

  float luma(vec2 uv) {
    return dot(texture2D(u_scene, uv).rgb, LUMA);
  }

  // ── FXAA (edge-directed anti-aliasing) ─────────────────────────────────
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

  vec3 blurredColor(vec2 uv, vec2 texel, float radius) {
    vec3 sum = vec3(0.0);
    float total = 0.0;

    // FIX 3: Start loops at 0 to avoid iOS ANGLE compiler bugs with negative indices
    for (int i = 0; i < 5; i++) {
      for (int j = 0; j < 5; j++) {
        vec2 o = vec2(float(i - 2), float(j - 2));
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

    float bandDist = abs(centered.y) * 2.0;
    float blurRadius = u_blurStrength * bandDist * 4.0;

    vec3 blurred = blurredColor(v_uv, texel, blurRadius);
    vec3 sharp = u_antialias > 0.5 ? fxaa(u_scene, v_uv, texel) : texture2D(u_scene, v_uv).rgb;
    vec3 color = mix(sharp, blurred, smoothstep(0.0, 0.01, blurRadius));

    // ── Highlight Detection (Branchless for iOS performance) ──
    float isHighlighted = 0.0;
    for (int i = 0; i < MAX_HIGHLIGHT_COLORS; i++) {
        // Mask out inactive colors to avoid matching uninitialized memory
        float active = step(float(i) + 0.5, float(u_highlightCount));
        float dist = distance(color.rgb, u_highlightColors[i]);
        float match = step(dist, u_highlightThreshold) * active;
        isHighlighted = max(isHighlighted, match);
    }

    // ── Grayscale & Contrast ──
    float lum = dot(color, LUMA);
    float c = (lum - 0.5) * u_contrast + 0.5 + u_brightness;
    c = clamp(c, 0.0, 1.0);

    // ── Sobel edge detection ──
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
    vec3 toned = mix(u_shadowTone, u_paperTone, c);

    // Mix toned grayscale with original color if highlighted
    vec3 finalColor = mix(toned, color, isHighlighted);

    // ── Film grain ──
    vec2 grainUv = floor(v_uv * u_resolution / u_grainSize);
    finalColor += (rand(grainUv) - 0.5) * u_grainAmount;

    // ── Vignette ──
    float dist = length(centered);
    float vig = smoothstep(u_vignetteInner, u_vignetteOuter, dist);
    finalColor *= (1.0 - vig * u_vignetteStrength);

    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
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

  // ── Highlighting parameters ────────────────────────────────────────────
  // Colors must be normalized 0.0 - 1.0 (e.g., [1.0, 0.0, 0.0] for pure red)
  highlightColors: [number, number, number][] = [];
  highlightThreshold: number = 0.15; // Tolerance for color matching (0.0 - 1.0)

  private gl!: GL;
  private program!: WebGLProgram;
  private quadBuffer!: WebGLBuffer;
  private posLoc = 0;
  private sceneTexture!: WebGLTexture;
  private texWidth = 0;
  private texHeight = 0;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private startTime = performance.now();

  addHighlightColor(color: string): this {
    let hex = color.replace(/^#/, "").trim();

    // Handle 3-digit hex (e.g., "F00" -> "FF0000")
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }

    // Parse and normalize 6-digit hex to 0.0 - 1.0 range
    if (hex.length === 6 && /^[0-9A-Fa-f]{6}$/.test(hex)) {
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      this.highlightColors.push([r, g, b]);
    } else {
      console.warn(`[ArchitectureModelBWLayer] Invalid color format: "${color}". Expected hex (e.g., "#FF0000" or "F00").`);
    }

    return this;
  }

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
      "u_shadowTone",
      "u_highlightCount",
      "u_highlightThreshold",
      "u_highlightColors"
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

    if (width <= 0 || height <= 0) return;

    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);

    if (width !== this.texWidth || height !== this.texHeight) {
      const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      const internalFormat = isWebGL2 ? (gl as WebGL2RenderingContext).RGBA8 : gl.RGBA;
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      this.texWidth = width;
      this.texHeight = height;
    }

    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);

    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST) as boolean;
    const prevBlend = gl.getParameter(gl.BLEND) as boolean;
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

    // ── Highlighting Uniforms ──
    const maxColors = 8;
    const flatColors = new Float32Array(maxColors * 3);
    const count = Math.min(this.highlightColors.length, maxColors);

    for (let i = 0; i < count; i++) {
      flatColors[i * 3] = this.highlightColors[i][0];
      flatColors[i * 3 + 1] = this.highlightColors[i][1];
      flatColors[i * 3 + 2] = this.highlightColors[i][2];
    }

    if (this.uniforms.u_highlightColors) {
      gl.uniform3fv(this.uniforms.u_highlightColors, flatColors);
    }
    gl.uniform1i(this.uniforms.u_highlightCount, count);
    gl.uniform1f(this.uniforms.u_highlightThreshold, this.highlightThreshold);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.depthMask(true);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    if (prevBlend) gl.enable(gl.BLEND);
  }
}
