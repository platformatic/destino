// SPDX-License-Identifier: MIT

import { dlopen, toBuffer } from 'node:ffi'
import { VideoError } from './errors.js'
import { libraryPath } from './loader.js'
import { VideoOutput } from './video-output.js'

// OpenTUI 0.5.11 ABI, as used by Principe: u32 handles and [4]u16 colors.
const signatures = {
  createRenderer: { arguments: ['uint32', 'uint32', 'uint8', 'uint8', 'pointer'], return: 'uint32' },
  destroyRenderer: { arguments: ['uint32', 'bool'], return: 'void' },
  setUseThread: { arguments: ['uint32', 'bool'], return: 'void' },
  setTerminalEnvVar: { arguments: ['uint32', 'pointer', 'uint32', 'pointer', 'uint32'], return: 'bool' },
  setClearOnShutdown: { arguments: ['uint32', 'bool'], return: 'void' },
  setKittyKeyboardFlags: { arguments: ['uint32', 'uint8'], return: 'void' },
  setKittyImageTransport: { arguments: ['uint32', 'uint32'], return: 'uint32' },
  setupTerminal: { arguments: ['uint32', 'bool'], return: 'void' },
  processCapabilityResponse: { arguments: ['uint32', 'pointer', 'uint32'], return: 'void' },
  queryPixelResolution: { arguments: ['uint32'], return: 'void' },
  resizeRenderer: { arguments: ['uint32', 'uint32', 'uint32'], return: 'void' },
  getNextBuffer: { arguments: ['uint32'], return: 'uint32' },
  bufferClear: { arguments: ['uint32', 'pointer'], return: 'void' },
  bufferDrawText: { arguments: ['uint32', 'pointer', 'uint32', 'uint32', 'uint32', 'pointer', 'pointer', 'uint32'], return: 'void' },
  imageCreateFromRgba: { arguments: ['pointer', 'uint64', 'uint32', 'uint32', 'uint32', 'pointer'], return: 'uint32' },
  imageDestroy: { arguments: ['uint32'], return: 'void' },
  bufferDrawImage: { arguments: ['uint32', 'uint32', 'pointer'], return: 'uint8' },
  render: { arguments: ['uint32', 'bool'], return: 'uint8' }
}

export class Video {
  #doom
  #lib
  #functions
  #output
  #renderer = 0
  #image = 0
  #retired = []
  #frameBuffer
  #rgbaFrame
  #frameWidth
  #frameHeight
  #showStatus
  #status = ''
  #info = ''
  #columns = 0
  #rows = 0
  #pixelWidth = 0
  #pixelHeight = 0
  #kittySupported = false
  #awaitingPixels = false
  #response = ''
  #onData
  #onResize
  #resolutionTimer
  #pendingResolution
  #failure
  #closed = false
  #black = Buffer.from([0, 0, 0, 0, 0, 0, 255, 0])
  #white = Buffer.from([255, 0, 255, 0, 255, 0, 255, 0])

  constructor (doom, { fixVideoIndex = true, showStatus = true } = {}) {
    if (typeof fixVideoIndex !== 'boolean' || typeof showStatus !== 'boolean') {
      throw new VideoError('fixVideoIndex and showStatus must be booleans')
    }
    this.#doom = doom
    this.#showStatus = showStatus
    this.#onData = data => {
      try {
        this.#processResponses(data)
      } catch (error) {
        this.#failure = error
        this.#pendingResolution?.reject(error)
      }
    }
    this.#onResize = () => {
      try {
        this.#resize()
        this.#requestResolution()
      } catch (error) {
        this.#failure = error
        this.#pendingResolution?.reject(error)
      }
    }
    try {
      // SAFETY: Load the pinned library once so the feed and renderer share all
      // native state, including when Node materializes it from the SEA VFS.
      const { lib, functions } = dlopen(libraryPath('video'), signatures)
      this.#lib = lib
      this.#functions = functions
      this.#output = new VideoOutput(lib, fixVideoIndex)
    } catch (error) {
      this.destroy()
      throw new VideoError(`Cannot initialize OpenTUI: ${error.message}`, { cause: error })
    }
  }

  #call (name, ...args) {
    try {
      // SAFETY: Handles belong to this live library and JS buffers are borrowed
      // only for synchronous calls. Native rendering threads are disabled.
      const result = this.#functions[name](...args)
      this.#output.flush(name)
      return result
    } catch (error) {
      throw new VideoError(`${name}: ${error.message}`, { cause: error })
    }
  }

  #resize () {
    const columns = Math.max(1, process.stdout.columns ?? 80)
    const rows = Math.max(1, process.stdout.rows ?? 24)
    if (!this.#renderer) {
      this.#renderer = this.#call('createRenderer', columns, rows, 0, 0, this.#output.feed)
      if (!this.#renderer) {
        throw new VideoError('Cannot create OpenTUI renderer')
      }
      // Configure the renderer's native environment explicitly. Text measurement
      // probes draw before alternate-screen entry and are unnecessary for our
      // ASCII status bar. Graphics, keyboard and pixel-size queries stay enabled.
      for (const [name, value] of Object.entries({
        OPENTUI_IMAGE_PROTOCOL: 'kitty',
        OPENTUI_GRAPHICS: 'true',
        OPENTUI_FORCE_EXPLICIT_WIDTH: 'false'
      })) {
        const key = Buffer.from(name)
        const bytes = Buffer.from(value)
        if (!this.#call('setTerminalEnvVar', this.#renderer, key, key.length, bytes, bytes.length)) {
          throw new VideoError(`Cannot configure OpenTUI setting ${name}`)
        }
      }
      this.#call('setUseThread', this.#renderer, 0)
      this.#call('setClearOnShutdown', this.#renderer, 1)
      // Use the same flags as TerminalParser: OpenTUI may finish negotiation
      // later and push its own mode. Both owners pop one level during shutdown.
      this.#call('setKittyKeyboardFlags', this.#renderer, 11)
      this.#call('setKittyImageTransport', this.#renderer, 1)
    } else if (columns !== this.#columns || rows !== this.#rows) {
      this.#call('resizeRenderer', this.#renderer, columns, rows)
    }
    this.#columns = columns
    this.#rows = rows
  }

  #processResponses (data) {
    this.#response = (this.#response + data.toString('ascii')).slice(-16384)
    // Forward complete CSI/APC replies, retaining fragmented terminal responses.
    // Keyboard sequences are ignored by OpenTUI's capability parser.
    // eslint-disable-next-line no-control-regex
    const replies = [...this.#response.matchAll(/\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b_G[^\x1b]*\x1b\\/g)]
    for (const reply of replies) {
      const bytes = Buffer.from(reply[0], 'ascii')
      this.#call('processCapabilityResponse', this.#renderer, bytes, bytes.length)
      // OpenTUI 0.5.11 uses image 31337 for its graphics capability query.
      // eslint-disable-next-line no-control-regex
      if (/^\x1b_G(?:[^;]*,)?i=31337(?:,[^;]*)?;OK\x1b\\$/.test(reply[0])) {
        this.#kittySupported = true
      }
      // eslint-disable-next-line no-control-regex
      const dimensions = /^\x1b\[4;(\d+);(\d+)t$/.exec(reply[0])
      if (dimensions) {
        const height = Number(dimensions[1])
        const width = Number(dimensions[2])
        if ([height, width].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) {
          this.#pixelWidth = width
          this.#pixelHeight = height
          this.#awaitingPixels = false
        }
      }
      if (this.#kittySupported && this.#pixelWidth && this.#pixelHeight && !this.#awaitingPixels) {
        clearTimeout(this.#resolutionTimer)
        this.#pendingResolution?.resolve()
      }
    }
    if (replies.length) {
      const last = replies.at(-1)
      this.#response = this.#response.slice(last.index + last[0].length)
    }
  }

  #requestResolution () {
    clearTimeout(this.#resolutionTimer)
    this.#awaitingPixels = true
    this.#resolutionTimer = setTimeout(() => {
      this.#failure = new VideoError('Terminal did not confirm Kitty Graphics and pixel resolution within 1500ms')
      this.#pendingResolution?.reject(this.#failure)
    }, 1500)
    this.#call('queryPixelResolution', this.#renderer)
  }

  async measureScreen () {
    this.#pendingResolution = Promise.withResolvers()
    try {
      this.#requestResolution()
      await this.#pendingResolution.promise
    } finally {
      this.#pendingResolution = null
    }
  }

  setStatus (text) { this.#status = text }
  setInfo (text) { this.#info = text }

  setupFrameBuffer () {
    this.#frameWidth = this.#doom.getFrameWidth()
    this.#frameHeight = this.#doom.getFrameHeight()
    // SAFETY: Doom owns this allocation and outlives the renderer. Reads happen
    // on the same thread between engine ticks, before its library is unloaded.
    this.#frameBuffer = toBuffer(this.#doom.getFramebuffer(), this.#frameWidth * this.#frameHeight * 4, false)
    this.#rgbaFrame = Buffer.alloc(this.#frameBuffer.length)
    this.#resize()
    process.stdin.on('data', this.#onData)
    process.stdout.on('resize', this.#onResize)
    process.on('SIGWINCH', this.#onResize)
    this.#call('setupTerminal', this.#renderer, 1)
  }

  render () {
    if (this.#failure) {
      throw this.#failure
    }
    if (this.#closed || !this.#pixelWidth || !this.#pixelHeight) {
      throw new VideoError('Renderer is closed or terminal pixel resolution is unavailable')
    }
    this.#resize()
    const buffer = this.#call('getNextBuffer', this.#renderer)
    // Rebuild the entire native frame, including black margins and the bar.
    // OpenTUI owns graphics transfer, placement, synchronization and presentation.
    this.#call('bufferClear', buffer, this.#black)
    const gameRows = this.#rows - Number(this.#showStatus)
    if (gameRows > 0) {
      const ratio = (this.#frameWidth / this.#frameHeight) *
        (this.#pixelHeight / this.#rows) / (this.#pixelWidth / this.#columns)
      let width = this.#columns
      let height = Math.max(1, Math.floor(width / ratio))
      if (height > gameRows) {
        height = gameRows
        width = Math.max(1, Math.floor(height * ratio))
      }
      for (let i = 0; i < this.#frameBuffer.length; i += 4) {
        this.#rgbaFrame[i] = this.#frameBuffer[i + 2]
        this.#rgbaFrame[i + 1] = this.#frameBuffer[i + 1]
        this.#rgbaFrame[i + 2] = this.#frameBuffer[i]
        this.#rgbaFrame[i + 3] = 255
      }
      const handle = Buffer.alloc(4)
      const result = this.#call('imageCreateFromRgba', this.#rgbaFrame, BigInt(this.#rgbaFrame.length),
        this.#frameWidth, this.#frameHeight, this.#frameWidth * 4, handle)
      if (result !== 0 || handle.readUInt32LE(0) === 0) {
        throw new VideoError(`Cannot create OpenTUI image: status ${result}`)
      }
      if (this.#image) {
        this.#retired.push(this.#image)
      }
      this.#image = handle.readUInt32LE(0)
      const options = Buffer.alloc(44)
      options.writeInt32LE(Math.floor((this.#columns - width) / 2), 0)
      options.writeInt32LE(Math.floor((gameRows - height) / 2), 4)
      options.writeUInt32LE(width, 8)
      options.writeUInt32LE(height, 12)
      options.writeUInt32LE(this.#frameWidth, 16)
      options.writeUInt32LE(this.#frameHeight, 20)
      options.writeUInt32LE(this.#frameWidth, 32)
      options.writeUInt32LE(this.#frameHeight, 36)
      if (!this.#call('bufferDrawImage', buffer, this.#image, options)) {
        throw new VideoError('Cannot draw OpenTUI image')
      }
    }
    if (this.#showStatus) {
      const info = Buffer.from(this.#info.replace(/[^\x20-\x7e]/g, '?').slice(0, this.#columns))
      const status = Buffer.from(this.#status.replace(/[^\x20-\x7e]/g, '?')
        .slice(0, Math.max(0, this.#columns - info.length - 1)))
      this.#call('bufferDrawText', buffer, status, status.length, 0, this.#rows - 1, this.#white, this.#black, 0)
      this.#call('bufferDrawText', buffer, info, info.length, this.#columns - info.length,
        this.#rows - 1, this.#white, this.#black, 0)
    }
    const result = this.#call('render', this.#renderer, 1)
    if (result === 2) {
      throw new VideoError('OpenTUI presentation failed')
    }
    if (result === 0) {
      for (const image of this.#retired) {
        this.#call('imageDestroy', image)
      }
      this.#retired = []
    }
  }

  destroy () {
    if (this.#closed) {
      return
    }
    this.#closed = true
    clearTimeout(this.#resolutionTimer)
    this.#pendingResolution?.reject(new VideoError('Screen resolution detection was interrupted'))
    process.stdin.off('data', this.#onData)
    process.stdout.off('resize', this.#onResize)
    process.off('SIGWINCH', this.#onResize)
    try {
      if (this.#renderer) {
        this.#call('destroyRenderer', this.#renderer, 1)
        this.#renderer = 0
      }
      for (const image of [...this.#retired, this.#image]) {
        if (image) {
          this.#call('imageDestroy', image)
        }
      }
    } finally {
      try {
        this.#output?.close()
      } finally {
        this.#lib?.close()
      }
    }
  }
}
