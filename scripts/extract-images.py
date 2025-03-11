#!/usr/bin/env python

from PIL import Image, ImageDraw, ImageFilter
import argparse, pathlib, json, sys, math, glob, os
import time
from pathlib import Path
import traceback
from packaging import version
from termcolor import cprint
import numpy as np
import cv2
import pywt

image_meta = "images.json"
default_dir = "content/post"
gitignore_file = ".gitignore"
weights_dir = "./weights"
model = None
debug = False
default_image_ext = ".jpg"

gitignore_file = os.path.join(default_dir, ".gitignore")

def find_directories(start, file):
    pattern = f"{start}/**/{file}"
    if debug:
        cprint(f"Looking for {pattern}", "yellow")
    files = glob.glob(pattern, recursive=True)
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

def gitignore(dir, file, gitignore_file = ".gitignore"):
    if str(pathlib.Path(gitignore_file).parent) == '.':
        gitignore_path = os.path.join(dir, gitignore_file)
        ignore_line = f"{pathlib.Path(file).name}\n"
    else:
        gitignore_path = gitignore_file
        rel_dir = os.path.relpath(dir, pathlib.Path(gitignore_file).parent)
        ignore_line = f"{os.path.join(rel_dir, pathlib.Path(file).name)}\n"

    if not os.path.isfile(gitignore_path):
        pathlib.Path(gitignore_path).touch()
    with open(gitignore_path, 'r') as gif:
        for line in gif:
            if line == ignore_line:
                return
    with open(gitignore_path, 'a') as gif:
        gif.write(ignore_line)
    #if debug:
    cprint(f"Wrote '{ignore_line}' to {gitignore_path}", "yellow")

def postprocess(image, processors, debug_str=""):
    for p in processors:
        try:
            cprint(f"Trying to run {p} on area of {debug_str}", "yellow")
            if isinstance(p, str):
                image = globals()[p](image)
            elif isinstance(p, dict):
                image = globals()[p["function"]](image, params=p['params'])

            if image.mode == "L":
                image = image.convert('RGB')
        except Exception as e:
            st = traceback.format_exc()
            cprint(f"Failed to call preprocessor {p}: {str(e)}\n{st}", "red")
            if debug:
                sys.exit(1)
            else:
                model = None
                break

    return image

def extract(meta, dir):
    global model

    def wrt(image, name, dir):
        with open(name, 'w') as f:
            image.save(f)
            cprint(f"Saved {name}", "green")
            gitignore(dir, name, gitignore_file)

    for image_meta in meta:
        image_file = os.path.join(dir, image_meta["image"])
        if str(image_file).endswith('.jxl'):
            from jxlpy import JXLImagePlugin

        if not os.path.isfile(image_file):
            cprint(f"File {image_file} not found, skipping!", "red")
            continue
        im = Image.open(image_file)
        if not "size" in image_meta:
            cprint(f"Missing size for {image_file}: \"size\": [{im.width}, {im.height}],", "yellow")
        else:
            if image_meta["size"][0] != im.width:
                cprint(f"Width is wrong for {image_file}: got {image_meta["size"][0]}, expected {im.width}", "red")
            if image_meta["size"][1] != im.height:
                cprint(f"Height is wrong for {image_file}: got {image_meta["size"][1]}, expected {im.height}", "red")
        if "areas" in image_meta:
            i = 1
            for area in image_meta["areas"]:
                name = os.path.join(dir, f"{area["name"]}{default_image_ext}")
                left = area['position']['x']
                top = area['position']['y']
                right = area['size']['x'] + area['position']['x']
                bottom = area['size']['y'] + area['position']['y']
                a = im.crop((left, top, right, bottom))

                if Path(name).is_file():
                    continue

                if "postprocess" in area:
                    a = postprocess(a, area["postprocess"], debug_str=f"{image_file}, area {i}")

                wrt(a, name, dir)
                i += 1
        elif "postprocess" in image_meta:
            im = postprocess(im, image_meta["postprocess"], debug_str=f"{image_file}")
            if "name" in image_meta:
                name = image_meta["name"]
            else:
                name = pathlib.Path(image_file).stem + default_image_ext
            wrt(a, name, dir)

def smoothen(im, params=None):
    if im.mode == "RGBA":
        im = im.convert('RGB')
    image = np.asarray(im)
    blur = cv2.bilateralFilter(image, 11, 115, 115)
    return Image.fromarray(blur)

def smoothen_median(im, params=None):
    if im.mode == "RGBA":
        im = im.convert('RGB')
    image = np.asarray(im)
    blur = cv2.medianBlur(image, 7)
    return Image.fromarray(blur)

def grayscale_simple(im, params=None):
    if im.mode == "RGBA":
        im = im.convert('RGB')
    if im.mode == "RGB":
        im = im.convert('L')
    return im

def contrast(im, params=None):
    if im.mode == "RGBA":
        im = im.convert('RGB')
    image = np.asarray(im)
    enhanced = output = clahe_contrast(rgb_img=image)
    return Image.fromarray(enhanced)

def clahe_contrast(bgr_img=None, rgb_img=None):
    def safe_rgb(cv_image):
        if(len(cv_image.shape) < 3):
            return cv2.cvtColor(cv_image, cv2.COLOR_GRAY2RGB)
        else:
            return cv_image

    def safe_bgr(cv_image):
        if(len(cv_image.shape) < 3):
            return cv2.cvtColor(cv_image, cv2.COLOR_GRAY2BGR)
        else:
            return cv_image

    if bgr_img is not None:
        lab = cv2.cvtColor(safe_bgr(np.asarray(bgr_img)), cv2.COLOR_BGR2LAB)
    elif rgb_img is not None:
        lab = cv2.cvtColor(safe_rgb(np.asarray(rgb_img)), cv2.COLOR_RGB2LAB)
    else:
        raise ValueError("No valid input image")

    l_channel, a, b = cv2.split(lab)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    cl = clahe.apply(l_channel)

    limg = cv2.merge((cl,a,b))

    enhanced_img = cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)

    return Image.fromarray(enhanced_img)

# See https://stackoverflow.com/q/57030125
def auto_brightness(im, params=None, minimum_brightness = 0.66):
    if isinstance(im, Image.Image):
        image = np.asarray(im)
    else:
        image = im
    cols, rows = image.shape
    brightness = np.sum(image) / (255 * cols * rows)
    ratio = brightness / minimum_brightness
    if ratio >= 1:
        print("Image already bright enough")
        return im

    image = cv2.convertScaleAbs(image, alpha = 1 / ratio, beta = 0)
    return Image.fromarray(image)


def white_balance(im, params=None):
    def get_patch (im):
        h, w = im.size
        (nw, nx) = (w / 3, w / 3)
        (nh, ny) = (h / 30, h / 30)
        return im.crop((nx, ny, nx + nw, ny + nh))

    mode = "mean"
    if im.mode == "RGBA":
        im = im.convert('RGB')
    image = np.asarray(im)
    image_patch = np.asarray(get_patch(im))
    if mode == 'mean':
        image_gt = ((image * (image_patch.mean() / image.mean(axis=(0, 1)))).clip(0, 255).astype(int))
    elif mode == 'max':
        image_gt = ((image * 1.0 / image_patch.max(axis=(0,1))).clip(0, 1))
    else:
        cprint("Mode not set! Failing!", 'red')

    return Image.fromarray(image_gt.astype('uint8'))

def normalize(im, params=None):
    cvAr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2GRAY)
    normalized = cv2.normalize(cvAr, None, beta=0, alpha=255, norm_type=cv2.NORM_MINMAX)
    return Image.fromarray(cv2.cvtColor(normalized, cv2.COLOR_GRAY2RGB))

# See https://www.kaggle.com/code/djokester/image-super-resolution-upscaling-with-real-esrgan
def enhance_ai(img, params=None, factor=4, smoothen=False, weights="RealESRGAN_x{factor}plus.pth"):
    start = time.time()
    global model
    from huggingface_hub import hf_hub_download
    def cached_download_stub(config_file_url, cache_dir="", force_filename=""):
        from RealESRGAN.model import HF_MODELS
        import re
        scale = re.sub(r'http.*_x(\d).pth', '\\1', config_file_url)
        repo = HF_MODELS[int(scale)]['repo_id']
        filename = HF_MODELS[int(scale)]['filename']
        if debug:
            cprint(f"Downloading {config_file_url} to {cache_dir} (repo: {repo}, filename: {filename})", "yellow")
        return hf_hub_download(repo, filename, cache_dir=cache_dir, force_filename=force_filename)

    import torch

    from torchvision.transforms.functional import rgb_to_grayscale

    import types, sys
    functional_tensor_mod = types.ModuleType('functional_tensor')
    functional_tensor_mod.rgb_to_grayscale = rgb_to_grayscale

    import huggingface_hub
    huggingface_hub.cached_download = cached_download_stub

    sys.modules.setdefault('torchvision.transforms.functional_tensor', functional_tensor_mod)
    sys.modules.setdefault('huggingface_hub', huggingface_hub)

    from RealESRGAN import RealESRGAN

    if img.mode in ("RGBA", "L"):
        img = img.convert('RGB')

    if torch.cuda.is_available():
        device = torch.device('cuda')
    #elif torch.mps.is_available():
    #    device = torch.device('mps')
    else:
        device = torch.device('cpu')

    if model is None:
        weight_file = weights.format(**{"factor": factor})
        model = RealESRGAN(device, scale=factor)
        model_path = os.path.join(weights_dir, weight_file)
        model.load_weights(os.path.abspath(model_path), download=False)

    with torch.no_grad():
        output_image = model.predict(img)

    if smoothen:
        output_image = output_image.filter(ImageFilter.SMOOTH)
    width, height = output_image.size
    output_image = output_image.resize((int((1/factor)*width), (int((1/factor)*height))), Image.LANCZOS)
    if debug:
        cprint(f"Scaled from {width}x{height} to {output_image.size[0]}x{output_image.size[1]}", "yellow")
    end = time.time()
    if debug:
        cprint(f"Processing took {(end-start) * 10**3}ms", "yellow")
    return output_image

def remove_halftone_grid_wavelet(img, params=None, wavelet='bior1.3', level=10, threshold=30):
    if img.mode in ("RGBA", "RGB"):
        img = img.convert('L')
    img = np.asarray(img)

    coeffs = pywt.wavedec2(img, wavelet, level=level) # Decompose the image

    # Threshold the high-frequency coefficients (detail coefficients)
    thresholded_coeffs = tuple(
        [pywt.threshold(c, value=threshold, mode='soft') if i > 0 else c for i, c in enumerate(level_coeffs)]
        for level_coeffs in coeffs
    )

    img_filtered = pywt.waverec2(thresholded_coeffs, wavelet) # Reconstruct the image

    img_filtered = np.abs(img_filtered).astype(np.uint8) # Convert and return
    return Image.fromarray(img_filtered.astype('uint8'))

def preview(image, params=None, size=(2048, 2048)):
    image.thumbnail(size)
    return image

def dehalftone(image, params=None, resize=None):

    def generate_grid(m, n):
        x = np.arange(-m/2, m/2) / m
        y = np.arange(-n/2, n/2) / n
        z = np.zeros((m, n))
        mask = np.zeros((m, n))
        for i in range(m-1):
            for j in range(n-1):
                z[i][j] = x[i] ** 2 + y[j] ** 2
        return z

    def generate_mask(m, n, a=1.0, b=.19):
        z = generate_grid(m, n)
        mask = a * np.exp(-np.pi*z / b**2)
        return mask


    if image.mode in ("RGBA", "RGB"):
        image = image.convert('L')
    image = np.asarray(image)

    w, h = image.shape

    if w % 2 > 0:
        image_bw = cv2.resize(image, (h, w-1))
    elif h % 2 > 0:
        image_bw = cv2.resize(image, (h-1, w))

    h, w = image.shape

    F = np.fft.fft2(image)
    F = np.fft.fftshift(F)

    mask = generate_mask(w, h)

    product = np.multiply(F.T, mask)

    ifft_product = np.fft.ifft2(product)
    ifft_mag = np.abs(ifft_product) ** 2

    normalized = ifft_mag.T / ifft_mag.max() * 255
    if(debug):
        cprint("Removed halftone grid", "green")
    output = normalized.astype('uint8')
#    if brightness:
#        print(output.shape)
#        rgb = cv2.cvtColor(output, cv2.COLOR_GRAY2RGB)
#        cprint(f"Adjusting contras / brightness {rgb.shape}", "yellow")
#
#        output = clahe_contrast(rgb_img=rgb)
    return Image.fromarray(output.astype('uint8'))

def main():
    global debug

    parser = argparse.ArgumentParser(description='Extract images')
    parser.add_argument('--dir', type=pathlib.Path, help='directory to process')
    parser.add_argument('--meta', type=pathlib.Path, help='File containing coordinates')
    parser.add_argument('--debug', '-d', help='Print information about JXL bindings', default=False, action='store_true')

    args = parser.parse_args()


    if args.debug:
        debug = True
        import jxlpy
        print("jxlpy: {}, libjxl: {}, pillow: {}".format(jxlpy.__version__, jxlpy._jxl_version, Image.__version__))

    if debug:
        import warnings
        warnings.simplefilter(action='ignore', category=FutureWarning)

    if not args.meta:
        if not args.dir:
            start = default_dir
        else:
            start = args.dir
        metas = find_directories(start, image_meta)
    else:
        metas = [args.meta]

    for dir in metas:
        meta = read_dir(dir)
        #print(dir, meta)
        cprint(f"Processing {str(dir)}", "green")
        extract(meta, dir)


if __name__ == "__main__":
    main()
