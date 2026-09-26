#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function getPlatformConfig () {
  if (process.platform === 'darwin') {
    return {
      platform: 'darwin',
      output: './dist/destino',
      nativeAsset: 'destino.dylib',
      nativePath: './deps/engine/destino.dylib',
      sdlAsset: 'libSDL3.dylib'
    }
  } else {
    return {
      platform: 'linux',
      output: './dist/destino',
      nativeAsset: 'destino.so',
      nativePath: './deps/engine/destino.so',
      sdlAsset: 'libSDL3.so'
    }
  }
}

function getArch () {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

async function run (command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })

    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} exited with code ${code}`))
      }
    })
  })
}

async function download (url, destination) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function getNodeBinary ({ platform, arch }) {
  const baseUrl = process.env.NODE_BUILD_BASE_URL

  if (!baseUrl) {
    return process.execPath
  }

  const nodeBaseUrl = new URL(baseUrl)
  const pathParts = nodeBaseUrl.pathname.split('/').filter(Boolean)
  const version = pathParts.at(-1)

  if (!version) {
    throw new Error(`Unable to determine Node version from NODE_BUILD_BASE_URL: ${baseUrl}`)
  }

  const nodeDirectory = join('tmp', `node-${platform}-${arch}`)
  const archiveBase = join('tmp', `node-${platform}-${arch}`)
  const archiveName = `node-${version}-${platform}-${arch}`

  await rm(nodeDirectory, { force: true, recursive: true })
  await mkdir(nodeDirectory, { recursive: true })

  const archive = `${archiveBase}.tar.gz`
  const nodeBinary = join(nodeDirectory, 'bin', 'node')

  await download(new URL(`${archiveName}.tar.gz`, nodeBaseUrl).href, archive)
  await run('tar', ['-xzf', archive, '-C', nodeDirectory, '--strip-components', '1'])
  await chmod(nodeBinary, 0o755)

  return nodeBinary
}

async function main () {
  const config = getPlatformConfig()
  const arch = getArch()

  await run('rolldown', ['-c', 'rolldown.config.js'], { shell: true })
  await mkdir('tmp', { recursive: true })

  const nodeBinary = await getNodeBinary({ platform: config.platform, arch })
  const sdlPath = resolve(import.meta.dirname, `../../deps/audio/lib/${config.sdlAsset}`)

  await writeFile(
    'tmp/sea.json',
    JSON.stringify(
      {
        main: './dist/index.js',
        mainFormat: 'module',
        output: config.output,
        execArgv: ['--no-warnings'],
        useCodeCache: false,
        useVfs: true,
        assets: {
          'config.schema.json': 'src/config.schema.json',
          [config.nativeAsset]: config.nativePath,
          [config.sdlAsset]: sdlPath,
          'wads/freedoom1.wad': 'deps/freedoom/freedoom1.wad',
          'wads/freedoom2.wad': 'deps/freedoom/freedoom2.wad',
          'midi/GeneralUser-GS.sf2': 'deps/audio/font/GeneralUser-GS.sf2'
        }
      },
      null,
      2
    )
  )

  await run(nodeBinary, ['--build-sea', 'tmp/sea.json'])
  if (process.platform === 'darwin') {
    // SEA changes the executable image; arm64 macOS requires a new signature.
    // Release notarization can replace this local ad-hoc signature later.
    await run('codesign', ['--force', '--sign', '-', config.output])
  }
}

await main()
