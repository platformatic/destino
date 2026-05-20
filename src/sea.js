// SPDX-License-Identifier: MIT

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { getAssetKeys, getRawAsset, isSea } from 'node:sea'

export function getAssetsRoot () {
  return isSea() ? resolve(tmpdir(), `destino-${process.pid}`) : resolve(process.cwd(), 'dist')
}

export async function initSEA () {
  if (!isSea()) {
    return
  }

  const root = getAssetsRoot()

  await mkdir(root, { recursive: true })

  // Export all the assets
  for (const path of getAssetKeys()) {
    const destination = resolve(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, new Uint8Array(getRawAsset(path)))
  }
}

export function cleanupSEA () {
  if (!isSea()) {
    return
  }

  return rm(getAssetsRoot(), { recursive: true, force: true })
}
