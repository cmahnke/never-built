import { cloneElement } from './html/lib';

export const defaultTransitionMs = 800;
const ignoreProperties = ["overflow", "word-break", "letter-spacing", "text-shadow", "transition", "transform", "background"];
export const overlayClassName = "animated-link-overlay";
export const animationClassName = "animate";

export const defaultAllowedPrefetch = ['localhost', 'wikipedia.org', 'projektemacher.org', 'christianmahnke.de', 'goettingen.xyz']

export function addPrefetch(url, allowedPrefetch) {
  if (!url.startsWith('/') && !url.startsWith('//') && !url.startsWith('http')) {
    return;
  }
  if (allowedPrefetch !== undefined && !url.startsWith('/')) {
    const parsed = URL.parse(url);
    if (!allowedPrefetch.filter(domain => { return parsed.hostname.endsWith(domain) }).length) {
      return
    }
  }
  const head = document.querySelector('head');
  const prefetch = `<link rel="prefetch" href="${url}" as="document">`;
  if (!head.querySelector(`link[href="${url}"]`)) {
    head.insertAdjacentHTML('beforeend', prefetch);
  }
}

function addOverlay(elem, cls, additionalClasses) {
  const body = document.querySelector('body');
  const overlay = document.createElement("div");
  overlay.addEventListener("pointerdown", (event) => {
    e.preventDefault();
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
  body.insertAdjacentElement('beforeend', overlay);
}

function bodyLinkHandler(e, timeout) {
  e.preventDefault();
  if (timeout === undefined) {
    timeout = defaultTransitionMs;
  }
  let animatedElement = e.target
  let additionalClasses = "";
  if (e.target.classList.contains('readmore')) {
    let heading = e.target.closest(':has(h1), :has(h2)');
    heading = heading.querySelector('h1 a, h2 a');
    if (heading !== undefined) {
      animatedElement = heading
      if (heading.dataset.animationClasses) {
        additionalClasses += " " + heading.dataset.animationClasses;
      }
    }
  }
  const anchor = e.target.closest('a');

  if (e.target.dataset.animationClasses) {
    additionalClasses = e.target.dataset.animationClasses;
  }
  if (anchor.dataset.animationClasses) {
    additionalClasses += " " + anchor.dataset.animationClasses;
  }
  const clone = cloneElement(animatedElement, ignoreProperties);
  addOverlay(clone, overlayClassName, additionalClasses.trim());
  setTimeout(function(){ clone.classList.add(animationClassName) }, 2);
  const callback = () => {
    window.location = anchor.getAttribute('href')
  }
  setTimeout(callback, timeout);
}

function menuLinkHandler(e, timeout) {
  e.preventDefault();
  if (timeout === undefined) {
    timeout = defaultTransitionMs;
  }
  const anchor = e.target.closest('a');
  document.querySelector('.header .menu').classList.add('animate');

  const callback = () => {
    window.location = anchor.getAttribute('href')
  }
  setTimeout(callback, timeout);
}

export function setupAnimatedLinks(links) {
  links.forEach((link) => {
    if (link.hasAttribute('href')) {
      addPrefetch(link.getAttribute('href'), defaultAllowedPrefetch);
    }
    link.addEventListener("click", (event) => {
      bodyLinkHandler(event);
    });
  });
}

export function setupAnimatedMenu(links) {
  links.forEach((link) => {
    if (link.hasAttribute('href')) {
      addPrefetch(link.getAttribute('href'));
    }
    link.addEventListener("click", (event) => {
      menuLinkHandler(event);
    });
  });
}
