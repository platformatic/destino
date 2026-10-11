import { dlopen, getRawPointer, toBuffer, toString } from 'node:ffi'
import { AudioError, LoaderError } from './errors.js'
import { libraryPath, loadGameAssets, startupProgress } from './loader.js'

export class Engine {
  #lib
  #cleanup
  #setWindowTitle
  #destroyed
  #renderAudio
  #loadSoundfont
  #mountFiles

  constructor (runtime) {
    const libPath = libraryPath('engine')

    // SAFETY: These signatures match the native platform layer on supported 64-bit targets.
    const {
      lib,
      functions: {
        init,
        doomgeneric_Tick: tick,
        send_key: sendKey,
        get_framebuffer: getFramebuffer,
        get_frame_width: getFrameWidth,
        get_frame_height: getFrameHeight,
        frame_ready: frameReady,
        clear_frame_ready: clearFrameReady,
        quit_requested: quitRequested,
        audio_render: renderAudio,
        audio_load_soundfont: loadSoundfont,
        files_mount: mountFiles,
        cleanup
      }
    } = dlopen(libPath, {
      init: { arguments: ['int32', 'pointer', 'pointer'], return: 'void' },
      send_key: { arguments: ['uint8', 'int32'], return: 'void' },
      get_framebuffer: { arguments: [], return: 'pointer' },
      get_frame_width: { arguments: [], return: 'int32' },
      get_frame_height: { arguments: [], return: 'int32' },
      frame_ready: { arguments: [], return: 'int32' },
      clear_frame_ready: { arguments: [], return: 'void' },
      quit_requested: { arguments: [], return: 'int32' },
      audio_render: { arguments: ['int32'], return: 'pointer' },
      audio_load_soundfont: { arguments: ['pointer', 'int32'], return: 'int32' },
      files_mount: { arguments: ['string', 'pointer', 'uint64', 'string'], return: 'int32' },
      cleanup: { arguments: [], return: 'void' },
      doomgeneric_Tick: { arguments: [], return: 'void' }
    })

    this.#lib = lib
    this.#cleanup = cleanup
    this.#destroyed = false

    this.init = init
    this.tick = tick
    this.sendKey = sendKey
    this.getFramebuffer = getFramebuffer
    this.getFrameWidth = getFrameWidth
    this.getFrameHeight = getFrameHeight
    this.frameReady = frameReady
    this.clearFrameReady = clearFrameReady
    this.quitRequested = quitRequested
    this.#renderAudio = renderAudio
    this.#loadSoundfont = loadSoundfont
    this.#mountFiles = mountFiles
  }

  initialize (config) {
    const assets = loadGameAssets(config)
    const args = [process.execPath, '-iwad', assets.wadPath]

    startupProgress('Preparing in-memory game assets...')
    // SAFETY: The mount copies the borrowed WAD buffer during this synchronous call.
    if (assets.wad && !this.#mountFiles(assets.wadPath, assets.wad, BigInt(assets.wad.length), assets.saveDirectory)) {
      throw new LoaderError('Cannot initialize in-memory game files')
    }

    startupProgress('Initializing the soundfont synthesizer...')
    // SAFETY: The synthesizer copies the borrowed font buffer during this synchronous call.
    if (assets.font.length > 0x7fffffff || !this.#loadSoundfont(assets.font, assets.font.length)) {
      throw new AudioError(`Cannot load SF2 soundfont: ${assets.fontPath}`)
    }

    if (config.demo) {
      args.push('-playdemo', config.demo)
    }

    // Retain the NUL-terminated buffers while constructing the native char** argument table.
    const argsC = args.map(s => Buffer.from(s + '\0', 'utf8'))
    const argsBuffer = Buffer.alloc(args.length * 8) // Each pointer is bigint
    for (let i = 0; i < args.length; i++) {
      // SAFETY: argsC keeps each allocation alive through the synchronous initialization below.
      argsBuffer.writeBigUInt64LE(getRawPointer(argsC[i]), i * 8)
    }

    // SAFETY: Keep the callback registered while native code may invoke it on Node's thread.
    this.#setWindowTitle = this.#lib.registerCallback({ arguments: ['pointer'], return: 'void' }, cstr => {
      // SAFETY: Doom provides a borrowed NUL-terminated title, copied before returning.
      process.title = toString(cstr)
    })

    startupProgress('Initializing Doom...')
    // SAFETY: Native initialization copies argv before the local buffers can be collected.
    this.init(args.length, argsBuffer, this.#setWindowTitle)
  }

  renderAudio () {
    // SAFETY: audio.c returns 1260 stereo int16 frames; copy before its next render.
    return toBuffer(this.#renderAudio(1260), 1260 * 4)
  }

  destroy () {
    if (this.#destroyed) {
      return
    }

    this.#destroyed = true
    this.#cleanup()
    this.#lib.close()
  }
}
