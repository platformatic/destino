<!-- SPDX-License-Identifier: MIT -->

# Destino

Destino runs Doom in a terminal using Node.js, [`node:ffi`](https://nodejs.org/api/ffi.html), and [OpenTUI](https://github.com/sst/opentui)'s [Kitty Graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/) renderer.

The Doom engine is built from [doomgeneric](https://github.com/ozkl/doomgeneric) as a native shared library. Node.js owns the application loop, forwards terminal input to Doom, reads Doom's framebuffer through FFI, and renders it with Kitty Graphics.

Sound effects are mixed into 44.1 kHz signed-16 stereo PCM by `src/native/audio.c`.
JavaScript reads that PCM through FFI and queues it to SDL3 using `src/audio.js`.
MUS scores are converted using DoomGeneric's converter; TinyMidiLoader schedules
MIDI events and TinySoundFont synthesizes music with the GeneralUser GS soundfont.
Music and effects are mixed together before being sent to SDL3, with support for
music volume, pause/resume, and looping.

## Architecture

The project is split into a small native platform layer and a JavaScript runtime:

1. `src/native/main.c` implements the platform callbacks required by `doomgeneric`, including input, timing, frame readiness, and framebuffer access.
2. `src/engine.js` loads the Doom shared library through `node:ffi` and exposes a small JavaScript wrapper around the native functions.
3. `src/input.js` parses terminal keyboard input, including Kitty keyboard protocol events, and maps configured keys to Doom key codes.
4. `src/video.js` converts Doom's framebuffer to RGBA and presents it through OpenTUI's native Kitty Graphics renderer. `src/video-output.js` drains native output and applies the CMUX placement fix.
5. `src/index.js` wires everything together and runs Doom at 35 Hz.

JavaScript pulls the native framebuffer on every tick. OpenTUI owns Kitty Graphics transmission, placement, synchronization, text rendering and image cleanup. Kitty Graphics is the only video backend; no character-cell fallback is used.

## Requirements

You need:

1. Node.js **26.10.0 or newer**, with `node:ffi` support.
2. `pkg-config`, `tar` and `unzip` for dependency provisioning.
3. SDL3 3.2+ and its `pkg-config` metadata; a C compiler (`clang` by default) for the native build.
4. `doomgeneric` sources under `deps/engine`.
5. A Doom-compatible WAD, such as `freedoom1.wad` from [Freedoom](https://freedoom.github.io/download.html).
6. A terminal with both [Kitty Graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/) and [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) support.

## Installation

### Install local prerequisites

SDL3 must already be installed with its `sdl3.pc` metadata.
The installer imports only the shared library;
it never installs system packages. It checks prerequisites before
downloading or replacing any dependency.

On macOS, use Homebrew:

```sh
brew install pkg-config sdl3 unzip
```

Install Apple's Command Line Tools manually with `xcode-select --install` if
`clang` is unavailable. The build does not use SDL headers or link against SDL.

On Debian or Ubuntu:

```sh
sudo apt install clang pkg-config libsdl3-dev tar unzip
```

On Fedora:

```sh
sudo dnf install clang pkgconf-pkg-config SDL3-devel tar unzip
```

On Arch Linux:

```sh
sudo pacman -S clang pkgconf sdl3 tar unzip
```

Older distributions may not provide SDL3 yet; install it from the official
[SDL releases](https://github.com/libsdl-org/SDL/releases) or your distribution's
supported package source. For custom installations, set `PKG_CONFIG_PATH` to
the directory containing `sdl3.pc`, optionally in the repository's `.env` file.

### Prepare dependencies

```sh
pnpm install
pnpm run prepare
```

The single JavaScript installer reports progress in English with ANSI colors
and creates the following layout:

```text
deps/
├── engine/
│   └── src/      # Only .c and .h files from the latest default-branch commit
├── freedoom/     # Only .wad files from the latest stable release
├── audio/
│   ├── lib/      # Only libSDL3.dylib or libSDL3.so
│   ├── src/      # Unmodified TinySoundFont and TinyMidiLoader headers
│   └── font/GeneralUser-GS.sf2
└── video/        # OpenTUI 0.5.11: libopentui.dylib or libopentui.so
```

Imported SDL libraries always match the current host
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, or `linux-x64`).
SDL copies use stable filenames (`libSDL3.dylib` or
`libSDL3.so`), retaining their original loader
metadata and external runtime dependencies. This step prepares dependencies;
it does not produce a standalone binary.

OpenTUI is downloaded from npm and verified against its SHA-512 integrity value.
By default it matches the host. `pnpm run prepare linux-arm64` selects another
supported target for OpenTUI only; SDL still comes from the current host.

Rerunning refreshes each managed component after it has been prepared
successfully. Local changes inside those component directories are replaced;
unrelated files in `deps/` are preserved.

## Building

Build the native Doom library:

```sh
pnpm run build
```

`src/scripts/build.js` invokes `clang` directly (override with `CC`), producing
`deps/engine/destino.dylib` on macOS or `deps/engine/destino.so` on Linux.
Intermediate objects are stored in `tmp/doomgeneric/`. The upstream sources are
unchanged; our PCM backend replaces the original sound and music implementations.

## Building a SEA executable

Destino can be packaged as a Node.js Single Executable Application (SEA) on macOS.

First install dependencies and build the native library:

```sh
pnpm install
pnpm run prepare
pnpm run build
```

Then build the executable:

```sh
pnpm run sea
```

This bundles the JavaScript entry point, native libraries, WAD files, and SF2 soundfont into `dist/destino`.
SEA assets are mounted by Node's read-only VFS (`useVfs: true`, code cache disabled).
`src/loader.js` resolves packaged and development paths; Destino does not extract
assets or create temporary directories. Node may internally materialize native
libraries while loading them, including temporary files on macOS.

In SEA mode, the WAD and SF2 are passed to native code as memory buffers. Saves
persist in `saves/<WAD filename>/` under the current working directory (for example,
`saves/freedoom1.wad/doomsav0.dsg`). Save slots, temporary save files and recovery
saves are the only application-owned disk writes, along with their directory.
Doom's configuration, demos and screenshots stay in process memory and disappear
on exit. Source-mode engine files retain their normal filesystem behavior.
The executable can be run directly:

```sh
./dist/destino
```

## Running the game

Destino reads configuration from `destino.json` in the current directory by default.
From source, a missing file is created and the program exits. In SEA mode,
missing configuration uses in-memory defaults without creating any files.

Run once to generate the config:

```sh
/path/to/node src/index.js
```

Update `wadPath` if it was not detected automatically, then run again:

```sh
/path/to/node src/index.js
```

You can also pass a custom config path as the first argument:

```sh
/path/to/node src/index.js ./foo.json
```

Controls are configured in `destino.json`. Press `Ctrl+C` to exit.

The bottom information bar shows the WAD name and exit shortcut on the left,
and the framebuffer resolution and audio format on the right. Set `showStatus`
to `false` at the root of `destino.json` to hide it (default: `true`). The game
uses the remaining rows, and its centered layout updates when the terminal is
resized. Text is truncated to fit narrow terminals without wrapping.

Like Principe, video sizing uses the terminal's reported pixel dimensions to
measure cell geometry. The game starts at full available width and is reduced
only when its proportional height exceeds the available rows. The framebuffer's
aspect ratio is preserved to terminal-cell rounding, with centered black margins.
OpenTUI negotiates Kitty Graphics support; an unsupported terminal fails rather
than falling back to sixel or character cells. Pixel geometry is queried again
on resize and font/DPI changes; missing graphics or geometry confirmation
within 1.5 seconds raises `DESTINO_VIDEO`. Every tick repaints the whole surface,
including margins and the information bar, even if Doom's frame is unchanged.

The CMUX workaround `fixVideoIndex` is enabled by default at the root of `destino.json`:

```json
{
  "fixVideoIndex": true
}
```

Set it to `false` to disable it. When enabled, Kitty images use a z-index of `-1`,
above cell backgrounds and below text, matching Principe's CMUX workaround.

Keyboard input requires a terminal supporting the Kitty keyboard protocol,
including press/repeat/release events and reporting all keys as escape sequences.
Destino queries the active protocol flags at startup and fails with
`DESTINO_INPUT` if the required flags are unavailable or the terminal does not
respond within 1.5 seconds. Legacy ASCII and xterm input are not supported.

Set `sf2Path` to use a custom SF2 soundfont (relative to the current working
directory or absolute). An empty value selects the bundled
[GeneralUser GS](https://schristiancollins.com/generaluser.php) soundfont.
The synthesizer libraries come from [TinySoundFont](https://github.com/schellingb/TinySoundFont).

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

Destino is distributed as GPL-3.0-or-later because the Doom binding links with the GPL-licensed Doom engine sources. See [LICENSE](LICENSE).

Files that do not directly bind to, build, or embed the Doom engine are licensed under the MIT License and carry an `SPDX-License-Identifier: MIT` header. See [LICENSE-MIT](LICENSE-MIT).

The files that directly bind to or build the Doom engine carry an `SPDX-License-Identifier: GPL-3.0-or-later` header.
