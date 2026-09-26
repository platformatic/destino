// SPDX-License-Identifier: MIT

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { configPath, findWadPath, packaged, schemaPath } from './loader.js'

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
    throw new Error(`Cannot read config file: ${configPath}`, { cause: error })
  }

  let parsed

  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid JSON in config file: ${configPath}`, { cause: error })
  }

  const { wadPath: defaultWadPath, sf2Path: defaultSF2Path, keybindings: defaultKeyBindings } = defaultConfig
  const { wadPath, sf2Path, fixVideoIndex, fixIndexing, showStatus, keybindings, ...rest } = parsed

  return {
    wadPath: wadPath ?? defaultWadPath,
    sf2Path: sf2Path ?? defaultSF2Path,
    fixVideoIndex: fixVideoIndex ?? defaultConfig.fixVideoIndex,
    showStatus: showStatus ?? defaultConfig.showStatus,
    keybindings: {
      ...defaultKeyBindings,
      ...keybindings
    },
    ...rest
  }
}

// Compact arrays of strings into single lines for better readability
export function serializeConfig (config, configPath) {
  return JSON.stringify(config, null, 2).replaceAll(
    /\[\s+((.+\n){1,2})\s+\]/gm,
    (_, g1) => `[${g1.replaceAll(/\s+/g, ' ').trim()}]`
  )
}

export async function loadConfig () {
  // Load the destino.json file
  const path = configPath()

  if (!existsSync(path)) {
    if (packaged) {
      return structuredClone(defaultConfig)
    }
    await writeFile(
      path,
      serializeConfig({ ...defaultConfig, wadPath: await findWadPath() }),
      'utf8'
    )

    console.log(`Wrote default config to ${path}. Check it out and then run the program again!`)
    process.exit(0)
  }

  return createConfig(path)
}
