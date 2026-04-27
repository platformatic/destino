import { dlopen, getRawPointer, suffix, toString } from 'node:ffi'
import { resolve } from 'node:path'
import { isSea } from 'node:sea'
import { getAssetsRoot } from './sea.js'

export class Engine {
  #lib
  #cleanup
  #setWindowTitle
  #destroyed

  constructor (runtime) {
    const libPath = resolve(getAssetsRoot(), `destino.${suffix}`)
    console.log(`Loading doomgeneric from ${libPath}`)

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
        release_audio: releaseAudio,
        cleanup
      }
    } = dlopen(libPath, {
      init: { parameters: ['int32', 'pointer', 'string', 'pointer'], result: 'pointer' },
      send_key: { parameters: ['uint8', 'int32'], result: 'void' },
      get_framebuffer: { parameters: [], result: 'pointer' },
      get_frame_width: { parameters: [], result: 'int32' },
      get_frame_height: { parameters: [], result: 'int32' },
      frame_ready: { parameters: [], result: 'int32' },
      clear_frame_ready: { parameters: [], result: 'void' },
      quit_requested: { parameters: [], result: 'int32' },
      release_audio: { parameters: [], result: 'void' },
      cleanup: { parameters: [], result: 'void' },
      doomgeneric_Tick: { parameters: [], result: 'void' }
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
    this.releaseAudio = releaseAudio
  }

  initialize (config) {
    // Convert all arguments to pointers to get a char**
    const args = [process.execPath, '-iwad', this.#getWadPath(config)]

    if (config.demo) {
      args.push('-playdemo', config.demo)
    }

    const argsC = args.map(s => Buffer.from(s + '\0', 'utf8'))
    const argsBuffer = Buffer.alloc(args.length * 8) // Each pointer is bigint
    for (let i = 0; i < args.length; i++) {
      argsBuffer.writeBigUInt64LE(getRawPointer(argsC[i]), i * 8)
    }

    // Initialize the game
    this.#setWindowTitle = this.#lib.registerCallback({ parameters: ['string'], result: 'void' }, cstr => {
      process.title = toString(cstr)
    })

    this.init(args.length, argsBuffer, this.#getSF2Path(config), this.#setWindowTitle)
  }

  destroy () {
    if (this.#destroyed) {
      return
    }

    this.#destroyed = true
    this.#cleanup()
    this.#lib.close()
  }

  #getWadPath (config) {
    const path = config.wadPath
      ? resolve(process.cwd(), config.wadPath)
      : resolve(getAssetsRoot(), 'wads/freedoom1.wad')

    console.log(`Using WAD file ${path}`)
    return path
  }

  #getSF2Path (config) {
    let path = null

    if (config.sf2Path) {
      path = resolve(process.cwd(), config.sf2Path)
    } else if (isSea()) {
      path = resolve(getAssetsRoot(), 'sf2s/GeneralUser.sf2')
    }

    console.log(`Using SF2 file ${path}`)
    return path
  }
}
