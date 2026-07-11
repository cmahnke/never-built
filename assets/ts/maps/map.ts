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

interface ToolTipStrings {
  zoomIn: string;
  zoomOut: string;
  fullscreen: string;
  rotate: string;
  rotateLeft: string;
  rotateRight: string;
}

export const toolTips: Record<Lang, ToolTipStrings> = {
  de: {
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    fullscreen: 'Vollbildansicht',
    rotate: 'Rotation zurücksetzen',
    rotateLeft: '90° nach links drehen',
    rotateRight: '90° nach rechst drehen',
  },
  en: {
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fullscreen: 'Toggle full-screen',
    rotate: 'Reset rotation',
    rotateLeft: 'Rotate 90° left',
    rotateRight: 'Rotate 90° right',
  },
};

export function getLang(): Lang {
  let lang = 'en';
  if (document.documentElement.lang !== undefined) {
    lang = document.documentElement.lang;
  }
  return (lang in toolTips ? lang : 'en') as Lang;
}

export function bboxToBounds(bbox: string | (string | number)[]): LngLatBoundsLike {
  let arr: (string | number)[];
  if (typeof bbox === 'string') {
    arr = bbox.split(',');
  } else {
    arr = bbox.flat();
  }
  const n = arr.map((e) => Number(e));
  return [
    [n[0], n[1]],
    [n[2], n[3]],
  ];
}

export function absUrl(url: string): string {
  if (url.startsWith('http') || url.startsWith('//')) {
    return url;
  }
  let base = window.location.protocol + '//' + window.location.hostname;
  if (window.location.port !== '') {
    base += ':' + window.location.port;
  }
  return base + url;
}

export function loadOrParse<T = unknown>(str: T | string): T | Promise<T | void> {
  if (typeof str === 'object') {
    return str as T;
  }
  try {
    // BUG (preserved from original): `json` was never actually passed in.
    return JSON.parse((globalThis as any).json) as T;
  } catch {
    return fetch(str as string)
      .then((response) => response.json() as Promise<T>)
      .catch((body) => {
        console.log(`Could not read JSON from ${str}` + body);
      })
      .catch(() => {
        console.log(`Could not read data from URL ${str}`);
      });
  }
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

/**
 * Converts a CSS font-family name into a URL-safe, filename-style slug:
 * lowercase, spaces replaced with hyphens. E.g. "Roboto Mono Variable"
 * becomes "roboto-mono-variable".
 */
function fontFamilyToSlug(fontFamily: string): string {
  return fontFamily.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Injects a <link rel="stylesheet"> for a given font-family's CSS template
 * (containing @font-face rules), if not already present.
 */
function loadFontCss(fontFamily: string, template: string): Promise<void> {
  const slug = fontFamilyToSlug(fontFamily);
  const href = absUrl(template.replace('{font-family}', slug));
  const existing = document.querySelector(`link[data-font-family="${CSS.escape(fontFamily)}"]`);
  if (existing) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.fontFamily = fontFamily;
    link.onload = () => resolve();
    link.onerror = () =>
      reject(new Error(`Could not load font CSS for "${fontFamily}" from ${href}`));
    document.head.appendChild(link);
  });
}

/** Collects every distinct font-family name referenced in `text-font`
 * arrays across all symbol layers of a style. */
function collectFontFamilies(style: StyleSpecification): string[] {
  const families = new Set<string>();
  style.layers.forEach((layer) => {
    if (layer.type === 'symbol' && layer.layout && 'text-font' in layer.layout) {
      const textFont = (layer.layout as any)['text-font'];
      if (Array.isArray(textFont)) {
        textFont.forEach((f) => {
          if (typeof f === 'string') families.add(f);
        });
      }
    }
  });
  return Array.from(families);
}

/**
 * Ensures every font-family referenced by the style's symbol layers is
 * loaded via CSS (@font-face) and preloaded via the Font Loading API,
 * BEFORE the map is created — mirroring the pattern from MapLibre's own
 * web-font example (`document.fonts.load("24px 'Font Name'")`).
 */
async function preloadStyleFonts(
  style: StyleSpecification,
  fontCssTemplate: string
): Promise<void> {
  const families = collectFontFamilies(style);
  if (families.length === 0) return;

  await Promise.all(
    families.map(async (family) => {
      try {
        await loadFontCss(family, fontCssTemplate);
        if ('fonts' in document) {
          await document.fonts.load(`24px '${family}'`);
        }
      } catch (err) {
        console.warn(`Could not preload web font "${family}":`, err);
      }
    })
  );

  if ('fonts' in document) {
    await document.fonts.ready;
  }
}

/* =========================================================================
 * default map style
 * ========================================================================= */

type LayerColorTuple = [string, number, number, number];

const defaultStyleLayers: LayerColorTuple[] = [
  ['water', 6, 204, 204],
  ['water_name', 2, 44, 91],
  ['waterway', 35, 117, 224],
  ['landcover', 83, 224, 51],
  ['landuse', 229, 180, 4],
  ['park', 132, 234, 91],
  ['boundary', 197, 69, 211],
  ['aeroway', 81, 174, 181],
  ['transportation', 242, 182, 72],
  ['transportation_name', 188, 107, 56],
  ['building', 43, 43, 43],
  ['housenumber', 40, 40, 40],
  ['place', 242, 14, 147],
  ['mountain_peak', 98, 237, 247],
  ['poi', 59, 181, 10],
];

function buildDefaultStyle(source: string): StyleSpecification {
  const backgroundLayer: BackgroundLayerSpecification = {
    id: 'background',
    type: 'background',
    paint: { 'background-color': 'rgb(250,250,250)' },
  };

  const fillLayers: FillLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_polygon`,
    type: 'fill',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': `rgba(${r}, ${g}, ${b}, 0.3)`,
      'fill-antialias': true,
      'fill-outline-color': `rgba(${r}, ${g}, ${b}, 0.3)`,
    },
  }));

  const lineLayers: LineLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_line`,
    type: 'line',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': `rgba(${r}, ${g}, ${b}, 0.6)` },
  }));

  const circleLayers: CircleLayerSpecification[] = defaultStyleLayers.map(([id, r, g, b]) => ({
    id: `vector_layer__${id}_circle`,
    type: 'circle',
    source: 'vector_layer_',
    'source-layer': id,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-color': `rgba(${r}, ${g}, ${b}, 0.8)`, 'circle-radius': 2 },
  }));

  const vectorSource: VectorSourceSpecification = {
    type: 'vector',
    tiles: [source],
    minzoom: 0,
    maxzoom: 14,
    attribution: '&copy; OpenStreetMap contributors and Natural Earth',
  };

  const layers: LayerSpecification[] = [backgroundLayer, ...fillLayers, ...lineLayers, ...circleLayers];

  // NOTE: no `glyphs` key set at all — the default style has no symbol/text
  // layers, and custom styles that DO have text layers rely on local
  // web-font rendering via `preloadStyleFonts()` instead of a PBF endpoint.
  return {
    version: 8,
    metadata: { inspect: true },
    sources: { vector_layer_: vectorSource },
    layers,
  } as StyleSpecification;
}

export function setupDefaultStyle(
  source: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: LngLatLike,
  background?: string
): StyleSpecification {
  const style = buildDefaultStyle(source);
  const src = style.sources.vector_layer_ as VectorSourceSpecification;

  src.tiles = [source];
  if (minzoom !== undefined) src.minzoom = minzoom;
  if (maxzoom !== undefined) src.maxzoom = maxzoom;
  if (bounds !== undefined) {
    (src as any).bounds = bounds.flat().map((e) => Number(e));
  }
  if (background !== undefined) {
    (style.layers[0] as BackgroundLayerSpecification).paint = {
      ...(style.layers[0] as BackgroundLayerSpecification).paint,
      'background-color': background,
    };
  }
  (style as any).center = center;
  (style as any).zoom = initialzoom;

  return style;
}

/* =========================================================================
 * updateStyle — `fontPath` is a CSS template (the original "ol:webfonts"
 * concept), NOT a glyphs PBF template. `font` overrides the primary
 * text-font entry in every symbol layer.
 *
 * IMPORTANT: Any pre-existing `style.glyphs` value (e.g. pointing to
 * MapTiler/Mapbox with an unresolved API-key placeholder, or blocked by
 * CSP) is explicitly removed, since text rendering relies entirely on
 * locally loaded web fonts instead (see preloadStyleFonts()).
 * ========================================================================= */

export function updateStyle(
  style: StyleSpecification,
  url: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: LngLatLike,
  background?: string,
  sprites?: string,
  fontPath?: string,
  font?: string,
  attribution?: string
): StyleSpecification {
  const sourceKey = Object.keys(style.sources)[0];
  const source = style.sources[sourceKey] as VectorSourceSpecification & {
    url?: string;
    attribution?: unknown;
  };

  source.tiles = [url];
  if ('url' in source) {
    delete source.url;
  }

  if (minzoom !== undefined) source.minzoom = minzoom;
  if (maxzoom !== undefined) source.maxzoom = maxzoom;
  if (bounds !== undefined) {
    (source as any).bounds = bounds.flat().map((e) => Number(e));
  }

  // Defensive: only ever write a real string into `attribution`, and strip
  // out any pre-existing invalid (e.g. boolean) value from the loaded style.
  if (attribution !== undefined && typeof attribution === 'string') {
    source.attribution = attribution;
  } else if (typeof source.attribution !== 'string') {
    if (attribution !== undefined) {
      console.warn(
        `updateStyle(): "attribution" must be a string, got ${typeof attribution} ` +
          `(${JSON.stringify(attribution)}). Falling back to default attribution. ` +
          `Check the call site — arguments may be shifted/mismatched.`
      );
      source.attribution = defaultAttribution;
    } else {
      delete source.attribution;
    }
  }

  if (center !== undefined) {
    (style as any).center = center;
  }
  if (initialzoom !== undefined) {
    (style as any).zoom = initialzoom;
  }

  if (background !== undefined) {
    style.layers.forEach((layer) => {
      if (layer.type === 'background') {
        layer.paint = { ...layer.paint, 'background-color': background };
      }
    });
  }

  // Always strip any pre-existing "glyphs" URL from the loaded style — it
  // may point to a third-party service (MapTiler, Mapbox, etc.) with an
  // unresolved API-key placeholder or one that's blocked by CSP. Text
  // rendering relies entirely on locally loaded web fonts instead.
  if ('glyphs' in style) {
    delete (style as any).glyphs;
  }

  if (style.sprite !== undefined) {
    style.sprite = sprites === undefined ? undefined : sprites;
  }

  if (style.metadata) {
    Object.keys(style.metadata as Record<string, unknown>).forEach((key) => {
      if (key.startsWith('mapbox') || key.startsWith('openmaptiles')) {
        delete (style.metadata as Record<string, unknown>)[key];
      }
    });
  }

  // `font` here must be a font-family name that actually exists via a CSS
  // @font-face rule loaded through `fontPath`, NOT a glyphs fontstack name.
  if (font !== undefined) {
    style.layers.forEach((layer) => {
      if (layer.type === 'symbol' && layer.layout && 'text-font' in layer.layout) {
        const textFont = (layer.layout as any)['text-font'];
        if (Array.isArray(textFont)) {
          textFont[0] = font;
        }
      }
    });
  }

  // Stash the CSS template on metadata so callers (projektemacherMap) can
  // retrieve it after updateStyle() without needing a separate parameter
  // threaded through every call site.
  (style as any).metadata = {
    ...(style.metadata as object | undefined),
    'projektemacher:fontPath': fontPath ?? defaultFontsCssTemplate,
  };

  style.sources[sourceKey] = source as VectorSourceSpecification;
  return style;
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
    attribution = undefined;
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
  map.addControl(new AttributionControl({ compact: true, customAttribution: attribution }));

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
        // Query all features within a small tolerance around the click
        // point (not just the topmost one) so overlapping markers can be
        // merged into a single popup, matching the original OpenLayers
        // behavior of combining multiple point features at the same
        // location into one popup instead of showing only the topmost.
        const bufferedBox: [[number, number], [number, number]] = [
          [e.point.x - popupHitTolerance, e.point.y - popupHitTolerance],
          [e.point.x + popupHitTolerance, e.point.y + popupHitTolerance],
        ];
        const features = map.queryRenderedFeatures(bufferedBox, { layers: clickableLayers });
        if (features.length === 0) return;

        // If any cluster feature is among the hits, expand the cluster
        // instead of showing a popup.
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

        // Merge all remaining (non-cluster) point features at this
        // location into a single popup.
        const merged = mergeFeatureProperties(features);
        const lngLat = (features[0].geometry as any).coordinates as LngLatLike;
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
