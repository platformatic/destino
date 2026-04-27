import { writeSync } from 'node:fs'
import { loadConfig } from './config.js'
import { Engine } from './engine.js'
import { TerminalParser } from './input.js'
import { OpenTUI } from './opentui.js'
import { cleanupSEA, initSEA } from './sea.js'

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

  if (runtime.openTUI !== null) {
    runtime.openTUI.destroy()
    runtime.openTUI = null
  }

  if (runtime.doom !== null) {
    runtime.doom.destroy()
    runtime.doom = null
  }

  writeSync(process.stdout.fd, '\x1b[<u\x1b[?1049l\x1b[?25h\x1b[2J\x1b[3J\x1b[H')
  resolve()
}

export async function main (context) {
  const rows = process.stdout.rows ?? 0
  const columns = process.stdout.columns ?? 0
  if (columns < 160 || rows < 100) {
    console.error(
      'Destino requires a terminal size of at least 160 columns by 100 rows. Resize your terminal and try again.'
    )
    return
  }

  const { promise, resolve } = Promise.withResolvers()
  const config = await loadConfig()

  // Open FFI libs
  const doom = new Engine()
  const runtime = {
    doom,
    input: new TerminalParser(config.keybindings),
    openTUI: new OpenTUI(doom),
    timer: null,
    audioReleased: false,
    shuttingDown: false
  }

  const boundShutdown = shutdown.bind(null, runtime, resolve)
  process.once('SIGINT', boundShutdown)
  process.once('SIGTERM', boundShutdown)

  // Setup modules
  runtime.doom.initialize(config)
  runtime.openTUI.setupFrameBuffer()
  runtime.input.on('quit', () => shutdown(runtime, resolve))
  runtime.input.on('press', doomKey => runtime.doom.sendKey(doomKey, 1))
  runtime.input.on('release', doomKey => runtime.doom.sendKey(doomKey, 0))
  runtime.input.start()

  // Execute the game, doom runs at 35Hz
  runtime.timer = setInterval(() => {
    if (runtime.shuttingDown) {
      return
    }

    runtime.doom.tick()

    if (runtime.doom.quitRequested()) {
      shutdown(runtime, resolve)
      return
    }

    if (!runtime.doom.frameReady()) {
      return
    }

    runtime.openTUI.render()

    if (!runtime.audioReleased) {
      runtime.audioReleased = true
      runtime.doom.releaseAudio()
    }

    runtime.doom.clearFrameReady()
  }, 1000 / 35)

  await promise

  process.off('SIGINT', boundShutdown)
  process.off('SIGTERM', boundShutdown)
}

if (import.meta.main) {
  await initSEA()

  try {
    await main()
  } finally {
    await cleanupSEA()
  }
}
