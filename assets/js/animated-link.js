export const defaultTransitionMs = 800;
export const overlayClassName = "animated-link-overlay";
export const animationClassName = "animate";

export function addPrefetch(url) {
  const head = document.querySelector('head');
  const prefetch = `<link rel="prefetch" href="${url}" as="document">`;
  head.insertAdjacentHTML('beforeend', prefetch);
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
    additionalClasses.split(/(\s+)/).forEach(cls => {
      overlay.classList.add(cls)
    });
  }
  container.classList.add(`container`);
  container.appendChild(elem)
  overlay.appendChild(container)
  body.insertAdjacentElement('beforeend', overlay);
}

function cloneElem(elem) {
  const ignoreProperties = ["overflow", "word-break", "letter-spacing", "text-shadow", "transition", "transform"];
  if (elem.firstElementChild) {
    throw new Error("Cloning with CSS only works for nodes without child elements!");
  }
  const clone = elem.cloneNode(true);
  const compStyles = window.getComputedStyle(elem);
  Array.from(compStyles).forEach(key => {
    if (!key.startsWith('animation') && !key.startsWith("-") && !ignoreProperties.includes(key)) {
      clone.style.setProperty(key, compStyles.getPropertyValue(key)) //, compStyles.getPropertyPriority(key)
    }
  });

  clone.style.setProperty("position", "absolute", "important")
  clone.style.setProperty("z-index", 1001, "important")
  clone.style.setProperty("display", "block", "important")
  const pos = elem.getBoundingClientRect();
  clone.style.setProperty("top", `${pos.top}px`);
  clone.style.setProperty("left", `${pos.left}px`);
  clone.style.setProperty("width", `${pos.width}px`);
  clone.style.setProperty("height", `${pos.height}px`);
  return clone;
}

function bodyLinkHandler(e, timeout) {
  e.preventDefault();
  if (timeout === undefined) {
    timeout = defaultTransitionMs;
  }
  const anchor = e.target.closest('a');
  var additionalClasses;
  if (e.target.dataset.animationClasses) {
    additionalClasses = e.target.dataset.animationClasses;
  }
  const clone = cloneElem(e.target);
  addOverlay(clone, overlayClassName, additionalClasses);
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
      addPrefetch(link.getAttribute('href'));
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
