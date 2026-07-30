// assets/ts/layers/tree-layer.ts

import * as THREE from "three";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapSourceDataEvent,
  FilterSpecification
} from "maplibre-gl";
import { MercatorCoordinate } from "maplibre-gl";

// ─── Geo helpers ────────────────────────────────────────────────────────────

const EARTH_RADIUS_METERS = 6371000;
const METERS_PER_DEGREE_LAT = 111320;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMeters(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersToDegreesLat(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT;
}

function metersToDegreesLng(meters: number, atLat: number): number {
  return meters / (METERS_PER_DEGREE_LAT * Math.cos(toRad(atLat)));
}

interface SampledPoint {
  lng: number;
  lat: number;
}

function sampleLineAtSpacing(coords: Array<[number, number]>, spacingMeters: number): SampledPoint[] {
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

function calculateDistanceMercatorToMeters(from: MercatorCoordinate, to: MercatorCoordinate): { dEastMeter: number; dNorthMeter: number } {
  const mercatorPerMeter = from.meterInMercatorCoordinateUnits();
  const dEast = to.x - from.x;
  const dEastMeter = dEast / mercatorPerMeter;
  const dNorth = from.y - to.y;
  const dNorthMeter = dNorth / mercatorPerMeter;
  return { dEastMeter, dNorthMeter };
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface TreeRecord {
  lng: number;
  lat: number;
  heightMeters: number;
}

interface DefaultProjectionData {
  mainMatrix: ArrayLike<number>;
}

type RenderInputWithProjection = CustomRenderMethodInput & {
  defaultProjectionData?: DefaultProjectionData;
};

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
  heightScale = 1;
  debug = false;

  /** Multiplier applied to resolved terrain elevation. */
  terrainExaggeration = 1;

  maxTrees = 20000;
  refreshDebounceMs = 250;

  ensureSourceStaysLoaded = true;
  cacheHardLimitMultiplier = 4;

  private static readonly KEEP_ALIVE_LAYER_ID_PREFIX = "__tree_layer_keepalive__";

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
  private originMercator: MercatorCoordinate | undefined;

  private readonly originMatrix = new THREE.Matrix4();

  private readonly dummy = new THREE.Object3D();
  private readonly scratchMapMatrix = new THREE.Matrix4();

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private elevationCache = new Map<string, number>();

  private treeCache = new Map<string, TreeRecord>();

  private firstTreeLocal: { east: number; up: number; north: number } | undefined;
  private diagnosticLogged = false;

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

  // ── Lifecycle ────────────────────────────────────────────────────────────

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    const canvas = map.getCanvas();
    this.renderer.setSize(canvas.width, canvas.height, false);

    this.camera = new THREE.Camera();

    this.scene = new THREE.Scene();
    this.scene.rotateX(Math.PI / 2);
    this.scene.scale.multiply(new THREE.Vector3(1, 1, -1));

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(50, 70, -30).normalize();
    this.scene.add(ambient, directional);

    this.trunkGeometry = new THREE.CylinderGeometry(0.7, 1, 1, this.radialSegments);
    this.trunkGeometry.translate(0, 0.5, 0);

    this.canopyGeometry = new THREE.SphereGeometry(1, this.radialSegments, Math.max(4, Math.round(this.radialSegments / 2)));

    this.trunkMaterial = new THREE.MeshLambertMaterial({
      color: this.trunkColor,
      transparent: true,
      opacity: this.opacity
    });
    this.canopyMaterial = new THREE.MeshLambertMaterial({
      color: this.canopyColor,
      transparent: true,
      opacity: this.opacity
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
    this.originMercator = MercatorCoordinate.fromLngLat([this.originLng, this.originLat], 0);

    const scale = this.originMercator.meterInMercatorCoordinateUnits();
    this.originMatrix
      .makeTranslation(this.originMercator.x, this.originMercator.y, this.originMercator.z)
      .scale(new THREE.Vector3(scale, -scale, scale));

    if (this.debug) {
      console.log("[TreeLayer] onAdd complete. origin:", {
        originLng: this.originLng,
        originLat: this.originLat,
        originMercator: {
          x: this.originMercator.x,
          y: this.originMercator.y,
          z: this.originMercator.z
        },
        scale
      });
    }

    this.addKeepAliveLayers(map);

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

    this.removeKeepAliveLayers(map);

    this.trunkGeometry?.dispose();
    this.canopyGeometry?.dispose();
    this.trunkMaterial?.dispose();
    this.canopyMaterial?.dispose();

    this.map = undefined;
  }

  // ── Keep-alive layers (fix, part 1) ─────────────────────────────────────

  private addKeepAliveLayers(map: MapLibreMap): void {
    if (!this.ensureSourceStaysLoaded) return;

    for (const sourceLayer of this.sourceLayers) {
      const layerId = `${TreeLayer.KEEP_ALIVE_LAYER_ID_PREFIX}${sourceLayer}`;
      if (map.getLayer(layerId)) continue;

      try {
        map.addLayer({
          id: layerId,
          type: "circle",
          source: this.source,
          "source-layer": sourceLayer,
          minzoom: 0,
          maxzoom: 24,
          paint: {
            "circle-radius": 0,
            "circle-opacity": 0
          }
        });
      } catch (err) {
        if (this.debug) {
          console.warn(`[TreeLayer] could not add keep-alive layer for "${sourceLayer}":`, err);
        }
      }
    }
  }

  private removeKeepAliveLayers(map: MapLibreMap): void {
    for (const sourceLayer of this.sourceLayers) {
      const layerId = `${TreeLayer.KEEP_ALIVE_LAYER_ID_PREFIX}${sourceLayer}`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
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
    this.rebuild();
  }

  setOpacity(v: number): void {
    this.opacity = v;
    if (this.trunkMaterial) this.trunkMaterial.opacity = v;
    if (this.canopyMaterial) this.canopyMaterial.opacity = v;
    this.map?.triggerRepaint();
  }

  setHeightScale(v: number): void {
    this.heightScale = v;
    this.scheduleRefresh();
  }

  // ── Data + geometry ──────────────────────────────────────────────────────

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.rebuild(), this.refreshDebounceMs);
  }

  private resolveHeightMeters(properties: MapGeoJSONFeature["properties"]): number {
    const jitter = 1 + (Math.random() * 2 - 1) * this.heightJitter;
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

  private elevationKey(lng: number, lat: number): string {
    return `${lng.toFixed(5)},${lat.toFixed(5)}`;
  }

  private resolveGroundMeters(lng: number, lat: number): number {
    const key = this.elevationKey(lng, lat);
    const queried = this.map!.queryTerrainElevation([lng, lat]);

    if (queried !== null && Number.isFinite(queried)) {
      this.elevationCache.set(key, queried);
      return queried;
    }

    return this.elevationCache.get(key) ?? 0;
  }

  private approxDistanceSq(t: TreeRecord, centerLng: number, centerLat: number): number {
    const dLat = t.lat - centerLat;
    const dLng = (t.lng - centerLng) * Math.cos(toRad(centerLat));
    return dLat * dLat + dLng * dLng;
  }

  /**
   * Evicts the farthest-from-current-view entries once the persistent
   * cache grows past maxTrees * cacheHardLimitMultiplier. Keeps memory
   * bounded during long pan sessions across large areas.
   */
  private pruneCacheIfNeeded(): void {
    const hardLimit = this.maxTrees * this.cacheHardLimitMultiplier;
    if (this.treeCache.size <= hardLimit || !this.map) return;

    const center = this.map.getCenter();
    const entries = Array.from(this.treeCache.entries());
    entries.sort((a, b) => this.approxDistanceSq(a[1], center.lng, center.lat) - this.approxDistanceSq(b[1], center.lng, center.lat));

    this.treeCache.clear();
    for (let i = 0; i < hardLimit; i++) {
      this.treeCache.set(entries[i][0], entries[i][1]);
    }
  }

  private addRowTrees(
    baseKey: string,
    coords: Array<[number, number]>,
    properties: MapGeoJSONFeature["properties"],
    budget: number
  ): number {
    const samples = sampleLineAtSpacing(coords, this.treeRowSpacing);
    let added = 0;

    for (let i = 0; i < samples.length; i++) {
      if (added >= budget) break;

      const key = `${baseKey}:${i}`;
      if (this.treeCache.has(key)) continue;

      let { lng, lat } = samples[i];
      if (this.treeRowJitterMeters > 0) {
        const offsetMeters = (Math.random() * 2 - 1) * this.treeRowJitterMeters;
        lng += metersToDegreesLng(offsetMeters, lat);
        lat += metersToDegreesLat(offsetMeters);
      }

      this.treeCache.set(key, { lng, lat, heightMeters: this.resolveHeightMeters(properties) });
      added++;
    }

    return added;
  }

  /**
   * Queries currently-loaded tiles and merges any NEWLY-seen features
   * into the persistent treeCache (fix, part 2). Never removes existing
   * cache entries here — only pruneCacheIfNeeded() does that, based on
   * distance. A per-call budget bounds worst-case cost of a single
   * rebuild; the cache can still grow further across subsequent calls as
   * the user pans/zooms into new tiles.
   */
  private collectAndCacheTrees(): Record<string, Record<string, number>> {
    const debugCounts: Record<string, Record<string, number>> = {};
    if (!this.map) return debugCounts;

    let addedThisCall = 0;
    const perCallBudget = this.maxTrees;

    for (const sourceLayer of this.sourceLayers) {
      let features: MapGeoJSONFeature[];
      try {
        features = this.map.querySourceFeatures(this.source, {
          sourceLayer,
          filter: this.layerFilter
        });
      } catch {
        continue;
      }

      if (this.debug) debugCounts[sourceLayer] = {};

      for (const f of features) {
        if (addedThisCall >= perCallBudget) break;

        const key = this.featureKey(sourceLayer, f);
        const geomType = f.geometry?.type ?? "unknown";
        if (this.debug) {
          const layerCounts = debugCounts[sourceLayer];
          layerCounts[geomType] = (layerCounts[geomType] ?? 0) + 1;
        }

        if (geomType === "Point") {
          if (this.treeCache.has(key)) continue;
          const [lng, lat] = f.geometry.coordinates as [number, number];
          this.treeCache.set(key, { lng, lat, heightMeters: this.resolveHeightMeters(f.properties) });
          addedThisCall++;
        } else if (geomType === "MultiPoint") {
          const coordsArr = f.geometry.coordinates as Array<[number, number]>;
          for (let i = 0; i < coordsArr.length; i++) {
            if (addedThisCall >= perCallBudget) break;
            const subKey = `${key}:${i}`;
            if (this.treeCache.has(subKey)) continue;
            const [lng, lat] = coordsArr[i];
            this.treeCache.set(subKey, { lng, lat, heightMeters: this.resolveHeightMeters(f.properties) });
            addedThisCall++;
          }
        } else if (geomType === "LineString") {
          addedThisCall += this.addRowTrees(
            key,
            f.geometry.coordinates as Array<[number, number]>,
            f.properties,
            perCallBudget - addedThisCall
          );
        } else if (geomType === "MultiLineString") {
          const lines = f.geometry.coordinates as Array<Array<[number, number]>>;
          for (let li = 0; li < lines.length; li++) {
            if (addedThisCall >= perCallBudget) break;
            addedThisCall += this.addRowTrees(`${key}:${li}`, lines[li], f.properties, perCallBudget - addedThisCall);
          }
        }
      }
    }

    return debugCounts;
  }

  /**
   * Rebuilds both InstancedMesh buffers from the persistent treeCache
   * (not directly from querySourceFeatures — see collectAndCacheTrees).
   * If the cache holds more than maxTrees entries, only the nearest
   * maxTrees to the current view are actually instanced this frame.
   */
  private rebuild(): void {
    if (!this.map || !this.map.getSource(this.source) || !this.trunkMesh || !this.canopyMesh) return;

    const debugCounts = this.collectAndCacheTrees();
    this.pruneCacheIfNeeded();

    const center = this.map.getCenter();
    let trees = Array.from(this.treeCache.values());
    if (trees.length > this.maxTrees) {
      trees.sort((a, b) => this.approxDistanceSq(a, center.lng, center.lat) - this.approxDistanceSq(b, center.lng, center.lat));
      trees = trees.slice(0, this.maxTrees);
    }

    let index = 0;
    for (const tree of trees) {
      const rawGround = this.resolveGroundMeters(tree.lng, tree.lat);
      const groundMeters = rawGround * this.terrainExaggeration;

      const treeMercator = MercatorCoordinate.fromLngLat([tree.lng, tree.lat], 0);
      const { dEastMeter, dNorthMeter } = calculateDistanceMercatorToMeters(this.originMercator!, treeMercator);

      const east = dEastMeter;
      const north = dNorthMeter;
      const up = groundMeters;

      if (index === 0) {
        this.firstTreeLocal = { east, up, north };
        if (this.debug) {
          console.log("[TreeLayer] first tree ground calc:", {
            lng: tree.lng,
            lat: tree.lat,
            rawGround,
            terrainExaggeration: this.terrainExaggeration,
            groundMeters,
            local: { east, up, north }
          });
        }
      }

      const heightMeters = tree.heightMeters * this.heightScale;

      const trunkHeight = heightMeters * this.trunkHeightRatio;
      const trunkRadius = heightMeters * this.trunkRadiusRatio;
      const trunkTop = up + trunkHeight;

      this.dummy.position.set(east, up, north);
      this.dummy.scale.set(trunkRadius, trunkHeight, trunkRadius);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.trunkMesh.setMatrixAt(index, this.dummy.matrix);

      const canopyRadius = heightMeters * this.canopyRadiusRatio;
      const canopyRadiusY = canopyRadius * this.canopyVerticalSquash;
      const canopyCenterY = trunkTop - canopyRadiusY * 0.2;

      this.dummy.position.set(east, canopyCenterY, north);
      this.dummy.scale.set(canopyRadius, canopyRadiusY, canopyRadius);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.canopyMesh.setMatrixAt(index, this.dummy.matrix);

      index++;
    }

    this.trunkMesh.count = index;
    this.canopyMesh.count = index;
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.canopyMesh.instanceMatrix.needsUpdate = true;

    if (this.debug) {
      console.log(
        `[TreeLayer] rebuilt ${index}/${this.treeCache.size} cached tree instances ` +
          `(elevation cache size: ${this.elevationCache.size}) — raw counts:`,
        debugCounts
      );
    }

    this.map.triggerRepaint();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.map || !this.renderer || !this.scene || !this.camera) return;
    if (this.opacity <= 0) return;
    if (this.map.getZoom() < this.minzoom) return;
    if (!this.trunkMesh || this.trunkMesh.count === 0) return;

    const opts = options as RenderInputWithProjection;
    const mainMatrixArray =
      opts.defaultProjectionData?.mainMatrix ??
      (options as unknown as { modelViewProjectionMatrix?: ArrayLike<number> }).modelViewProjectionMatrix;

    if (!mainMatrixArray) {
      if (this.debug) console.warn("[TreeLayer] no usable projection matrix found on render options");
      return;
    }

    this.scratchMapMatrix.fromArray(mainMatrixArray);
    this.camera.projectionMatrix.multiplyMatrices(this.scratchMapMatrix, this.originMatrix);

    if (this.debug && !this.diagnosticLogged && this.firstTreeLocal) {
      this.diagnosticLogged = true;
      const p = this.firstTreeLocal;
      const clip = new THREE.Vector4(p.east, p.up, p.north, 1).applyMatrix4(this.camera.projectionMatrix);
      const ndc = { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
      console.log("[TreeLayer] projection self-check:", {
        local: p,
        clip: { x: clip.x, y: clip.y, z: clip.z, w: clip.w },
        ndc,
        onScreen: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && clip.w > 0
      });
    }

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }
}
