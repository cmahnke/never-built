#!/usr/bin/env bash

# See https://github.com/Lornatang/SRGAN-PyTorch

MODEL_DIR="./weights"

declare -a URLS=("https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/ESRGAN_SRx4_DF2KOST_official-ff704c30.pth" "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth" "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth")

mkdir -p $MODEL_DIR
for URL in "${URLS[@]}"
do
  OUTFILE=$MODEL_DIR/$(basename "$URL")
  echo "Downloading $URL to $OUTFILE"
  wget -nc -O "$OUTFILE" "$URL"
  if [[ "$URL" == *.tar ]] ; then
    tar xf "$OUTFILE" -C "$MODEL_DIR"
  fi
done
