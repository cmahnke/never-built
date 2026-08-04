import maplibregl, {
  Map,
  Popup,
  NavigationControl,
  FullscreenControl,
  AttributionControl,
  IControl,
  LngLatLike,
  LngLatBoundsLike,
  GeoJSONSource,
  setWorkerUrl,
} from 'maplibre-gl';
import type {
  PopupOptions,
  StyleSpecification,
  LayerSpecification,
  VectorSourceSpecification,
  GeoJSONSourceSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
  CircleLayerSpecification,
  SymbolLayerSpecification,
  BackgroundLayerSpecification,
} from 'maplibre-gl';
import { bbox as turfBbox, center as turfCenter } from '@turf/turf';
import type { Feature, FeatureCollection } from 'geojson';
import { updateStyle, setupDefaultStyle, buildDefaultStyle, collectFontFamilies, fontFamilyToSlug, loadFontCss, preloadStyleFonts } from './styles';
import { toolTips } from "./base-map";
import { absUrl, bboxToBounds, loadOrParse } from "./map-utils";

import type { ToolTipStrings } from "./base-map";


setWorkerUrl('/js/maplibre-gl/maplibre-gl-worker.mjs');

/* =========================================================================
 * Shared defaults
 * ========================================================================= */

const defaultSprites = '/map-styles/sprite';

const popupOptions: PopupOptions = { anchor: 'bottom-left', maxWidth: 'none' };

/** Pixel tolerance around a click point when looking for overlapping point
 * features to merge into a single popup — mirrors the original OpenLayers
 * setup's `markerOptions.hitTolerance`. */
const popupHitTolerance = 8;

/**
 * CSS template used to dynamically load @font-face rules per font-family
 * name, e.g. "/css/fonts/roboto-mono-variable.css". This is the ORIGINAL
 * "ol:webfonts" concept from the OpenLayers/ol-mapbox-style setup —
 * MapLibre doesn't know about that metadata convention natively, so we
 * replicate the loading behavior ourselves via <link> tags + the Font
 * Loading API.
 */
const defaultFontsCssTemplate = '/css/fonts/{font-family}.css';

const defaultAttribution =
  '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/** Fallback font-family used by the window.projektemacherMap wrapper when
 * no explicit `font` is given. Restored to match the original project
 * default. */
const defaultMapFont = 'Roboto Mono Variable';

export const defaultVectorSource =
  'https://static.projektemacher.org/maps/central-europe/tiles/{z}/{x}/{y}.pbf';

export const defaultPadding = 50;

const SUPPORTED_RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * Extends MapLibre's Map type with a legacy OpenLayers-style method for
 * backwards compatibility with external code that hasn't been migrated yet.
 */
interface MaplibreMapWithLegacyShim extends Map {
  /** @deprecated Use resize() instead. Kept for legacy call-site compatibility. */
  updateSize?: () => void;
}

/* =========================================================================
 * base-map: language, tooltips, helpers
 * ========================================================================= */

type Lang = 'de' | 'en';


export function getLang(): Lang {
  let lang = 'en';
  if (document.documentElement.lang !== undefined) {
    lang = document.documentElement.lang;
  }
  return (lang in toolTips ? lang : 'en') as Lang;
}

class MousePositionControl implements IControl {
  private container?: HTMLDivElement;
  private map?: Map;
  private onMouseMove = (e: maplibregl.MapMouseEvent) => {
    if (this.container) {
      const { lng, lat } = e.lngLat;
      this.container.textContent = `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
    }
  };

  onAdd(map: Map): HTMLElement {
    this.map = map;
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group mouse-position';
    this.container.style.padding = '0 6px';
    this.container.style.fontSize = '11px';
    map.on('mousemove', this.onMouseMove);
    return this.container;
  }

  onRemove(): void {
    this.map?.off('mousemove', this.onMouseMove);
    this.container?.parentNode?.removeChild(this.container);
    this.map = undefined;
  }
}



/* =========================================================================
 * Marker / route styling helpers — with SVG detection + rasterization
 * ========================================================================= */

interface MarkerOptions {
  src: string;
  scale?: number;
  anchor?: [number, number];
}

/**
 * Determines an SVG's intrinsic size from its width/height attributes or
 * viewBox, falling back to a reasonable default if none is specified.
 */
function getSvgIntrinsicSize(svgText: string, fallback = 64): { width: number; height: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.documentElement;

  const widthAttr = svgEl.getAttribute('width');
  const heightAttr = svgEl.getAttribute('height');
  const width = widthAttr ? parseFloat(widthAttr) : NaN;
  const height = heightAttr ? parseFloat(heightAttr) : NaN;
  if (!Number.isNaN(width) && !Number.isNaN(height) && width > 0 && height > 0) {
    return { width, height };
  }

  const viewBox = svgEl.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  return { width: fallback, height: fallback };
}

/**
 * Rasterizes an SVG at its own intrinsic size (times devicePixelRatio for
 * crispness on HiDPI screens), instead of a fixed arbitrary size — so the
 * displayed marker matches the size the SVG was actually designed for.
 */
async function svgUrlToImageData(
  svgUrl: string,
  scale = 1
): Promise<{ imageData: ImageData; cssWidth: number; cssHeight: number }> {
  const response = await fetch(svgUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch SVG "${svgUrl}": ${response.status} ${response.statusText}`);
  }
  const svgText = await response.text();
  const { width: intrinsicWidth, height: intrinsicHeight } = getSvgIntrinsicSize(svgText);

  const cssWidth = intrinsicWidth * scale;
  const cssHeight = intrinsicHeight * scale;
  const dpr = window.devicePixelRatio || 1;
  const rasterWidth = Math.round(cssWidth * dpr);
  const rasterHeight = Math.round(cssHeight * dpr);

  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not rasterize SVG "${svgUrl}"`));
      img.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = rasterWidth;
    canvas.height = rasterHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context not available for SVG rasterization.');
    }
    ctx.clearRect(0, 0, rasterWidth, rasterHeight);
    ctx.drawImage(img, 0, 0, rasterWidth, rasterHeight);
    return {
      imageData: ctx.getImageData(0, 0, rasterWidth, rasterHeight),
      cssWidth,
      cssHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function ensureMarkerImage(map: Map, id: string, marker: MarkerOptions): Promise<boolean> {
  if (map.hasImage(id)) return true;
  const src = absUrl(marker.src);
  const isSvg = src.toLowerCase().endsWith('.svg');
  const isSupportedRaster = SUPPORTED_RASTER_EXTENSIONS.some((ext) =>
    src.toLowerCase().endsWith(ext)
  );
  const scale = marker.scale ?? 1;

  try {
    if (isSvg) {
      const { imageData, cssWidth } = await svgUrlToImageData(src, scale);
      const pixelRatio = imageData.width / cssWidth; // = devicePixelRatio, by construction
      if (!map.hasImage(id)) {
        map.addImage(id, imageData, { pixelRatio });
      }
      return true;
    }

    if (!isSupportedRaster) {
      console.warn(
        `Marker image "${src}" has an unrecognized extension. Only PNG/JPEG/WebP are ` +
          `supported by loadImage(); SVGs are rasterized automatically. Attempting to load ` +
          `anyway, but this may fail.`
      );
    }

    const image = await map.loadImage(src);
    if (!image || !image.data) {
      console.warn(`Marker image "${src}" could not be decoded (loadImage() returned no data).`);
      return false;
    }
    // Preserve the raster image's natural pixel size as its CSS display
    // size when scale is 1 (matching the original OL Icon default
    // behavior), scaling proportionally otherwise.
    if (!map.hasImage(id)) {
      map.addImage(id, image.data, { pixelRatio: 1 / scale });
    }
    return true;
  } catch (err) {
    console.warn(`Could not load marker image "${src}":`, err);
    return false;
  }
}

async function addRouteAndMarkerLayers(
  map: Map,
  sourceId: string,
  marker: MarkerOptions | undefined
): Promise<void> {
  map.addLayer({
    id: `${sourceId}-outline`,
    type: 'line',
    source: sourceId,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': 'rgba(0,0,0,1)',
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 0, 5, 20, 28],
    },
  } as LineLayerSpecification);

  map.addLayer({
    id: `${sourceId}-line`,
    type: 'line',
    source: sourceId,
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: {
      'line-color': 'rgba(255,255,255,1)',
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 0, 1, 20, 24],
    },
  } as LineLayerSpecification);

  if (marker !== undefined) {
    const iconId = `${sourceId}-icon`;
    const loaded = await ensureMarkerImage(map, iconId, marker);
    if (loaded && map.hasImage(iconId)) {
      map.addLayer({
        id: `${sourceId}-points`,
        type: 'symbol',
        source: sourceId,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'icon-image': iconId,
          'icon-allow-overlap': true,
        },
      } as SymbolLayerSpecification);
      return;
    }
    console.warn(`Falling back to circle markers for points (icon "${iconId}" unavailable).`);
  }

  map.addLayer({
    id: `${sourceId}-points`,
    type: 'circle',
    source: sourceId,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': 'rgba(51, 153, 204, 0.7)', 'circle-radius': 6 },
  } as CircleLayerSpecification);
}

function addClusterLayers(map: Map, sourceId: string): void {
  map.addLayer({
    id: `${sourceId}-clusters`,
    type: 'circle',
    source: sourceId,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': 'rgba(51, 153, 204, 0.7)',
      'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 50, 25],
      'circle-stroke-color': 'rgba(255,255,255,0.7)',
      'circle-stroke-width': 2,
    },
  } as CircleLayerSpecification);

  map.addLayer({
    id: `${sourceId}-cluster-count`,
    type: 'symbol',
    source: sourceId,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-size': 12,
    },
    paint: { 'text-color': '#fff' },
  } as SymbolLayerSpecification);

  map.addLayer({
    id: `${sourceId}-unclustered`,
    type: 'circle',
    source: sourceId,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': 'rgba(51, 153, 204, 0.7)',
      'circle-radius': 8,
      'circle-stroke-color': 'rgba(255,255,255,0.7)',
      'circle-stroke-width': 1.25,
    },
  } as CircleLayerSpecification);
}

/**
 * Merges the `name` and `popupContent` properties of multiple overlapping
 * point features into a single combined popup payload — restores the
 * original OpenLayers behavior (`mergeFeatures()`), which combined
 * multiple markers at the same point into one popup instead of only
 * showing the topmost feature.
 */
function mergeFeatureProperties(
  features: Array<{ properties?: Record<string, any> | null }>
): { name?: string; popupContent?: string } {
  const names: string[] = [];
  let popupContent = '';

  features.forEach((feature) => {
    const props = feature.properties ?? {};
    if (props.name !== undefined && props.name !== null && props.name !== '') {
      names.push(String(props.name));
    }
    if (props.popupContent !== undefined && props.popupContent !== null) {
      popupContent += props.popupContent;
    }
  });

  return {
    name: names.length > 0 ? names.join(', ') : undefined,
    popupContent: popupContent || undefined,
  };
}

function showPopup(
  map: Map,
  lngLat: LngLatLike,
  name: string | undefined,
  popupContent: string | undefined
): void {
  const html = `<h1>${name ?? ''}</h1>${popupContent ?? ''}`;
  new Popup(popupOptions).setLngLat(lngLat).setHTML(html).addTo(map);
}

/* =========================================================================
 * Core map setup
 * ========================================================================= */

export async function getMapMetadata(
  url: string
): Promise<{ bounds: number[] | number[][]; [k: string]: unknown }> {
  const metadataFile = 'metadata.json';
  if (url.includes('{')) {
    url = url.substring(0, url.indexOf('{'));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith('/')) {
    url += '/' + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url) as Promise<{ bounds: number[] | number[][]; [k: string]: unknown }>;
}

type BBoxInput = number[] | number[][] | string;

export async function projektemacherMap(
  elem: string | HTMLElement,
  geojson?: string | FeatureCollection,
  source?: string,
  style?: string | StyleSpecification,
  bbox?: string | BBoxInput,
  center?: string | LngLatLike,
  initialZoom?: number,
  minZoom?: number,
  maxZoom?: number,
  cluster?: boolean,
  disabled?: boolean,
  popup?: boolean,
  background?: string,
  debug?: boolean,
  marker?: MarkerOptions,
  font?: string,
  attribution?: string,
  fontPath: string = defaultFontsCssTemplate
): Promise<Map> {
  // Defensive runtime checks — positional-argument mix-ups are easy with
  // this many parameters.
  if (attribution !== undefined && typeof attribution !== 'string') {
    console.error(
      `projektemacherMap(): "attribution" argument must be a string, received ` +
        `${typeof attribution} (${JSON.stringify(attribution)}). Check the call site — ` +
        `arguments may be shifted/mismatched. Ignoring this value.`
    );
    attribution = defaultAttribution;
  }
  if (font !== undefined && typeof font !== 'string') {
    console.error(
      `projektemacherMap(): "font" argument must be a string, received ${typeof font}. ` +
        `Check the call site. Ignoring this value.`
    );
    font = undefined;
  }

  source = absUrl(source as string);

  const geojsonObj = (await loadOrParse(geojson as string)) as FeatureCollection | undefined;

  let bboxObj: number[][] | undefined;
  if (bbox !== undefined) {
    const raw = (await loadOrParse(bbox as string)) as number[] | number[][];
    if ((raw as number[]).length === 4) {
      const flat = raw as number[];
      bboxObj = [
        [flat[0], flat[1]],
        [flat[2], flat[3]],
      ];
    } else {
      bboxObj = raw as number[][];
    }
  }

  let centerObj: LngLatLike;
  if (center !== undefined) {
    centerObj = (await loadOrParse(center as string)) as LngLatLike;
  } else if (geojsonObj !== undefined && geojsonObj.features.length !== 0) {
    centerObj = turfCenter(geojsonObj as any).geometry.coordinates as [number, number];
  } else if (bboxObj !== undefined && bboxObj.length !== 0) {
    const [[w, s], [e, n]] = bboxObj;
    centerObj = [(w + e) / 2, (s + n) / 2];
  } else {
    console.warn("Can't create center from features or bbox");
    centerObj = [0, 0];
  }

  if (maxZoom === undefined) maxZoom = 16;
  if (bbox === undefined || bboxObj === undefined || bboxObj.length === 0) {
    bboxObj = [
      [-180, -85.051129],
      [180, 85.051129],
    ];
  }
  if (cluster !== undefined && cluster !== false && marker !== undefined) {
    console.warn('Clustering combined with custom point markers is only partially supported.');
  }

  if (disabled === undefined) disabled = false;
  if (popup === undefined && !disabled) popup = true;
  if (debug === undefined) debug = false;
  if (attribution === undefined) attribution = defaultAttribution;
  if (initialZoom === undefined) initialZoom = 0;

  let styleObj: StyleSpecification;
  if (style !== undefined) {
    styleObj = (await loadOrParse(style as string)) as StyleSpecification;
    styleObj = updateStyle(
      styleObj,
      source,
      initialZoom,
      undefined,
      undefined,
      bboxObj,
      centerObj,
      background,
      absUrl(defaultSprites),
      fontPath,
      font,
      attribution
    );
  } else {
    styleObj = setupDefaultStyle(source, initialZoom, minZoom, maxZoom, bboxObj, centerObj, background);
  }

  // TODO: Fix building outline here
  styleObj.layers.forEach((layer: StyleLayer, index: number) => {
    if (layer.id === "building_pattern") {
      styleObj.layers[index] = {
        ...layer,
        paint: {
          ...layer.paint,
          "fill-outline-color": {
            base: 1,
            stops: [
              [14, "rgba(0, 0, 0, 0)"],   // Disabled at zoom 14
              [15, "rgba(0, 0, 0, 1)"] // Shown above zoom 14
            ]
          }
        }
      }
    }
  });

  console.log(styleObj);

  // Preload every web font referenced by the style's symbol layers BEFORE
  // creating the map, so text renders correctly from the first frame
  // instead of relying on MapLibre's per-glyph local-render fallback.
  const resolvedFontPath =
    ((styleObj.metadata as any)?.['projektemacher:fontPath'] as string | undefined) ?? fontPath;
  await preloadStyleFonts(styleObj, resolvedFontPath);

  const map = new Map({
    container: elem,
    style: styleObj,
    center: centerObj,
    zoom: initialZoom,
    minZoom,
    maxZoom,
    maxBounds: bboxObj ? (bboxObj as LngLatBoundsLike) : undefined,
    attributionControl: false,
    interactive: !disabled,
  });

  if (!disabled) {
    map.addControl(new NavigationControl({}), 'top-left');
    map.addControl(new FullscreenControl(), 'top-right');
  }
  const attributionControl = new AttributionControl(/* { compact: true, customAttribution: attribution }*/);
  //attributionControl.onAdd(map).open = false;

  map.addControl(attributionControl);


  if (debug) {
    console.log(
      `Adding map on ${elem}, from '${source}', style ${style}: options cluster '${cluster}', marker '${JSON.stringify(
        marker
      )}', bbox '${bbox}', center '${center}', initialZoom '${initialZoom}', min zoom '${minZoom}', max zoom '${maxZoom}', popup '${popup}', disabled '${disabled}' - debug '${debug}', fontPath '${resolvedFontPath}'`
    );
    console.log('Active style', styleObj);
    map.addControl(new MousePositionControl(), 'bottom-left');
    map.showTileBoundaries = true;
  }

  await new Promise<void>((resolve) => map.once('load', () => resolve()));

  if (geojsonObj !== undefined) {
    const sourceId = 'geojson-source';
    map.addSource(sourceId, {
      type: 'geojson',
      data: geojsonObj,
      cluster: !!cluster,
      clusterRadius: 25,
    } as GeoJSONSourceSpecification);

    if (cluster) {
      addClusterLayers(map, sourceId);
    } else if (marker !== undefined) {
      await addRouteAndMarkerLayers(map, sourceId, marker);
    } else {
      map.addLayer({
        id: `${sourceId}-points`,
        type: 'circle',
        source: sourceId,
        paint: { 'circle-color': 'rgba(51, 153, 204, 0.7)', 'circle-radius': 6 },
      } as CircleLayerSpecification);
    }

    if (!disabled && popup) {
      const clickableLayers = cluster
        ? [`${sourceId}-clusters`, `${sourceId}-unclustered`]
        : [`${sourceId}-points`];

        map.on('click', clickableLayers, async (e) => {
          const bufferedBox: [[number, number], [number, number]] = [
            [e.point.x - popupHitTolerance, e.point.y - popupHitTolerance],
            [e.point.x + popupHitTolerance, e.point.y + popupHitTolerance],
          ];
          const features = map.queryRenderedFeatures(bufferedBox, { layers: clickableLayers });
          if (features.length === 0) return;

          const clusterFeature = features.find(
            (f) => f.properties?.cluster && f.properties?.cluster_id !== undefined
          );
          if (clusterFeature) {
            const src = map.getSource(sourceId) as GeoJSONSource;
            const clusterId = clusterFeature.properties!.cluster_id as number;
            const zoom = await src.getClusterExpansionZoom(clusterId);
            map.easeTo({ center: (clusterFeature.geometry as any).coordinates, zoom });
            return;
          }

          const merged = mergeFeatureProperties(features);
          const lngLat = (features[0].geometry as any).coordinates as LngLatLike;

          map.easeTo({ center: lngLat, duration: 300 });

          showPopup(map, lngLat, merged.name, merged.popupContent);
        });

      map.on('mouseenter', clickableLayers, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', clickableLayers, () => {
        map.getCanvas().style.cursor = '';
      });
    }

    if (geojsonObj.features.length) {
      const box = turfBbox(geojsonObj as any) as [number, number, number, number];
      map.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        { padding: defaultPadding }
      );
    }
  }

  // MapLibre/Mapbox GL uses resize(), not the OpenLayers-style updateSize().
  map.resize();

  // Compatibility shim: legacy/external call sites (migrated from OpenLayers)
  // may still call map.updateSize() instead of MapLibre's map.resize().
  // Add a thin polyfill so those calls don't throw, instead of requiring
  // every external caller to be updated.
  (map as MaplibreMapWithLegacyShim).updateSize = () => map.resize();

  return map;
}

/* =========================================================================
 * window.projektemacherMap wrapper
 * ========================================================================= */

declare global {
  interface Window {
    projektemacherMap: (
      elem: string | HTMLElement,
      geojson?: string | FeatureCollection,
      source?: string,
      style?: string | StyleSpecification,
      bbox?: string | BBoxInput,
      center?: string | LngLatLike,
      initialZoom?: number,
      minZoom?: number,
      maxZoom?: number,
      cluster?: boolean,
      disabled?: boolean,
      popup?: boolean,
      background?: string,
      debug?: boolean,
      marker?: string | MarkerOptions,
      font?: string
    ) => Promise<Map>;
    projektemacher: {
      maps: Record<string, Map>;
    };
  }
}

window.projektemacherMap = async function (
  elem: string | HTMLElement,
  geojson?: string | FeatureCollection,
  source?: string,
  style?: string | StyleSpecification,
  bbox?: string | BBoxInput,
  center?: string | LngLatLike,
  initialZoom?: number,
  minZoom?: number,
  maxZoom?: number,
  cluster?: boolean,
  disabled?: boolean,
  popup?: boolean,
  background?: string,
  debug?: boolean,
  marker?: string | MarkerOptions,
  font?: string
): Promise<Map> {
  let bgElem: HTMLElement | null = null;
  if (typeof elem === 'string') {
    bgElem = document.getElementById(elem);
  }
  if (font === undefined) {
    font = defaultMapFont;
  }

  let markerObj: MarkerOptions | undefined;
  if (marker !== undefined) {
    markerObj = typeof marker === 'object' ? marker : (JSON.parse(marker) as MarkerOptions);
  }

  background = bgElem
    ? window.getComputedStyle(bgElem).getPropertyValue('--page-background')
    : background;

  const map = await projektemacherMap(
    elem,
    geojson,
    source,
    style,
    bbox,
    center,
    initialZoom,
    minZoom,
    maxZoom,
    cluster,
    disabled,
    popup,
    background,
    debug,
    markerObj,
    font
  );

  if (!('projektemacher' in window)) {
    window.projektemacher = { maps: {} };
  }
  if (!('maps' in window.projektemacher)) {
    window.projektemacher.maps = {};
  }
  window.projektemacher.maps[elem as string] = map;

  return map;
};
