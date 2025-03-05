import {animate, scroll} from 'motion';

export const effectMap = {"fade": undefined, "translate": undefined};
const effectCSSPrefix = "effect-";

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
  function splitClass(str) {
    const result = [];
      let currentPart = "";
      let i = 0;

      while (i < str.length) {
        if (str[i] === '-' && str[i + 1] !== '-') {
          result.push(currentPart);
          currentPart = "";
          i++;
        } else if (str[i] === '-' && str[i + 1] === '-') {
          result.push(currentPart);
          currentPart = "-";
          i += 2;
        } else {
          currentPart += str[i];
          i++;
        }
      }

      result.push(currentPart);
      return result;
  }

  let elementEffects = {};
  const effectElements = Array.from(document.querySelectorAll(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    let effects = [];
    Array.from(elem.classList).forEach(cls => {
      if (cls.startsWith(effectCSSPrefix)) {
        const str = cls.replace(effectCSSPrefix, "")
        //Consider a method to escape -
        const effect = splitClass(str)
        if (effect[0] in effectMap && effectMap[effect[0]] !== undefined) {
          effects.push(() => {effectMap[effect](...effect.slice(1))})
        } else {
          console.log(`No method defined for ${effect[0]}`)
        }
      }
    });
    if (effects.length) {
      elementEffects[elem] = effects
    }
  });
  console.log(elementEffects);
}

/* Animation ideas


*/
