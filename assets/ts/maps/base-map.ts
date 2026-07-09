import Map from 'ol/Map';
import BaseLayer from 'ol/layer/Base';
import { Tile as TileLayer, Vector as VectorLayer } from 'ol/layer';
import View from 'ol/View';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import { fromLonLat } from 'ol/proj';
import { OSM, XYZ, Cluster, Vector as VectorSource } from 'ol/source';
import { createEmpty, extend, getHeight, getWidth, Extent } from 'ol/extent.js';
import { Control, FullScreen, Zoom } from 'ol/control';
import {
  Circle as CircleStyle,
  RegularShape,
  Style,
  Fill,
  Stroke,
  Text,
  Icon,
} from 'ol/style.js';
import Feature from 'ol/Feature';
import Geometry from 'ol/geom/Geometry';
import { Coordinate } from 'ol/coordinate';
import { Options as IconOptions } from 'ol/style/Icon';

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

export const defaultVectorSource =
  'https://static.projektemacher.org/maps/central-europe/tiles/{z}/{x}/{y}.pbf';

export const defaultPadding: [number, number, number, number] = [50, 50, 50, 50];

export function getLang(): string {
  let lang = 'en';
  if (document.documentElement.lang !== undefined) {
    /* TODO: Check for lang locale combinations here: "de-de" instead of "de" will currently break this. */
    lang = document.documentElement.lang;
  }
  return lang;
}

export function bboxExtent(bbox: string | (string | number)[]): Extent {
  let bboxArr: (string | number)[];
  if (typeof bbox === 'string') {
    bboxArr = bbox.split(',');
  } else {
    bboxArr = bbox;
  }
  const stringBbox: string[] = bboxArr.flat().map((e) => e.toString());
  // NOTE: fromLonLat expects numeric Coordinate; original code passed strings here.
  const lowerLeft = fromLonLat([
    Number(stringBbox[0]),
    Number(stringBbox[1]),
  ] as Coordinate);
  const upperRight = fromLonLat([
    Number(stringBbox[2]),
    Number(stringBbox[3]),
  ] as Coordinate);
  return lowerLeft.concat(upperRight);
}

export function absUrl(url: string): string {
  if (url.startsWith('http') || url.startsWith('//')) {
    return url;
  } else {
    let base = window.location.protocol + '//' + window.location.hostname;
    if (window.location.port !== '') {
      base += ':' + window.location.port;
    }
    return base + url;
  }
}

export function loadOrParse(str: string | object): object | Promise<object | void> {
  let obj: object | Promise<object | void>;
  if (typeof str === 'object') {
    return str;
  }
  try {
    // BUG (preserved from original): `json` is never defined/passed to this function.
    // This will throw a ReferenceError at runtime if this branch is reached.
    obj = JSON.parse((globalThis as any).json);
  } catch (e) {
    obj = fetch(str)
      .then((response) => response.json())
      .catch(function (body) {
        console.log(`Could not read JSON from ${str}` + body);
      })
      .catch(function () {
        console.log(`Could not read data from URL ${str}`);
      });
  }
  return obj;
}

export function loadGeoJSON(url: string): void {
  fetch(url)
    .then(function (response) {
      response
        .json()
        .then(function (geojson) {
          // See https://openlayers.org/en/latest/examples/geojson.html

          // See https://gis.stackexchange.com/questions/373285/geojson-doesnt-render-on-map-in-openlayers-project
          const parser = new GeoJSON({
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
          });

          const vectorSource = new VectorSource({
            features: parser.readFeatures(geojson),
          });
        })
        .catch(function (body) {
          console.log('Could not read GeoJSON. ' + body);
        });
    })
    .catch(function () {
      console.log('Could not read data from URL.');
    });
}

function mergeFeatures(featureArray: Feature<Geometry>[]): Feature<Geometry> {
  let title = '';
  let popupContent = '';

  featureArray.forEach((feature) => {
    if (feature.get('title') !== undefined) {
      title += feature.get('title') + ', ';
    }
    if (feature.get('popupContent') !== undefined) {
      popupContent += feature.get('popupContent');
    }
  });

  featureArray[0].set('title', title);
  featureArray[0].set('popupContent', popupContent);

  return featureArray[0];
}

export function addOverlay(map: Map, markerOptions?: IconOptions): Overlay {
  const target = map.getTargetElement();
  const container = target?.parentElement?.querySelector('.ol-popup') as HTMLElement;
  const content = container.querySelector('.ol-popup-content') as HTMLElement;
  const closer = container.querySelector('.ol-popup-closer') as HTMLElement;

  function featurePopUpLocal(feature: Feature<Geometry>, overlay: Overlay) {
    const geometry = feature.getGeometry();
    const coord = geometry?.getCoordinates?.();
    let popup = '<h1>' + feature.get('name') + '</h1>';
    popup += feature.get('popupContent');
    content.innerHTML = popup;
    overlay.setPosition(coord);
  }

  const overlay = new Overlay({
    element: container,
    autoPan: true,
    autoPanAnimation: {
      duration: 250,
    },
  });

  map.addOverlay(overlay);

  map.on('singleclick', function (event) {
    const features = map.getFeaturesAtPixel(event.pixel) as Feature<Geometry>[];
    let feature: Feature<Geometry> | undefined;
    if (features.length > 1) {
      feature = mergeFeatures(features);
    } else {
      feature = features[0];
    }
    if (feature && 'geometry' in feature.getProperties()) {
      featurePopUpLocal(feature, overlay);
    }
  });

  closer.onclick = function () {
    overlay.setPosition(undefined);
    closer.blur();
    return false;
  };
  return overlay;
}

export function featurePopUp(
  feature: Feature<Geometry>,
  overlay: Overlay,
  content: HTMLElement
): void {
  const geometry = feature.getGeometry();
  const coord = geometry?.getCoordinates?.();
  let popup = '<h1>' + feature.get('name') + '</h1>';
  popup += feature.get('popupContent');
  content.innerHTML = popup;
  overlay.setPosition(coord);
}

export function setupMarker(
  marker: IconOptions | undefined,
  layer: VectorLayer<VectorSource<Feature<Geometry>>>
): VectorLayer<VectorSource<Feature<Geometry>>> | undefined {
  /* Marker style */
  if (marker !== undefined && marker) {
    const iconStyle = new Style({ image: new Icon(marker) });
    layer.setStyle(iconStyle);
    return layer;
  }
}

/**
 *  element: DOM element id
 *  geojson: GeoJSON object (parsed)
 *  source: Base layer (TileLayer or VectorLayer)
 *  cluster: Boolean to cluster
 *  marker: JSON containing marker setup
 */

function setupMap(
  element: string,
  geojson: object,
  source: BaseLayer | undefined,
  cluster: boolean | undefined,
  marker: IconOptions | undefined
): Map {
  function clusterMemberStyle(clusterMember: Feature<Geometry>): Style {
    if (marker !== undefined && marker) {
      return new Style({
        geometry: clusterMember.getGeometry(),
        image: new Icon(marker),
      });
    } else {
      return new Style({
        geometry: clusterMember.getGeometry(),
        image: innerCircle,
      });
    }
  }

  function clusterStyle(feature: Feature<Geometry>): Style | Style[] {
    const size = (feature.get('features') as Feature<Geometry>[]).length;
    if (size > 1) {
      if (marker !== undefined && marker) {
        return [
          new Style({ image: new Icon(marker) }),
          new Style({
            image: new CircleStyle({
              radius: 15,
              displacement: [-10, 25],
              fill: new Fill({ color: 'rgba(255, 255, 255, 0.7)' }),
            }),
            text: new Text({
              text: size.toString(),
              fill: textFill,
              stroke: textStroke,
              offsetY: -25,
              offsetX: -10,
            }),
          }),
        ];
      } else {
        return [
          new Style({
            image: outerCircle,
          }),
          new Style({
            image: innerCircle,
            text: new Text({
              text: size.toString(),
              fill: textFill,
              stroke: textStroke,
            }),
          }),
        ];
      }
    }
    const originalFeature = (feature.get('features') as Feature<Geometry>[])[0];
    return clusterMemberStyle(originalFeature);
  }

  function mergeFeaturesLocal(featureArray: Feature<Geometry>[]): Feature<Geometry> {
    let title = '';
    let popupContent = '';

    featureArray.forEach((feature) => {
      title += feature.get('title') + ', ';
      popupContent += feature.get('popupContent');
    });

    featureArray[0].set('title', title);
    featureArray[0].set('popupContent', popupContent);

    return featureArray[0];
  }

  // Languages
  let lang: string = 'en';
  if (document.documentElement.lang !== undefined) {
    /* TODO: Check for lang locale combinations here: "de-de" instead of "de" will currently break this. */
    lang = document.documentElement.lang;
  }
  const langKey = (lang in toolTips ? lang : 'en') as Lang;

  const padding: [number, number, number, number] = [30, 30, 30, 30];

  /* Cluster coloring*/
  const outerCircleFill = new Fill({ color: 'rgba(255, 255, 255, 0.7)' });
  const innerCircleFill = new Fill({ color: 'rgba(255, 255, 255, 0.3)' });
  const innerCircle = new CircleStyle({
    radius: 8,
    fill: innerCircleFill,
    stroke: new Stroke({ color: 'rgba(51, 153, 204, 0.7)', width: 1.25 }),
  });
  const outerCircle = new CircleStyle({
    radius: 15,
    fill: outerCircleFill,
    stroke: new Stroke({ color: 'rgba(51, 153, 204, 0.3)', width: 1.25 }),
  });
  const textFill = new Fill({ color: '#fff' });
  const textStroke = new Stroke({ color: 'rgba(0, 0, 0, 0.6)', width: 3 });

  // Base layer
  let baseLayer: BaseLayer;
  if (source !== undefined) {
    baseLayer = source;
  } else {
    console.error('baseLayer not set!');
    baseLayer = new TileLayer({ source: new OSM() });
  }

  // Popup elements
  const container = document.getElementById(element + '-popup') as HTMLElement;
  const content = document.getElementById(element + '-popup-content') as HTMLElement;
  const closer = document.getElementById(element + '-popup-closer') as HTMLElement;

  const map = new Map({
    controls: [
      new Zoom({
        zoomInTipLabel: toolTips[langKey].zoomIn,
        zoomOutTipLabel: toolTips[langKey].zoomOut,
      }),
      new FullScreen({ tipLabel: toolTips[langKey].fullscreen }),
    ],
    layers: [baseLayer],
    target: element,
  });

  const overlay = new Overlay({
    element: container,
    autoPan: true,
    autoPanAnimation: {
      duration: 250,
    },
  });

  map.addOverlay(overlay);

  closer.onclick = function () {
    overlay.setPosition(undefined);
    closer.blur();
    return false;
  };

  /*
      fetch(url)
          .then(function(response) {
              response
                  .json()
                  .then(function(geojson) {
  */

  // See https://openlayers.org/en/latest/examples/geojson.html

  // See https://gis.stackexchange.com/questions/373285/geojson-doesnt-render-on-map-in-openlayers-project
  const parser = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

  const vectorSource = new VectorSource({
    features: parser.readFeatures(geojson),
  });

  let vectorLayer: VectorLayer<VectorSource<Feature<Geometry>>>;

  // BUG (preserved from original): `clickFeature`, `clickResolution`, `iconStyle`,
  // and `markerOptions` are referenced below but never declared in this function scope.
  // Declaring them here to allow compilation; behavior may need review.
  let clickFeature: Feature<Geometry> | undefined;
  let clickResolution: number | undefined;
  let iconStyle: Style | undefined;
  const markerOptions: any = undefined;

  if (cluster !== undefined && cluster) {
    // See https://openlayers.org/en/latest/examples/clusters-dynamic.html
    const clusterSource = new Cluster({
      distance: 25,
      source: vectorSource,
    });

    vectorLayer = new VectorLayer({
      source: clusterSource,
      style: clusterStyle,
    });

    map.on('click', (event) => {
      vectorLayer.getFeatures(event.pixel).then((features) => {
        if (features.length > 0) {
          const clusterMembers = features[0].get('features') as Feature<Geometry>[];
          if (clusterMembers.length > 1) {
            // Calculate the extent of the cluster members.
            const extent = createEmpty();
            clusterMembers.forEach((feature) =>
              extend(extent, feature.getGeometry()!.getExtent())
            );
            const view = map.getView();
            const resolution = map.getView().getResolution() as number;
            if (
              view.getZoom() === view.getMaxZoom() ||
              (getWidth(extent) < resolution && getHeight(extent) < resolution)
            ) {
              // Show an expanded view of the cluster members.
              if (clusterMembers.length === 1) {
                clickFeature = features[0];
              } else {
                clickFeature = mergeFeaturesLocal(clusterMembers);
              }
              if (clickFeature) {
                featurePopUp(clickFeature, overlay, content);
              }
              clickResolution = resolution;
              //TODO: check for what this is needed
              //clusterCircles.setStyle(clusterCircleStyle);
            } else {
              // Zoom to the extent of the cluster members.
              view.fit(extent, { duration: 500, padding: [50, 50, 50, 50] });
            }
          } else if (clusterMembers.length === 1) {
            clickFeature = clusterMembers[0];
            featurePopUp(clickFeature, overlay, content);
          }
        }
      });
    });
  } else {
    vectorLayer = new VectorLayer({
      source: vectorSource,
    });

    if (iconStyle !== undefined) {
      vectorLayer.setStyle(iconStyle);
    }

    map.on('click', function (event) {
      const feature = map.forEachFeatureAtPixel(
        event.pixel,
        function (feature) {
          return feature as Feature<Geometry>;
        },
        markerOptions
      );

      if (feature) {
        featurePopUp(feature, overlay, content);
      }
    });
  }
  (vectorLayer as any).reportError = true;
  map.addLayer(vectorLayer);

  map.setView(
    new View({
      center: [0, 0],
      zoom: 2,
    })
  );

  map.getView().fit(vectorSource.getExtent(), {
    size: map.getSize(),
    padding: padding,
  });

  /*
                  })
                  .catch(function(body) {
                      console.log('Could not read GeoJSON. ' + body);
                  });
          })
          .catch(function() {
              console.log('Could not read data from URL.');
          });
          */
  return map;
}
