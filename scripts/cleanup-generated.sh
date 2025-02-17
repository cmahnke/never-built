#!/usr/bin/env bash

for IGNORE in `find content/post/ -name .gitignore` ;
do
  while read FILE;
  do
    echo "Deleting `dirname $IGNORE`/$FILE"
    rm -f "`dirname $IGNORE`/$FILE"
  done <$IGNORE
done
