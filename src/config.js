import { existsSync } from 'node:fs'
import { glob, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const defaultConfigPath = 'destino.json'

export const defaultConfig = {
  $schema: resolve(import.meta.dirname, 'config.schema.json'),
  wadPath: '',
  sf2Path: '',
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

export async function findWadPath () {
  const candidate = glob('**/freedoom1.wad')
  const first = await candidate.next()
  return first.value ? resolve(process.cwd(), first.value) : undefined
}

export async function findSF2Path () {
  const candidate = glob('**/*.sf2')
  const first = await candidate.next()
  return first.value ? resolve(process.cwd(), first.value) : undefined
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
  const { wadPath, sf2Path, keybindings, ...rest } = parsed

  return {
    wadPath: wadPath ?? defaultWadPath,
    sf2Path: sf2Path ?? defaultSF2Path,
    keybindings: {
      ...defaultKeyBindings,
      ...keybindings
    },
    ...rest
  }
}

export async function loadConfig () {
  // Load the destino.json file
  const configPath = resolve(process.cwd(), process.argv[2] ?? 'destino.json')

  if (!existsSync(configPath)) {
    await writeFile(
      configPath,
      JSON.stringify(
        { ...defaultConfig, wadPath: await findWadPath(), sf2Path: await findSF2Path() },
        null,
        2
        // Compact arrays of strings into single lines for better readability
      ).replaceAll(/\[\s+((.+\n){1,2})\s+\]/gm, (_, g1) => `[${g1.replaceAll(/\s+/g, ' ').trim()}]`),
      'utf8'
    )

    console.log(`Wrote default config to ${configPath}. Check it out and then run the program again!`)
    process.exit(0)
  }

  return createConfig(configPath)
}
