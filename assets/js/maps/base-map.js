import Map from 'ol/Map';
import {Tile as TileLayer, Vector as VectorLayer} from 'ol/layer';
import View from 'ol/View';
import GeoJSON from 'ol/format/GeoJSON';
import Overlay from 'ol/Overlay';
import {OSM, XYZ, Cluster, Vector as VectorSource} from 'ol/source';
import {createEmpty, extend, getHeight, getWidth} from 'ol/extent.js';
import {Control, FullScreen, Zoom} from 'ol/control';
import {Circle as CircleStyle, RegularShape, Style, Fill, Stroke, Text, Icon} from 'ol/style.js';


export const toolTips = { 'de': {'zoomIn': 'Vergrößern', 'zoomOut': 'Verkleinern', 'fullscreen': 'Vollbildansicht', 'rotate': 'Rotation zurücksetzen', 'rotateLeft': '90° nach links drehen', 'rotateRight': '90° nach rechst drehen'},
                 'en': {'zoomIn': 'Zoom in', 'zoomOut': 'Zoom out', 'fullscreen': 'Toggle full-screen', 'rotate': 'Reset rotation', 'rotateLeft': 'Rotate 90° left', 'rotateRight': 'Rotate 90° right'}};

export function getLang() {
  var lang = 'en';
  if (document.documentElement.lang !== undefined) {
      /* TODO: Check for lang locale combinations here: "de-de" instead of "de" will currently break this. */
      lang = document.documentElement.lang;
  }
  return lang;
}

export function loadGeoJSON(url) {
  fetch(url)
    .then(function(response) {
      response.json()
      .then(function(geojson) {
        // See https://openlayers.org/en/latest/examples/geojson.html

        // See https://gis.stackexchange.com/questions/373285/geojson-doesnt-render-on-map-in-openlayers-project
        var parser = new GeoJSON({dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});

        var vectorSource = new VectorSource({
          features: parser.readFeatures(geojson)
        });
      })
      .catch(function(body) {
        console.log('Could not read GeoJSON. ' + body);
      });
    })
    .catch(function() {
      console.log('Could not read data from URL.');
    });
}

/**
 *  element: DOM element
 *  url: GeoJSON URL (replace with geojson)
 *  source: URL or tile lay name (Replace with OL Source)
 *  cluster: Boolean to cluster
 *  marker: JSON containing marker setup
 */

function setupMap(element, geojson, source, cluster, marker) {

  function featurePopUp(feature) {
    var geometry = feature.getGeometry();
    var coord = geometry.getCoordinates();
    var popup = '<h1>' + feature.get('name') + '</h1>';
    popup += feature.get('popupContent');
    content.innerHTML = popup;
    overlay.setPosition(coord);
  }

  /* Marker style */
  var iconStyle;
  var markerOptions = {};
  if (marker !== undefined && marker) {
    try {
        marker = JSON.parse(marker);
    } catch (e) {
      console.warn(`Can't parse marker ${marker}`);
    }
    iconStyle = new Style({image: new Icon(marker)});
    markerOptions = {hitTolerance: 10};
  }

  function clusterMemberStyle(clusterMember) {
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

  function clusterStyle(feature) {
    const size = feature.get('features').length;
    if (size > 1) {
      if (marker !== undefined && marker) {
        return [
          new Style({image: new Icon(marker)}),
          new Style({
            image: new CircleStyle({radius: 15, displacement: [-10, 25], fill: new Fill({color: 'rgba(255, 255, 255, 0.7)'})}),
            text: new Text({
              text: size.toString(),
              fill: textFill,
              stroke: textStroke,
              offsetY: -25,
              offsetX: -10
            })
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
    const originalFeature = feature.get('features')[0];
    return clusterMemberStyle(originalFeature);
  }

  function mergeFeatures (featureArray) {
    //console.log(featureArray);

    var title = "";
    var popupContent = "";

    featureArray.forEach(feature => {
      title += feature.get("title") + ", ";
      popupContent += feature.get("popupContent");
    });

    featureArray[0].set("title", title);
    featureArray[0].set("popupContent", popupContent);

    return featureArray[0];
  }

  // Languages
  var lang = 'en';
  if (document.documentElement.lang !== undefined) {
      /* TODO: Check for lang locale combinations here: "de-de" instead of "de" will currently break this. */
      lang = document.documentElement.lang;
  }


  var padding = [30, 30, 30, 30];



  /* Cluster coloring*/
  const outerCircleFill = new Fill({color: 'rgba(255, 255, 255, 0.7)'});
  const innerCircleFill = new Fill({color: 'rgba(255, 255, 255, 0.3)'});
  const innerCircle = new CircleStyle({radius: 8, fill: innerCircleFill, stroke: new Stroke({color: 'rgba(51, 153, 204, 0.7)', width: 1.25})});
  const outerCircle = new CircleStyle({radius: 15, fill: outerCircleFill, stroke: new Stroke({color: 'rgba(51, 153, 204, 0.3)', width: 1.25})});
  const textFill = new Fill({color: '#fff'});
  const textStroke = new Stroke({color: 'rgba(0, 0, 0, 0.6)', width: 3});


    // Base layer
    var baseLayer;
    if (source !== undefined && source !== '') {
      baseLayer = source;
    } else {
      console.error("baseLayer not set!");
    }

    // Popup elements
    var container = document.getElementById(element + '-popup');
    var content = document.getElementById(element + '-popup-content');
    var closer = document.getElementById(element + '-popup-closer');

    var map = new Map({
            controls: [new Zoom({zoomInTipLabel: toolTips[lang]['zoomIn'], zoomOutTipLabel: toolTips[lang]['zoomOut']}),
                       new FullScreen({tipLabel: toolTips[lang]['fullscreen']})],
            layers: [baseLayer],
            target: element,
        }),


    overlay = new Overlay({
        element: container,
        autoPan: true,
        autoPanAnimation: {
            duration: 250
        }
    });

    map.addOverlay(overlay);


    closer.onclick = function() {
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
                    var parser = new GeoJSON({dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'});

                    var vectorSource = new VectorSource({
                        features: parser.readFeatures(geojson)
                    });

                    var vectorLayer;
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
                            const clusterMembers = features[0].get('features');
                            if (clusterMembers.length > 1) {
                              // Calculate the extent of the cluster members.
                              const extent = createEmpty();
                              clusterMembers.forEach((feature) =>
                                extend(extent, feature.getGeometry().getExtent()),
                              );
                              const view = map.getView();
                              const resolution = map.getView().getResolution();
                              if (
                                view.getZoom() === view.getMaxZoom() ||
                                (getWidth(extent) < resolution && getHeight(extent) < resolution)
                              ) {
                                // Show an expanded view of the cluster members.
                                if (features[0].get('features').length == 1) {
                                  clickFeature = features[0];
                                } else {
                                  clickFeature = mergeFeatures(features[0].get('features'));
                                }
                                featurePopUp(clickFeature);
                                clickResolution = resolution;
                                //TODO: check for what this is needed
                                //clusterCircles.setStyle(clusterCircleStyle);
                              } else {
                                // Zoom to the extent of the cluster members.
                                view.fit(extent, {duration: 500, padding: [50, 50, 50, 50]});
                              }
                            } else if (clusterMembers.length == 1) {
                              clickFeature = clusterMembers[0];
                              featurePopUp(clickFeature);
                            }
                          }
                        });
                      });

                    } else {
                      vectorLayer = new VectorLayer({
                          source: vectorSource
                      });

                      if (iconStyle !== undefined) {
                        vectorLayer.setStyle(iconStyle);
                      }

                      map.on('click', function (event) {
                          var feature = map.forEachFeatureAtPixel(event.pixel,
                              function(feature, layer) {
                                  return feature;
                              }, markerOptions);

                          if (feature) {
                            featurePopUp(feature);
                          }

                      });

                    }
                    vectorLayer.reportError = true;
                    map.addLayer(vectorLayer);

                    map.setView(
                        new View({
                            center: [0, 0],
                            zoom: 2
                        })
                    );

                    map.getView().fit(vectorSource.getExtent(),
                        {size: map.getSize(), padding: padding}
                    );

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
