import {animate, scroll, inView} from 'motion';
import * as effectConfig from '../json/effects.json';

export const effectMap = {"fade": undefined, "translate": undefined};
const effectCSSPrefix = "_effect-";
const triggerCSSPrefix = "_efTrigger-";
const scrollCSSPrefix = "_efScroll-";

const functionMap = {
  "defaultTrigger": defaultTriggerFunc,
  "inview": inViewTrigger,
  "fade": fade,
  "translate": translate,
  "addclass": addClass
}

export function setupBook() {
  if (!document.querySelectorAll('.scroll-layout, .scroll-trigged')) {
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


  let elementEffects = {};
  const effectElements = Array.from(document.querySelectorAll(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    let effects = [], triggers = [];
    Array.from(elem.classList).forEach(cls => {
      const effect = parseClass(cls, effectCSSPrefix)
      if ((effect[0] in functionMap)) {
        effects.push(createFunctionProxy(effect[0], elem, effect.slice(1)))
      }
      const trigger = parseClass(cls, triggerCSSPrefix)
      if (trigger.length) {
        triggers.push(trigger)
      }

    });

    if (effects.length) {
      if (!triggers.length) {
        triggers.push(["defaultTrigger"])
      }

      triggers.forEach((trigger) => {
        if (!(trigger[0] in functionMap)) {
          console.log(`Trigger ${trigger[0]} is not defined!`)
          return
        }
        functionMap[trigger[0]].apply(elem, [...trigger.slice(1), effects])
      });
    }
  });
}

function createFunctionProxy(name, target, args) {
  if (!(name in functionMap)) {
    return
  }
  const func = () => {
    return functionMap[name].apply(target, args)
  }

  return func
}

function parseClass (cls, prefix) {
  if (cls.startsWith(prefix)) {
    const str = cls.replace(prefix, "")
    return splitClass(str)
  }
  return []
}

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

function getScrollReference(start, reference) {
  if (reference === undefined) {
    let context = start
    while (context.parentElement) {
      let computedStyle = window.getComputedStyle(context)
      if (computedStyle.getPropertyValue("scroll-snap-align") || computedStyle.getPropertyValue("scroll-snap-stop")) {
        return context
      } else {
        context = context.parentElement
      }
    }
  } else {

  }
}

function defaultTriggerFunc() {
  let effects = Array.from(arguments).slice(-1)[0]
  const target = this;
  if (!Array.isArray(effects)) {
    effects = [effects]
  }
  if (effects !== undefined) {
    effects.forEach(effect => {
      if (effect !== undefined) {
        effect()
      }
    });
  }
}

function inViewTrigger(offset) {
  let effects = Array.from(arguments).slice(-1)[0]
  const target = this;
  inView(target, (element) => {
    if (effects !== undefined) {
      effects.forEach(effect => {
        if (effect !== undefined) {
          effect()
        }
      });
    }
  }, { margin: `0px ${offset} 0px 0px` })

}

function scrollTrigger() {
  let effects = Array.from(arguments).slice(-1)[0]
  const target = this;
  const reference = getScrollReference(this)
  if (effects !== undefined) {
    effects.forEach(effect => {
      if (effect !== undefined) {
        scroll(effect())
      }
    });
  }
}

/* Animation functions */

function fade (direction = 'in', duration = 1000) {
  let computedStyle = window.getComputedStyle(this)
  if (direction === 'in' || computedStyle.getPropertyValue("opacity") !== 1) {
    opacity = 1
  } else {
    opacity = 0
  }

  //let args = Array.from(arguments).slice(1)
  console.log(`called fade (with ${direction}) on `, direction, arguments)
  return animate(this, { opacity: opacity, duration: duration })
}

function translate (direction, axis = 'x', duration = 1000) {
  if (direction === 'in') {
    direction = '-100%'
  }
  if (direction === 'out') {
    direction = '100%'
  }
  let translatePos = [direction, 0]
  if (axis === 'y') {
    translatePos = [0, direction]
  }
  //let args = Array.from(arguments)
  console.log("called translate on ", this,  direction)
  return animate(this, { translate: translatePos, duration: duration })
}

function addClass(cls) {
  this.classList.add(cls)
}

//function inView()
