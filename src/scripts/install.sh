#!/bin/bash

set -x -e

if [[ "$(uname -s)" == "Darwin" ]]; then
  brew install pkg-config sdl2_mixer
else 
  sudo apt install clang make pkg-config libsdl2-mixer-dev
fi

mkdir -p deps
cd deps

curl -sSL -o doomgeneric.zip https://github.com/ozkl/doomgeneric/archive/refs/heads/master.zip
curl -sSL -o freedoom.zip https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
curl -sSL -o GeneralUser.sf2 https://github.com/mrbumpy409/GeneralUser-GS/raw/refs/heads/main/GeneralUser-GS.sf2

unzip doomgeneric.zip
mv doomgeneric-master doomgeneric
unzip freedoom.zip
mv freedoom-0.13.0 freedoom
rm *.zip

