#!/usr/bin/env python3

import os
import sys
import glob
import json
import argparse
import logging
from pathlib import Path

import cv2
import numpy as np
import torch
import pyvips
from huggingface_hub import hf_hub_download
from ultralytics.models.sam import SAM3SemanticPredictor

CONTENT_PATH = "./content/post"
IMAGE_META_FILE = "images.json"

SCRIPT_DIR = Path(__file__).resolve().parent
CONTENT_DIR = (SCRIPT_DIR / ".." / ".." / ".." / CONTENT_PATH).resolve()

logger = logging.getLogger("outline")

if torch.cuda.is_available():
    compute_device = "cuda"
elif torch.backends.mps.is_available():
    compute_device = "mps"
else:
    compute_device = "cpu"

model_file = hf_hub_download(repo_id="1038lab/sam3", filename="sam3.pt")

overrides = dict(
    conf=0.25,
    task="segment",
    mode="predict",
    model=model_file,
    device=compute_device,
    verbose=False,
    save=False,
)


def find_directories(start, file_name):
    pattern = f"{start}/**/{file_name}"
    logger.debug(f"Looking for directory pattern: {pattern}")
    files = glob.glob(pattern, recursive=True)
    dirs = []
    for f in files:
        dirs.append(Path(f).parent)
    return dirs


def read_dir(directory):
    meta = Path(directory) / IMAGE_META_FILE
    try:
        with open(meta, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read {meta}, might be malformed: {e}")
        sys.exit(10)


def merge_masks(tensors):
    merged = torch.any(torch.stack(tensors), dim=0)
    return merged.byte() * 255


def vips_to_numpy(vips_img: pyvips.Image) -> np.ndarray:
    if vips_img.bands == 4:
        vips_img = vips_img[0:3]
    elif vips_img.bands == 1:
        vips_img = vips_img.bandjoin([vips_img, vips_img])

    if vips_img.format != 'uchar':
        vips_img = vips_img.cast('uchar')

    np_arr = np.ndarray(
        buffer=vips_img.write_to_memory(),
        dtype=np.uint8,
        shape=[vips_img.height, vips_img.width, vips_img.bands]
    )
    return np_arr


def detect_region(vips_img, search_terms, crop_box=None):
    try:
        if crop_box:
            x, y, w, h = crop_box
            # Clamp coordinates to image boundaries
            x = max(0, min(x, vips_img.width - 1))
            y = max(0, min(y, vips_img.height - 1))
            w = min(w, vips_img.width - x)
            h = min(h, vips_img.height - y)

            if w <= 0 or h <= 0:
                logger.error(f"Invalid crop dimensions: x={x}, y={y}, w={w}, h={h}")
                return None

            vips_img = vips_img.crop(x, y, w, h)

        np_img = vips_to_numpy(vips_img)
    except Exception as e:
        logger.error(f"Failed to process region with pyvips: {e}")
        return None

    predictor = SAM3SemanticPredictor(overrides=overrides)
    predictor.set_image(np_img)
    results = predictor(text=search_terms)

    if results and results[0].masks is not None:
        mask_tensor = results[0].masks.data
        mask_list = [mask_tensor[i] for i in range(mask_tensor.shape[0])]
        final_mask = merge_masks(mask_list)
        return final_mask

    logger.warning("No masks returned for region.")
    return None


def mask_to_svg_solid(mask, output_file="shape.svg", merge_distance=0):
    if mask is None:
        return None

    if isinstance(mask, torch.Tensor):
        mask = mask.cpu().numpy()

    if mask.dtype != np.uint8:
        mask = (mask > 0).astype(np.uint8) * 255

    if merge_distance > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (merge_distance, merge_distance))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        mask = np.zeros_like(mask)
        cv2.drawContours(mask, contours, -1, 255, thickness=cv2.FILLED)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    height, width = mask.shape
    svg_header = f'<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">'
    paths = []

    for cnt in contours:
        points = cnt.reshape(-1, 2)
        if len(points) > 2:
            d = f"M {points[0][0]} {points[0][1]} " + " ".join([f"L {p[0]} {p[1]}" for p in points[1:]]) + " Z"
            paths.append(f'<path d="{d}" fill="black" stroke="none"/>')

    svg_content = svg_header + "".join(paths) + "</svg>"
    with open(output_file, "w") as f:
        f.write(svg_content)

    logger.debug(f"Generated SVG file: {output_file}")
    return svg_content


def main() -> None:
    parser = argparse.ArgumentParser(
        description="A tool to generate image outlines using SAM3 text prompts",
        formatter_class=argparse.RawTextHelpFormatter
    )

    group = parser.add_mutually_exclusive_group(required=False)
    group.add_argument('-i', '--input', help="The single input image file.")
    group.add_argument('-a', '--auto', action="store_true", help="Directory traversal mode (default behavior).")

    parser.add_argument('-o', '--output', help="The path for the output file (used only with -i).")
    parser.add_argument('-s', '--search', nargs='+', default=["building"], help="Search term(s) for SAM3 (e.g. -s building car)")
    parser.add_argument('-d', '--debug', action="store_true", help="Enable debug mode.")
    args = parser.parse_args()

    log_level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    is_auto_mode = args.auto or (args.input is None)

    if is_auto_mode and args.output:
        parser.error("Argument -o/--output can only be used with single input mode (-i/--input).")

    logger.info(f"Using compute device: {compute_device}")
    logger.info(f"Search terms: {args.search}")

    if is_auto_mode:
        logger.info("Starting automatic directory traversal mode.")
        image_dirs = find_directories(CONTENT_DIR, IMAGE_META_FILE)
        for directory in image_dirs:
            logger.debug(f"Processing directory: {directory}")
            post_images = read_dir(directory)
            for img_data in post_images:
                image_file = os.path.join(directory, img_data["image"])
                if not os.path.isfile(image_file):
                    logger.error(f"File {image_file} not found, skipping!")
                    continue

                try:
                    # Access mode "random" allows multiple crop operations on same handle
                    vips_img = pyvips.Image.new_from_file(str(image_file), access="random")
                except Exception as e:
                    logger.error(f"Failed to load image {image_file} with pyvips: {e}")
                    continue

                areas = img_data.get("areas", [])
                if areas:
                    for area in areas:
                        area_name = area.get("name", "unnamed_area")
                        pos = area.get("position", {})
                        size = area.get("size", {})
                        crop_box = (pos.get("x", 0), pos.get("y", 0), size.get("x", 0), size.get("y", 0))

                        logger.info(f"Processing area '{area_name}' in {image_file}")
                        mask = detect_region(vips_img, args.search, crop_box=crop_box)
                        output_path = os.path.join(directory, f"{area_name}.svg")
                        mask_to_svg_solid(mask, output_path)
                else:
                    logger.info(f"Processing full image {image_file}")
                    mask = detect_region(vips_img, args.search)
                    output_path = os.path.join(directory, f"{Path(img_data['image']).stem}.svg")
                    mask_to_svg_solid(mask, output_path)
    else:
        logger.info(f"Processing single file mode: {args.input}")
        if not os.path.isfile(args.input):
            logger.error(f"Input file {args.input} not found!")
            sys.exit(1)

        try:
            vips_img = pyvips.Image.new_from_file(str(args.input), access="random")
        except Exception as e:
            logger.error(f"Failed to load {args.input}: {e}")
            sys.exit(1)

        mask = detect_region(vips_img, args.search)
        output_path = args.output if args.output else f"{Path(args.input).stem}.svg"
        mask_to_svg_solid(mask, output_path)


if __name__ == "__main__":
    main()
