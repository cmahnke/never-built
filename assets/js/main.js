import {setupAnimatedLinks, setupAnimatedMenu} from './animated-link';
import Glide from '@glidejs/glide'
import { projektemacherMap } from './maps/projektemacher-map';

window.projektemacherMap = projektemacherMap;

const animatedLinkColor = ["black", "#000", "#000000", "rgb(0, 0, 0)"]

document.addEventListener("DOMContentLoaded", function(event) {
  var links = Array.from(document.querySelectorAll('a.click-animation'));
  document.querySelectorAll('.main a').forEach((link) => {
    const compStyles = window.getComputedStyle(link);
    if (animatedLinkColor.includes(compStyles.getPropertyValue("color")) && !link.firstElementChild &&  !link.classList.contains("no-animation")) {
      links.push(link);
    }
  });
  setupAnimatedLinks(links);


  const menuLinks = Array.from(document.querySelectorAll('.header .menu .navigation-link'))
  setupAnimatedMenu(menuLinks);

  if (document.querySelector('body.home')) {
    new Glide('.featured',{
      gap: 20,
      type: 'carousel'
    }).mount()
  }
});
