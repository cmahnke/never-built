#!/usr/bin/env python

from PIL import Image, ImageDraw
import argparse, pathlib, json, sys, math, glob, os
from pathlib import Path
import traceback
from packaging import version
from termcolor import cprint
import numpy as np
import cv2
import pywt

image_meta = "images.json"
default_dir = "content/post"
weights_dir = "./weights"
model = None
debug = True

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

        if not os.path.isfile(image_file):
            cprint(f"File {image_file} not found, skipping!", "red")
            continue
        im = Image.open(image_file)
        if "areas" in image_meta:
            for area in image_meta["areas"]:
                name = os.path.join(dir, f"{area["name"]}.jpg")
                left = area['position']['x']
                top = area['position']['y']
                right = area['size']['x'] + area['position']['x']
                bottom = area['size']['y'] + area['position']['y']
                a = im.crop((left, top, right, bottom))

                if Path(name).is_file():
                    continue

                if "postprocess" in area:
                    for p in area["postprocess"]:
                        try:
                            cprint(f"trying to run {p} on area of {image_file}", "yellow")
                            if isinstance(p, str):
                                a = globals()[p](a)
                            elif isinstance(p, dict):
                                a = globals()[p["function"]](a, params=p['params'])

                            if a.mode == "L":
                                a = a.convert('RGB')
                        except Exception as e:
                            st = traceback.format_exc()
                            cprint(f"failed to call preprocessor {p}: {str(e)}\n{st}", "red")

                with open(name, 'w') as f:
                    a.save(f)
                    gitignore(dir, name)

def smoothen(im, params=None):
    if im.mode == "RGBA":
        im = im.convert('RGB')
    image = np.asarray(im)
    blur = cv2.bilateralFilter(image, 11, 115, 115)
    return Image.fromarray(blur)

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

    if bgr_img is not None:
        lab = cv2.cvtColor(safe_bgr(bgr_img), cv2.COLOR_BGR2LAB)
    elif rgb_img is not None:
        lab = cv2.cvtColor(safe_rgb(rgb_img), cv2.COLOR_RGB2LAB)
    else:
        raise ValueError("No valid input image")

    l_channel, a, b = cv2.split(lab)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
    cl = clahe.apply(l_channel)

    limg = cv2.merge((cl,a,b))

    enhanced_img = cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)

    return enhanced_img

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
def enhance_ai(img, params=None, factor=4):
    global model
    def cached_download_stub(config_file_url, cache_dir="", force_filename=""):
        hf_hub_download(config_file_url, cache_dir=cache_dir, force_filename=force_filename)


    import torch

    from torchvision.transforms.functional import rgb_to_grayscale
    #import torchvision

    import types, sys
    functional_tensor_mod = types.ModuleType('functional_tensor')
    functional_tensor_mod.rgb_to_grayscale = rgb_to_grayscale

    import huggingface_hub
    #huggingface_hub.cached_download = types.FunctionType('cached_download', global())
    huggingface_hub.cached_download = cached_download_stub

    sys.modules.setdefault('torchvision.transforms.functional_tensor', functional_tensor_mod)
    sys.modules.setdefault('huggingface_hub', huggingface_hub)

    from RealESRGAN import RealESRGAN

    if img.mode in ("RGBA", "L"):
        img = img.convert('RGB')

    #device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    device = torch.device('mps' if torch.mps.is_available() else 'cpu')

    if model is None:
        model = RealESRGAN(device, scale=factor)
        model.load_weights(os.path.join(weights_dir, f"RealESRGAN_x{factor}.pth"))

    with torch.no_grad():
        output_image = model.predict(img)

    width, height = output_image.size
    output_image.resize((int((1/factor)*width), (int((1/factor)*height))))

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
