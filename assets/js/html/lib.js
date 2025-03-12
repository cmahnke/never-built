export const defaultIgnoreProperties = ["overflow", "word-break", "letter-spacing", "text-shadow", "transition", "transform", "background"];

export function cloneElement(elem, ignoreProperties, recursive) {
  if (ignoreProperties === undefined) {
    ignoreProperties = defaultIgnoreProperties;
  }

  if ((recursive !== undefined && recursive !== false) || recursive === undefined) {
    if (elem.firstElementChild) {
      throw new Error("Cloning with CSS only works for nodes without child elements!");
    }
  } else {
    throw new Error("Recursive cloning isn't immplemented yet!");
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
