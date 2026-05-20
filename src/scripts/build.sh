#!/bin/bash
# SPDX-License-Identifier: MIT

set -x -e

cmake -S . -B tmp
cmake --build tmp