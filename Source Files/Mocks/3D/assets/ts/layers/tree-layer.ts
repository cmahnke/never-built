// assets/ts/layers/tree-layer.ts
//
// (all prior header comments unchanged — omitted here for brevity)
//
// ⚠️ FIX APPLIED: removed `camera.projectionMatrixInverse = ...invert()` —
// `Matrix4.invert()` is the CURRENT Three.js API name; versions before
// r123 (~2021) called this method `.getInverse()` instead. If installed
// Three.js predates that, this line threw a TypeError every frame inside
// render(), which could plausibly result in "layer draws nothing" rather
// than an obvious crash, depending on how MapLibre's render loop handles
// a custom layer's render() throwing. This property was also never
// actually required for basic MeshLambertMaterial rendering (only used
// by advanced techniques like log-depth buffers) — removed rather than
// version-guarded, since it wasn't doing anything useful here anyway.
//
// Also added: defensive console logging/try-catch around WebGLRenderer
// construction and the render() draw call, since several earlier rounds
// of blind guessing in this project's history wasted time — this time,
// if trees are still invisible, we get concrete evidence instead.

import * as THREE from "three";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapSourceDataEvent,
  FilterSpecification,
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";

// ─── Deterministic PRNG (stable jitter across rebuilds) ────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Geo helpers ────────────────────────────────────────────────────────────

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_DEGREE_LAT = 111320;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function metersPerDegreeLng(atLat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos(toRad(atLat));
}

function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersToDegreesLat(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT;
}

function metersToDegreesLng(meters: number, atLat: number): number {
  return meters / metersPerDegreeLng(atLat);
}

interface SampledPoint {
  lng: number;
  lat: number;
}

function sampleLineAtSpacing(
  coords: Array<[number, number]>,
  spacingMeters: number
): SampledPoint[] {
  const result: SampledPoint[] = [];
  if (coords.length < 2 || spacingMeters <= 0) return result;

  result.push({ lng: coords[0][0], lat: coords[0][1] });

  let distanceSinceLast = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    let [curLng, curLat] = coords[i];
    const [endLng, endLat] = coords[i + 1];
    let segRemaining = haversineMeters(curLng, curLat, endLng, endLat);
    if (segRemaining === 0) continue;

    while (segRemaining > 0) {
      const distanceToNext = spacingMeters - distanceSinceLast;

      if (distanceToNext <= segRemaining) {
        const t = distanceToNext / segRemaining;
        const lng = curLng + (endLng - curLng) * t;
        const lat = curLat + (endLat - curLat) * t;
        result.push({ lng, lat });

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

interface TreeRecord {
  lng: number;
  lat: number;
  heightMeters: number;
}

// ─── Layer ──────────────────────────────────────────────────────────────────

export class TreeLayer implements CustomLayerInterface {
  id = "tree";
  type = "custom" as const;
  renderingMode = "3d" as const;

  source = "openmaptiles";
  sourceLayers: string[] = ["tree", "tree_row"];
  layerFilter: FilterSpecification | undefined = undefined;

  minzoom = 13;

  baseHeightMeters = 6;
  heightProperty: string | undefined = undefined;
  heightJitter = 0.35;

  trunkRadiusRatio = 0.035;
  trunkHeightRatio = 0.45;
  canopyRadiusRatio = 0.42;
  canopyVerticalSquash = 0.75;
  radialSegments = 8;

  treeRowSpacing = 4;
  treeRowJitterMeters = 0.3;

  trunkColor = "#6b5335";
  canopyColor = "#6e7f52";

  opacity = 1;
  debug = false;

  maxTrees = 20000;
  refreshDebounceMs = 250;

  private static readonly GROUND_CLEARANCE_METERS = 0.1;
  private static readonly MAX_ELEVATION_RETRIES = 3;

  private trees = new Map<string, TreeRecord>();

  private map: MapLibreMap | undefined;
  private renderer: THREE.WebGLRenderer | undefined;
  private scene: THREE.Scene | undefined;
  private camera: THREE.Camera | undefined;

  private trunkGeometry: THREE.CylinderGeometry | undefined;
  private canopyGeometry: THREE.SphereGeometry | undefined;
  private trunkMaterial: THREE.MeshLambertMaterial | undefined;
  private canopyMaterial: THREE.MeshLambertMaterial | undefined;
  private trunkMesh: THREE.InstancedMesh | undefined;
  private canopyMesh: THREE.InstancedMesh | undefined;

  private originLng = 0;
  private originLat = 0;
  private originMatrix: THREE.Matrix4 | undefined;

  private readonly dummy = new THREE.Object3D();

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingElevationRetry = false;
  private elevationRetryCount = 0;

  /** Debug-only: logs the first render() call's early-return path (or
   *  lack thereof), so we can see EXACTLY why nothing draws, instead of
   *  guessing. Fires once per addTo(), not every frame. */
  private renderDiagnosticLogged = false;

  private onSourceData = (e: MapSourceDataEvent): void => {
    if (e.sourceId === this.source && e.isSourceLoaded) this.scheduleRefresh();
  };
  private onMoveEnd = (): void => this.scheduleRefresh();
  private onResize = (): void => {
    if (this.renderer && this.map) {
      const canvas = this.map.getCanvas();
      this.renderer.setSize(canvas.width, canvas.height, false);
    }
  };

  // ── Lifecycle (CustomLayerInterface) ────────────────────────────────────

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderDiagnosticLogged = false;

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      this.renderer.autoClear = false;
      const canvas = map.getCanvas();
      this.renderer.setSize(canvas.width, canvas.height, false);
      if (this.debug) {
        console.log(
          `[TreeLayer] WebGLRenderer created OK. Three.js revision: ${THREE.REVISION}`
        );
      }
    } catch (err) {
      console.error(
        "[TreeLayer] FAILED to construct THREE.WebGLRenderer — this layer " +
        "cannot render at all. Full error:",
        err
      );
      return;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(0.75, 1.2, -0.66);
    this.scene.add(ambient, directional);

    this.trunkGeometry = new THREE.CylinderGeometry(0.7, 1, 1, this.radialSegments);
    this.trunkGeometry.translate(0, 0.5, 0);

    this.canopyGeometry = new THREE.SphereGeometry(
      1,
      this.radialSegments,
      Math.max(4, Math.round(this.radialSegments / 2))
    );

    this.trunkMaterial = new THREE.MeshLambertMaterial({
      color: this.trunkColor,
      transparent: true,
      opacity: this.opacity,
    });
    this.canopyMaterial = new THREE.MeshLambertMaterial({
      color: this.canopyColor,
      transparent: true,
      opacity: this.opacity,
    });

    this.trunkMesh = new THREE.InstancedMesh(this.trunkGeometry, this.trunkMaterial, this.maxTrees);
    this.canopyMesh = new THREE.InstancedMesh(this.canopyGeometry, this.canopyMaterial, this.maxTrees);
    this.trunkMesh.count = 0;
    this.canopyMesh.count = 0;
    this.trunkMesh.frustumCulled = false;
    this.canopyMesh.frustumCulled = false;
    this.scene.add(this.trunkMesh, this.canopyMesh);

    this.originLng = map.getCenter().lng;
    this.originLat = map.getCenter().lat;
    const originMercator = MercatorCoordinate.fromLngLat([this.originLng, this.originLat], 0);
    const scale = originMercator.meterInMercatorCoordinateUnits();

    this.originMatrix = new THREE.Matrix4();
    this.originMatrix.set(
      scale, 0,     0,     originMercator.x,
      0,     0,     scale, originMercator.y,
      0,     scale, 0,     originMercator.z,
      0,     0,     0,     1
    );

    if (this.debug) {
      console.log("[TreeLayer] origin set:", {
        originLng: this.originLng,
        originLat: this.originLat,
        originMercator: { x: originMercator.x, y: originMercator.y, z: originMercator.z },
        scale,
      });
    }

    map.on("sourcedata", this.onSourceData);
    map.on("moveend", this.onMoveEnd);
    map.on("zoomend", this.onMoveEnd);
    window.addEventListener("resize", this.onResize);

    this.scheduleRefresh();
  }

  onRemove(): void {
    if (!this.map) return;
    const map = this.map;

    map.off("sourcedata", this.onSourceData);
    map.off("moveend", this.onMoveEnd);
    map.off("zoomend", this.onMoveEnd);
    window.removeEventListener("resize", this.onResize);
    clearTimeout(this.refreshTimer);

    this.trunkGeometry?.dispose();
    this.canopyGeometry?.dispose();
    this.trunkMaterial?.dispose();
    this.canopyMaterial?.dispose();

    this.map = undefined;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  addTo(map: MapLibreMap, beforeId?: string): void {
    map.addLayer(this, beforeId);
  }

  remove(): void {
    if (!this.map) return;
    if (this.map.getLayer(this.id)) this.map.removeLayer(this.id);
  }

  refresh(): void {
    this.queryAndMergeTrees();
  }

  clear(): void {
    this.trees.clear();
    this.regenerateInstances();
  }

  setOpacity(v: number): void {
    this.opacity = v;
    if (this.trunkMaterial) this.trunkMaterial.opacity = v;
    if (this.canopyMaterial) this.canopyMaterial.opacity = v;
    this.map?.triggerRepaint();
  }

  // ── Data: query vector tile source, merge into persistent registry ─────

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.queryAndMergeTrees(), this.refreshDebounceMs);
  }

  private resolveHeightMeters(properties: MapGeoJSONFeature["properties"], rng: () => number): number {
    const jitter = 1 + (rng() * 2 - 1) * this.heightJitter;
    const rawHeight: unknown = this.heightProperty ? properties?.[this.heightProperty] : undefined;
    const propHeight = typeof rawHeight === "number" ? rawHeight : Number(rawHeight);
    const heightMeters = Number.isFinite(propHeight) ? propHeight : this.baseHeightMeters;
    return heightMeters * jitter;
  }

  private featureKey(sourceLayer: string, f: MapGeoJSONFeature): string {
    if (f.id !== undefined) return `${sourceLayer}:${String(f.id)}`;
    const coords = (f.geometry as { coordinates?: unknown }).coordinates;
    return `${sourceLayer}:${JSON.stringify(coords).slice(0, 80)}`;
  }

  private rowGridKey(lng: number, lat: number): string {
    const cellLat = metersToDegreesLat(this.treeRowSpacing);
    const cellLng = metersToDegreesLng(this.treeRowSpacing, lat);
    const gy = Math.round(lat / cellLat);
    const gx = Math.round(lng / cellLng);
    return `row:${gx}:${gy}`;
  }

  private upsertPointTree(key: string, lng: number, lat: number, properties: MapGeoJSONFeature["properties"]): void {
    if (this.trees.has(key) || this.trees.size >= this.maxTrees) return;
    const rng = mulberry32(hashStringToSeed(key));
    const heightMeters = this.resolveHeightMeters(properties, rng);
    this.trees.set(key, { lng, lat, heightMeters });
  }

  private upsertRowSamples(coords: Array<[number, number]>, properties: MapGeoJSONFeature["properties"]): void {
    const samples = sampleLineAtSpacing(coords, this.treeRowSpacing);

    for (const s of samples) {
      if (this.trees.size >= this.maxTrees) return;

      const key = this.rowGridKey(s.lng, s.lat);
      if (this.trees.has(key)) continue;

      const rng = mulberry32(hashStringToSeed(key));
      let { lng, lat } = s;
      if (this.treeRowJitterMeters > 0) {
        const offsetMeters = (rng() * 2 - 1) * this.treeRowJitterMeters;
        lng += metersToDegreesLng(offsetMeters, lat);
        lat += metersToDegreesLat(offsetMeters);
      }

      const heightMeters = this.resolveHeightMeters(properties, rng);
      this.trees.set(key, { lng, lat, heightMeters });
    }
  }

  private queryAndMergeTrees(): void {
    if (!this.map || !this.map.getSource(this.source)) {
      if (this.debug) {
        console.log(
          `[TreeLayer] queryAndMergeTrees: skipped — map ${this.map ? "exists" : "MISSING"}, ` +
          `source "${this.source}" ${this.map?.getSource(this.source) ? "exists" : "MISSING"}`
        );
      }
      return;
    }

    let currentQueryTotal = 0;
    const debugCounts: Record<string, Record<string, number>> = {};

    for (const sourceLayer of this.sourceLayers) {
      let features: MapGeoJSONFeature[];
      try {
        features = this.map.querySourceFeatures(this.source, {
          sourceLayer,
          filter: this.layerFilter,
        });
      } catch {
        continue;
      }

      currentQueryTotal += features.length;
      if (this.debug) debugCounts[sourceLayer] = {};

      for (const f of features) {
        const geomType = f.geometry?.type ?? "unknown";
        if (this.debug) {
          const layerCounts = debugCounts[sourceLayer];
          layerCounts[geomType] = (layerCounts[geomType] ?? 0) + 1;
        }

        if (geomType === "Point") {
          const [lng, lat] = f.geometry.coordinates as [number, number];
          this.upsertPointTree(this.featureKey(sourceLayer, f), lng, lat, f.properties);
        } else if (geomType === "MultiPoint") {
          const coordsList = f.geometry.coordinates as Array<[number, number]>;
          const baseKey = this.featureKey(sourceLayer, f);
          coordsList.forEach(([lng, lat]: [number, number], i: number) => {
            this.upsertPointTree(`${baseKey}:${i}`, lng, lat, f.properties);
          });
        } else if (geomType === "LineString") {
          this.upsertRowSamples(f.geometry.coordinates as Array<[number, number]>, f.properties);
        } else if (geomType === "MultiLineString") {
          for (const line of f.geometry.coordinates as Array<Array<[number, number]>>) {
            this.upsertRowSamples(line, f.properties);
          }
        }
      }
    }

    this.regenerateInstances();

    if (this.debug) {
      console.log(
        `[TreeLayer] query: ${currentQueryTotal} raw features seen this pass — breakdown:`,
        debugCounts
      );
      console.log(`[TreeLayer] persistent registry: ${this.trees.size} trees total`);
    }
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  private regenerateInstances(): void {
    if (!this.map || !this.trunkMesh || !this.canopyMesh) {
      if (this.debug) {
        console.log(
          `[TreeLayer] regenerateInstances: skipped — map=${!!this.map}, ` +
          `trunkMesh=${!!this.trunkMesh}, canopyMesh=${!!this.canopyMesh}`
        );
      }
      return;
    }

    const metersPerLng = metersPerDegreeLng(this.originLat);
    let index = 0;
    let unresolvedElevationCount = 0;

    for (const tree of this.trees.values()) {
      if (index >= this.maxTrees) break;

      const dxEast = (tree.lng - this.originLng) * metersPerLng;
      const dzSouth = (this.originLat - tree.lat) * METERS_PER_DEGREE_LAT;

      let groundMeters = 0;
      const queried = this.map.queryTerrainElevation([tree.lng, tree.lat]);
      if (queried !== null && Number.isFinite(queried)) {
        groundMeters = queried;
      } else {
        unresolvedElevationCount++;
      }
      groundMeters += TreeLayer.GROUND_CLEARANCE_METERS;

      const heightMeters = tree.heightMeters;
      const trunkHeight = heightMeters * this.trunkHeightRatio;
      const trunkRadius = heightMeters * this.trunkRadiusRatio;
      const trunkTop = groundMeters + trunkHeight;

      this.dummy.position.set(dxEast, groundMeters, dzSouth);
      this.dummy.scale.set(trunkRadius, trunkHeight, trunkRadius);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.trunkMesh.setMatrixAt(index, this.dummy.matrix);

      const canopyRadius = heightMeters * this.canopyRadiusRatio;
      const canopyRadiusY = canopyRadius * this.canopyVerticalSquash;
      const canopyCenterY = trunkTop - canopyRadiusY * 0.2;

      this.dummy.position.set(dxEast, canopyCenterY, dzSouth);
      this.dummy.scale.set(canopyRadius, canopyRadiusY, canopyRadius);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.canopyMesh.setMatrixAt(index, this.dummy.matrix);

      if (this.debug && index === 0) {
        console.log("[TreeLayer] first instance local-space transform:", {
          lng: tree.lng, lat: tree.lat,
          dxEast, dzSouth, groundMeters,
          trunkHeight, trunkRadius, canopyRadius, canopyRadiusY,
        });
      }

      index++;
    }

    this.trunkMesh.count = index;
    this.canopyMesh.count = index;
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.canopyMesh.instanceMatrix.needsUpdate = true;

    if (this.debug) {
      console.log(
        `[TreeLayer] regenerated ${index} tree instances` +
        (unresolvedElevationCount > 0 ? ` — ${unresolvedElevationCount} unresolved elevation` : "")
      );
    }

    if (unresolvedElevationCount > 0 && !this.pendingElevationRetry) {
      if (this.elevationRetryCount >= TreeLayer.MAX_ELEVATION_RETRIES) {
        if (this.debug) {
          console.warn(`[TreeLayer] giving up on elevation retry after ${TreeLayer.MAX_ELEVATION_RETRIES} attempts`);
        }
      } else {
        this.pendingElevationRetry = true;
        this.elevationRetryCount++;
        this.map.once("idle", () => {
          this.pendingElevationRetry = false;
          this.regenerateInstances();
        });
      }
    } else if (unresolvedElevationCount === 0) {
      this.elevationRetryCount = 0;
    }

    this.map.triggerRepaint();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.renderDiagnosticLogged && this.debug) {
      this.renderDiagnosticLogged = true;
      console.log("[TreeLayer] render() first call — state check:", {
        hasMap: !!this.map,
        hasRenderer: !!this.renderer,
        hasScene: !!this.scene,
        hasCamera: !!this.camera,
        hasOriginMatrix: !!this.originMatrix,
        opacity: this.opacity,
        zoom: this.map?.getZoom(),
        minzoom: this.minzoom,
        trunkMeshCount: this.trunkMesh?.count,
      });
    }

    if (!this.map || !this.renderer || !this.scene || !this.camera || !this.originMatrix) return;
    if (this.opacity <= 0) return;
    if (this.map.getZoom() < this.minzoom) return;
    if (!this.trunkMesh || this.trunkMesh.count === 0) return;

    try {
      const mapMatrix = new THREE.Matrix4().fromArray(
        Array.from(options.modelViewProjectionMatrix as unknown as ArrayLike<number>)
      );
      const combined = new THREE.Matrix4().multiplyMatrices(mapMatrix, this.originMatrix);

      this.camera.projectionMatrix = combined;

      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      this.map.triggerRepaint();
    } catch (err) {
      console.error("[TreeLayer] render() threw — nothing was drawn this frame:", err);
    }
  }
}
