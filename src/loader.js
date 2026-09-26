// SPDX-License-Identifier: MIT

import { suffix } from 'node:ffi'
import { mkdirSync, readFileSync, writeSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { LoaderError } from './errors.js'

export const packaged = isSea()

export function startupProgress (message) {
  if (!packaged) {
    return
  }
  // Flush before synchronous FFI/file work so progress is visible immediately.
  // These messages are emitted only before OpenTUI takes over the terminal.
  const line = `--> ${message}\n`
  writeSync(process.stdout.fd, process.stdout.isTTY ? `\x1b[36m${line}\x1b[0m` : line)
}

// With useVfs, the bundled ESM entry point lives at the root of the SEA mount.
// Obtain that location from Node rather than constructing a virtual mount path.
function assetPath (bundled, development) {
  return resolve(import.meta.dirname, packaged ? bundled : `../deps/${development}`)
}

export function libraryPath (name) {
  const label = { engine: 'Doom engine', video: 'OpenTUI', audio: 'SDL3' }[name]
  startupProgress(`Loading ${label} native library...`)
  if (name === 'video') {
    return assetPath(`libopentui.${suffix}`, `video/libopentui.${suffix}`)
  }
  return name === 'engine'
    ? assetPath(`destino.${suffix}`, `engine/destino.${suffix}`)
    : assetPath(`libSDL3.${suffix}`, `audio/lib/libSDL3.${suffix}`)
}

export function configPath () {
  return resolve(process.cwd(), process.argv[2] ?? 'destino.json')
}

export function schemaPath () {
  return resolve(import.meta.dirname, 'config.schema.json')
}

export async function findWadPath () {
  const candidate = glob('**/freedoom1.wad')
  const first = await candidate.next()
  return first.value ? resolve(process.cwd(), first.value) : undefined
}

export function loadGameAssets (config) {
  const wadPath = config.wadPath
    ? resolve(process.cwd(), config.wadPath)
    : assetPath('wads/freedoom1.wad', 'freedoom/freedoom1.wad')
  const fontPath = config.sf2Path
    ? resolve(process.cwd(), config.sf2Path)
    : assetPath('midi/GeneralUser-GS.sf2', 'audio/font/GeneralUser-GS.sf2')
  try {
    startupProgress('Reading WAD data...')
    const wad = packaged ? readFileSync(wadPath) : null
    startupProgress('Reading SF2 soundfont...')
    const font = readFileSync(fontPath)
    const saveDirectory = packaged ? resolve(process.cwd(), 'saves', basename(wadPath)) : null
    if (saveDirectory) {
      // Persistent saves are the only application-owned SEA filesystem writes.
      mkdirSync(saveDirectory, { recursive: true })
    }
    return {
      // Doom's IWAD identification uses the basename to distinguish game types.
      wadPath: packaged ? `/destino/${basename(wadPath)}` : wadPath,
      wad,
      font,
      saveDirectory,
      fontPath
    }
  } catch (error) {
    throw new LoaderError(`Cannot read game assets: ${error.message}`, { cause: error })
  }
}
