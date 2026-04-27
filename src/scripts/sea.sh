#!/bin/bash

set -x -e

  rolldown -c rolldown.config.js

if [[ "$(uname -s)" == "Darwin" ]]; then
  node --build-sea src/sea/macos.json
  codesign --sign - dist/destino
else 
  node --build-sea src/sea/linux.json
fi
