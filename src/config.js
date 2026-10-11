import { readFile } from 'node:fs/promises'
import { ConfigError } from './errors.js'
import { configPath, schemaPath } from './loader.js'

export const defaultConfigPath = 'destino.json'

export const defaultConfig = {
  $schema: schemaPath(),
  wadPath: '',
  sf2Path: '',
  fixVideoIndex: true,
  showStatus: true,
  keybindings: {
    moveForward: ['w', 'up'],
    moveBackward: ['s', 'down'],
    turnLeft: ['a', 'left'],
    turnRight: ['d', 'right'],
    strafeLeft: ['q', ','],
    strafeRight: ['e', '.'],
    fire: ['space', 'ctrl'],
    use: ['enter'],
    menu: ['escape'],
    pause: ['p'],
    confirm: ['enter'],
    abort: ['escape'],
    yes: ['y'],
    no: ['n']
  }
}

async function createConfig (configPath) {
  let source

  try {
    source = await readFile(configPath, 'utf8')
  } catch (error) {
    throw new ConfigError(`Cannot read config file: ${configPath}. Use --bootstrap to create it.`, { cause: error })
  }

  let parsed

  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new ConfigError(`Invalid JSON in config file: ${configPath}`, { cause: error })
  }

  const { wadPath: defaultWadPath, sf2Path: defaultSF2Path, keybindings: defaultKeyBindings } = defaultConfig

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('Configuration must be a JSON object')
  }

  const { wadPath, sf2Path, audio, fixVideoIndex, fixIndexing, showStatus, keybindings, ...rest } = parsed

  if (audio !== undefined && audio !== null && audio !== false && (typeof audio !== 'string' || audio.length === 0)) {
    throw new ConfigError('audio must be a non-empty device name, null or false')
  }

  // Fill omitted settings without discarding custom fields or partial keybinding overrides.
  return {
    wadPath: wadPath ?? defaultWadPath,
    sf2Path: sf2Path ?? defaultSF2Path,
    audio: audio ?? null,
    fixVideoIndex: fixVideoIndex ?? defaultConfig.fixVideoIndex,
    showStatus: showStatus ?? defaultConfig.showStatus,
    keybindings: {
      ...defaultKeyBindings,
      ...keybindings
    },
    ...rest
  }
}

// Compact short arrays of strings into single lines so keybindings remain easy to edit.
export function serializeConfig (config, configPath) {
  return JSON.stringify(config, null, 2).replaceAll(
    /\[\s+((.+\n){1,2})\s+\]/gm,
    (_, g1) => `[${g1.replaceAll(/\s+/g, ' ').trim()}]`
  )
}

export async function loadConfig (path = configPath()) {
  return createConfig(path)
}
