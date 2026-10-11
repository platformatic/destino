# Destino: Agent and Maintainer Reference

Keep user-facing startup, CLI, configuration and controls in `README.md`.
Keep architecture, dependency provisioning, native build and packaging details here.

## Tests

This repository does not use automated tests. Do not add test files, test suites or
test scripts.

## Licenses

Keep project license texts in the root `LICENSE` and upstream license texts and
attributions in `THIRD_PARTY_NOTICES`. These are the only repository-owned license
files; do not add `src/licenses.js` or per-file license identifiers.

Preserve upstream legal texts verbatim and record their source revisions. Review
notices when changing Node.js, Doom/doomgeneric, Freedoom, SDL3, OpenTUI,
TinySoundFont/TinyMidiLoader, GeneralUser GS or their redistributed dependencies.
Leave upstream source notices intact.

Do not import notices into the CLI bundle or embed them in SEA assets.
`src/scripts/prepare-artifact.sh` only copies `LICENSE` and `THIRD_PARTY_NOTICES`
verbatim beside the executable, without additional license validation or generation.
Keep both root files current before publishing releases. GPL distributions must
also satisfy the applicable corresponding-source requirements.

## Architecture

Destino combines a native Doom platform layer with a JavaScript runtime:

1. `src/native/main.c` implements platform callbacks for doomgeneric, including input,
   timing, frame readiness and framebuffer access.
2. `src/engine.js` loads the Doom shared library through `node:ffi` and wraps its functions.
3. `src/input.js` parses Kitty keyboard events and maps configured chords to Doom keys.
4. `src/video.js` converts Doom's framebuffer to RGBA and renders through OpenTUI.
   `src/video-output.js` drains native output and applies the CMUX placement fix.
5. `src/audio.js` queues PCM through SDL3 using FFI.
6. `src/index.js` dispatches CLI modes and runs the game at 35 Hz.
   `src/cli/args.js` centralizes `node:util.parseArgs`; the other CLI modules implement
   bootstrap, input setup/probe and audio device listing.
7. `src/config.js` loads and serializes configuration; `src/config.schema.json` documents it.
   `src/loader.js` resolves packaged and development asset paths.

JavaScript pulls the native framebuffer on every tick. OpenTUI owns Kitty Graphics
transmission, placement, synchronization, text rendering and image cleanup. Kitty
Graphics is the only video backend; there is no character-cell or sixel fallback.

### Audio pipeline

`src/native/audio.c` mixes sound effects into 44.1 kHz signed-16 stereo PCM.
JavaScript reads the PCM through FFI and queues it to SDL3 using `src/audio.js`.
DoomGeneric's converter handles MUS scores; TinyMidiLoader schedules MIDI events and
[TinySoundFont](https://github.com/schellingb/TinySoundFont) synthesizes music with the
GeneralUser GS soundfont. Music and effects are mixed before SDL3 playback, with
support for music volume, pause/resume and looping.

### Terminal contracts

Video sizing uses the terminal's reported pixel dimensions to measure cell geometry,
as in Principe. The game starts at full available width and is reduced only when its
proportional height exceeds the available rows. Preserve aspect ratio to terminal-cell
rounding, with centered black margins.

OpenTUI negotiates Kitty Graphics support. Query pixel geometry again on resize and
font/DPI changes. Missing graphics or geometry confirmation within 1.5 seconds raises
`DESTINO_VIDEO`. Every tick repaints the whole surface, including margins and the
information bar, even if Doom's frame is unchanged.

`fixVideoIndex` defaults to true. The CMUX workaround places Kitty images at z-index
`-1`, above cell backgrounds and below text, matching Principe.

Keyboard input requires Kitty press/repeat/release events and encoding of all keys.
Destino queries active flags at startup; unsupported flags or no response within
1.5 seconds raises `DESTINO_INPUT`. Legacy ASCII and xterm input are not supported
for gameplay. Input setup reserves Ctrl+C and Ctrl+D for cancellation, including
before Kitty negotiation.

## Development prerequisites

- Node.js **26.10.0 or newer**, with `node:ffi` support.
- `pkg-config`, `tar` and `unzip` for dependency provisioning.
- SDL3 3.2+ installed with its `sdl3.pc` metadata.
- A C compiler (`clang` by default) for the native build.
- doomgeneric sources under `deps/engine` and a Doom-compatible WAD, provisioned below.
- A terminal supporting Kitty Graphics and Kitty keyboard for interactive execution.

The installer imports the SDL shared library; it never installs system packages.
It checks prerequisites before downloading or replacing dependencies. The build
does not use SDL headers or link against SDL.

### System packages

On macOS:

```sh
brew install pkg-config sdl3 unzip
```

If `clang` is unavailable, install Apple's Command Line Tools manually with
`xcode-select --install`.

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

Older distributions may require SDL3 from the official
[SDL releases](https://github.com/libsdl-org/SDL/releases). For a custom installation,
set `PKG_CONFIG_PATH` to the directory containing `sdl3.pc`, optionally in the repo's `.env`.
Load `.env` when present before running project scripts.

## Dependency preparation

```sh
pnpm install
pnpm run prepare
```

The JavaScript installer reports progress in English with ANSI colors and creates:

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

Imported SDL libraries match the current host (`darwin-arm64`, `darwin-x64`,
`linux-arm64` or `linux-x64`). Copies use stable names (`libSDL3.dylib` or `libSDL3.so`),
retaining their original loader metadata and external runtime dependencies.
Dependency preparation does not produce a standalone binary.

OpenTUI is downloaded from npm and verified against its SHA-512 integrity value.
By default it matches the host. `pnpm run prepare linux-arm64` selects another
supported target for OpenTUI only; SDL still comes from the current host.

Rerunning refreshes each managed component after it has been prepared successfully.
Local changes inside those component directories are replaced; unrelated files in
`deps/` are preserved. Do not provision dependencies over local changes without
considering this replacement behavior.

## Native build

```sh
pnpm run build
```

`src/scripts/build.js` invokes `clang` directly (override with `CC`), producing
`deps/engine/destino.dylib` on macOS or `deps/engine/destino.so` on Linux.
Intermediate objects go in `tmp/doomgeneric/`. Upstream sources remain unchanged;
our PCM backend replaces the original sound and music implementations.

## SEA packaging

Destino can be packaged as a Node.js Single Executable Application (SEA) on macOS.
Prepare dependencies and build the native library, then package:

```sh
pnpm install
pnpm run prepare
pnpm run build
pnpm run sea
```

The result is `dist/destino`, bundling JavaScript, native libraries, WAD files and
the SF2 soundfont. Keep the executable name `destino`.

Assets are mounted through Node's read-only VFS (`useVfs: true`, code cache disabled).
Destino does not extract assets or create temporary directories. Node may internally
materialize native libraries while loading them, including temporary files on macOS.
WAD and SF2 data reach native code as memory buffers in SEA mode.

### Persistence

Packaged saves persist under `saves/<WAD filename>/` in the current working directory,
for example `saves/freedoom1.wad/doomsav0.dsg`. Save slots, temporary save files and
recovery saves, along with their directory, are the only application-owned disk
writes during gameplay. Doom's configuration, demos and screenshots stay in memory
and disappear on exit. Source-mode engine files retain their normal filesystem behavior.

Explicit bootstrap and input setup also write configuration. Bootstrap replaces
the entire selected file with defaults before starting input setup. Normal startup
never creates config; missing configuration shows usage and exits with status 1.
Optional unset settings are omitted from generated JSON rather than written as null.
