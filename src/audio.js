// SPDX-License-Identifier: MIT

import { dlopen, toString } from 'node:ffi'
import { AudioError } from './errors.js'
import { libraryPath } from './loader.js'

const signatures = {
  SDL_GetVersion: { arguments: [], return: 'int32' },
  SDL_InitSubSystem: { arguments: ['uint32'], return: 'bool' },
  SDL_QuitSubSystem: { arguments: ['uint32'], return: 'void' },
  SDL_GetError: { arguments: [], return: 'pointer' },
  SDL_OpenAudioDeviceStream: { arguments: ['uint32', 'pointer', 'pointer', 'pointer'], return: 'pointer' },
  SDL_DestroyAudioStream: { arguments: ['pointer'], return: 'void' },
  SDL_PutAudioStreamData: { arguments: ['pointer', 'pointer', 'int32'], return: 'bool' },
  SDL_GetAudioStreamQueued: { arguments: ['pointer'], return: 'int32' },
  SDL_ClearAudioStream: { arguments: ['pointer'], return: 'bool' },
  SDL_ResumeAudioStreamDevice: { arguments: ['pointer'], return: 'bool' }
}

export class Audio {
  #lib
  #functions
  #stream = 0n
  #initialized = false

  constructor () {
    const path = libraryPath('audio')
    try {
      // SAFETY: Signatures match SDL 3.2+; no callbacks run on SDL's audio thread.
      const { lib, functions } = dlopen(path, signatures)
      this.#lib = lib
      this.#functions = functions
      const version = this.#call('SDL_GetVersion')
      if (version < 3002000 || version >= 4000000) {
        throw new AudioError('SDL 3.2 or later in the 3.x series is required')
      }
      this.#check('SDL_InitSubSystem', 0x10)
      this.#initialized = true
      const spec = Buffer.alloc(12)
      spec.writeUInt32LE(0x8010, 0) // SDL_AUDIO_S16LE.
      spec.writeInt32LE(2, 4)
      spec.writeInt32LE(44100, 8)
      this.#stream = this.#call('SDL_OpenAudioDeviceStream', 0xffffffff, spec, null, null)
      if (!this.#stream) {
        throw this.#error('SDL_OpenAudioDeviceStream')
      }
      // Prime one tick of silence to absorb timer jitter without unbounded latency.
      this.#check('SDL_PutAudioStreamData', this.#stream, Buffer.alloc(1260 * 4), 1260 * 4)
      this.#check('SDL_ResumeAudioStreamDevice', this.#stream)
    } catch (error) {
      this.destroy()
      throw error.code === 'DESTINO_AUDIO' ? error : new AudioError(error.message, { cause: error })
    }
  }

  #call (name, ...args) {
    // SAFETY: Handles belong to the live library; SDL synchronously copies input buffers.
    return this.#functions[name](...args)
  }

  #error (name) {
    const pointer = this.#call('SDL_GetError')
    // SAFETY: SDL owns this thread-local NUL-terminated string.
    return new AudioError(`${name}: ${pointer ? toString(pointer) : 'unknown SDL error'}`)
  }

  #check (name, ...args) {
    if (!this.#call(name, ...args)) {
      throw this.#error(name)
    }
  }

  write (samples) {
    if (!this.#stream) {
      throw new AudioError('Audio stream is closed')
    }
    const queued = this.#call('SDL_GetAudioStreamQueued', this.#stream)
    if (queued < 0) {
      throw this.#error('SDL_GetAudioStreamQueued')
    }
    // Drop stale output after a stall instead of allowing latency to grow indefinitely.
    if (queued + samples.length > 44100 * 4 / 10) {
      this.#check('SDL_ClearAudioStream', this.#stream)
    }
    this.#check('SDL_PutAudioStreamData', this.#stream, samples, samples.length)
  }

  destroy () {
    if (this.#stream) {
      this.#call('SDL_DestroyAudioStream', this.#stream)
      this.#stream = 0n
    }
    if (this.#initialized) {
      this.#call('SDL_QuitSubSystem', 0x10)
      this.#initialized = false
    }
    this.#lib?.close()
    this.#lib = null
  }
}
