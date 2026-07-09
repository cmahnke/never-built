import { projektemacherMap } from './projektemacher-map';
import { Style, Fill, Stroke, Icon } from 'ol/style.js';
import { StyleFunction } from 'ol/style/Style';
import Feature from 'ol/Feature';
import Geometry from 'ol/geom/Geometry';
import { Options as IconOptions } from 'ol/style/Icon';
import Map from 'ol/Map';

const defaultMapFont = 'Roboto Mono Variable';

declare global {
  interface Window {
    projektemacherMap: (
      elem: string | HTMLElement,
      geojson?: string | object,
      source?: string,
      style?: string | object,
      bbox?: string | number[] | number[][],
      center?: string | number[],
      initialZoom?: number,
      minZoom?: number,
      maxZoom?: number,
      cluster?: boolean,
      disabled?: boolean,
      popup?: boolean,
      background?: string,
      debug?: boolean,
      marker?: string | IconOptions,
      font?: string
    ) => Promise<Map>;
    projektemacher: {
      maps: Record<string, Map>;
    };
  }
}

window.projektemacherMap = async function (
  elem: string | HTMLElement,
  geojson?: string | object,
  source?: string,
  style?: string | object,
  bbox?: string | number[] | number[][],
  center?: string | number[],
  initialZoom?: number,
  minZoom?: number,
  maxZoom?: number,
  cluster?: boolean,
  disabled?: boolean,
  popup?: boolean,
  background?: string,
  debug?: boolean,
  marker?: string | IconOptions,
  font?: string
): Promise<Map> {
  let bgElem: HTMLElement | null = null;
  if (typeof elem === 'string') {
    bgElem = document.getElementById(elem);
  }
  if (font === undefined) {
    font = defaultMapFont;
  }
  let markerObj: IconOptions | undefined;
  if (!(typeof marker === 'object')) {
    markerObj = JSON.parse(marker as string) as IconOptions;
  } else {
    markerObj = marker;
  }

  function createStyleFunction(marker: IconOptions | undefined): StyleFunction {
    return ((feature: Feature<Geometry>, level: number) => {
      const lineWidth = Math.floor(50 / level);
      return [
        new Style({
          image: new Icon(marker),
        }),
        new Style({
          stroke: new Stroke({
            color: 'rgba(0,0,0,1)',
            width: lineWidth + 4,
          }),
        }),
        new Style({
          stroke: new Stroke({
            color: 'rgba(255,255,255,1)',
            width: lineWidth,
          }),
        }),
      ];
    }) as StyleFunction;
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
    createStyleFunction(markerObj) as any,
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
