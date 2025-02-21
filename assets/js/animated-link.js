
function addPrefetch(url) {
  const head = document.querySelector('head');
  const prefetch = `<link rel="prefetch" href="${url}" as="document">`;
  head.insertAdjacentHTML('beforeend', prefetch);
}

//TODO: Pass function or class
function delayClick(elem, timeout) {
  elem.addEventListener('click', (e) => {
    elem.classList.add('delayed-click');
    setTimeout(() => {
      //
    }, timeout);
  });
}

const defaultTransitionMs = 500;

export function setupAnimatedLinks() {

  document.querySelectorAll('a.click-animation').forEach((link) => {
    var transition;
    if (link.dataset.transition !== undefined ) {
      transition = link.dataset.transition;
    } else {
      transition = defaultTransitionMs;
    }

    if (myDiv.dataset.class !== undefined ) {
      var transition;

    }

    if (link.hasAttribute('href')) {
      addPrefetch(link.getAttribute('href'));
    }
  });

}
