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
  "scroll": {func: scrollTrigger, meta: {triggered: inViewTrigger}},
  "fade": {func: fade, meta: {scrollable: true}},
  "slide": {func: translateHorizontal, meta: {
    scrollable: true,
  }},
  "shift": {func: shiftHorizontal, meta: {
    scrollable: true,
  }},
  "scale": {func: scale, meta: {scrollable: true}},
  "blur": {func: blur, meta: {scrollable: true}},
  "whitebox": {func: textBackground, meta: {scrollable: true}},
  "emphasis": {func: textEmphasis, meta: {scrollable: true}},
  "addclass": {func: addClass, meta: {scrollable: false}},
  "textshadow": {func: textShadow, meta: {scrollable: true}}
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
  function getFloat(elem) {

    let computedStyle = window.getComputedStyle(elem);
    const floatProperty =  computedStyle.getPropertyValue("float")
    if (floatProperty !== 'none' && floatProperty !== '') {
      return floatProperty
    }
    return false;
  }
  const effectElements = Array.from(document.querySelectorAll(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    let alignment;
    if (getFloat(elem)) {
      alignment = getFloat(elem)
    } else if (elem.firstElementChild !== null && getFloat(elem.firstElementChild)) {
      alignment = getFloat(elem.firstElementChild)
    } else {
      const box = elem.getBoundingClientRect();
      const center = (box.left + box.right) / 2;

      if (center < window.innerWidth / 3) {
        alignment = "left"
      } else if (center > (window.innerWidth / 3) * 2) {
        alignment = "right"
      } else {
        alignment = "center"
      }
    }
    elem.classList.add(`${scrollAlignmenPrefix}${alignment}`)
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
        let triggerFunction = functionMap[trigger[0]].func
        if (type === "trigged" && "meta" in functionMap[trigger[0]] && "triggered" in functionMap[trigger[0]].meta) {
          triggerFunction = functionMap[trigger[0]].meta.triggered
          console.log("Replaces scroll with inView trigger")
        }
        triggerFunction.apply(elem, [effects, ...trigger.slice(1)])
      });
    }
  });

}

function exec(cmd) {
  if (!(cmd.name in functionMap)) {
    return
  }
  if ("func" in functionMap[cmd.name]) {
    return functionMap[cmd.name].func.apply(cmd.target, cmd.args)
  }
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
function defaultTriggerFunc(effects) {
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

function inViewTrigger(effects, offset = '0px') {
  const target = this;

  if ((typeof offset === "string") && !offset.endsWith('px')) {
    offset = '0px'
  }

  if (offset && !isNaN(offset)) {
    offset += "%";
  }

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

function scrollTrigger(effects, targetOffset = null, containerOffset = null) {
  const target = this;
  const reference = getScrollReference(this)

  if (effects !== undefined) {

    effects.forEach(effect => {
      if (!functionMap[effect.name].meta.scrollable) {
        throw new Error("Effect is not scrollable!");
      }
      if (effect !== undefined) {
        let offset = ["start end", "start 30%"];

        if (targetOffset === null && containerOffset === null) {
          /*
          const box = target.getBoundingClientRect();
          if (box.height > window.innerWidth / 3) {
            offset[0] = "end start";
          }
          */
        } else {
          if (!isNaN(targetOffset)) {
            targetOffset += "%";
          }
          if (!isNaN(containerOffset)) {
            containerOffset += "%";
          }

          offset = [`${targetOffset} ${containerOffset}`]
        }

        if (arguments.length >= 5) {
          if (!isNaN(arguments[3])) {
            arguments[3] += "%";
          }
          if (!isNaN(arguments[4])) {
            arguments[4] += "%";
          }

          offset.push(`${arguments[3]} ${arguments[4]}`)
        }

        scroll(exec(effect), {
          target: target,
          offset: offset
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

function shiftHorizontal(direction = 'in', distance = "10%", safe = false, duration = 1000) {
  const alignment = getAlignment(this);
  if (distance && !isNaN(distance)) {
    distance += "%";
  }
  if (alignment === "center" && safe) {
    return animate(this)
  }
  if (direction === 'in' && alignment === 'right') {
    translatePos = [0, `-${distance}`]
  } else if (direction === 'out' && alignment === 'left') {
    translatePos = [0, `-${distance}`]
  } else if (direction === 'in' && alignment === 'left') {
    translatePos = [0, `${distance}`]
  } else if (direction === 'out' && alignment === 'right') {
    translatePos = [0, `${distance}`]
  }

  return animate(this, { translate: translatePos, duration: duration })
}

function translateHorizontal (direction = 'in', duration = 1000) {
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
  return animate(this, { translate: translatePos, duration: duration })
}

function scale (direction = 'in', factor = 200, duration = 1000) {
  const alignment = getAlignment(this);
  let origin = {};
  /*
  if (direction === 'in') {
    if (alignment === 'right') {
      origin["transform-origin"] =  "center left"
    } else if (alignment === 'left') {
      origin["transform-origin"] =  "center right"
    } else {
      throw new Error(`Unhandled alignment '${direction}' for `, this);
    }
  }
  */

  return animate(this, { ...origin, scale: factor/100, duration: duration })
}

function blur(radius = 5, duration = 1000) {
  if (!radius.match(/.+\w{2,3}$/gm)) {
    radius += "px";
  }
  return animate(this, { filter: `blur(${radius})`, duration: duration })
}

function textBackground(background = '#fff', scale = 1.05, duration = 1000) {
  const currentBackground = window.getComputedStyle(this).getPropertyValue('--page-background');
  return animate(this, { scale: scale, background: [currentBackground, background], duration: duration })
}

function textEmphasis(scale = 1.05, duration = 1000) {
  return animate(this, { scale: scale, background: background, duration: duration })
}


function textShadow (x = 10, y = 10, blur = 10, color = "#fff") {
  return animate(this, { scale: scale, textShadow: `${x} ${y} ${blur} ${color}`, duration: duration })
}

function addClass(cls) {
  this.classList.add(cls)
}
