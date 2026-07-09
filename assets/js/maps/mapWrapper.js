import { projektemacherMap } from './projektemacher-map';
import {Style, Fill, Stroke, Icon} from 'ol/style.js';

const defaultMapFont = "Roboto Mono Variable";

window.projektemacherMap = async function(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker, font) {
  var bgElem;
  if (typeof elem === "string") {
    bgElem = document.getElementById(elem)
  }
  if (font === undefined) {
    font = defaultMapFont;
  }
  if (!(typeof marker === 'object')) {
    marker = JSON.parse(marker)
  }
  function createStyleFunction(marker) {
    return (feature, level) => {
      const lineWidth = Math.floor(50 / level)
      return [new Style({
          image: new Icon(marker)
        }),
        new Style({
          stroke: new Stroke({
            color: 'rgba(0,0,0,1)',
            width: lineWidth + 4
          }),
        }),
        new Style({
          stroke: new Stroke({
            color: 'rgba(255,255,255,1)',
            width: lineWidth
          })
        })]
    };
  }
  background = window.getComputedStyle(bgElem).getPropertyValue('--page-background');
  const map = projektemacherMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, createStyleFunction(marker), font);

  if (!("projektemacher" in window)) {
    window.projektemacher = {};
  }
  if (!("maps" in window.projektemacher)) {
    window.projektemacher.maps = {};
  }
  window.projektemacher.maps[bgElem] = await map

  return map
}
