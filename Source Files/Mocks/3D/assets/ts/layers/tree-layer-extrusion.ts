// assets/ts/layers/tree-layer.ts
//
// (header comments unchanged — omitted here for brevity, keep as-is)

import type { Map as MapLibreMap, MapGeoJSONFeature, MapSourceDataEvent, FilterSpecification, GeoJSONSource } from "maplibre-gl";

// ─── GeoJSON typing ─────────────────────────────────────────────────────────
//
// Uses the real `GeoJSON.Feature`/`GeoJSON.FeatureCollection` types (from
// the @types/geojson package, a transitive dependency of maplibre-gl)
// instead of a locally hand-rolled interface. This is what
// map.addSource()'s `data` field and GeoJSONSource.setData() actually
// expect (GeoJSON.GeoJSON | string — confirmed via
// node_modules/maplibre-gl/dist/maplibre-gl.d.ts's GeoJSONSourceOptions
// type), so no `any`/`unknown` cast is needed anywhere in this file.

type PolygonFeature = GeoJSON.Feature<GeoJSON.Polygon, Record<string, number | string>>;
type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, Record<string, number | string>>;

function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ─── Deterministic PRNG (stable jitter across rebuilds) ────────────────────

/** Simple, fast, deterministic PRNG (mulberry32) — NOT cryptographically
 *  random, but perfectly adequate for stable-looking jitter. Given the
 *  same numeric seed, always produces the same sequence of values. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of a string — used to turn a stable key into
 *  a stable PRNG seed. */
function hashStringToSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ─── Geo helpers (circle generation + tree_row line sampling) ──────────────

const EARTH_RADIUS_METERS = 6371000;

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
  return meters / 111320;
}

function metersToDegreesLng(meters: number, atLat: number): number {
  return meters / (111320 * Math.cos(toRad(atLat)));
}

/** Generates a closed polygon ring approximating a circle of `radiusMeters`
 *  centered at (lng, lat), with `segments` sides. Used for both the trunk
 *  footprint and each canopy "ring" (stacked cylinder band). */
function circleRing(lng: number, lat: number, radiusMeters: number, segments: number): number[][] {
  const ring: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const dx = Math.cos(angle) * radiusMeters;
    const dy = Math.sin(angle) * radiusMeters;
    ring.push([lng + metersToDegreesLng(dx, lat), lat + metersToDegreesLat(dy)]);
  }
  return ring;
}

interface SampledPoint {
  lng: number;
  lat: number;
}

/** Walks a polyline and returns points spaced `spacingMeters` apart along
 *  its length. Always includes the line's starting vertex. */
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface TreeRecord {
  lng: number;
  lat: number;
  heightMeters: number;
}

// ─── Layer ──────────────────────────────────────────────────────────────────

export class TreeLayer {
  id = "tree";

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
  canopyRings = 4;
  circleSegments = 8;

  treeRowSpacing = 4;
  treeRowJitterMeters = 0.3;

  trunkColor = "#6b5335";
  canopyColor = "#6e7f52";

  opacity = 1;
  debug = false;

  maxTrees = 20000;
  refreshDebounceMs = 250;

  private static readonly GROUND_CLEARANCE_METERS = 0.1;

  private trees = new Map<string, TreeRecord>();

  private map: MapLibreMap | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private get trunkSourceId(): string {
    return `${this.id}-trunk-source`;
  }
  private get canopySourceId(): string {
    return `${this.id}-canopy-source`;
  }
  private get trunkLayerId(): string {
    return `${this.id}-trunk-layer`;
  }
  private get canopyLayerId(): string {
    return `${this.id}-canopy-layer`;
  }

  private onSourceData = (e: MapSourceDataEvent): void => {
    if (e.sourceId === this.source && e.isSourceLoaded) this.scheduleRefresh();
  };
  private onMoveEnd = (): void => this.scheduleRefresh();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  addTo(map: MapLibreMap, beforeId?: string): void {
    this.map = map;

    map.addSource(this.trunkSourceId, {
      type: "geojson",
      data: emptyFeatureCollection(),
      maxzoom: 22
    });
    map.addSource(this.canopySourceId, {
      type: "geojson",
      data: emptyFeatureCollection(),
      maxzoom: 22
    });

    map.addLayer(
      {
        id: this.trunkLayerId,
        type: "fill-extrusion",
        source: this.trunkSourceId,
        minzoom: this.minzoom,
        paint: {
          "fill-extrusion-color": this.trunkColor,
          "fill-extrusion-opacity": this.opacity,
          "fill-extrusion-height": ["get", "top"],
          "fill-extrusion-base": ["get", "base"]
        }
      },
      beforeId
    );

    map.addLayer(
      {
        id: this.canopyLayerId,
        type: "fill-extrusion",
        source: this.canopySourceId,
        minzoom: this.minzoom,
        paint: {
          "fill-extrusion-color": this.canopyColor,
          "fill-extrusion-opacity": this.opacity,
          "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-height": ["get", "top"],
          "fill-extrusion-base": ["get", "base"]
        }
      },
      beforeId
    );

    map.on("sourcedata", this.onSourceData);
    map.on("moveend", this.onMoveEnd);
    map.on("zoomend", this.onMoveEnd);

    this.scheduleRefresh();
  }

  remove(): void {
    if (!this.map) return;
    const map = this.map;

    map.off("sourcedata", this.onSourceData);
    map.off("moveend", this.onMoveEnd);
    map.off("zoomend", this.onMoveEnd);
    clearTimeout(this.refreshTimer);

    if (map.getLayer(this.trunkLayerId)) map.removeLayer(this.trunkLayerId);
    if (map.getLayer(this.canopyLayerId)) map.removeLayer(this.canopyLayerId);
    if (map.getSource(this.trunkSourceId)) map.removeSource(this.trunkSourceId);
    if (map.getSource(this.canopySourceId)) map.removeSource(this.canopySourceId);

    this.map = undefined;
  }

  refresh(): void {
    this.buildAndUpload();
  }

  clear(): void {
    this.trees.clear();
    this.regenerateAndUpload();
  }

  setOpacity(v: number): void {
    this.opacity = v;
    if (!this.map) return;
    if (this.map.getLayer(this.trunkLayerId)) {
      this.map.setPaintProperty(this.trunkLayerId, "fill-extrusion-opacity", v);
    }
    if (this.map.getLayer(this.canopyLayerId)) {
      this.map.setPaintProperty(this.canopyLayerId, "fill-extrusion-opacity", v);
    }
  }

  // ── Data: query vector tile source, merge into persistent registry ─────

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.buildAndUpload(), this.refreshDebounceMs);
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

  private addTreeFeatures(
    lng: number,
    lat: number,
    heightMeters: number,
    trunkFeatures: PolygonFeature[],
    canopyFeatures: PolygonFeature[]
  ): void {
    const clearance = TreeLayer.GROUND_CLEARANCE_METERS;
    const trunkTop = clearance + heightMeters * this.trunkHeightRatio;
    const trunkRadius = heightMeters * this.trunkRadiusRatio;
    const canopyMaxRadius = heightMeters * this.canopyRadiusRatio;
    const canopyBase = clearance + trunkTop * 0.85;
    const canopyHeight = heightMeters - canopyBase;

    trunkFeatures.push({
      type: "Feature",
      properties: { base: clearance, top: trunkTop },
      geometry: { type: "Polygon", coordinates: [circleRing(lng, lat, trunkRadius, this.circleSegments)] }
    });

    for (let i = 0; i < this.canopyRings; i++) {
      const tBottom = i / this.canopyRings;
      const tTop = (i + 1) / this.canopyRings;
      const tMid = (tBottom + tTop) / 2;
      const radiusAtMid = canopyMaxRadius * Math.sqrt(Math.max(0, 1 - tMid * tMid));

      canopyFeatures.push({
        type: "Feature",
        properties: {
          base: canopyBase + tBottom * canopyHeight,
          top: canopyBase + tTop * canopyHeight
        },
        geometry: {
          type: "Polygon",
          coordinates: [circleRing(lng, lat, Math.max(radiusAtMid, 0.15), this.circleSegments)]
        }
      });
    }
  }

  private buildAndUpload(): void {
    if (!this.map || !this.map.getSource(this.source)) return;

    let currentQueryTotal = 0;
    const debugCounts: Record<string, Record<string, number>> = {};

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

    this.regenerateAndUpload();

    if (this.debug) {
      console.log(
        `[TreeLayer] rebuild: ${currentQueryTotal} raw features seen this pass — ` + `breakdown by source-layer/geometry:`,
        debugCounts
      );
      console.log(
        `[TreeLayer] persistent registry: ${this.trees.size} trees total ` +
          `(accumulated across the whole session — never shrinks; see clear())`
      );
    }
  }

  private regenerateAndUpload(): void {
    if (!this.map) return;

    const trunkFeatures: PolygonFeature[] = [];
    const canopyFeatures: PolygonFeature[] = [];

    for (const { lng, lat, heightMeters } of this.trees.values()) {
      this.addTreeFeatures(lng, lat, heightMeters, trunkFeatures, canopyFeatures);
    }

    const trunkSource = this.map.getSource(this.trunkSourceId) as GeoJSONSource | undefined;
    const canopySource = this.map.getSource(this.canopySourceId) as GeoJSONSource | undefined;
    trunkSource?.setData({ type: "FeatureCollection", features: trunkFeatures });
    canopySource?.setData({ type: "FeatureCollection", features: canopyFeatures });
  }
}
