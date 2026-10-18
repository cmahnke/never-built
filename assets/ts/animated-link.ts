import { cloneElement } from './html/lib';

export const defaultTransitionMs = 800;
const ignoreProperties = ["overflow", "word-break", "letter-spacing", "text-shadow", "transition", "transform", "background"];
export const overlayClassName = "animated-link-overlay";
export const animationClassName = "animate";
import {detect} from 'detect-browser';

export const defaultAllowedPrefetch = ['localhost', 'wikipedia.org', 'projektemacher.org', 'christianmahnke.de', 'goettingen.xyz']

export function addPrefetch(url: string, allowedPrefetch?: string[]): void {
  if (!url.startsWith('/') && !url.startsWith('//') && !url.startsWith('http')) {
    return;
  }
  if (url.includes('/404')) {
    return
  }
  if (allowedPrefetch !== undefined && !url.startsWith('/')) {
    const parsed = URL.parse(url);
    if (parsed === null || !allowedPrefetch.filter(domain => { return parsed.hostname.endsWith(domain) }).length) {
      return
    }
  }
  const head = document.querySelector('head');
  const prefetch = `<link rel="prefetch" href="${url}" as="document">`;
  if (head && !head.querySelector(`link[href="${url}"]`)) {
    head.insertAdjacentHTML('beforeend', prefetch);
  }
}

function addOverlay(elem: Element, cls: string, additionalClasses: string): void {
  const body = document.querySelector('body');
  const overlay = document.createElement("div");
  overlay.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  })
  const container = document.createElement("div");
  overlay.classList.add(cls);
  if (additionalClasses !== undefined && additionalClasses !== "") {
    additionalClasses.split(" ").forEach(cls => {
      overlay.classList.add(cls)
    });
  }
  container.classList.add(`container`);
  container.appendChild(elem)
  overlay.appendChild(container)
  if (body) {
    body.insertAdjacentElement('beforeend', overlay);
  }
}

function bodyLinkHandler(e: Event, timeout: number = defaultTransitionMs): void {
  e.preventDefault();
  const target = e.target as HTMLElement;
  let animatedElement: Element = target
  let additionalClasses = "";
  if (target.classList.contains('readmore')) {
    const headingContainer = target.closest(':has(h1), :has(h2)');
    const heading = headingContainer?.querySelector<HTMLElement>('h1 a, h2 a');
    if (heading) {
      animatedElement = heading
      if (heading.dataset.animationClasses) {
        additionalClasses += " " + heading.dataset.animationClasses;
      }
    }
  }
  const anchor = target.closest<HTMLAnchorElement>('a');
  if (anchor === null) {
    return;
  }

  if (target.dataset.animationClasses) {
    additionalClasses = target.dataset.animationClasses;
  }
  if (anchor.dataset.animationClasses) {
    additionalClasses += " " + anchor.dataset.animationClasses;
  }
  const clone = cloneElement(animatedElement, ignoreProperties);
  addOverlay(clone, overlayClassName, additionalClasses.trim());
  setTimeout(function(){ clone.classList.add(animationClassName) }, 2);
  const callback = () => {
    const href = anchor.getAttribute('href');
    if (href !== null) {
      window.location.href = href;
    }
  }
  setTimeout(callback, timeout);
}

function menuLinkHandler(e: Event, timeout: number = defaultTransitionMs): void {
  /*
  const browser = detect();
  if (browser && browser.name === 'firefox') {
    return;
  }
  */
  e.preventDefault();
  const anchor = e.target instanceof HTMLElement ? e.target.closest<HTMLAnchorElement>('a') : null;
  document.querySelector('.header .menu')?.classList.add('animate');

  const callback = () => {
    const href = anchor?.getAttribute('href');
    if (href !== null && href !== undefined) {
      window.location.href = href;
    }
  }
  setTimeout(callback, timeout);
}

export function setupAnimatedLinks(links: HTMLElement[]): void {
  /*
  const browser = detect();
  if (browser && browser.name === 'firefox') {
    return;
  }
  */

  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (href !== null) {
      addPrefetch(href, defaultAllowedPrefetch);
    }
    link.addEventListener("click", (event) => {
      bodyLinkHandler(event);
    });
  });
}

export function setupAnimatedMenu(links: HTMLElement[]): void {
  links.forEach((link) => {
    const href = link.getAttribute('href');
    if (href !== null) {
      addPrefetch(href);
    }
    link.addEventListener("click", (event) => {
      menuLinkHandler(event);
    });
  });
}
