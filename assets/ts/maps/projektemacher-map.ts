import { Map, View } from 'ol';
import { Options as ViewOptions } from 'ol/View';
import Attribution from 'ol/control/Attribution.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import TileLayer from 'ol/layer/Tile.js';
import { TileDebug } from 'ol/source.js';
import MVT from 'ol/format/MVT';
import { boundingExtent, getCenter, Extent } from 'ol/extent';
import { fromLonLat } from 'ol/proj';
import { apply, applyStyle } from 'ol-mapbox-style';
import { debugStyle, setupDefaultStyle } from './projektemacher-default-map-style';
import { updateStyle } from './styles';
import {
  toolTips,
  defaultPadding,
  getLang,
  addOverlay,
  absUrl,
  bboxExtent,
  loadOrParse,
  setupMarker,
  featurePopUp,
} from './base-map';
import { center as turf_center } from '@turf/turf';
import { Control, FullScreen, Zoom, MousePosition } from 'ol/control';
import Feature from 'ol/Feature';
import Geometry from 'ol/geom/Geometry';
import BaseLayer from 'ol/layer/Base';
import { Coordinate } from 'ol/coordinate';
import { StyleLike } from 'ol/style/Style';

const defaultSprites = '/map-styles/sprite';
const defaultFonts = '/css/fonts/{font-family}.css';
const defaultAttribution =
  '&copy; <a href="http://openstreetmap.org/copyright">OpenStreetMap contributors</a>';

interface GeoJSONFeatureCollection {
  type: string;
  features: unknown[];
  [key: string]: unknown;
}

type BBoxInput = number[] | number[][] | string;

function geoJSONVectorSource(
  geojson: GeoJSONFeatureCollection
): VectorSource<Feature<Geometry>> {
  const parser = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

  const vectorSource = new VectorSource({
    features: parser.readFeatures(geojson),
  });
  return vectorSource;
}

interface MapMetadata {
  bounds: BBoxInput;
  [key: string]: unknown;
}

export async function getMapMetadata(url: string): Promise<MapMetadata> {
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
  return loadOrParse(url) as Promise<MapMetadata>;
}

interface MapboxStyleLike {
  version?: number;
  sources?: {
    vector_layer_?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function checkMapboxStyle(style: MapboxStyleLike): boolean {
  if (
    style.version !== undefined &&
    style.sources !== undefined &&
    style.sources.vector_layer_ !== undefined
  ) {
    return true;
  }
  return false;
}

interface ProjektemacherViewOptions extends ViewOptions {
  smoothResolutionConstraint?: boolean;
  smoothExtentConstraint?: boolean;
}

interface MapControlsConfig {
  controls?: Control[];
  interactions?: unknown[];
}

export async function projektemacherMap(
  elem: string | HTMLElement,
  geojson?: string | GeoJSONFeatureCollection,
  source?: string,
  style?: string | object,
  bbox?: string | BBoxInput,
  center?: string | Coordinate,
  initialZoom?: number,
  minZoom?: number,
  maxZoom?: number,
  cluster?: boolean,
  disabled?: boolean,
  popup?: boolean,
  background?: string,
  debug?: boolean,
  marker?: string | object | StyleLike,
  font?: string,
  attribution?: string
): Promise<Map> {
  let geojsonObj: GeoJSONFeatureCollection | undefined;
  let styleObj: any;
  let bboxObj: number[][] | undefined;
  let centerObj: Coordinate | undefined;
  let markerObj: object | StyleLike | undefined;

  const lang = getLang();
  source = absUrl(source as string);

  geojsonObj = (await loadOrParse(geojson as string)) as GeoJSONFeatureCollection;

  if (bbox !== undefined) {
    let rawBbox = (await loadOrParse(bbox as string)) as number[] | number[][];
    if ((rawBbox as number[]).length === 4) {
      const flat = rawBbox as number[];
      bboxObj = [
        [flat[0], flat[1]],
        [flat[2], flat[3]],
      ];
    } else {
      bboxObj = rawBbox as number[][];
    }
  }

  if (center !== undefined) {
    centerObj = (await loadOrParse(center as string)) as Coordinate;
  } else {
    if (geojsonObj !== undefined && geojsonObj.features.length !== 0) {
      centerObj = turf_center(geojsonObj as any).geometry.coordinates as Coordinate;
    } else if (bboxObj !== undefined && bboxObj.length !== 0) {
      centerObj = getCenter(boundingExtent(bboxObj));
    } else {
      console.warn("Can't create center from features or bbox");
      centerObj = [0, 0];
    }
  }

  if (marker !== undefined && !(typeof marker === 'function')) {
    markerObj = (await loadOrParse(marker as string)) as object;
  } else if (marker !== undefined && typeof marker === 'function') {
    markerObj = marker as unknown as StyleLike;
  }

  if (maxZoom === undefined) {
    maxZoom = 16;
  }
  if (bbox === undefined || bboxObj === undefined || Object.keys(bboxObj).length === 0) {
    bboxObj = [
      [-180, -85.051129],
      [180, 85.051129],
    ];
  }
  if (cluster !== undefined && cluster !== false) {
    throw new Error("Clustering isn't implemented for this type of map yet!");
  }

  // Disabled should also stop popups
  if (disabled === undefined) {
    disabled = false;
  }
  if (popup === undefined && !disabled) {
    popup = true;
  }

  if (debug === undefined) {
    debug = false;
  }

  if (attribution === undefined) {
    attribution = defaultAttribution;
  }

  if (initialZoom === undefined) {
    initialZoom = 0;
  }

  const viewConfig: ProjektemacherViewOptions = {
    center: fromLonLat(centerObj as Coordinate),
    projection: 'EPSG:3857',
    zoom: initialZoom,
  };

  if (minZoom !== undefined) {
    viewConfig.minZoom = minZoom;
    viewConfig.smoothResolutionConstraint = false;
  }
  if (maxZoom !== undefined) {
    viewConfig.maxZoom = maxZoom;
    viewConfig.smoothResolutionConstraint = false;
  }
  if (bboxObj !== undefined) {
    viewConfig.smoothExtentConstraint = false;
    viewConfig.extent = bboxExtent(bboxObj);
  }

  if (style !== undefined) {
    styleObj = await loadOrParse(style as string);
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
      defaultFonts,
      font,
      attribution
    );
  } else {
    styleObj = setupDefaultStyle(source, initialZoom, minZoom, maxZoom, bboxObj, centerObj, background);
  }

  const view = new View(viewConfig);
  const layers: BaseLayer[] = [];
  const geojsonSource = geoJSONVectorSource(geojsonObj);

  const controls: MapControlsConfig = {
    controls: [
      new Attribution({
        collapsible: false,
      }),
    ],
  };
  if (disabled) {
    controls.interactions = [];
  } else {
    controls.controls = [
      new Zoom({
        zoomInTipLabel: toolTips[lang]['zoomIn'],
        zoomOutTipLabel: toolTips[lang]['zoomOut'],
      }),
      new FullScreen({ tipLabel: toolTips[lang]['fullscreen'] }),
      new Attribution({ collapsible: true }),
    ];
  }

  if (debug) {
    console.log(
      `Adding map on ${elem}, with '${JSON.stringify(geojsonObj)}', from '${source}', style ${style}: options cluster '${cluster}', marker '${JSON.stringify(
        markerObj
      )}', bbox '${bbox}', center '${center}', initialZoom '${initialZoom}', min zoom '${minZoom}', max zoom '${maxZoom}', popup '${popup}', disabled '${disabled}'  - debug '${debug}'`
    );
    controls.controls!.push(new MousePosition());
    console.log('Active style', styleObj);
    const debugLayer = new TileLayer({
      source: new TileDebug({ zDirection: 1, template: '{z}/{x}/{y}' } as any),
    });
    layers.push(debugLayer);
  }

  const geojsonLayer = new VectorLayer({
    source: geojsonSource,
  });
  if (markerObj !== undefined) {
    if (!(typeof marker === 'function')) {
      setupMarker(markerObj as any, geojsonLayer as any);
    } else {
      geojsonLayer.setStyle(markerObj as StyleLike);
    }
  }
  layers.push(geojsonLayer);

  const map = new Map({
    //layers: layers,
    target: elem,
    view: view,
    ...controls,
  });

  const mapMetadata = await getMapMetadata(source);

  let vectorTileLayer: VectorTileLayer | undefined;
  if (styleObj !== undefined) {
    apply(map, styleObj);
  } else {
    const bounds = bboxExtent(mapMetadata.bounds as BBoxInput);
    vectorTileLayer = new VectorTileLayer({
      // NOTE: "extend" is not a valid VectorTileLayer option (likely meant "extent"); preserved from original.
      extend: bounds,
      maxZoom: maxZoom,
      source: new VectorTileSource({
        format: new MVT(),
        url: source,
        extent: bounds,
      }),
      style: debugStyle,
    } as any);
    applyStyle(vectorTileLayer, styleObj);

    map.addLayer(vectorTileLayer);
  }

  layers.forEach((layer) => {
    map.addLayer(layer);
  });

  if (geojson !== undefined) {
    const markerOptions = { hitTolerance: 10 };
    if (!disabled && popup) {
      const overlay = addOverlay(map, markerOptions);
    }

    if (geojsonObj.features.length) {
      const extent = geojsonLayer.getSource()?.getExtent() as Extent;
      map.getView().fit(extent, { size: map.getSize(), padding: defaultPadding });
    }
  }

  map.updateSize();
  return map;
}

//window.projektemacherMap = projektemacherMap;
