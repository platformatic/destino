# Destino

Destino runs Doom in a terminal using Node.js, [`node:ffi`](https://nodejs.org/api/ffi.html), and [OpenTUI](https://github.com/sst/opentui)'s [Kitty Graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/) renderer.

Music and sound effects use SDL3 and the GeneralUser GS soundfont.

You need a terminal supporting both [Kitty Graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
and the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
Freedoom is included; you can also use your own Doom-compatible WAD.

Internal architecture, dependency preparation, build and packaging details are in
[AGENTS.md](AGENTS.md).

## Getting Started

Open a terminal supporting Kitty graphics and keyboard input. Run these commands
from the directory where you want to keep your configuration and saves.

### 1. Create your configuration

```sh
destino --bootstrap
```

Bootstrap creates `destino.json` in the current directory, then walks you through
keyboard setup. Press a key or shortcut for each action, or wait five seconds to
keep its default bindings. Bootstrap does not start the game. **It completely
overwrites any existing config with defaults before keyboard setup.** If you cancel
setup with `Ctrl+C` or `Ctrl+D`, the reset config stays in place with default bindings;
the previous configuration is not restored.

### 2. Start the game

```sh
destino
```

Destino reads `destino.json` and uses the bundled Freedoom WAD by default. To play a
different WAD, set `wadPath` in the config. Press `Ctrl+C` to exit the game.

If the config is missing, Destino shows usage and exits with status 1. It never
creates configuration automatically during normal startup.

### Use a custom configuration

For a custom config, pass the same path to bootstrap and to the game:

```sh
destino --bootstrap ./custom.json
destino ./custom.json
```

## CLI Reference

The config path is optional and **positional**, defaulting to `destino.json` in the
current directory. There is no `-c` / `--config` option.

| Switch | Purpose |
| --- | --- |
| `--bootstrap`, `--b`, `-b` | Create or completely reset config, then run guided keyboard setup. |
| `-i`, `--input` | Reconfigure keyboard bindings in an existing config. |
| `--probe` | With `-i` / `--input`, display recognized chords and assigned actions without saving. |
| `-a`, `--audio` | List SDL playback device names without loading config or starting the game. |
| `-h`, `--help` | Show usage. |

Bootstrap, input and audio modes cannot be combined. Use `destino --help` to show usage.

### Input setup and probe

```sh
destino -i                     # Guided setup using destino.json
destino --input ./custom.json  # Guided setup using an existing custom config
destino -i --probe             # Display recognized keys, chords and actions
```

Both modes require an interactive terminal supporting Kitty keyboard, but do not
initialize the game, renderer or audio. Setup groups Doom movement, game and menu
actions. Press a key or shortcut to replace an action's bindings, or wait five seconds
to retain them. New conflicts with another action are rejected; existing shared
bindings are preserved. Standalone modifiers are ignored during capture.

`Ctrl+C` or `Ctrl+D` cancels without saving, as do SIGINT and SIGTERM. Successful setup
updates only keybindings and preserves other configuration. If the config changes
while setup is running, Destino refuses to overwrite it.

Probe never writes configuration. It uses defaults when the implicit `destino.json`
is absent; an explicit missing path or malformed config is an error. `--probe` requires
`-i` / `--input`.

### Audio output

```sh
destino -a
```

This lists SDL playback device names without reading configuration, opening a playback
stream or starting the game. Set `audio` to the exact device name, not SDL's temporary ID:

```json
{
  "audio": "External Speakers"
}
```

Omit `audio` or set it to `null` for the system default. An unavailable device
raises `DESTINO_AUDIO`; invalid audio configuration raises `DESTINO_CONFIG`.
Bootstrap omits unset optional settings rather than writing `null` values.

## Running the game

The bottom information bar shows the WAD name and exit shortcut on the left,
and the framebuffer resolution and audio format on the right. Set `showStatus`
to `false` at the root of `destino.json` to hide it (default: `true`). The game
uses the remaining rows, and its centered layout updates when the terminal is
resized. Text is truncated to fit narrow terminals without wrapping.

The game fits the available terminal area while preserving its aspect ratio and
adjusts when the terminal is resized. A terminal without the required graphics or
keyboard support reports an error; there is no fallback renderer.

The CMUX workaround `fixVideoIndex` is enabled by default at the root of `destino.json`:

```json
{
  "fixVideoIndex": true
}
```

Set it to `false` to disable the workaround.

Set `sf2Path` to use a custom SF2 soundfont (relative to the current working
directory or absolute). An empty value selects the bundled
[GeneralUser GS](https://schristiancollins.com/generaluser.php) soundfont.

### Saves

Saves are stored in `saves/<WAD filename>/` under the directory where you run Destino,
for example `saves/freedoom1.wad/doomsav0.dsg`. Doom's configuration, demos and
screenshots are not persisted between runs.

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

Files that do not directly bind to, build, or embed the Doom engine are licensed under the MIT License, also included in [LICENSE](LICENSE).

Third-party license texts and attributions are collected in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Release archives include both files alongside the executable.
