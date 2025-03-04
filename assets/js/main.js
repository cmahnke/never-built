import {setupAnimatedLinks, setupAnimatedMenu} from './animated-link';
import {setupBook} from './scrollify';
import Glide from '@glidejs/glide'
import { projektemacherMap } from './maps/projektemacher-map';
import {initializeChart} from './chart';

const defaultMapFont = "Roboto Mono Variable";
const animatedLinkColor = ["black", "#000", "#000000", "rgb(0, 0, 0)"]

window.initializeChart = initializeChart;

window.projektemacherMap = async function(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker, font) {
  var bgElem;
  if (typeof elem === "string") {
    bgElem = document.getElementById(elem)
  }
  if (font === undefined) {
    font = defaultMapFont
  }
  background = window.getComputedStyle(bgElem).getPropertyValue('--page-background');
  return projektemacherMap(elem, geojson, source, style, bbox, center, initialZoom, minZoom, maxZoom, cluster, disabled, popup, background, debug, marker, font);
}

window.anchorTop = (anchor) => {
  const heading = document.querySelector(`.header-title`)
  const topHeight = Number(window.getComputedStyle(heading, '::before').getPropertyValue('height').replace('px', ''))
  const target = document.querySelector(`a[name="${anchor}"]`)
  const targetTop = target.getBoundingClientRect().top//;
  const to = targetTop + window.pageYOffset - topHeight;

  if (target !== null) {
    window.scrollTo({
      top: targetTop + window.pageYOffset - topHeight,
      behavior: 'smooth',
    });
  }
}

document.addEventListener("DOMContentLoaded", function(event) {
  var links = Array.from(document.querySelectorAll('a.click-animation'));
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
});
