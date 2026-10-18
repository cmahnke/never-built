import { animate, scroll, inView } from 'motion';
import type { AnimationPlaybackControls } from 'motion';
//import * as effectConfig from '../json/effects.json';

export const effectMap = {"fade": undefined, "translate": undefined};
const effectCSSPrefix = "_effect-";
const triggerCSSPrefix = "_efTrigger-";
const scrollCSSPrefix = "_efScroll-";
const scrollAlignmenPrefix = "_efAlign-";

const usePx = false;

type InViewOptionsArg = NonNullable<Parameters<typeof inView>[2]>;
type ScrollOptionsArg = NonNullable<Parameters<typeof scroll>[1]>;

interface EffectCommand {
  name: string;
  target: HTMLElement;
  args: string[];
}

type EffectFunc = (this: HTMLElement, ...args: any[]) => unknown;

interface FunctionSpec {
  func: EffectFunc;
  meta: {
    scrollable?: boolean;
    init?: EffectFunc;
    triggered?: EffectFunc;
  };
}

interface ImageRegionArea {
  name?: string;
  position: { x: number; y: number };
  size: { x: number; y: number };
}

interface ImageRegion {
  size: [number, number];
  areas?: ImageRegionArea[];
}

const functionMap: Record<string, FunctionSpec> = {
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

export function setupBook(): void {
  let type: string | undefined;
  const rootContainer = document.querySelectorAll('.scroll-layout, .scroll-trigged');
  if (!rootContainer.length) {
    return;
  } else {
    if (rootContainer[0].classList.contains('scroll-trigged')) {
      type = 'trigged';
    } else {
      type = 'layout';
    }
  }

  Array.from(document.querySelectorAll<HTMLElement>('.preview-container[data-image-regions]')).forEach((elem) => {
    const images = JSON.parse(elem.dataset.imageRegions as string) as ImageRegion[];
    const scan = elem.querySelector<HTMLImageElement>('.scan');
    let updated = false
    Array.from(elem.querySelectorAll<HTMLElement>('.preview[data-image-name]')).forEach((name) => {
      images.forEach((image) => {
        if (image.areas !== undefined) {
          image.areas.forEach((area) => {
            if (area.name !== undefined && name.dataset.imageName !== undefined && name.dataset.imageName.startsWith(area.name)) {
              name.dataset.imageMetadata = JSON.stringify(area);
              if (scan && !updated) {
                scan.dataset.imageMetadata = String(image.size);
                const container = scan.closest<HTMLElement>('.scan-container')!;
                let subImage: {position: {x: number; y: number}; size: {x: number; y: number}};
                let unit: string;
                if (usePx) {
                  unit = 'px';
                  const wFactor = scan.naturalWidth / image.size[0];
                  const hFactor = scan.naturalHeight / image.size[1];
                  subImage = {position: {x: area.position.x * wFactor, y: area.position.y * hFactor},
                                    size: {x: area.size.x * wFactor, y: area.size.y * hFactor}};

                  name.parentElement!.style.position = 'absolute';
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
                scan.parentElement!.after(name.parentElement!);
                name.classList.add("overlay");
                updated = true;
              }
            }
          });
        }
      });
    })
  });
  addAlignment();
  addEffects(type);
}

function addAlignment(): void {
  function getFloat(elem: Element): string | false {

    const computedStyle = window.getComputedStyle(elem);
    const floatProperty =  computedStyle.getPropertyValue("float")
    if (floatProperty !== 'none' && floatProperty !== '') {
      return floatProperty
    }
    return false;
  }
  const effectElements = Array.from(document.querySelectorAll<HTMLElement>(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    let alignment: string | undefined;
    if (getFloat(elem)) {
      alignment = getFloat(elem) as string
    } else if (elem.firstElementChild !== null && getFloat(elem.firstElementChild)) {
      alignment = getFloat(elem.firstElementChild) as string
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

function addEffects(type?: string): void {
  const effectElements = Array.from(document.querySelectorAll<HTMLElement>(`[class*="${effectCSSPrefix}"]`));
  effectElements.forEach((elem) => {
    const effects: EffectCommand[] = [], triggers: string[][] = [];
    Array.from(elem.classList).forEach(cls => {
      const effect = parseClass(cls, effectCSSPrefix)
      if ((effect[0] in functionMap)) {
        effects.push({name: effect[0], target: elem, args: effect.slice(1)})
        const init = functionMap[effect[0]].meta.init;
        if (init !== undefined) {
          init.apply(elem, effect.slice(1))
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
        let triggerFunction: EffectFunc = functionMap[trigger[0]].func
        const triggered = functionMap[trigger[0]].meta.triggered;
        if (type === "trigged" && triggered !== undefined) {
          triggerFunction = triggered
          console.log("Replaces scroll with inView trigger")
        }
        triggerFunction.apply(elem, [effects, ...trigger.slice(1)])
      });
    }
  });

}

function exec(cmd: EffectCommand): unknown {
  if (!(cmd.name in functionMap)) {
    return
  }
  return functionMap[cmd.name].func.apply(cmd.target, cmd.args)
}

function parseClass (cls: string, prefix: string): string[] {
  if (cls.startsWith(prefix)) {
    const str = cls.replace(prefix, "")
    return splitClass(str)
  }
  return []
}

function splitClass(str: string): string[] {
  const result: string[] = [];
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

function _getScrollReference(start: HTMLElement, reference?: HTMLElement): HTMLElement | undefined {
  if (reference === undefined) {
    let context = start
    while (context.parentElement !== null) {
      const computedStyle = window.getComputedStyle(context)
      if (computedStyle.getPropertyValue("scroll-snap-align") || computedStyle.getPropertyValue("scroll-snap-stop")) {
        return context
      } else {
        context = context.parentElement
      }
    }
  }
  return undefined;
}

/* Animation utils */
function getAlignment(elem: HTMLElement | undefined): string | undefined {
  let alignment: string | undefined
  if (elem === undefined) {
    throw new Error(`Element or classList is undefined for ${elem}`);
  }
  elem.classList.forEach(cls => {
    if (cls.startsWith(scrollAlignmenPrefix)) {
      alignment =  cls.replace(scrollAlignmenPrefix, "")
    }
  });
  return alignment;
}

function _disableTransition(elem: HTMLElement, func: () => void): void {
  const computedStyle = window.getComputedStyle(elem)
  const transition = computedStyle.getPropertyValue("transition")
  elem.style.transition = ""
  func()
  elem.style.transition = transition
}

/* Trigger functions */
function defaultTriggerFunc(this: HTMLElement, effects?: EffectCommand | EffectCommand[]): void {
  const effectList = effects === undefined ? [] : Array.isArray(effects) ? effects : [effects];
  effectList.forEach(effect => {
    exec(effect)
  });
}

function inViewTrigger(this: HTMLElement, effects?: EffectCommand[], offset: string = '0px'): void {
  if ((typeof offset === "string") && !offset.endsWith('px')) {
    offset = '0px'
  }

  if (offset && !Number.isNaN(Number(offset))) {
    offset += "%";
  }

  inView(this, (_element) => {
    if (effects !== undefined) {
      effects.forEach(effect => {
        if (effect !== undefined) {
          exec(effect)
        }
      });
    }
  }, { margin: `0px ${offset} 0px 0px` as InViewOptionsArg["margin"] })
}

function scrollTrigger(this: HTMLElement, effects?: EffectCommand[], targetOffset: string | number | null = null, containerOffset: string | number | null = null, targetEndOffset: string | number | null = null, containerEndOffset: string | number | null = null): void {
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
            if (!Number.isNaN(Number(targetOffset))) {
              targetOffset = `${targetOffset}%`;
            }
            if (!Number.isNaN(Number(containerOffset))) {
              containerOffset = `${containerOffset}%`;
            }

            offset = [`${targetOffset} ${containerOffset}`]
          }

          if (targetEndOffset !== null && containerEndOffset !== null) {
            if (!Number.isNaN(Number(targetEndOffset))) {
              targetEndOffset = `${targetEndOffset}%`;
            }
            if (!Number.isNaN(Number(containerEndOffset))) {
              containerEndOffset = `${containerEndOffset}%`;
            }

            offset.push(`${targetEndOffset} ${containerEndOffset}`)
          }

          const animation = exec(effect)
          if (animation === undefined || animation === null) {
            return
          }
          scroll(animation as AnimationPlaybackControls, {
            target: this,
            offset: offset as ScrollOptionsArg["offset"]
          })
        }
    });
  }
}

/* Animation functions */

function fade (this: HTMLElement, direction: string = 'in', duration: string | number = 1000): AnimationPlaybackControls {
  const computedStyle = window.getComputedStyle(this)
  let opacity
  if (direction === 'in' || computedStyle.getPropertyValue("opacity") !== "1") {
    opacity = 1
  } else {
    opacity = 0
  }

  return animate(this, { opacity: opacity }, { duration: Number(duration) / 1000 })
}

function shiftHorizontal(this: HTMLElement, direction: string = 'in', distance: string | number = "10%", safe: string | boolean = false, duration: string | number = 1000): AnimationPlaybackControls | undefined {
  const alignment = getAlignment(this);
  if (distance && !Number.isNaN(Number(distance))) {
    distance = `${distance}%`;
  }
  if (alignment === "center" && safe) {
    return undefined
  }
  let translatePos: (string | number)[]
  if (direction === 'in' && alignment === 'right') {
    translatePos = [0, `-${distance}`]
  } else if (direction === 'out' && alignment === 'left') {
    translatePos = [0, `-${distance}`]
  } else if (direction === 'in' && alignment === 'left') {
    translatePos = [0, `${distance}`]
  } else if (direction === 'out' && alignment === 'right') {
    translatePos = [0, `${distance}`]
  } else {
    return undefined
  }

  return animate(this, { translate: translatePos }, { duration: Number(duration) / 1000 })
}

function translateHorizontal (this: HTMLElement, direction: string = 'in', duration: string | number = 1000): AnimationPlaybackControls {
  const random = ['-100%', '100%'][(Math.random() < 0.5) ? 1 : 0]
  const alignment = getAlignment(this);
  let translatePos: (string | number)[]

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
    throw new Error(`Unhandled alignment '${direction}' for ${this}`);
  }
  return animate(this, { translate: translatePos }, { duration: Number(duration) / 1000 })
}

function scale (this: HTMLElement, direction: string = 'in', factor: string | number = 200, duration: string | number = 1000): AnimationPlaybackControls {
  const alignment = getAlignment(this);
  const origin: Record<string, string> = {};
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

  return animate(this, { ...origin, scale: Number(factor) / 100 }, { duration: Number(duration) / 1000 })
}

function blur(this: HTMLElement, radius: string | number = 5, duration: string | number = 1000): AnimationPlaybackControls {
  if (!String(radius).match(/.+\w{2,3}$/gm)) {
    radius = `${radius}px`;
  }
  return animate(this, { filter: `blur(${radius})` }, { duration: Number(duration) / 1000 })
}

function textBackground(this: HTMLElement, background: string = '#fff', scale: string | number = 1.05, duration: string | number = 1000): AnimationPlaybackControls {
  const currentBackground = window.getComputedStyle(this).getPropertyValue('--page-background');
  return animate(this, { scale: scale, background: [currentBackground, background] }, { duration: Number(duration) / 1000 })
}

function textEmphasis(this: HTMLElement, scale: string | number = 1.05, duration: string | number = 1000): AnimationPlaybackControls {
  return animate(this, { scale: scale }, { duration: Number(duration) / 1000 })
}


function textShadow (this: HTMLElement, x: string | number = 10, y: string | number = 10, blur: string | number = 10, color: string = "#fff", duration: string | number = 1000): AnimationPlaybackControls {
  return animate(this, { textShadow: `${x}px ${y}px ${blur}px ${color}` }, { duration: Number(duration) / 1000 })
}

function addClass(this: HTMLElement, cls: string): void {
  this.classList.add(cls)
}
