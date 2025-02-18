#!/usr/bin/env bash

TILES_DIR=./static/map

for IGNORE in `find content/post/ -name .gitignore` ;
do
  while read FILE;
  do
    echo "Deleting `dirname $IGNORE`/$FILE"
    rm -f "`dirname $IGNORE`/$FILE"
  done <$IGNORE
done

rm -r $TILES_DIR
