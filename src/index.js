import { writeSync } from 'node:fs'
import { basename } from 'node:path'
import { Audio } from './audio.js'
import { bootstrap } from './cli/bootstrap.js'
import { parseCommandLine, usage } from './cli/args.js'
import { listAudioDevices } from './cli/audio.js'
import { configureInput } from './cli/input.js'
import { loadConfig, serializeConfig } from './config.js'
import { Engine } from './engine.js'
import { TerminalParser } from './input.js'
import { Video } from './video.js'
import { startupProgress } from './loader.js'

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

export async function main (args = process.argv.slice(2)) {
  const options = parseCommandLine(args)

  // Maintenance modes must return before game resources or terminal rendering are initialized.
  if (options.help) {
    console.log(usage)
    return
  }

  if (options.audio) {
    listAudioDevices()
    return
  }

  if (options.input) {
    await configureInput(options)
    return
  }

  if (options.bootstrap) {
    await bootstrap(options.config)
    return
  }

  const rows = process.stdout.rows ?? 0
  const columns = process.stdout.columns ?? 0
  const terminalArea = rows * columns
  const { promise, resolve } = Promise.withResolvers()
  const config = await loadConfig(options.config)

  if (process.env.DEBUG === 'true') {
    printDebugInfo(columns, rows, terminalArea, config)
    return
  }

  // Keep partially initialized resources together so startup failures use the same teardown path.
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

  // Negotiate terminal capabilities before starting ticks or submitting audio.
  try {
    runtime.renderer = new Video(engine, config)
    runtime.engine.initialize(config)
    if (config.audio !== false) {
      runtime.audio = new Audio(config.audio)
    }

    runtime.renderer.setStatus(`${basename(config.wadPath || 'freedoom1.wad')} | Ctrl+C: Quit`)
    const audioInfo = runtime.audio === null ? 'Disabled' : 'SDL3 44.1 kHz stereo'
    runtime.renderer.setInfo(`${engine.getFrameWidth()}x${engine.getFrameHeight()} | Audio: ${audioInfo}`)

    startupProgress('Initializing terminal graphics and keyboard...')
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

  // Doom advances at 35 Hz; presentation and audio consume the same completed tick.
  runtime.timer = setInterval(() => {
    if (runtime.shuttingDown) {
      return
    }

    runtime.engine.tick()

    try {
      if (runtime.audio !== null) {
        runtime.audio.write(runtime.engine.renderAudio())
      }

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
  try {
    await main()
  } catch (error) {
    // Missing configuration is a CLI usage failure, not a generic runtime error.
    if (error.code === 'DESTINO_CONFIG' && error.cause?.code === 'ENOENT') {
      console.error(usage)
    } else {
      console.error(`${error.code}: ${error.message}`)
    }

    process.exitCode = 1
  }
}
