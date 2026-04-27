#!/bin/bash

set -x -e

cmake -S . -B tmp
cmake --build tmp