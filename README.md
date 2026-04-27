# Destino

Destino runs Doom in a terminal using Node.js, [`node:ffi`](https://nodejs.org/api/ffi.html), and [OpenTUI](https://github.com/sst/opentui).

The Doom engine is built from [doomgeneric](https://github.com/ozkl/doomgeneric) as a native shared library. Node.js owns the application loop, forwards terminal input to Doom, reads Doom's framebuffer through FFI, and asks OpenTUI to render it as terminal graphics.

Sound is delegated to DoomGeneric's SDL2 audio backend through SDL2_mixer; Node.js only coordinates the process and does not synthesize or mix audio itself.

## Architecture

The project is split into a small native platform layer and a JavaScript runtime:

1. `src/native/main.c` implements the platform callbacks required by `doomgeneric`, including input, timing, frame readiness, and framebuffer access.
2. `src/engine.js` loads the Doom shared library through `node:ffi` and exposes a small JavaScript wrapper around the native functions.
3. `src/input.js` parses terminal keyboard input, including Kitty keyboard protocol events, and maps configured keys to Doom key codes.
4. `src/opentui.js` loads OpenTUI's native library and renders Doom's framebuffer into the terminal.
5. `src/index.js` wires everything together and runs Doom at 35 Hz.

Rendering is pull-based: Doom marks a frame ready, JavaScript pulls the native framebuffer, scales it into a reusable buffer, and passes that buffer to OpenTUI. This avoids C-to-JS callbacks in the frame path.

## Requirements

You need:

1. A Node.js build with `node:ffi` support. At the time of writing this is not released yet and is expected in Node.js 26.1.0. Use a nightly after April 21, 2026, for example `v26.0.0-nightly20260421eb54e709c7`.
2. `cmake`, `clang`, and `pkg-config`.
3. SDL2_mixer development files.
4. `doomgeneric` sources under `deps/doomgeneric`.
5. A Doom-compatible WAD, such as `freedoom1.wad` from [Freedoom](https://freedoom.github.io/download.html).
6. An SF2 sound font, such as [GeneralUser GS](https://schristiancollins.com/generaluser.php).
7. A terminal with [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) support, used for reliable key press and release events.

## Installation

### Automatic

This is only supported on macOS or Ubuntu Linux.

```
npm install
npm run dependencies
```

### Manual

Install NPM dependencies:

```
npm install
```

On macOS, install native dependencies with:

```sh
brew install clang pkg-config sdl2_mixer
```

On Linux install SDL2 Mixer, clang, make and pkg-config according to your distribution package manager.

Download runtime assets and `doomgeneric` locally:

```sh
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
cd ..
```

## Building

Build the native Doom library:

```sh
npm run build
```

## Building a SEA executable

Destino can be packaged as a Node.js Single Executable Application (SEA) on macOS.

First install dependencies and build the native library:

```sh
npm install
npm run dependencies
npm run build
```

Then build the executable:

```sh
npm run sea
```

This bundles the JavaScript entry point, native libraries, WAD files, and SF2 sound font into `dist/destino`.
The SEA config also enables `--experimental-ffi` automatically, so the executable can be run directly:

```sh
./dist/destino
```

## Running the game

Destino reads configuration from `destino.json` in the current directory by default. If the file does not exist, it creates one and exits.

Run once to generate the config:

```sh
/path/to/node --experimental-ffi src/index.js
```

Update `wadPath` and `sf2Path` if they were not detected automatically, then run again:

```sh
/path/to/node --experimental-ffi src/index.js
```

You can also pass a custom config path as the first argument:

```sh
/path/to/node --experimental-ffi src/index.js ./foo.json
```

Controls are configured in `destino.json`. Press `Ctrl+C` to exit.

Default keybindings:

| Action        | Keys            |
| ------------- | --------------- |
| Move forward  | `w`, `up`       |
| Move backward | `s`, `down`     |
| Turn left     | `a`, `left`     |
| Turn right    | `d`, `right`    |
| Strafe left   | `q`, `,`        |
| Strafe right  | `e`, `.`        |
| Fire          | `space`, `ctrl` |
| Use           | `enter`         |
| Menu          | `escape`        |
| Pause         | `p`             |
| Confirm       | `enter`         |
| Abort         | `escape`        |
| Quit confirm  | `y`             |
| Quit abort    | `n`             |

## License

Apache-2.0 - See [LICENSE](LICENSE) for more information.
