// SPDX-License-Identifier: MIT

import { writeSync } from 'node:fs'
import { basename } from 'node:path'
import { Audio } from './audio.js'
import { loadConfig, serializeConfig } from './config.js'
import { Engine } from './engine.js'
import { TerminalParser } from './input.js'
import { Video } from './video.js'

function printDebugInfo (columns, rows, terminalArea, config) {
  console.log(`Node.js version: ${process.version}`)
  console.log(`Screen size: ${columns}x${rows} (${terminalArea} cells)`)
  console.log('Renderer: Kitty')
  console.log(`Configuration: ${serializeConfig(config)}`)
}

function shutdown (runtime, resolve) {
  if (runtime.shuttingDown) {
    return
  }

  runtime.shuttingDown = true

  if (runtime.timer !== null) {
    clearInterval(runtime.timer)
    runtime.timer = null
  }

  if (runtime.input !== null) {
    runtime.input.destroy()
    runtime.input = null
  }

  if (runtime.renderer !== null) {
    runtime.renderer.destroy()
    runtime.renderer = null
  }

  if (runtime.engine !== null) {
    runtime.engine.destroy()
    runtime.engine = null
  }

  if (runtime.audio !== null) {
    runtime.audio.destroy()
    runtime.audio = null
  }

  writeSync(process.stdout.fd, '\x1b[?2026l\x1b[0m\x1b[?1049l\x1b[?25h\x1b[2J\x1b[3J\x1b[H')
  resolve()
}

export async function main (context) {
  const rows = process.stdout.rows ?? 0
  const columns = process.stdout.columns ?? 0
  const terminalArea = rows * columns
  const { promise, resolve } = Promise.withResolvers()
  const config = await loadConfig()

  if (process.env.DEBUG === 'true') {
    printDebugInfo(columns, rows, terminalArea, config)
    return
  }

  // Open FFI libs
  const engine = new Engine()
  const runtime = {
    engine,
    audio: null,
    input: new TerminalParser(config.keybindings),
    renderer: null,
    timer: null,
    shuttingDown: false
  }

  const boundShutdown = shutdown.bind(null, runtime, resolve)
  process.once('SIGINT', boundShutdown)
  process.once('SIGTERM', boundShutdown)

  // Setup modules
  try {
    runtime.renderer = new Video(engine, config)
    runtime.engine.initialize(config)
    runtime.audio = new Audio()
    runtime.renderer.setStatus(`${basename(config.wadPath || 'freedoom1.wad')} | Ctrl+C: Quit`)
    runtime.renderer.setInfo(`${engine.getFrameWidth()}x${engine.getFrameHeight()} | Audio: SDL3 44.1 kHz stereo`)
    runtime.renderer.setupFrameBuffer()
    runtime.input.on('quit', boundShutdown)
    runtime.input.on('press', doomKey => runtime.engine.sendKey(doomKey, 1))
    runtime.input.on('release', doomKey => runtime.engine.sendKey(doomKey, 0))
    await runtime.input.start()
    await runtime.renderer.measureScreen()
  } catch (error) {
    boundShutdown()
    process.off('SIGINT', boundShutdown)
    process.off('SIGTERM', boundShutdown)
    throw error
  }

  // Execute the game, doom runs at 35Hz
  runtime.timer = setInterval(() => {
    if (runtime.shuttingDown) {
      return
    }

    runtime.engine.tick()
    try {
      runtime.audio.write(runtime.engine.renderAudio())
      // Present the whole terminal even when Doom has not marked a new frame.
      runtime.renderer.render()
    } catch (error) {
      console.error(`${error.code}: ${error.message}`)
      process.exitCode = 1
      boundShutdown()
      return
    }

    if (runtime.engine.quitRequested()) {
      boundShutdown()
      return
    }

    runtime.engine.clearFrameReady()
  }, 1000 / 35)

  await promise

  process.off('SIGINT', boundShutdown)
  process.off('SIGTERM', boundShutdown)
}

if (import.meta.main) {
  await main()
}
