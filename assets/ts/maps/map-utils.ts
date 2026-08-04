
export function bboxToBounds(bbox: string | (string | number)[]): LngLatBoundsLike {
  let arr: (string | number)[];
  if (typeof bbox === 'string') {
    arr = bbox.split(',');
  } else {
    arr = bbox.flat();
  }
  const n = arr.map((e) => Number(e));
  return [
    [n[0], n[1]],
    [n[2], n[3]],
  ];
}

export function absUrl(url: string): string {
  if (url.startsWith('http') || url.startsWith('//')) {
    return url;
  }
  let base = window.location.protocol + '//' + window.location.hostname;
  if (window.location.port !== '') {
    base += ':' + window.location.port;
  }
  return base + url;
}

export function loadOrParse<T = unknown>(str: T | string): T | Promise<T | void> {
  if (typeof str === 'object') {
    return str as T;
  }
  try {
    // BUG (preserved from original): `json` was never actually passed in.
    return JSON.parse((globalThis as any).json) as T;
  } catch {
    return fetch(str as string)
      .then((response) => response.json() as Promise<T>)
      .catch((body) => {
        console.log(`Could not read JSON from ${str}` + body);
      })
      .catch(() => {
        console.log(`Could not read data from URL ${str}`);
      });
  }
}
