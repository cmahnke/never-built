import {animate, scroll, inView} from 'motion';
import * as effectConfig from '../json/effects.json';

export const effectMap = {"fade": undefined, "translate": undefined};
const effectCSSPrefix = "_effect-";
const triggerCSSPrefix = "_efTrigger-";
const scrollCSSPrefix = "_efScroll-";
const scrollAlignmenPrefix = "_efAlign-";

const usePx = false;

const functionMap = {
  "defaultTrigger": {func: defaultTriggerFunc, meta: {}},
  "inview": {func: inViewTrigger, meta: {}},
  "scroll": {func: scrollTrigger, meta: {}},
  "fade": {func: fade, meta: {scrollable: true}},
  "translate": {func: translateHorizontal, meta: {
    scrollable: true,
//    init: initTranslateHorizontal
  }},
  "addclass": {func: addClass, meta: {scrollable: false}}
}

export function setupBook() {
  let type;
  let rootContainer = document.querySelectorAll('.scroll-layout, .scroll-trigged');
  if (!rootContainer.length) {
    return;
  } else {
    if (rootContainer[0].classList.contains('scroll-trigged')) {
      type = 'trigged';
    } else {
      type = 'layout';
    }
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
                const container = scan.closest('.scan-container');
                let subImage, unit;
                if (usePx) {
                  unit = 'px';
                  let wFactor = scan.naturalWidth / image.size[0];
                  let hFactor = scan.naturalHeight / image.size[1];
                  subImage = {position: {x: area.position.x * wFactor, y: area.position.y * hFactor},
                                    size: {x: area.size.x * wFactor, y: area.size.y * hFactor}};

                  name.parentElement.style.position = 'absolute';
                  container.style.width = scan.naturalWidth + unit;
                  container.style.height = scan.naturalHeight + unit;
                } else {
                  unit = '%';
                  subImage = {position: {x: (area.position.x / image.size[0]) * 100, y: (area.position.y / image.size[1]) * 100},
                                    size: {x: (area.size.x / image.size[0]) * 100, y: (area.size.y / image.size[1]) * 100}};

                }
                name.style.position = 'absolute';
                name.style.top = subImage.position.y + unit;
                name.style.left = subImage.position.x + unit;
                name.style.height = subImage.size.y + unit;
                name.style.width = subImage.size.x + unit;
                scan.dataset.imagePart = JSON.stringify(subImage);
                scan.parentElement.after(name.parentElement);
                name.classList.add("overlay");
                updated = true;
              }
            };
          });
        };
      });
    })
  });
  addAlignment();
  addEffects(type);
}

function addAlignment() {
  const effectElements = Array.from(document.querySelectorAll(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    const box = elem.getBoundingClientRect();
    const center = (box.left + box.right) / 2;
    if (center < window.innerWidth / 3) {
      elem.classList.add(`${scrollAlignmenPrefix}left`)
    } else if (center > (window.innerWidth / 3) * 2) {
      elem.classList.add(`${scrollAlignmenPrefix}right`)
    } else {
      elem.classList.add(`${scrollAlignmenPrefix}center`)
    }
  });
}

function addEffects(type) {
  let elementEffects = {};
  let init = []
  const effectElements = Array.from(document.querySelectorAll(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    let effects = [], triggers = [];
    Array.from(elem.classList).forEach(cls => {
      const effect = parseClass(cls, effectCSSPrefix)
      if ((effect[0] in functionMap)) {
        effects.push({name: effect[0], target: elem, args: effect.slice(1)})
        if ("meta" in functionMap[effect[0]] && "init" in functionMap[effect[0]].meta) {
          functionMap[effect[0]].meta.init.apply(elem, effect.slice(1))
        }
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
        functionMap[trigger[0]].func.apply(elem, [...trigger.slice(1), effects])
      });
    }
  });

}

function exec(cmd) {
  if (!(cmd.name in functionMap)) {
    return
  }
  return functionMap[cmd.name].func.apply(cmd.target, cmd.args)
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

/* Animation utils */
function getAlignment(elem) {
  let alignment
  if (elem === undefined || elem.classList === undefined) {
    throw new Error("Elemnt or classList is undefined for ", elem);
  }
  elem.classList.forEach(cls => {
    if (cls.startsWith(scrollAlignmenPrefix)) {
      alignment =  cls.replace(scrollAlignmenPrefix, "")
    }
  });
  return alignment;
}

function disableTransition(elem, func) {
  let computedStyle = window.getComputedStyle(elem)
  const transition = computedStyle.getPropertyValue("transition")
  element.style.transition = ""
  func()
  element.style.transition = transition
}


/* Trigger functions */
function defaultTriggerFunc() {
  let effects = Array.from(arguments).slice(-1)[0]
  const target = this;
  if (!Array.isArray(effects)) {
    effects = [effects]
  }
  if (effects !== undefined) {
    effects.forEach(effect => {
      if (effect !== undefined) {
        exec(effect)
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
          exec(effect)
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
      if (!functionMap[effect.name].meta.scrollable) {
        throw new Error("Effect is not scrollable!");
      }
      if (effect !== undefined) {
        /*
        scroll((progress, info) => {
          console.log(target, info)
        })
        */

        scroll(exec(effect), {
          target: target,
          offset: ["start end", "start 30%"]
        })
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

  return animate(this, { opacity: opacity, duration: duration })
}

function initTranslateHorizontal(direction) {
  const alignment = getAlignment(this);
  let initial;
  if (direction === 'in' && alignment === 'right') {
    initial = '100%'
  }
  if (direction === 'out' && alignment === 'left') {
    initial = '-100%'
  }

  if (initial !== undefined) {
    this.style.translate = `${initial}`
  }
}

function translateHorizontal (direction = 'in', axis = 'x', duration = 1000) {
  const random = ['-100%', '100%'][(Math.random() < 0.5) * 1]
  const alignment = getAlignment(this);
  let initial, translatePos;

  if (direction === 'in' && alignment === 'right') {
    translatePos = [ '100vw', '0%']
  } else if (direction === 'out' && alignment === 'left') {
    translatePos = ['-100vw', '0%']
  } else if (direction === 'in' && alignment === 'left') {
    translatePos = ['-100vw', 0]
  } else if (direction === 'out' && alignment === 'right') {
    translatePos = ['100vw', 0]
  } else if (alignment === 'center') {
    translatePos = [random, 0]
  } else {
    throw new Error(`Unhandled alignment '${direction}' for `, this);
  }
  if (axis === 'y') {
    throw new Error("Y axis for translate isn't immplemented!");
  }
  return animate(this, { translate: translatePos, duration: duration })
}

function addClass(cls) {
  this.classList.add(cls)
}
