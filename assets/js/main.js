import {setupAnimatedLinks, setupAnimatedMenu} from './animated-link';
import {setupBook} from './scrollify';
import Glide from '@glidejs/glide'
import {imageViewer} from './image-viewer';
import {detect} from 'detect-browser';
import { projektemacherMap } from '../ts/maps/projektemacher-map';

const defaultMapFont = "Roboto Mono Variable";
const animatedLinkColor = ["black", "#000", "#000000", "rgb(0, 0, 0)"]

//Needed agains Safari caching
const browser = detect();
if (browser && browser.name === 'safari') {
  window.addEventListener('beforeunload', () => {
    document.querySelector(".animated-link-overlay").remove()
  });
}
if (browser && (browser.name === 'ios' || browser.name === 'ios-webview')) {
  window.addEventListener('pagehide', () => {
    document.querySelector(".animated-link-overlay").remove()
  });
}

window.anchorTop = (anchor) => {
  const heading = document.querySelector(`.header-background`)
  const topHeight = Number(window.getComputedStyle(heading).getPropertyValue('height').replace('px', ''))
  const target = document.querySelector(`a[name="${anchor}"]`)
  const targetTop = target.getBoundingClientRect().top;
  const to = targetTop + window.pageYOffset - topHeight;

console.log(target, targetTop, topHeight, window.getComputedStyle(heading, '::before').getPropertyValue('height'))

  if (target !== null) {
    window.scrollTo({
      top: targetTop + window.pageYOffset, // - topHeight
      behavior: 'smooth'
    });
  }
}

document.addEventListener("DOMContentLoaded", function(event) {
  var links = Array.from(document.querySelectorAll('a.click-animation, a.readmore'));
  document.querySelectorAll('.main a').forEach((link) => {
    const compStyles = window.getComputedStyle(link);
    if (!link.hasAttribute("href")) {
      return
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

    if (animatedLinkColor.includes(compStyles.getPropertyValue("color")) && !link.firstElementChild &&  !link.classList.contains("no-animation")) {
      links.push(link);
    }
  });
  setupAnimatedLinks(links);
  setupBook();

  const menuLinks = Array.from(document.querySelectorAll('.header .menu .navigation-link'))
  setupAnimatedMenu(menuLinks);

  if (document.querySelector('body.home')) {
    new Glide('.featured',{
      gap: 20,
      type: 'carousel'
    }).mount()
  }

  var imageZoomWidth = window.getComputedStyle(document.body)
  imageZoomWidth = imageZoomWidth.getPropertyValue('--image-zoom-width');
  let widthMQL = window.matchMedia(`(max-width: ${imageZoomWidth})`);
  if (widthMQL.matches && !document.querySelectorAll('.scroll-layout').length) {
    const zoomable = document.querySelectorAll('.article-single .content-container figure img, .article-single .content .featured img')
    imageViewer(zoomable)
  }

});

function isCurrentPage(url) {
  try {
    const linkURL = new URL(url);
    return linkURL.pathname === window.location.pathname;
  } catch (error) {
    console.error("Invalid URL provided:", urlString, error);
    return false;
  }
}

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
  background = window.getComputedStyle(bgElem).getPropertyValue('--page-background');
  const map = projektemacherMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker, font);

  if (!("projektemacher" in window)) {
    window.projektemacher = {};
  }
  if (!("maps" in window.projektemacher)) {
    window.projektemacher.maps = {};
  }
  window.projektemacher.maps[bgElem] = await map

  return map
}
