// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dlopen } from 'node:ffi'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DependencyError } from '../errors.js'

const exec = promisify(execFile)
const deps = resolve(import.meta.dirname, '../../deps')
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const currentTarget = `${process.platform}-${process.arch}`
// Pin public downloads to keep builds reproducible without GitHub API requests or tokens.
const doomGenericCommit = 'dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284'
const freedoomVersion = '0.13.0'
const generalUserCommit = '684543d5e5efaef08d02be50dcda8d552478fa60'
const tinySoundFontCommit = '853a0a171759f1ddba0de1442133a75912bbeffa'

function step (message) {
  console.log(`\x1b[35;1m--> ${message}\x1b[0m`)
}

function info (message) {
  console.log(`\x1b[36m${message}\x1b[0m`)
}

async function run (command, args) {
  try {
    const { stdout } = await exec(command, args, { maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim()
  } catch (error) {
    throw new DependencyError(`${command}: ${error.message}`)
  }
}

async function metadata (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) {
    throw new DependencyError(`${url}: HTTP ${response.status}`)
  }
  return response.json()
}

async function download (url, path) {
  info(`Downloading ${basename(path)}...`)
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) {
    throw new DependencyError(`${url}: HTTP ${response.status}`)
  }
  const data = Buffer.from(await response.arrayBuffer())
  await writeFile(path, data)
  return data
}

async function localSDL () {
  const libdir = await run('pkg-config', ['--variable=libdir', 'sdl3'])
  const filename = process.platform === 'darwin' ? 'libSDL3.dylib' : 'libSDL3.so'
  const source = await realpath(resolve(libdir, process.platform === 'darwin' ? filename : 'libSDL3.so.0'))
  // SAFETY: SDL3 exposes SDL_GetVersion as int(void) on the host architecture.
  const { lib, functions } = dlopen(source, { SDL_GetVersion: { arguments: [], return: 'int32' } })
  try {
    // SAFETY: The resolved function matches SDL3's version ABI.
    const version = functions.SDL_GetVersion()
    if (version < 3002000 || version >= 4000000) {
      throw new DependencyError('SDL 3.2 or later in the 3.x series is required')
    }
    return { source, filename, version }
  } finally {
    lib.close()
  }
}

async function preflight () {
  step('Checking local prerequisites')
  try {
    for (const command of ['pkg-config', 'tar', 'unzip']) {
      await run('which', [command])
    }
    await run('pkg-config', ['--exists', 'sdl3'])
    return await localSDL()
  } catch (error) {
    console.error('\x1b[33mInstall the prerequisites manually, then run this command again. See README.md.\x1b[0m')
    console.error(process.platform === 'darwin'
      ? '  brew install pkg-config sdl3 unzip'
      : '  Install SDL3 (3.2+) and its pkg-config metadata using your distribution package manager.')
    throw new DependencyError(error.message)
  }
}

async function archive (directory, url, zip = false) {
  const path = resolve(directory, zip ? 'download.zip' : 'download.tar.gz')
  await download(url, path)
  info('Extracting archive...')
  if (zip) {
    await run('unzip', ['-q', path, '-d', directory])
  } else {
    await run('tar', ['-xzf', path, '-C', directory, '--strip-components=1'])
  }
  await rm(path)
}

async function install (name, action) {
  step(name)
  const temporary = await mkdtemp(resolve(deps, `.${name}-`))
  try {
    await action(temporary)
    // Replace only this component after successful preparation, preserving unrelated deps.
    await rm(resolve(deps, name), { recursive: true, force: true })
    await rename(temporary, resolve(deps, name))
    info(`Ready: deps/${name}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function installDoomGeneric () {
  await install('engine', async directory => {
    const url = `https://codeload.github.com/ozkl/doomgeneric/tar.gz/${doomGenericCommit}`
    const extracted = resolve(directory, 'archive')
    const source = resolve(extracted, 'doomgeneric')
    const destination = resolve(directory, 'src')
    await mkdir(extracted)
    await archive(extracted, url)
    await mkdir(destination)
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isFile() && /\.(c|h)$/.test(entry.name)) {
        await cp(resolve(source, entry.name), resolve(destination, entry.name))
      }
    }
    await rm(extracted, { recursive: true })
  })
}

async function installFreedoom () {
  await install('freedoom', async directory => {
    const name = `freedoom-${freedoomVersion}`
    await archive(directory, `https://github.com/freedoom/freedoom/releases/download/v${freedoomVersion}/${name}.zip`, true)
    const extracted = resolve(directory, name)
    for (const entry of await readdir(extracted, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.wad')) {
        await cp(resolve(extracted, entry.name), resolve(directory, entry.name))
      }
    }
    await rm(extracted, { recursive: true })
  })
}

async function importSDL (directory, libraries) {
  await mkdir(directory)
  for (const { source, filename, version } of libraries) {
    info(`Importing ${source} (${version})...`)
    const bytes = await readFile(source)
    await writeFile(resolve(directory, filename), bytes)
  }
}

async function installAudio (libraries) {
  await install('audio', async directory => {
    await importSDL(resolve(directory, 'lib'), libraries)
    const source = resolve(directory, 'src')
    const font = resolve(directory, 'font')
    await mkdir(source)
    await mkdir(font)
    for (const filename of ['tsf.h', 'tml.h']) {
      await download(
        `https://raw.githubusercontent.com/schellingb/TinySoundFont/${tinySoundFontCommit}/${filename}`,
        resolve(source, filename)
      )
    }
    await download(
      `https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/${generalUserCommit}/GeneralUser-GS.sf2`,
      resolve(font, 'GeneralUser-GS.sf2')
    )
  })
}

async function installVideo (target) {
  await install('video', async directory => {
    const data = await metadata(`https://registry.npmjs.org/@opentui/core-${target}/0.5.11`)
    const path = resolve(directory, 'package.tgz')
    const bytes = await download(data.dist.tarball, path)
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== data.dist.integrity) {
      throw new DependencyError('OpenTUI archive integrity mismatch')
    }
    const filename = target.startsWith('darwin-') ? 'libopentui.dylib' : 'libopentui.so'
    await run('tar', ['-xzf', path, '-C', directory, '--strip-components=1', `package/${filename}`])
    await rm(path)
  })
}

async function main () {
  const target = process.argv[2] ?? currentTarget
  if (!targets.includes(target)) {
    throw new DependencyError(`Unsupported video target: ${target}`)
  }
  if (!targets.includes(currentTarget)) {
    throw new DependencyError(`Unsupported host: ${currentTarget}`)
  }
  const sdl = await preflight()
  await mkdir(deps, { recursive: true })
  await installDoomGeneric()
  await installFreedoom()
  await installAudio([sdl])
  await installVideo(target)
  info('All dependencies are ready.')
}

try {
  await main()
} catch (error) {
  console.error(`\x1b[31m${error.code ?? 'DESTINO_DEPENDENCY'}: ${error.message}\x1b[0m`)
  process.exitCode = 1
}
