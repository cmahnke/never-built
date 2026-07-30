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
        console.log(`Could not read JSON from ${str}` + body, e);
      })
      .catch(function () {
        console.log(`Could not read data from URL ${str}`, e);
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
