// assets/ts/layers/tree-layer.ts

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
  LngLatLike,
  MapGeoJSONFeature,
  MapSourceDataEvent,
  FilterSpecification,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

// ─── Shaders ────────────────────────────────────────────────────────────────

const VERTEX_SRC = /* glsl */ `
  // Per-vertex (shared quad, 4 verts, drawn as TRIANGLE_STRIP)
  attribute vec2 a_corner;      // x: -0.5..0.5, y: 0 (base) .. 1 (top)

  // Per-instance (one tree each)
  attribute vec3 a_instancePos;  // mercator x, y, z (ground/terrain height)
  attribute vec2 a_instanceSize; // width, height in mercator units
  attribute float a_instanceSeed;

  uniform mat4  u_matrix;
  uniform vec3  u_cameraPos;   // mercator-space camera position
  uniform float u_time;
  uniform float u_windStrength;
  uniform float u_windSpeed;

  varying vec2  v_uv;
  varying float v_seed;

  void main() {
    v_uv   = vec2(a_corner.x + 0.5, 1.0 - a_corner.y);
    v_seed = a_instanceSeed;

    vec3 toCamera = u_cameraPos - a_instancePos;
    // Keep billboard upright: only rotate around the vertical (z) axis.
    vec3 toCameraFlat = vec3(toCamera.xy, 0.0);
    float len = length(toCameraFlat);
    vec3 forward = len > 1e-9 ? toCameraFlat / len : vec3(1.0, 0.0, 0.0);
    vec3 worldUp = vec3(0.0, 0.0, 1.0);
    vec3 right   = normalize(cross(worldUp, forward));

    // Fake wind: sway top vertices sideways along "right", phase offset per tree.
    float sway = sin(u_time * u_windSpeed + a_instanceSeed * 6.2831853) *
                 u_windStrength * a_corner.y;

    vec3 offset =
      right   * (a_corner.x * a_instanceSize.x + sway) +
      worldUp * (a_corner.y * a_instanceSize.y);

    vec3 worldPos = a_instancePos + offset;
    gl_Position = u_matrix * vec4(worldPos, 1.0);
  }
`;

const FRAGMENT_SRC = /* glsl */ `
  precision mediump float;

  uniform sampler2D u_sprite;
  uniform float     u_opacity;
  uniform vec3      u_tint;
  uniform bool      u_debug;

  varying vec2  v_uv;
  varying float v_seed;

  void main() {
    vec4 tex = texture2D(u_sprite, v_uv);

    if (u_debug) {
      gl_FragColor = vec4(mix(vec3(1.0, 0.0, 1.0), u_tint, 0.3), tex.a * u_opacity);
      if (tex.a < 0.05) discard;
      return;
    }

    if (tex.a < 0.1) discard; // alpha-cutout: lets us keep normal depth writes

    // Subtle per-tree tint variance so a forest doesn't look copy-pasted.
    // Note: the default sprite already bakes in per-facet shading (see
    // buildDefaultAbstractTreeSvg), so this variance is intentionally
    // gentle — it nudges brightness, it doesn't need to invent shape.
    float variance = 0.9 + 0.2 * fract(v_seed * 13.37);
    vec3 color = tex.rgb * u_tint * variance;

    gl_FragColor = vec4(color, tex.a * u_opacity);
  }
`;

// ─── GL helpers ─────────────────────────────────────────────────────────────

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

/** Thin wrapper so we can use hardware instancing on both WebGL1 (via
 *  ANGLE_instanced_arrays) and WebGL2 (native) with one code path. */
interface Instancing {
  vertexAttribDivisor(index: number, divisor: number): void;
  drawArraysInstanced(mode: number, first: number, count: number, instanceCount: number): void;
}

function getInstancing(gl: GL): Instancing {
  if ("drawArraysInstanced" in gl) {
    const gl2 = gl as WebGL2RenderingContext;
    return {
      vertexAttribDivisor: (index: number, divisor: number): void =>
        gl2.vertexAttribDivisor(index, divisor),
      drawArraysInstanced: (
        mode: number,
        first: number,
        count: number,
        instanceCount: number
      ): void => gl2.drawArraysInstanced(mode, first, count, instanceCount),
    };
  }

  // NOTE: lib.dom.d.ts already declares the `ANGLE_instanced_arrays`
  // interface + the matching getExtension() overload, so `ext` below is
  // typed as `ANGLE_instanced_arrays | null` — no `any` involved.
  const ext = (gl as WebGLRenderingContext).getExtension("ANGLE_instanced_arrays");
  if (!ext) {
    throw new Error("Instanced rendering not supported (need WebGL2 or ANGLE_instanced_arrays)");
  }

  return {
    vertexAttribDivisor: (index: number, divisor: number): void =>
      ext.vertexAttribDivisorANGLE(index, divisor),
    drawArraysInstanced: (
      mode: number,
      first: number,
      count: number,
      instanceCount: number
    ): void => ext.drawArraysInstancedANGLE(mode, first, count, instanceCount),
  };
}

// ─── Default abstract vector tree (SVG) ────────────────────────────────────

interface FacetTriangle {
  points: [[number, number], [number, number], [number, number]];
  /** 0 (darkest) .. 1 (brightest) — baked-in facet shading. Multiplied
   *  by u_tint per-instance in the fragment shader, so the overall hue
   *  is still fully controllable via `TreeLayer.tint`. */
  shade: number;
}

function trianglePoints(t: FacetTriangle["points"]): string {
  return t.map(([x, y]) => `${x},${y}`).join(" ");
}

function shadeToHex(shade: number): string {
  const v = Math.round(Math.max(0, Math.min(1, shade)) * 255);
  const hex = v.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

/**
 * Builds a stylized, low-poly "paper-craft" SYCAMORE as raw SVG markup:
 * a broad, irregular/lobed radial-fan canopy (a fixed, hand-tuned set of
 * boundary radii — not a perfect circle — to suggest the asymmetric,
 * wide-spreading crown typical of a mature sycamore), flat-shaded per
 * facet via a fixed upper-right "sunlight" direction, plus a short,
 * slightly forked trunk hinting at the multi-limbed structure sycamores
 * often develop.
 *
 * This is intentionally geometric/abstract rather than photorealistic,
 * to match the flat-shaded "architecture model" look used elsewhere in
 * this project (see ArchitectureModelBWLayer). Output is pure vector
 * (polygons only, no raster data), and is only rasterized into a GPU
 * texture at the very end via an off-screen <img> load — see
 * `TreeLayer.loadVectorSprite()`.
 */
function buildDefaultAbstractTreeSvg(size = 256): string {
  // Working in a 100×100 coordinate space for readable numbers; scaled
  // to `size` via the SVG's width/height + viewBox.
  const cx = 50;
  const cy = 38; // canopy center height, leaving room for the trunk below

  // Sycamores read as broad and rounded rather than tall — squash the
  // fan vertically a bit so the crown isn't a perfect circle.
  const verticalSquash = 0.82;

  // Hand-tuned (not random) boundary radii, so the default tree is
  // deterministic/reproducible — gives the canopy an irregular, lobed
  // silhouette instead of a perfect circle.
  const radii = [30, 25, 33, 24, 31, 27, 34, 23, 32, 26, 29, 28];
  const n = radii.length;

  const boundary: Array<[number, number]> = radii.map((r, i) => {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top, go clockwise
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r * verticalSquash;
    return [x, y];
  });

  // Fixed "sunlight from the upper right" direction, used to shade each
  // fan triangle by how directly its outward-facing normal points toward
  // the light — gives the flat-shaded canopy a sense of volume without
  // any raster gradients.
  const lightX = 0.75;
  const lightY = -0.66;
  const lightLen = Math.hypot(lightX, lightY);
  const lx = lightX / lightLen;
  const ly = lightY / lightLen;

  const canopyFacets: FacetTriangle[] = [];
  for (let i = 0; i < n; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % n];
    const midX = (a[0] + b[0]) / 2 - cx;
    const midY = (a[1] + b[1]) / 2 - cy;
    const midLen = Math.hypot(midX, midY) || 1;
    const dot = (midX / midLen) * lx + (midY / midLen) * ly; // -1..1
    const shade = 0.62 + ((dot + 1) / 2) * 0.36; // map to ~0.62..0.98
    canopyFacets.push({ points: [[cx, cy], a, b], shade });
  }

  // Trunk: short and slightly forked near the canopy base, evoking the
  // multi-limbed silhouette typical of a mature sycamore — without
  // modeling actual branch geometry.
  const trunkTopY = cy + 22;
  const forkY = 78;
  const baseY = 95;

  const trunkFacets: FacetTriangle[] = [
    // Left limb — slightly darker, matching the canopy's left-shade bias.
    { points: [[cx - 5, trunkTopY], [cx - 1, forkY], [cx - 9, baseY]], shade: 0.55 },
    // Right limb — lighter, facing the light source.
    { points: [[cx + 5, trunkTopY], [cx + 1, forkY], [cx + 8, baseY]], shade: 0.75 },
    // Wedge connecting both limbs at the fork so they read as one trunk.
    { points: [[cx - 5, trunkTopY], [cx + 5, trunkTopY], [cx, forkY]], shade: 0.65 },
  ];

  // Trunk drawn first, canopy fan drawn on top (slightly overlapping the
  // trunk's top few units) — same draw order convention as before, so
  // the trunk appears to emerge naturally from beneath the crown.
  const polygons = [...trunkFacets, ...canopyFacets]
    .map((f) => `<polygon points="${trianglePoints(f.points)}" fill="${shadeToHex(f.shade)}" />`)
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 100 100">` +
    polygons +
    `</svg>`
  );
}

/** Extreme fallback if even SVG data-URI rasterization fails (should be
 *  effectively unreachable — data: URIs don't hit network/CORS issues —
 *  but better a visible gray square than a silently invisible layer). */
function createFallbackCanvas(size = 64): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#bbbbbb";
  ctx.fillRect(size * 0.3, size * 0.1, size * 0.4, size * 0.6);
  return canvas;
}

// ─── Geo helpers (line sampling for tree_row) ──────────────────────────────

const EARTH_RADIUS_METERS = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lng/lat points, in meters.
 *  Accurate enough at the scale of a single tree row (tens to low
 *  hundreds of meters) — no need for a full geodesic library here. */
function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersToDegreesLat(meters: number): number {
  return meters / 111320;
}

function metersToDegreesLng(meters: number, atLat: number): number {
  return meters / (111320 * Math.cos(toRad(atLat)));
}

interface SampledPoint {
  lng: number;
  lat: number;
  /** Direction of travel at this sample, in raw lng/lat degrees (not
   *  normalized to meters) — good enough to derive a perpendicular
   *  offset for the row-jitter effect. */
  dirLng: number;
  dirLat: number;
}

/**
 * Walks a polyline (array of [lng, lat] vertices) and returns points
 * spaced `spacingMeters` apart along its length — used to scatter
 * individual tree billboards along a `tree_row` LineString.
 *
 * Always includes the line's starting vertex. Distance is tracked
 * cumulatively across segments so spacing stays consistent even when
 * a line has many short vertices (e.g. a curved tree row).
 */
function sampleLineAtSpacing(
  coords: Array<[number, number]>,
  spacingMeters: number
): SampledPoint[] {
  const result: SampledPoint[] = [];
  if (coords.length < 2 || spacingMeters <= 0) return result;

  const first = coords[0];
  const second = coords[1];
  result.push({
    lng: first[0],
    lat: first[1],
    dirLng: second[0] - first[0],
    dirLat: second[1] - first[1],
  });

  let distanceSinceLast = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    let [curLng, curLat] = coords[i];
    const [endLng, endLat] = coords[i + 1];
    let segRemaining = haversineMeters(curLng, curLat, endLng, endLat);
    if (segRemaining === 0) continue;

    const dirLng = endLng - curLng;
    const dirLat = endLat - curLat;

    while (segRemaining > 0) {
      const distanceToNext = spacingMeters - distanceSinceLast;

      if (distanceToNext <= segRemaining) {
        const t = distanceToNext / segRemaining;
        const lng = curLng + (endLng - curLng) * t;
        const lat = curLat + (endLat - curLat) * t;
        result.push({ lng, lat, dirLng, dirLat });

        segRemaining -= distanceToNext;
        curLng = lng;
        curLat = lat;
        distanceSinceLast = 0;
      } else {
        distanceSinceLast += segRemaining;
        segRemaining = 0;
      }
    }
  }

  return result;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface TreeInstance {
  lng: number;
  lat: number;
  heightMeters: number;
  widthMeters: number;
  seed: number;
}

// ─── Layer ──────────────────────────────────────────────────────────────────

export class TreeLayer implements CustomLayerInterface {
  id = "tree-layer";
  type = "custom" as const;
  renderingMode = "3d" as const;

  // ── Public, mutable config (mirrors the pattern used elsewhere: assign
  //    properties directly, then call map.triggerRepaint() / layer.refresh()) ──
  source = "openmaptiles";

  /**
   * Vector tile source-layers to pull tree data from. Queried independently
   * (querySourceFeatures only accepts one source-layer at a time), then
   * merged. Safe to list source-layers that don't exist in the current
   * tileset — they simply contribute zero features.
   *
   *  - "tree"     → individual Point features, one tree each.
   *  - "tree_row" → LineString/MultiLineString features, scattered into
   *                 individual tree billboards spaced `treeRowSpacing`
   *                 meters apart along the line.
   */
  sourceLayers: string[] = ["tree", "tree_row"];

  /** MapLibre filter expression, applied server-side by querySourceFeatures.
   *  Applied identically to every entry in `sourceLayers`. */
  layerFilter: FilterSpecification | undefined = undefined;

  minZoom = 14;
  maxZoom = 16;

  /**
   * Raster (or vector) image URL for the tree billboard. Takes priority
   * over everything below if set.
   */
  spriteUrl: string | undefined = undefined;

  /**
   * Custom raw SVG markup to use instead of the built-in default (a
   * low-poly abstract sycamore). Ignored if `spriteUrl` is set. Must be
   * a self-contained <svg> string (no external references — it's
   * rasterized via a `data:` URI, which cannot resolve external
   * resources).
   */
  svgMarkup: string | undefined = undefined;

  baseHeightMeters = 6;
  heightProperty: string | undefined = undefined; // e.g. "height" on the feature
  heightJitter = 0.35; // 0..1 fraction of random variance

  /** Sycamores have broad, wide-spreading crowns — canopy width is often
   *  comparable to (or greater than) tree height. Tune down for a
   *  narrower species, up for an even broader one. */
  widthToHeightRatio = 0.85;

  /** Spacing, in meters, between individual trees scattered along a
   *  tree_row LineString. */
  treeRowSpacing = 4;

  /** Small random perpendicular offset (meters) applied to row-sampled
   *  trees so a row doesn't look like a perfectly straight, robotic
   *  line of identical billboards. Set to 0 to disable. */
  treeRowJitterMeters = 0.3;

  windStrength = 0.15; // meters of sway at the top of the tree
  windSpeed = 1.2;

  tint: [number, number, number] = [0.85, 0.85, 0.85];
  opacity = 1;
  debug = false;

  /** Safety cap so a huge dataset can't tank the frame rate. */
  maxTrees = 20000;

  /** Debounce (ms) between source-data/move events and rebuilding the buffer. */
  refreshDebounceMs = 250;

  private map!: MapLibreMap;
  private gl!: GL;
  private instancing!: Instancing;
  private program!: WebGLProgram;

  private quadBuffer!: WebGLBuffer;
  private instanceBuffer!: WebGLBuffer;
  private instanceCount = 0;

  private texture!: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private attribs: Record<string, number> = {};

  private startTime = performance.now();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private onSourceData = (e: MapSourceDataEvent): void => {
    if (e.sourceId === this.source && e.isSourceLoaded) this.scheduleRefresh();
  };
  private onMoveEnd = (): void => this.scheduleRefresh();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  onAdd(map: MapLibreMap, gl: GL): void {
    this.map = map;
    this.gl = gl;
    this.instancing = getInstancing(gl);
    this.program = linkProgram(gl, VERTEX_SRC, FRAGMENT_SRC);

    this.attribs.a_corner = gl.getAttribLocation(this.program, "a_corner");
    this.attribs.a_instancePos = gl.getAttribLocation(this.program, "a_instancePos");
    this.attribs.a_instanceSize = gl.getAttribLocation(this.program, "a_instanceSize");
    this.attribs.a_instanceSeed = gl.getAttribLocation(this.program, "a_instanceSeed");

    const uniformNames: string[] = [
      "u_matrix", "u_cameraPos", "u_time",
      "u_windStrength", "u_windSpeed",
      "u_sprite", "u_opacity", "u_tint", "u_debug",
    ];
    for (const name of uniformNames) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    // Shared quad geometry: base at y=0, top at y=1, x in [-0.5, 0.5].
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]),
      gl.STATIC_DRAW
    );

    this.instanceBuffer = gl.createBuffer()!;

    this.texture = gl.createTexture()!;
    this.loadTexture();

    map.on("sourcedata", this.onSourceData);
    map.on("moveend", this.onMoveEnd);
    map.on("zoomend", this.onMoveEnd);

    this.scheduleRefresh();
  }

  onRemove(map: MapLibreMap, gl: GL): void {
    map.off("sourcedata", this.onSourceData);
    map.off("moveend", this.onMoveEnd);
    map.off("zoomend", this.onMoveEnd);
    clearTimeout(this.refreshTimer);

    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteTexture(this.texture);
  }

  /** Force a re-query of source features + buffer rebuild right now. */
  refresh(): void {
    this.buildInstances();
  }

  /** Force the sprite texture to be regenerated/reloaded — call this if
   *  you change `spriteUrl` or `svgMarkup` after the layer was added. */
  reloadSprite(): void {
    this.loadTexture();
  }

  // ── Texture setup ───────────────────────────────────────────────────────

  private uploadTexture(src: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.map.triggerRepaint();
  }

  private loadTexture(): void {
    if (this.spriteUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = (): void => this.uploadTexture(img);
      img.onerror = (): void => {
        console.warn(
          `[TreeLayer] Failed to load spriteUrl "${this.spriteUrl}" — ` +
          `falling back to the built-in abstract sycamore.`
        );
        this.loadVectorSprite();
      };
      img.src = this.spriteUrl;
      return;
    }

    this.loadVectorSprite();
  }

  /** Rasterizes `svgMarkup` (or the built-in default abstract sycamore)
   *  into the GPU texture. SVG is loaded via a `data:` URI, which the
   *  browser can decode into an <img> without any network request — no
   *  CORS concerns, no external asset needed. */
  private loadVectorSprite(): void {
    const svg = this.svgMarkup ?? buildDefaultAbstractTreeSvg();
    const img = new Image();
    img.onload = (): void => this.uploadTexture(img);
    img.onerror = (): void => {
      console.error(
        "[TreeLayer] Failed to rasterize tree SVG — using a plain fallback shape. " +
        "Check that `svgMarkup` (if set) is valid, self-contained SVG."
      );
      this.uploadTexture(createFallbackCanvas());
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  // ── Data: query vector tile source, build instance buffer ──────────────

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.buildInstances(), this.refreshDebounceMs);
  }

  /** Reads `heightProperty` off a feature's properties (falling back to
   *  `baseHeightMeters`), then applies random jitter. Shared by both
   *  Point (tree) and Line (tree_row) handling so a row's individual
   *  trees still vary in height like a real, less-uniform planting. */
  private resolveHeightMeters(properties: MapGeoJSONFeature["properties"]): number {
    const jitter = 1 + (Math.random() * 2 - 1) * this.heightJitter;
    const rawHeight: unknown = this.heightProperty ? properties?.[this.heightProperty] : undefined;
    const propHeight = typeof rawHeight === "number" ? rawHeight : Number(rawHeight);
    const heightMeters = Number.isFinite(propHeight) ? propHeight : this.baseHeightMeters;
    return heightMeters * jitter;
  }

  /** Best-effort de-dupe key for a feature within one source-layer, so
   *  the same feature straddling two adjacent tiles isn't counted twice.
   *  Falls back to a coarse geometry fingerprint when no feature id is
   *  present (common for line data depending on tileset generation). */
  private featureKey(sourceLayer: string, f: MapGeoJSONFeature): string {
    if (f.id !== undefined) return `${sourceLayer}:${String(f.id)}`;
    const coords = (f.geometry as { coordinates?: unknown }).coordinates;
    return `${sourceLayer}:${JSON.stringify(coords).slice(0, 80)}`;
  }

  private buildInstances(): void {
    if (!this.map.getSource(this.source)) return;

    const seen = new Set<string>();
    const trees: TreeInstance[] = [];
    let totalFeatureCount = 0;

    outer: for (const sourceLayer of this.sourceLayers) {
      let features: MapGeoJSONFeature[];
      try {
        features = this.map.querySourceFeatures(this.source, {
          sourceLayer,
          filter: this.layerFilter,
        });
      } catch {
        continue; // tiles for this source-layer not loaded yet
      }

      totalFeatureCount += features.length;

      for (const f of features) {
        const key = this.featureKey(sourceLayer, f);
        if (seen.has(key)) continue;
        seen.add(key);

        const geomType = f.geometry?.type;

        if (geomType === "Point") {
          const [lng, lat] = f.geometry.coordinates as [number, number];
          const heightMeters = this.resolveHeightMeters(f.properties);
          trees.push({
            lng,
            lat,
            heightMeters,
            widthMeters: heightMeters * this.widthToHeightRatio,
            seed: Math.random(),
          });
        } else if (geomType === "MultiPoint") {
          const coordsList = f.geometry.coordinates as Array<[number, number]>;
          for (const [lng, lat] of coordsList) {
            const heightMeters = this.resolveHeightMeters(f.properties);
            trees.push({
              lng,
              lat,
              heightMeters,
              widthMeters: heightMeters * this.widthToHeightRatio,
              seed: Math.random(),
            });
            if (trees.length >= this.maxTrees) break outer;
          }
        } else if (geomType === "LineString") {
          this.scatterAlongLine(f.geometry.coordinates as Array<[number, number]>, f.properties, trees);
        } else if (geomType === "MultiLineString") {
          for (const line of f.geometry.coordinates as Array<Array<[number, number]>>) {
            this.scatterAlongLine(line, f.properties, trees);
            if (trees.length >= this.maxTrees) break outer;
          }
        } else {
          continue; // Polygon / unsupported geometry — silently ignored
        }

        if (trees.length >= this.maxTrees) break outer;
      }
    }

    this.uploadInstances(trees);

    if (this.debug) {
      console.log(
        `[TreeLayer] ${trees.length} trees built from ${totalFeatureCount} features ` +
        `across source-layers: ${this.sourceLayers.join(", ")}`
      );
    }

    this.map.triggerRepaint();
  }

  /** Samples a LineString (a tree_row) into individual tree instances,
   *  pushing directly into `out`. Applies a small perpendicular jitter
   *  per tree so rows don't look perfectly mechanical. */
  private scatterAlongLine(
    coords: Array<[number, number]>,
    properties: MapGeoJSONFeature["properties"],
    out: TreeInstance[]
  ): void {
    const samples = sampleLineAtSpacing(coords, this.treeRowSpacing);

    for (const s of samples) {
      let { lng, lat } = s;

      if (this.treeRowJitterMeters > 0) {
        const dirLen = Math.hypot(s.dirLng, s.dirLat);
        if (dirLen > 1e-12) {
          // Perpendicular unit vector in raw lng/lat space, then scaled
          // to an actual meter offset (accounting for lng compressing
          // at higher latitudes).
          const perpLng = -s.dirLat / dirLen;
          const perpLat = s.dirLng / dirLen;
          const offsetMeters = (Math.random() * 2 - 1) * this.treeRowJitterMeters;
          lng += metersToDegreesLng(perpLng * offsetMeters, lat);
          lat += metersToDegreesLat(perpLat * offsetMeters);
        }
      }

      const heightMeters = this.resolveHeightMeters(properties);
      out.push({
        lng,
        lat,
        heightMeters,
        widthMeters: heightMeters * this.widthToHeightRatio,
        seed: Math.random(),
      });

      if (out.length >= this.maxTrees) return;
    }
  }

  private uploadInstances(trees: TreeInstance[]): void {
    const gl = this.gl;
    const FLOATS_PER_INSTANCE = 6; // pos.x, pos.y, pos.z, size.x, size.y, seed
    const data = new Float32Array(trees.length * FLOATS_PER_INSTANCE);

    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const lngLat: LngLatLike = [t.lng, t.lat];

      let groundMeters = 0;
      if (typeof this.map.queryTerrainElevation === "function") {
        groundMeters = this.map.queryTerrainElevation(lngLat) ?? 0;
      }

      const base = MercatorCoordinate.fromLngLat(lngLat, groundMeters);
      const metersToMercator = base.meterInMercatorCoordinateUnits();

      const o = i * FLOATS_PER_INSTANCE;
      data[o + 0] = base.x;
      data[o + 1] = base.y;
      data[o + 2] = base.z;
      data[o + 3] = t.widthMeters * metersToMercator;
      data[o + 4] = t.heightMeters * metersToMercator;
      data[o + 5] = t.seed;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.instanceCount = trees.length;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(gl: GL, options: CustomRenderMethodInput): void {
    const zoom = this.map.getZoom();
    if (this.opacity <= 0 || this.instanceCount === 0) return;
    if (zoom < this.minZoom || zoom > this.maxZoom) return;

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);

    // Camera position in Mercator space, for horizontal billboarding.
    let camX = 0, camY = 0, camZ = 0;
    if (typeof this.map.getFreeCameraOptions === "function") {
      const cam = this.map.getFreeCameraOptions().position;
      if (cam) { camX = cam.x; camY = cam.y; camZ = cam.z; }
    }

    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, options.modelViewProjectionMatrix);
    gl.uniform3f(this.uniforms.u_cameraPos, camX, camY, camZ);
    gl.uniform1f(this.uniforms.u_time, (performance.now() - this.startTime) / 1000);
    gl.uniform1f(this.uniforms.u_windStrength, this.windStrength * 1e-5);
    gl.uniform1f(this.uniforms.u_windSpeed, this.windSpeed);
    gl.uniform1f(this.uniforms.u_opacity, this.opacity);
    gl.uniform3f(this.uniforms.u_tint, ...this.tint);
    gl.uniform1i(this.uniforms.u_debug, this.debug ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.u_sprite, 0);

    // Per-vertex quad attribute (divisor 0 = same for every instance).
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.attribs.a_corner);
    gl.vertexAttribPointer(this.attribs.a_corner, 2, gl.FLOAT, false, 0, 0);
    this.instancing.vertexAttribDivisor(this.attribs.a_corner, 0);

    // Per-instance attributes.
    const stride = 6 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

    gl.enableVertexAttribArray(this.attribs.a_instancePos);
    gl.vertexAttribPointer(this.attribs.a_instancePos, 3, gl.FLOAT, false, stride, 0);
    this.instancing.vertexAttribDivisor(this.attribs.a_instancePos, 1);

    gl.enableVertexAttribArray(this.attribs.a_instanceSize);
    gl.vertexAttribPointer(this.attribs.a_instanceSize, 2, gl.FLOAT, false, stride, 3 * 4);
    this.instancing.vertexAttribDivisor(this.attribs.a_instanceSize, 1);

    gl.enableVertexAttribArray(this.attribs.a_instanceSeed);
    gl.vertexAttribPointer(this.attribs.a_instanceSeed, 1, gl.FLOAT, false, stride, 5 * 4);
    this.instancing.vertexAttribDivisor(this.attribs.a_instanceSeed, 1);

    this.instancing.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);

    // Reset divisors so we don't break other custom layers sharing this GL context.
    this.instancing.vertexAttribDivisor(this.attribs.a_instancePos, 0);
    this.instancing.vertexAttribDivisor(this.attribs.a_instanceSize, 0);
    this.instancing.vertexAttribDivisor(this.attribs.a_instanceSeed, 0);
  }
}
