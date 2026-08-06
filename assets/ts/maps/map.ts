// assets/ts/maps/map.ts

import {
  Map as MapLibreMap,
  NavigationControl,
  FullscreenControl,
  AttributionControl,
  IControl,
  LngLatLike,
  LngLatBoundsLike,
  setWorkerUrl
} from "maplibre-gl";
import { bbox as turfBbox, center as turfCenter } from "@turf/turf";
import { setupDefaultStyle, preloadStyleFonts } from "./styles";
import { updateStyle } from "./never-built-styles";
import { getMaplibreGLLocale } from "./base-map";
import { absUrl, loadOrParse, getMapMetadata } from "./map-utils";
import { addGeoJSONLayersAndInteractions } from "./maplibregl-util";
import type { StyleSpecification, MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection, GeoJSON } from "geojson";
import type { MarkerOptions } from "./map-utils";

setWorkerUrl("/js/maplibre-gl/maplibre-gl-worker.mjs");

/* =========================================================================
 * Shared defaults
 * ========================================================================= */

const defaultSprites = "/map-styles/sprite";

/**
 * CSS template used to dynamically load @font-face rules per font-family
 * name, e.g. "/css/fonts/roboto-mono-variable.css". This is the ORIGINAL
 * "ol:webfonts" concept from the OpenLayers/ol-mapbox-style setup —
 * MapLibre doesn't know about that metadata convention natively, so we
 * replicate the loading behavior ourselves via <link> tags + the Font
 * Loading API.
 */
const defaultFontsCssTemplate = "/css/fonts/{font-family}.css";

const defaultAttribution =
  '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/** Fallback font-family used by the window.projektemacherMap wrapper when
 * no explicit `font` is given. Restored to match the original project
 * default. */
const defaultMapFont = "Roboto Mono Variable";

export const defaultVectorSource =
  "https://static.projektemacher.org/maps/central-europe/tiles/{z}/{x}/{y}.pbf";

export const defaultPadding = 50;

const debug = false;

/**
 * Extends MapLibre's Map type with a legacy OpenLayers-style method for
 * backwards compatibility with external code that hasn't been migrated yet.
 */
interface MaplibreMapWithLegacyShim extends MapLibreMap {
  /** @deprecated Use resize() instead. Kept for legacy call-site compatibility. */
  updateSize?: () => void;
}

/* =========================================================================
 * base-map: tooltips, helpers
 * ========================================================================= */

class MousePositionControl implements IControl {
  private container?: HTMLDivElement;
  private map?: MapLibreMap;
  private onMouseMove = (e: MapMouseEvent) => {
    if (this.container) {
      const { lng, lat } = e.lngLat;
      this.container.textContent = `${lng.toFixed(5)}, ${lat.toFixed(5)}`;
    }
  };

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    this.container = document.createElement("div");
    this.container.className =
      "maplibregl-ctrl maplibregl-ctrl-group mouse-position";
    this.container.style.padding = "0 6px";
    this.container.style.fontSize = "11px";
    map.on("mousemove", this.onMouseMove);
    return this.container;
  }

  onRemove(): void {
    this.map?.off("mousemove", this.onMouseMove);
    this.container?.parentNode?.removeChild(this.container);
    this.map = undefined;
  }
}

/* =========================================================================
 * Core map setup
 * ========================================================================= */


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
  fontPath: string = defaultFontsCssTemplate,
): Promise<MapLibreMap> {
  // Defensive runtime checks — positional-argument mix-ups are easy with
  // this many parameters.
  if (attribution !== undefined && typeof attribution !== "string") {
    console.error(
      `projektemacherMap(): "attribution" argument must be a string, received ` +
        `${typeof attribution} (${JSON.stringify(attribution)}). Check the call site — ` +
        `arguments may be shifted/mismatched. Ignoring this value.`,
    );
    attribution = defaultAttribution;
  }
  if (font !== undefined && typeof font !== "string") {
    console.error(
      `projektemacherMap(): "font" argument must be a string, received ${typeof font}. ` +
        `Check the call site. Ignoring this value.`,
    );
    font = undefined;
  }

  source = absUrl(source as string);

  const geojsonObj = (await loadOrParse(geojson as string)) as
    FeatureCollection | undefined;

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
    centerObj = turfCenter(geojsonObj as GeoJSON).geometry.coordinates as [
      number,
      number,
    ];
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
    console.warn(
      "Clustering combined with custom point markers is only partially supported.",
    );
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
      attribution,
    );
  } else {
    styleObj = setupDefaultStyle(
      source,
      initialZoom,
      minZoom,
      maxZoom,
      bboxObj,
      centerObj,
      background,
    );
  }

  if (debug) {
    console.log(styleObj);
  }
  // Preload every web font referenced by the style's symbol layers BEFORE
  // creating the map, so text renders correctly from the first frame
  // instead of relying on MapLibre's per-glyph local-render fallback.
  const resolvedFontPath =
    ((styleObj.metadata as Record<string, unknown> | undefined)?.[
      "projektemacher:fontPath"
    ] as string | undefined) ?? fontPath;
  await preloadStyleFonts(styleObj, resolvedFontPath);

  const map = new MapLibreMap({
    container: elem,
    style: styleObj,
    center: centerObj,
    zoom: initialZoom,
    minZoom,
    maxZoom,
    maxBounds: bboxObj ? (bboxObj as LngLatBoundsLike) : undefined,
    attributionControl: false,
    interactive: !disabled,
    locale: getMaplibreGLLocale(),
  });

  if (!disabled) {
    map.addControl(new NavigationControl({}), "top-left");
    map.addControl(new FullscreenControl(), "top-right");
  }
  const attributionControl = new AttributionControl(
    /* { compact: true, customAttribution: attribution }*/
  );
  //attributionControl.onAdd(map).open = false;

  map.addControl(attributionControl);

  if (debug) {
    console.log(
      `Adding map on ${elem}, from '${source}', style ${style}: options cluster '${cluster}', marker '${JSON.stringify(
        marker,
      )}', bbox '${bbox}', center '${center}', initialZoom '${initialZoom}', min zoom '${minZoom}', max zoom '${maxZoom}', popup '${popup}', disabled '${disabled}' - debug '${debug}', fontPath '${resolvedFontPath}'`,
    );
    console.log("Active style", styleObj);
    map.addControl(new MousePositionControl(), "bottom-left");
    map.showTileBoundaries = true;
  }

  await new Promise<void>((resolve) => map.once("load", () => resolve()));

  if (geojsonObj !== undefined) {
    // Add layers and get their names
    const geojsonLayerNames = await addGeoJSONLayersAndInteractions({
      map,
      geojson: geojsonObj,
      cluster,
      marker,
      disabled,
      popup,
    });

    if (debug) {
      console.log("Created GeoJSON Layers:", geojsonLayerNames);
    }

    if (geojsonObj.features.length) {
      const box = turfBbox(geojsonObj as GeoJSON) as [
        number,
        number,
        number,
        number,
      ];
      const geojsonBounds: LngLatBoundsLike = [
        [box[0], box[1]],
        [box[2], box[3]],
      ];
      map.fitBounds(geojsonBounds, { padding: defaultPadding });
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
      font?: string,
    ) => Promise<MapLibreMap>;
    projektemacher: {
      maps: Map<string | HTMLElement, MapLibreMap>;
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
  font?: string,
): Promise<MapLibreMap> {
  let bgElem: HTMLElement | null = null;
  if (typeof elem === "string") {
    bgElem = document.getElementById(elem);
  }
  if (font === undefined) {
    font = defaultMapFont;
  }

  let markerObj: MarkerOptions | undefined;
  if (marker !== undefined) {
    markerObj =
      typeof marker === "object"
        ? marker
        : (JSON.parse(marker) as MarkerOptions);
  }

  background = bgElem
    ? window.getComputedStyle(bgElem).getPropertyValue("--page-background")
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
    font,
  );

  if (!window.projektemacher) {
    window.projektemacher = {
      maps: new Map<string | HTMLElement, MapLibreMap>(),
    };
  }
  if (!window.projektemacher.maps) {
    window.projektemacher.maps = new Map<string | HTMLElement, MapLibreMap>();
  }

  window.projektemacher.maps.set(elem, map);

  return map;
};
