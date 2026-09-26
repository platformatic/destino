// SPDX-License-Identifier: GPL-3.0-or-later

import { dlopen, getRawPointer, toBuffer, toString } from 'node:ffi'
import { AudioError, LoaderError } from './errors.js'
import { libraryPath, loadGameAssets } from './loader.js'

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
    // Convert all arguments to pointers to get a char**
    const assets = loadGameAssets(config)
    const args = [process.execPath, '-iwad', assets.wadPath]
    // SAFETY: Both loaders copy the borrowed buffers during these synchronous calls.
    if (assets.wad && !this.#mountFiles(assets.wadPath, assets.wad, BigInt(assets.wad.length), assets.saveDirectory)) {
      throw new LoaderError('Cannot initialize in-memory game files')
    }
    if (assets.font.length > 0x7fffffff || !this.#loadSoundfont(assets.font, assets.font.length)) {
      throw new AudioError(`Cannot load SF2 soundfont: ${assets.fontPath}`)
    }

    if (config.demo) {
      args.push('-playdemo', config.demo)
    }

    const argsC = args.map(s => Buffer.from(s + '\0', 'utf8'))
    const argsBuffer = Buffer.alloc(args.length * 8) // Each pointer is bigint
    for (let i = 0; i < args.length; i++) {
      argsBuffer.writeBigUInt64LE(getRawPointer(argsC[i]), i * 8)
    }

    // Initialize the game
    this.#setWindowTitle = this.#lib.registerCallback({ arguments: ['pointer'], return: 'void' }, cstr => {
      process.title = toString(cstr)
    })

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
