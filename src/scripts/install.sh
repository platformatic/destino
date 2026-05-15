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
  unzip -q doomgeneric.zip
  mv doomgeneric-master doomgeneric
  rm doomgeneric.zip
}

opentui () {
  PLATFORM=$(node -e "console.log(process.platform === 'darwin' ? 'macos' : 'linux')")
  ARCH=$(node -e "console.log(process.arch === 'arm64' ? 'aarch64' : 'x86_64')")
  SUFFIX=$(node --no-warnings --experimental-ffi -e "console.log(require('node:ffi').suffix)")
  ZIG_VERSION=0.15.2

  # Download Zig
  curl -sSL -o zig.tar.xz https://ziglang.org/download/$ZIG_VERSION/zig-$ARCH-$PLATFORM-$ZIG_VERSION.tar.xz
  tar -xf zig.tar.xz
  rm zig.tar.xz

  # Download OpenTUI
  curl -sSL -o opentui.zip https://github.com/anomalyco/opentui/archive/refs/heads/main.zip
  unzip -q opentui.zip
  mkdir opentui
  rm opentui.zip

  # Patch and build OpenTUI
  cd opentui-main/packages/core/src/zig
  sed -i.bak 's/const OUTPUT_BUFFER_SIZE = 1024 \* 1024 \* 2;/const OUTPUT_BUFFER_SIZE = 1024 * 1024 * 16;/' renderer.zig
  ../../../../../zig-$ARCH-$PLATFORM-$ZIG_VERSION/zig build -Doptimize=ReleaseFast

  cd ../../../../..
  mv opentui-main/packages/core/src/zig/lib/$ARCH-$PLATFORM/libopentui.$SUFFIX opentui
  rm -rf opentui-main zig-$ARCH-$PLATFORM-$ZIG_VERSION
}

freedoom () {
  curl -sSL -o freedoom.zip https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
  unzip -q freedoom.zip
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