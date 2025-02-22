import {setupAnimatedLinks} from './animated-link';
import Glide from '@glidejs/glide'

new Glide('.featured').mount()


document.addEventListener("DOMContentLoaded", function(event) {
  setupAnimatedLinks()
});
