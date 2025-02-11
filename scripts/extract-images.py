#!/usr/bin/env python

from PIL import Image, ImageDraw
import argparse, pathlib, json, sys, math, glob, os
from packaging import version
from termcolor import cprint

image_meta = "images.json"
default_dir = "content/post"

def find_directories(start, file):
    files = glob.glob(f"{start}/**/{file}", recursive=True)
    dirs = []
    for f in files:
        dirs.append(pathlib.Path(f).parent)
    return dirs

def read_dir(dir):
    meta = pathlib.Path(os.path.join(dir, image_meta))
    try:
        return json.load(meta.open())
    except:
        cprint(f"Failed to read {str(meta)}, might be malformed", 'red')
        sys.exit(10)

def gitignore(dir, file):
    gitignore_file = ".gitignore"
    gitignore_path = os.path.join(dir, gitignore_file)
    if not os.path.isfile(gitignore_path):
        pathlib.Path(gitignore_path).touch()
    ignore_line = f"{pathlib.Path(file).name}\n"
    with open(gitignore_path, 'r') as gif:
        for line in gif:
            if line == ignore_line:
                return
    with open(gitignore_path, 'a') as gif:
        gif.write(ignore_line)


def extract(meta, dir):
    for image_meta in meta:
        image_file = os.path.join(dir, image_meta["image"])
        if str(image_file).endswith('.jxl'):
            from jxlpy import JXLImagePlugin

        im = Image.open(image_file)
        for area in image_meta["areas"]:
            name = os.path.join(dir, f"{area["name"]}.jpg")
            left = area['position']['x']
            top = area['position']['y']
            right = area['size']['x'] + area['position']['x']
            bottom = area['size']['y'] + area['position']['y']
            a = im.crop((left, top, right, bottom))

            if "postprocess" in area:
                for p in area["postprocess"]:
                    pass

            with open(name, 'w') as f:
                a.save(f)
                gitignore(dir, name)


def main():

    parser = argparse.ArgumentParser(description='Extract images')
    parser.add_argument('--dir', type=pathlib.Path, help='directory to process')
    parser.add_argument('--meta', type=pathlib.Path, help='File containing coordinates')
    parser.add_argument('--debug', '-d', help='Print information about JXL bindings', default=False, action='store_true')

    args = parser.parse_args()


    if args.debug:
        import jxlpy
        print("jxlpy: {}, libjxl: {}, pillow: {}".format(jxlpy.__version__, jxlpy._jxl_version, Image.__version__))

    if not args.meta:
        if not args.dir:
            start = "."
        else:
            start = args.dir
        metas = find_directories(start, image_meta)
    else:
        metas = [args.meta]

    for dir in metas:
        meta = read_dir(dir)
        extract(meta, dir)


if __name__ == "__main__":
    main()
