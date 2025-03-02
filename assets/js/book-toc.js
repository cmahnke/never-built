export const effects = {};

export function setupBook() {
  if (!document.querySelectorAll('.scroll-layout')) {
    return;
  }
  Array.from(document.querySelectorAll('.preview-container[data-image-regions]')).forEach((elem) => {
    const images = JSON.parse(elem.dataset.imageRegions);
    const scan = elem.querySelector('.scan');
    let updated = false
    Array.from(elem.querySelectorAll('.preview[data-image-name]')).forEach((name) => {
      images.forEach((image) => {
        if ("areas" in image) {
          image.areas.forEach((area) => {
            if ("name" in area && name.dataset.imageName.startsWith(area.name)) {
              name.dataset.imageMetadata = JSON.stringify(area);
              if (scan && !updated) {
                scan.dataset.imageMetadata = image.size;
                const wFactor = scan.naturalWidth / image.size[0];
                const hFactor = scan.naturalHeight / image.size[1];
                const container = scan.closest('.scan-container');
                container.style.width = scan.naturalWidth + 'px';
                container.style.height = scan.naturalHeight + 'px';
                const subImage = {position: {x: area.position.x * wFactor, y: area.position.y * hFactor},
                                  size: {x: area.size.x * wFactor, y: area.size.y * hFactor}};
                scan.dataset.imagePart = JSON.stringify(subImage);
                scan.parentElement.after(name.parentElement);
                name.classList.add("overlay");
                name.parentElement.style.position = 'absolute';
                name.style.position = 'absolute';
                name.style.top = subImage.position.y + 'px';
                name.style.left = subImage.position.x + 'px';
                name.style.height = subImage.size.y + 'px';
                name.style.width = subImage.size.x + 'px';
                updated = true;
              }
            };
          });
        };
      });
    })
  });
  addEffects();
}

function addEffects() {
  checkEffects();
  Object.entries(effects).forEach(effect => {
    const [selector, func] = entry;
    Array.from(elem.querySelectorAll(selector)).forEach((node) => {
      func(node);
    });
  });
  //See https://codesandbox.io/p/sandbox/framer-motion-useinview-scroll-snap-0dwbm?file=%2Fsrc%2FApp.js
}

function checkEffects() {
  const effectElements = Array.from(document.querySelectorAll("[class^='effect-']"));
  effectElements.forEach((elem) => {
    elem.classList.forEach((cls) => {
      if(!cls.split('-')[1] in effects) {
        console.log(`Effect ${cls.split('-')[1]} not defined!`);
      }
    });
  });
}
