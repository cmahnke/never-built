#!/usr/bin/env bash
STYLE_URL=https://github.com/openmaptiles/maptiler-basic-gl-style/archive/refs/tags/v1.10.tar.gz
STYLE_DIR=./3d/public/map-styles

echo "See ../../scripts/get-map-tiles.sh"
exit 1

declare -a SPRITES=("https://openmaptiles.github.io/maptiler-basic-gl-style/sprite.json" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite@2x.json" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite.png" "https://openmaptiles.github.io/maptiler-toner-gl-style/sprite@2x.png")

if ! test -d "STYLE_DIR"; then
  mkdir -p $STYLE_DIR
  wget -O $STYLE_DIR/`basename $STYLE_URL` $STYLE_URL
  tar xzf $STYLE_DIR/`basename $STYLE_URL` -C $STYLE_DIR/
  rm $STYLE_DIR/*.tar.gz
  mv $STYLE_DIR/*/* $STYLE_DIR/
  rm $STYLE_DIR/*.md
  for SPRITE in "${SPRITES[@]}"
  do
    wget -P $STYLE_DIR/ "$SPRITE"
  done
else
  echo "Directory $STYLE_DIR exists."
fi
