import {setupAnimatedLinks} from './animated-link';
import Glide from '@glidejs/glide'
import { projektemacherMap } from 'maps/projektemacher-map';

window.projektemacherMap = projektemacherMap;

document.addEventListener("DOMContentLoaded", function(event) {
  setupAnimatedLinks()
  if (document.querySelector('body.home')) {
    new Glide('.featured',{
      gap: 20,
      type: 'carousel'
    }).mount()
  }
});
