import {Map, View} from 'ol';
import GeoJSON from 'ol/format/GeoJSON.js';
import VectorSource from 'ol/source/Vector.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorTileLayer from 'ol/layer/VectorTile.js';
import VectorTileSource from 'ol/source/VectorTile.js';
import TileLayer from 'ol/layer/Tile.js';
import {TileDebug} from 'ol/source.js';
import MVT from 'ol/format/MVT';
import {boundingExtent, getCenter} from 'ol/extent';
import {fromLonLat} from 'ol/proj';
import {apply, applyStyle} from 'ol-mapbox-style';
import {debugStyle, setupDefaultStyle} from './projektemacher-default-map-style';
import {toolTips, defaultPadding, getLang, addOverlay, absUrl, bboxExtent, loadOrParse, setupMarker, featurePopUp} from './base-map';
import {center as turf_center} from '@turf/turf';
import {Control, FullScreen, Zoom, MousePosition} from 'ol/control';
import {Circle as CircleStyle, RegularShape, Style, Fill, Stroke, Text, Icon} from 'ol/style.js';

const defaultSprites = "/map-styles/sprite";
const defaultFonts = "css/{font-family}.css";

function geoJSONVectorSource(geojson) {
  var parser = new GeoJSON({dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});

  var vectorSource = new VectorSource({
    features: parser.readFeatures(geojson)
  });
  return vectorSource
}

export async function getMapMetadata(url) {
  const metadataFile = "metadata.json";
  if (url.includes("{")) {
    url = url.substring(0, url.indexOf("{"));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith('/')) {
    url += '/' + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url);
}

function checkMapboxStyle(style) {
  if (style.version !== undefined && style.sources !== undefined && style.sources.vector_layer_ !== undefined) {
    return true;
  }
  return false;
}

function updateStyle(style, url, initialzoom, minzoom, maxzoom, bounds, center, background, sprites, fontPath, font) {
  const sourceKey = Object.keys(style.sources)[0]
  const source = style.sources[sourceKey]

  source.tiles = [url];
  if ("url" in source) {
    delete source.url
  }

  if (minzoom !== undefined) {
    source["minzoom"] = minzoom;
  }
  if (maxzoom !== undefined) {
    source["maxzoom"] = maxzoom;
  }
  if (bounds !== undefined) {
    bounds = bounds.flat().map(e => { return Number(e) });
    source["bounds"] = bounds
  }
  if (center !== undefined) {
    style.center = center;
  }

  if (background !== undefined) {
    style.layers.forEach(layer => {
      if ("type" in layer && layer.type === "background") {
        layer.paint["background-color"] = background;
      }
    });
  }

  if (fontPath !== undefined) {
    style["ol:webfonts"] = fontPath;
  } else {
    style["ol:webfonts"] = defaultFonts;
  }
  if (initialzoom !== undefined) {
    style.zoom = initialzoom;
  }

  if ("glyphs" in style) {
    delete style.glyphs;
  }

  if ("sprite" in style) {
    if (sprites === undefined) {
      //delete style.sprite;
      style.sprite = null;
    } else {
      style.sprite = sprites;
    }
  }
  Object.keys(style.metadata).forEach(key => {
    if (key.startsWith("mapbox") || key.startsWith("openmaptiles")) {
      delete style.metadata[key]
    }
  });

  if (font !== undefined) {
    style.layers.forEach(layer => {
      if (layer.type == "symbol") {
        if ("text-font" in layer.layout) {
          if (Array.isArray(layer.layout["text-font"])) {
            layer.layout["text-font"][0] = font;
          } else if (typeof layer.layout["text-font"] === 'object') {
            if ("stops" in layer.layout["text-font"]) {
              layer.layout["text-font"].stops.forEach(stop => {
                stop.forEach(s => {
                  if (Array.isArray(s)) {
                    s[0] = font;
                  }
                });
              });
            }
          }
        }
      }
    });
  }


  style.sources[sourceKey] = source
  return style
}

export async function projektemacherMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker, font) {

  var geojsonObj, styleObj, bboxObj, bboxObj, centerObj, markerObj;
  const lang = getLang();
  source = absUrl(source);

  geojsonObj = await loadOrParse(geojson);
  if (bbox !== undefined) {
    bboxObj = await loadOrParse(bbox);
    if (bboxObj.length == 4) {
      bboxObj = [[bboxObj[0], bboxObj[1]], [bboxObj[2], bboxObj[3]]];
    }
  }

  if (center !== undefined) {
    centerObj = await loadOrParse(center);
  } else {
    if (geojsonObj !== undefined && geojsonObj.features.length !== 0) {
      centerObj = turf_center(geojsonObj).geometry.coordinates;
    } else if (bboxObj !== undefined && bboxObj.length !== 0) {
      centerObj = getCenter(boundingExtent(bboxObj));
    } else {
      console.warn("Can't create center from features or bbox")
      centerObj = [0, 0]
    }
  }
  if (marker !== undefined) {
    var markerObj = await loadOrParse(marker);
  }

  if (maxZoom === undefined) {
    maxZoom = 16;
  }
  if (bbox === undefined || Object.keys(bboxObj).length === 0) {
    bboxObj = [[-180, -85.051129] ,[180, 85.051129]];
  }
  if (cluster !== undefined && cluster !== false) {
    throw new Error("Clustering isn't implemented for this type of map yet!");
  }

  // Disabled should also stop popups
  if (disabled === undefined ) {
    disabled = false;
  }
  if (popup === undefined && !disabled) {
    popup = true;
  }

  if (debug === undefined) {
    debug = false;
  }

  if (initialZoom === undefined) {
    initialZoom = 0;
  }
  var viewConfig = {
    center: fromLonLat(centerObj),
    projection: 'EPSG:3857',
    zoom: initialZoom
  }

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
    styleObj = await loadOrParse(style)
    styleObj = updateStyle(styleObj, source, initialZoom, undefined, undefined, bboxObj, centerObj, background, absUrl(defaultSprites), defaultFonts, font);
  } else {
    styleObj = setupDefaultStyle(source, initialZoom, minZoom, maxZoom, bboxObj, centerObj, background);
  }

  view = new View(viewConfig);
  const layers = [];
  var geojsonSource = geoJSONVectorSource(geojsonObj);

  let controls = {controls: []};
  if (disabled) {
    controls["interactions"] = [];
  } else {
    controls.controls = [new Zoom({zoomInTipLabel: toolTips[lang]['zoomIn'], zoomOutTipLabel: toolTips[lang]['zoomOut']}),
      new FullScreen({tipLabel: toolTips[lang]['fullscreen']})]
  }

  if (debug) {
    console.log(`Adding map on ${elem}, with '${JSON.stringify(geojsonObj)}', from '${source}', style ${style}: options cluster '${cluster}', marker '${JSON.stringify(markerObj)}', bbox '${bbox}', center '${center}', initialZoom '${initialZoom}', min zoom '${minZoom}', max zoom '${maxZoom}', popup '${popup}', disabled '${disabled}'  - debug '${debug}'`);
    controls.controls.push(new MousePosition());
    console.log("Active style", styleObj)
    const debugLayer = new TileLayer({
      source: new TileDebug({'zDirection': 1, 'template': '{z}/{x}/{y}'}),
    });
    layers.push(debugLayer);
  }

  const geojsonLayer = new VectorLayer({
    source: geojsonSource
  })
  if (markerObj !== undefined) {
    setupMarker(marker, geojsonLayer);
  }
  layers.push(geojsonLayer);

  const map = new Map({
    //layers: layers,
    target: elem,
    view: view,
    ...controls
  });

  const mapMetadata = await getMapMetadata(source);

  var vectorTileLayer;
  if (styleObj !== undefined) {
    //applyStyle(vectorTileLayer, styleObj);

    //map.addLayer(vectorTileLayer);
    apply(map, styleObj);
    //console.log(styleObj)
  } else {
    let bounds = bboxExtent(mapMetadata.bounds);
    vectorTileLayer = new VectorTileLayer({
      extend: bounds,
      maxZoom: maxZoom,
      source: new VectorTileSource({
        format: new MVT(),
        url: source,
        extent: bounds
      }),
      style: debugStyle
    });
    applyStyle(vectorTileLayer, styleObj);

    map.addLayer(vectorTileLayer);
  }

  layers.forEach(layer => {map.addLayer(layer)});

  if (geojson !== undefined) {
    const markerOptions = {hitTolerance: 10};
    if (!disabled && popup) {
      const overlay = addOverlay(map, markerOptions);
    }

    if (geojsonObj.features.length) {
      map.getView().fit(geojsonLayer.getSource().getExtent(),
          {size: map.getSize(), padding: defaultPadding}
      );
    }
  }

  map.updateSize();
  return map;
}

window.projektemacherMap = projektemacherMap;
