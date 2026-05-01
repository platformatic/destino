import { writeSync } from 'node:fs'
import { loadConfig } from './config.js'
import { Engine } from './engine.js'
import { TerminalParser } from './input.js'
import { KittyRenderer } from './kitty.js'
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

  if (runtime.renderer !== null) {
    runtime.renderer.destroy()
    runtime.renderer = null
  }

  if (runtime.engine !== null) {
    runtime.engine.destroy()
    runtime.engine = null
  }

  writeSync(process.stdout.fd, '\x1b[<u\x1b[?1049l\x1b[?25h\x1b[2J\x1b[3J\x1b[H')
  resolve()
}

export async function main (context) {
  const rows = process.stdout.rows ?? 0
  const columns = process.stdout.columns ?? 0
  const canUseKittyRenderer = KittyRenderer.isSupported()

  let useKittyRenderer = process.env.USE_KITTY_RENDERER === 'true'

  if (columns < 160 || rows < 100) {
    if (!canUseKittyRenderer) {
      console.error(`Your terminal size is currently ${columns} columns by ${rows} rows.`)
      console.error(
        'Destino requires a size of at least 160 columns by 100 rows or a terminal with Kitty support. Resize your terminal and try again.'
      )
    } else {
      useKittyRenderer = true
    }
  }

  const { promise, resolve } = Promise.withResolvers()
  const config = await loadConfig()

  // Open FFI libs
  const engine = new Engine()
  const runtime = {
    engine,
    input: new TerminalParser(config.keybindings),
    renderer: useKittyRenderer ? new KittyRenderer(engine) : new OpenTUI(engine),
    timer: null,
    audioReleased: false,
    shuttingDown: false
  }

  const boundShutdown = shutdown.bind(null, runtime, resolve)
  process.once('SIGINT', boundShutdown)
  process.once('SIGTERM', boundShutdown)

  // Setup modules
  runtime.engine.initialize(config)
  runtime.renderer.setupFrameBuffer()
  runtime.input.on('quit', () => shutdown(runtime, resolve))
  runtime.input.on('press', doomKey => runtime.engine.sendKey(doomKey, 1))
  runtime.input.on('release', doomKey => runtime.engine.sendKey(doomKey, 0))
  runtime.input.start()

  // Execute the game, doom runs at 35Hz
  runtime.timer = setInterval(() => {
    if (runtime.shuttingDown) {
      return
    }

    runtime.engine.tick()

    if (runtime.engine.quitRequested()) {
      shutdown(runtime, resolve)
      return
    }

    if (!runtime.engine.frameReady()) {
      return
    }

    runtime.renderer.render()

    if (!runtime.audioReleased) {
      runtime.audioReleased = true
      runtime.engine.releaseAudio()
    }

    runtime.engine.clearFrameReady()
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
