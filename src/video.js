// SPDX-License-Identifier: MIT

import { toBuffer } from 'node:ffi'
import { VideoError } from './errors.js'

const graphicsChunkSize = 4096

export class Video {
  #doom
  #frameBuffer
  #rgbaFrame
  #settings
  #imageId
  #previousImageId
  #fixVideoIndex
  #showStatus
  #status = ''
  #info = ''
  #columns = 0
  #rows = 0
  #pixelWidth = 0
  #pixelHeight = 0
  #response = ''
  #onData
  #onResize
  #resolutionTimer
  #pendingResolution
  #failure

  constructor (doom, { fixVideoIndex = true, showStatus = true } = {}) {
    if (typeof fixVideoIndex !== 'boolean') {
      throw new VideoError('fixVideoIndex must be a boolean')
    }
    if (typeof showStatus !== 'boolean') {
      throw new VideoError('showStatus must be a boolean')
    }
    this.#doom = doom
    this.#fixVideoIndex = fixVideoIndex
    this.#showStatus = showStatus
    this.#imageId = 1
    this.#previousImageId = null
    this.#onData = data => {
      // Replies may be split across stdin chunks or mixed with keyboard input.
      this.#response = (this.#response + data.toString('ascii')).slice(-4096)
      // CSI 4 ; height ; width t reports the text area's actual pixel size.
      // eslint-disable-next-line no-control-regex
      const replies = [...this.#response.matchAll(/\x1b\[4;(\d+);(\d+)t/g)]
      for (const reply of replies) {
        const height = Number(reply[1])
        const width = Number(reply[2])
        if (![height, width].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) {
          continue
        }
        this.#pixelWidth = width
        this.#pixelHeight = height
        clearTimeout(this.#resolutionTimer)
        this.#pendingResolution?.resolve()
      }
      if (replies.length) {
        const last = replies.at(-1)
        this.#response = this.#response.slice(last.index + last[0].length)
      }
    }
    this.#onResize = () => this.#requestResolution()
  }

  #requestResolution () {
    clearTimeout(this.#resolutionTimer)
    this.#resolutionTimer = setTimeout(() => {
      this.#failure = new VideoError('Terminal did not report its pixel resolution within 1500ms')
      this.#pendingResolution?.reject(this.#failure)
    }, 1500)
    process.stdout.write('\x1b[14t')
  }

  async measureScreen () {
    // Input has already enabled raw mode. Query after entering the alternate
    // screen, and repeat on SIGWINCH for font/DPI changes as well as grid resize.
    this.#pendingResolution = Promise.withResolvers()
    process.stdin.on('data', this.#onData)
    process.stdout.on('resize', this.#onResize)
    process.on('SIGWINCH', this.#onResize)
    this.#requestResolution()
    try {
      await this.#pendingResolution.promise
    } finally {
      this.#pendingResolution = null
    }
  }

  destroy () {
    clearTimeout(this.#resolutionTimer)
    this.#pendingResolution?.reject(new VideoError('Screen resolution detection was interrupted'))
    process.stdin.off('data', this.#onData)
    process.stdout.off('resize', this.#onResize)
    process.off('SIGWINCH', this.#onResize)
    if (this.#previousImageId !== null) {
      process.stdout.write(`\x1b_Ga=d,d=I,i=${this.#previousImageId},q=2;\x1b\\`)
      this.#previousImageId = null
    }
  }

  setStatus (text) {
    this.#status = text
  }

  setInfo (text) {
    this.#info = text
  }

  #updateLayout () {
    const columns = Math.max(1, process.stdout.columns ?? 80)
    const rows = Math.max(1, process.stdout.rows ?? 24)
    this.#columns = columns
    this.#rows = rows
    const { frameWidth, frameHeight } = this.#settings
    const gameRows = rows - (this.#showStatus ? 1 : 0)
    // Match Principe: use measured cell geometry, start at full width and only
    // shrink horizontally when the resulting height cannot fit the game area.
    const cellWidth = this.#pixelWidth / columns
    const cellHeight = this.#pixelHeight / rows
    const cellAspect = (frameWidth / frameHeight) * cellHeight / cellWidth
    let targetCellWidth = columns
    let targetCellHeight = Math.max(1, Math.floor(targetCellWidth / cellAspect))
    if (targetCellHeight > gameRows) {
      targetCellHeight = gameRows
      targetCellWidth = Math.max(1, Math.floor(targetCellHeight * cellAspect))
    }
    if (gameRows === 0) {
      targetCellWidth = 0
    }
    Object.assign(this.#settings, {
      targetCellWidth,
      targetCellHeight,
      targetCellX: Math.floor((columns - targetCellWidth) / 2),
      targetCellY: Math.floor((gameRows - targetCellHeight) / 2)
    })
  }

  #statusSequence () {
    if (!this.#showStatus) {
      return ''
    }
    // Like Principe, use printable ASCII for predictable one-cell text and to
    // prevent filenames from injecting terminal controls. Leave the final cell
    // unused so writing the bottom row cannot wrap or scroll the screen.
    const width = Math.max(0, this.#columns - 1)
    const info = this.#info.replace(/[^\x20-\x7e]/g, '?').slice(0, width)
    const status = this.#status.replace(/[^\x20-\x7e]/g, '?').slice(0, Math.max(0, width - info.length - 1))
    const line = status + ' '.repeat(width - status.length - info.length) + info
    return `\x1b[${this.#rows};1H\x1b[0;37;40m\x1b[2K${line}`
  }

  render () {
    if (this.#failure) {
      throw this.#failure
    }
    if (!this.#pixelWidth || !this.#pixelHeight) {
      throw new VideoError('Terminal pixel resolution is unavailable')
    }
    this.#updateLayout()
    const { frameWidth, frameHeight, targetCellX, targetCellY, targetCellWidth, targetCellHeight } = this.#settings
    if (targetCellHeight === 0) {
      const deletion = this.#previousImageId === null
        ? ''
        : `\x1b_Ga=d,d=I,i=${this.#previousImageId},q=2;\x1b\\`
      process.stdout.write(`\x1b[0;37;40m\x1b[2J${deletion}${this.#statusSequence()}`)
      this.#previousImageId = null
      return
    }

    for (let i = 0; i < this.#frameBuffer.length; i += 4) {
      this.#rgbaFrame[i] = this.#frameBuffer[i + 2]
      this.#rgbaFrame[i + 1] = this.#frameBuffer[i + 1]
      this.#rgbaFrame[i + 2] = this.#frameBuffer[i]
      this.#rgbaFrame[i + 3] = 0xff
    }

    const imageId = this.#imageId++
    const payload = this.#rgbaFrame.toString('base64')
    const chunks = []

    for (let i = 0; i < payload.length; i += graphicsChunkSize) {
      chunks.push(payload.slice(i, i + graphicsChunkSize))
    }

    // Repaint margins without erasing the current image. Clearing the whole
    // screen between uploads exposes a blank frame on terminals without atomic
    // graphics presentation. ECH paints only cells outside the new game area.
    const output = ['\x1b[0;37;40m']
    const gameRows = this.#rows - (this.#showStatus ? 1 : 0)
    for (let row = 0; row < gameRows; row++) {
      if (row < targetCellY || row >= targetCellY + targetCellHeight) {
        output.push(`\x1b[${row + 1};1H\x1b[2K`)
      } else {
        if (targetCellX > 0) {
          output.push(`\x1b[${row + 1};1H\x1b[${targetCellX}X`)
        }
        const right = targetCellX + targetCellWidth
        if (right < this.#columns) {
          output.push(`\x1b[${row + 1};${right + 1}H\x1b[${this.#columns - right}X`)
        }
      }
    }
    output.push(`\x1b[${targetCellY + 1};${targetCellX + 1}H`)
    // Use the original combined transmission/placement command for terminal
    // compatibility. The old image stays alive until this upload completes.
    const indexing = this.#fixVideoIndex ? ',z=-1' : ''
    for (let i = 0; i < chunks.length; i++) {
      const more = i < chunks.length - 1 ? 1 : 0
      const header =
        i === 0
          ? `a=T,t=d,f=32,s=${frameWidth},v=${frameHeight},c=${targetCellWidth},r=${targetCellHeight},i=${imageId},C=1,q=2,m=${more}${indexing}`
          : `m=${more}`

      output.push(`\x1b_G${header};${chunks[i]}\x1b\\`)
    }

    const deletion = this.#previousImageId === null
      ? ''
      : `\x1b_Ga=d,d=I,i=${this.#previousImageId},q=2;\x1b\\`
    output.push(deletion, this.#statusSequence())
    process.stdout.write(output.join(''))

    this.#previousImageId = imageId
  }

  setupFrameBuffer () {
    const frameWidth = this.#doom.getFrameWidth()
    const frameHeight = this.#doom.getFrameHeight()

    // SAFETY: Doom owns this buffer and outlives Video. Rendering reads it only
    // between synchronous engine ticks, before the native library is unloaded.
    this.#frameBuffer = toBuffer(this.#doom.getFramebuffer(), frameWidth * frameHeight * 4, false)
    this.#rgbaFrame = Buffer.allocUnsafe(frameWidth * frameHeight * 4)
    this.#settings = { frameWidth, frameHeight }

    process.stdout.write('\x1b[?2026l\x1b[?1049h\x1b[?25l\x1b[2J\x1b[3J\x1b[H')
  }
}
