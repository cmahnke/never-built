import {setupAnimatedLinks} from './animated-link';
import Glide from '@glidejs/glide'




document.addEventListener("DOMContentLoaded", function(event) {
  setupAnimatedLinks()
  if (document.querySelector('body.home')) {
    new Glide('.featured',{
  gap: 20}).mount()
  }

});
