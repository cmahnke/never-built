// assets/ts/main.ts

import { loadOrParse } from "./base-map";
import { initMap } from "./3d-map";
import * as maplibregl from "maplibre-gl";
import type { LngLatLike } from "maplibre-gl";
import type { CameraPositionConfig } from "./3d-map";
import type { TileMetadata } from "./@types/tile-metadata.d.ts";
import { center as turfCenter, points } from "@turf/turf";
import { UAParser } from "ua-parser-js";

declare global {
  interface Window {
    map: maplibregl.Map;
  }
}

let debug = true;
const elementId = "map";

const tileSource = "Blauer-Turm";
const topoRasterTiles = "/map/tiles/{z}/{x}/{y}.png";
const styleJson = "/map-styles/style.json";
const tilesUrl = `/map/${tileSource}/{z}/{x}/{y}.pbf`;
const metaJson = `/map/${tileSource}/metadata.json`;
const font = "Roboto Mono Variable";
const defaultCenter: [number, number] = [9.9365, 51.5395];
const bboxUrl = "/map/bbox.json";

const initialPos: CameraPositionConfig = {
  cameraLngLat: defaultCenter,
  cameraAlt: 100,
  bearing: -10,
  pitch: 75,
  roll: 0,
  zoom: 17
};

const metaObj = (await loadOrParse(metaJson)) as TileMetadata;
let centerObj: LngLatLike;
if (metaObj && typeof metaObj.bounds === "string") {
  const bboxObj = metaObj.bounds.split(",").slice(0, 4).map(Number);
  const c = turfCenter(
    points([
      [bboxObj[0], bboxObj[1]],
      [bboxObj[2], bboxObj[3]]
    ])
  );
  centerObj = c.geometry.coordinates as [number, number];
} else {
  console.error("Can't create center from features or bbox");
  centerObj = [0, 0];
}

let map: maplibregl.Map;

const uap = new UAParser();
if (uap.getDevice().is("mobile")) {
  debug = false;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", async () => {
    map = await initMap(
      elementId,
      undefined,
      tilesUrl,
      styleJson,
      bboxUrl,
      defaultCenter,
      undefined,
      undefined,
      undefined,
      false,
      false,
      false,
      undefined,
      debug,
      undefined,
      font,
      undefined,
      undefined,
      initialPos,
      topoRasterTiles
    );
    if (debug) {
      window.map = map;
    }
  });
} else {
  map = await initMap(
    elementId,
    undefined,
    tilesUrl,
    styleJson,
    bboxUrl,
    defaultCenter,
    undefined,
    undefined,
    undefined,
    false,
    false,
    false,
    undefined,
    debug,
    undefined,
    font,
    undefined,
    undefined,
    initialPos,
    topoRasterTiles
  );
  if (debug) {
    window.map = map;
  }
}
