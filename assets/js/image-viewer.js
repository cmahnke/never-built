import PhotoSwipeLightbox from 'photoswipe/lightbox';
import PhotoSwipe from 'photoswipe';

const imageViewerOverlayClass = "image-viewer-overlay";

export function imageViewer(images, startImage) {
  let counter = 1;
  var imageList = [];
  images.forEach((image) => {
    let imageEntry = {_el: image};
    if (!image.dataset.fullSrc) {
      imageEntry = {...{id: counter, src: image.getAttribute("src"), width: image.naturalWidth, height: image.naturalHeight}, ...imageEntry};
    } else {
      imageEntry = {...{id: counter, src: image.dataset.fullSrc, width: Number(image.dataset.fullWidth), height: Number(image.dataset.fullHeight)}, ...imageEntry};
    }
    counter++;
    imageList.push(imageEntry);
  })

  const lightbox = new PhotoSwipeLightbox({
    dataSource: imageList,
    showHideAnimationType: 'zoom',
    pswpModule: PhotoSwipe
  });
  lightbox.on('uiRegister', function() {
    lightbox.pswp.ui.registerElement({
      name: 'custom-caption',
      order: 9,
      isButton: false,
      appendTo: 'root',
      html: 'Caption text',

      onInit: (el, pswp) => {
        lightbox.pswp.on('change', () => {
          const currSlideElement = lightbox.pswp.currSlide.data.element;
          let captionHTML = '';
          let sourceEl = imageList[pswp.currIndex]._el;
          if (sourceEl && sourceEl.hasAttribute('alt')) {
            captionHTML = sourceEl.getAttribute('alt');
          }
          el.innerHTML = captionHTML || '';
          if (captionHTML === '') {
            el.setAttribute("style", 'opacity: 0 !important;');
          } else {

            el.setAttribute("style", 'opacity: 1 !important;');
          }
        });
      }
    });
  });

  lightbox.addFilter('thumbEl', (thumbEl, data, index) => {
    let el = imageList.filter((entry) => { return entry.id === data.id })
    el = el[0]._el;
    if (el) {
      return el;
    }
    return thumbEl;
  });

  lightbox.addFilter('placeholderSrc', (placeholderSrc, slide) => {
    let el = imageList.filter((entry) => { return entry.id === slide.data.id })
    el = el[0]._el;
    if (el) {
      return el.src;
    }
    return placeholderSrc;
  });

  lightbox.init();
  imageList.forEach((image, i) => {
    image._el.addEventListener(("click"), (e) => {
      lightbox.loadAndOpen(i);
      return false;
    });
  });
}
