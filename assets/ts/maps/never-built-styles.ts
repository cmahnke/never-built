import type {
  LngLatLike,
  StyleSpecification,
  FillLayerSpecification,
  LayerSpecification,
} from "maplibre-gl";
import { updateStyle as baseUpdateStyle } from "./styles";
import { ExtendedStyle } from "./styles";

export function updateStyle(
  style: StyleSpecification,
  url: string,
  initialzoom?: number,
  minzoom?: number,
  maxzoom?: number,
  bounds?: number[][],
  center?: LngLatLike,
  background?: string,
  sprites?: string,
  fontPath?: string,
  font?: string,
  attribution?: string,
): ExtendedStyle {
  const styleObj: ExtendedStyle = baseUpdateStyle(
    style,
    url,
    initialzoom,
    minzoom,
    maxzoom,
    bounds,
    center,
    background,
    sprites,
    fontPath,
    font,
    attribution,
  );

  // This fixes building outlines
  styleObj.layers.forEach((layer: LayerSpecification, index: number) => {
    if (layer.id === "building_pattern") {
      const fillLayer = layer as FillLayerSpecification;
      const newLayer: FillLayerSpecification = {
        ...fillLayer,
        paint: {
          ...fillLayer.paint,
          "fill-outline-color": [
            "interpolate",
            ["exponential", 1],
            ["zoom"],
            14,
            "rgba(0, 0, 0, 0)",
            15,
            "rgba(0, 0, 0, 1)",
          ],
        },
      };
      styleObj.layers[index] = newLayer as LayerSpecification;
    }
  });
  return styleObj;
}
