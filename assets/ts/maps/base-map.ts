// assets/ts/base-map.ts

import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";

export type Lang = "de" | "en";

export interface ToolTipStrings {
  zoomIn: string;
  zoomOut: string;
  fullscreen: string;
  rotate: string;
  rotateLeft: string;
  rotateRight: string;
}

export const translations = {
  en: {
    tooltips: {
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fullscreenEnter: "Toggle full-screen",
      fullscreenExit: "Toggle full-screen",
      toggleAttribution: "Toggle attribution",
      rotate: "Reset rotation",
      rotateLeft: "Rotate 90° left",
      rotateRight: "Rotate 90° right",
      closePopup: "Close popup",
      resetBearing: "Drag to rotate map, click to reset north",
    },
    "3d": {
      hideBuildings: "Show only never-built buildings",
      highlightBuildings: "Highlight never-built buildings",
      buildingProperties: "Gebäudeeigenschaften",
      buildingPost: "Beitrag zu siesem Gebäude"
    },
  },
  de: {
    tooltips: {
      zoomIn: "Vergrößern",
      zoomOut: "Verkleinern",
      fullscreenEnter: "Vollbildansicht",
      fullscreenExit: "Vollbildansicht verlasssen",
      toggleAttribution: "Quellenangabe ein-/ausblenden",
      rotate: "Rotation zurücksetzen",
      rotateLeft: "90° nach links drehen",
      rotateRight: "90° nach rechst drehen",
      closePopup: "Popup schließen",
      resetBearing:
        "Zum Drehen der Karte ziehen, zum Zurücksetzen auf Norden anklicken",
    },
    "3d": {
      hideBuildings: "Nur nicht gebaute Gebäude zeigen",
      highlightBuildings: "Nicht gebaute Gebäude hervorheben",
      buildingProperties: "Building Properties",
      buildingPost: "Post about this building"
    },
  },
};

export const defaultVectorSource =
  "https://static.projektemacher.org/maps/central-europe/tiles/{z}/{x}/{y}.pbf";

export const defaultPadding: [number, number, number, number] = [
  50, 50, 50, 50,
];

export function getMaplibreGLLocale(): Record<string, string> {
  i18next.use(LanguageDetector).init({
    debug: false,
    fallbackLng: "en",
    resources: translations,
    supportedLngs: ["en", "de"],
  });

  return {
    "AttributionControl.ToggleAttribution": i18next.t(
      "tooltips:toggleAttribution",
    ),
    "FullscreenControl.Enter": i18next.t("tooltips:fullscreenEnter"),
    "FullscreenControl.Exit": i18next.t("tooltips:fullscreenExit"),
    "NavigationControl.ZoomIn": i18next.t("tooltips:zoomIn"),
    "NavigationControl.ZoomOut": i18next.t("tooltips:zoomOut"),
    "Popup.Close": i18next.t("tooltips:closePopup"),
    "NavigationControl.ResetBearing": i18next.t("tooltips:resetBearing"),
  };
}

export function getLang(): string {
  let lang = "en";
  if (document.documentElement.lang !== undefined) {
    /* TODO: Check for lang locale combinations here: "de-de" instead of "de" will currently break this. */
    lang = document.documentElement.lang;
  }
  return lang;
}

export function absUrl(url: string): string {
  if (url.startsWith("http") || url.startsWith("//")) {
    return url;
  } else {
    let base = window.location.protocol + "//" + window.location.hostname;
    if (window.location.port !== "") {
      base += ":" + window.location.port;
    }
    return base + url;
  }
}

/*
export function loadGeoJSON(url: string): void {
  fetch(url)
    .then(function (response) {
      response
        .json()
        .then(function (geojson) {
          // See https://openlayers.org/en/latest/examples/geojson.html

          // See https://gis.stackexchange.com/questions/373285/geojson-doesnt-render-on-map-in-openlayers-project
          const parser = new GeoJSON({
            dataProjection: "EPSG:4326",
            featureProjection: "EPSG:3857"
          });

          const vectorSource = new VectorSource({
            features: parser.readFeatures(geojson)
          });
        })
        .catch(function (body) {
          console.log("Could not read GeoJSON. " + body);
        });
    })
    .catch(function () {
      console.log("Could not read data from URL.");
    });
}
*/
