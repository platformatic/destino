#!/bin/bash

set -x -e

step () {
  echo -e "\033[35m\033[1m--> $*\033[0m"
}

dependencies () {
  step "Dependencies"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    brew install pkg-config sdl2_mixer unzip
  else
    sudo apt -y update
    sudo apt -y install clang cmake pkg-config libsdl2-mixer-dev unzip
  fi
}

doomgeneric () {
  curl -sSL -o doomgeneric.zip https://github.com/ozkl/doomgeneric/archive/refs/heads/master.zip
  unzip doomgeneric.zip
  mv doomgeneric-master doomgeneric
  rm doomgeneric.zip
}

opentui () {
  PLATFORM=$(node -e "console.log(process.platform)")
  ARCH=$(node -e "console.log(process.arch)")
  SUFFIX=$(node --experimental-ffi -e "console.log(require('node:ffi').suffix)")

  ARCHIVE=$(curl -sSL https://registry.npmjs.org/@opentui/core-$PLATFORM-$ARCH/latest | yq .dist.tarball)
  curl -sSL -o opentui.tgz "$ARCHIVE"
  mkdir -p opentui
  tar zxf opentui.tgz --strip-components=1 -C opentui package/libopentui.$SUFFIX
  rm opentui.tgz
}

freedoom () {
  curl -sSL -o freedoom.zip https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
  unzip freedoom.zip
  mv freedoom-0.13.0 freedoom
  rm freedoom.zip

}

generalusersf2 () {
  curl -sSL -o GeneralUser.sf2 https://github.com/mrbumpy409/GeneralUser-GS/raw/refs/heads/main/GeneralUser-GS.sf2
}

rm -rf deps
mkdir -p deps
cd deps
dependencies
doomgeneric
opentui
freedoom
generalusersf2