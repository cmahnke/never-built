import { setupAnimatedLinks, setupAnimatedMenu } from './animated-link';
import { setupBook } from './scrollify';
import Glide from '@glidejs/glide';
import { imageViewer } from './image-viewer';
import { detect } from 'detect-browser';
import { projektemacherMap } from './maps/map';
import { projektemacher3DMap } from './maps/3d-map';
import { setWorkerUrl } from 'maplibre-gl';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LngLatLike, StyleSpecification } from 'maplibre-gl';
import type { MarkerOptions } from './maps/map-utils';
import type { CameraPositionConfig } from './maps/3d-map';

declare global {
  interface Window {
    projektemacherMap: (
      elem: string | HTMLElement,
      geojson?: string | FeatureCollection,
      source?: string,
      style?: string | StyleSpecification,
      bbox?: string | number[] | number[][],
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
      font?: string
    ) => Promise<MapLibreMap>;
    projektemacher3DMap: (
      elem: string | HTMLElement,
      geojson?: string | FeatureCollection,
      source?: string,
      style?: string | StyleSpecification,
      bbox?: string | number[] | number[][],
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
      initialPos?: CameraPositionConfig,
      topoRasterTiles?: string
    ) => Promise<MapLibreMap>;
  }
}

const defaultMapFont = "Roboto Mono Variable";
const animatedLinkColor = ["black", "#000", "#000000", "rgb(0, 0, 0)"];

setWorkerUrl("/js/maplibre-gl/maplibre-gl-worker.mjs");

// Needed against Safari caching
const browser = detect();
if (browser && browser.name === 'safari') {
  window.addEventListener('beforeunload', () => {
    document.querySelector(".animated-link-overlay")?.remove();
  });
}
if (browser && (browser.name === 'ios' || browser.name === 'ios-webview')) {
  window.addEventListener('pagehide', () => {
    document.querySelector(".animated-link-overlay")?.remove();
  });
}

window.anchorTop = (anchor: string) => {
  const target = document.querySelector(`a[id="${anchor}"], a[name="${anchor}"]`);
  if (target === null) {
    return;
  }
  const targetTop = target.getBoundingClientRect().top;
  window.scrollTo({
    top: targetTop + window.pageYOffset,
    behavior: 'smooth'
  });
};

document.addEventListener("DOMContentLoaded", function () {
  const links: HTMLAnchorElement[] = Array.from(document.querySelectorAll<HTMLAnchorElement>('a.click-animation, a.readmore'));
  document.querySelectorAll<HTMLAnchorElement>('.main a').forEach((link) => {
    const compStyles = window.getComputedStyle(link);
    if (!link.hasAttribute("href")) {
      return;
    }
    for (const className of link.classList) {
      if (className.startsWith('ol-')) {
        return;
      }
    }
    if (link.href.startsWith('#')) {
      return;
    }

    if (URL.canParse(link.href)) {
      if (isCurrentPage(link.href)) {
        return;
      }
    }

    if (animatedLinkColor.includes(compStyles.getPropertyValue("color")) && !link.firstElementChild && !link.classList.contains("no-animation")) {
      links.push(link);
    }
  });
  setupAnimatedLinks(links);
  setupBook();

  const menuLinks = Array.from(document.querySelectorAll<HTMLElement>('.header .menu .navigation-link'));
  setupAnimatedMenu(menuLinks);

  if (document.querySelector('body.home')) {
    new Glide('.featured', {
      gap: 20,
      type: 'carousel'
    }).mount();
  }

  const bodyStyles = window.getComputedStyle(document.body);
  const imageZoomWidth = bodyStyles.getPropertyValue('--image-zoom-width');
  const widthMQL = window.matchMedia(`(max-width: ${imageZoomWidth})`);
  if (widthMQL.matches && !document.querySelectorAll('.scroll-layout').length) {
    const zoomable = document.querySelectorAll<HTMLImageElement>('.article-single .content-container figure img, .article-single .content .featured img');
    imageViewer(zoomable);
  }

});

function isCurrentPage(url: string): boolean {
  try {
    const linkURL = new URL(url);
    return linkURL.pathname === window.location.pathname;
  } catch (error) {
    console.error("Invalid URL provided:", url, error);
    return false;
  }
}

window.projektemacherMap = async (
  elem: string | HTMLElement,
  geojson?: string | FeatureCollection,
  source?: string,
  style?: string | StyleSpecification,
  bbox?: string | number[] | number[][],
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
  font?: string
): Promise<MapLibreMap> => {
  let bgElem: HTMLElement | null = null;
  if (typeof elem === "string") {
    bgElem = document.getElementById(elem);
  }
  if (font === undefined) {
    font = defaultMapFont;
  }
  if (typeof marker !== 'object') {
    marker = JSON.parse(String(marker)) as MarkerOptions;
  }
  background = window.getComputedStyle(bgElem as Element).getPropertyValue('--page-background');
  const map = projektemacherMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker as MarkerOptions, font);

  const registry = window.projektemacher ?? (window.projektemacher = {});
  (registry.maps ??= new Map()).set(bgElem, await map);

  return map;
};

window.projektemacher3DMap = async (
  elem: string | HTMLElement,
  geojson?: string | FeatureCollection,
  source?: string,
  style?: string | StyleSpecification,
  bbox?: string | number[] | number[][],
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
  initialPos?: CameraPositionConfig,
  topoRasterTiles?: string
): Promise<MapLibreMap> => {
  let bgElem: HTMLElement | null = null;
  if (typeof elem === "string") {
    bgElem = document.getElementById(elem);
  }
  if (font === undefined) {
    font = defaultMapFont;
  }
  if (typeof marker !== 'object') {
    marker = JSON.parse(String(marker)) as MarkerOptions;
  }
  background = window.getComputedStyle(bgElem as Element).getPropertyValue('--page-background');
  const map = projektemacher3DMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker as MarkerOptions, font, undefined, undefined, initialPos, topoRasterTiles);

  const registry = window.projektemacher ?? (window.projektemacher = {});
  (registry.maps ??= new Map()).set(bgElem, await map);

  return map;
};
