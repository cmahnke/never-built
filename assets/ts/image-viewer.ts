import PhotoSwipeLightbox from 'photoswipe/lightbox';
import PhotoSwipe from 'photoswipe';

const _imageViewerOverlayClass = "image-viewer-overlay";

interface ImageEntry {
  _el: HTMLImageElement;
  id: number;
  src: string | undefined;
  width: number;
  height: number;
}

export function imageViewer(images: NodeListOf<HTMLImageElement>, _startImage?: number): void {
  let counter = 1;
  const imageList: ImageEntry[] = [];
  images.forEach((image) => {
    const entry: ImageEntry = !image.dataset.fullSrc
      ? { id: counter, src: image.getAttribute("src") ?? undefined, width: image.naturalWidth, height: image.naturalHeight, _el: image }
      : { id: counter, src: image.dataset.fullSrc, width: Number(image.dataset.fullWidth), height: Number(image.dataset.fullHeight), _el: image };
    counter++;
    imageList.push(entry);
  })

  const lightbox = new PhotoSwipeLightbox({
    dataSource: imageList,
    showHideAnimationType: 'zoom',
    pswpModule: PhotoSwipe
  });
  lightbox.on('uiRegister', function() {
    lightbox.pswp?.ui?.registerElement({
      name: 'custom-caption',
      order: 9,
      isButton: false,
      appendTo: 'root',
      html: 'Caption text',

      onInit: (el, pswp) => {
        pswp.on('change', () => {
          const sourceEl = imageList[pswp.currIndex]._el;
          let captionHTML = '';
          if (sourceEl && sourceEl.hasAttribute('alt')) {
            captionHTML = sourceEl.getAttribute('alt') ?? '';
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

  lightbox.addFilter('thumbEl', (thumbEl, data) => {
    const entry = imageList.filter((candidate) => { return candidate.id === data.id })[0];
    if (entry && entry._el) {
      return entry._el;
    }
    return thumbEl as HTMLElement;
  });

  lightbox.addFilter('placeholderSrc', (placeholderSrc, slide) => {
    const entry = imageList.filter((candidate) => { return candidate.id === slide.data.id })[0];
    if (entry && entry._el) {
      return entry._el.src;
    }
    return placeholderSrc;
  });

  lightbox.init();
  imageList.forEach((image, i) => {
    const handler = () => {
      lightbox.loadAndOpen(i);
      return false;
    }

    image._el.addEventListener("click", handler);
    image._el.style.cursor = "pointer";
    const parent = image._el.parentElement;
    if (parent) {
      parent.addEventListener("click", handler);
      parent.style.cursor = "pointer";
    }
  });
}
