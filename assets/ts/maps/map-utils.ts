import type { LngLatBoundsLike } from "maplibre-gl";
import type { TileMetadata } from "./@types/tile-metadata.d.ts";

export interface MarkerOptions {
  src: string;
  scale?: number;
  anchor?: [number, number];
}

export function bboxToBounds(
  bbox: string | (string | number)[],
): LngLatBoundsLike {
  let arr: (string | number)[];
  if (typeof bbox === "string") {
    arr = bbox.split(",");
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
  if (url.startsWith("http") || url.startsWith("//")) {
    return url;
  }
  let base = window.location.protocol + "//" + window.location.hostname;
  if (window.location.port !== "") {
    base += ":" + window.location.port;
  }
  return base + url;
}

export async function loadOrParse(
  str: object | string | null,
): Promise<unknown> {
  if (typeof str === "object" && str !== null) {
    return str;
  }

  try {
    return JSON.parse(str as string) as unknown;
  } catch {
    try {
      const response = await fetch(str as string);
      return (await response.json()) as unknown;
    } catch (err: unknown) {
      console.log(
        `Could not read JSON or fetch data from ${str}:`,
        String(err),
      );
      return undefined;
    }
  }
}

export async function getMapMetadata(
  url: string,
): Promise<TileMetadata> {
  const metadataFile = "metadata.json";
  if (url.includes("{")) {
    url = url.substring(0, url.indexOf("{"));
  }
  if (!url.endsWith(metadataFile) && !url.endsWith("/")) {
    url += "/" + metadataFile;
  } else if (!url.endsWith(metadataFile)) {
    url += metadataFile;
  }
  url = absUrl(url);
  return loadOrParse(url) as Promise<TileMetadata>;
}
