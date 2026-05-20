// SPDX-License-Identifier: MIT

import { toBuffer } from 'node:ffi'

const graphicsChunkSize = 4096

export class KittyRenderer {
  #doom
  #frameBuffer
  #rgbaFrame
  #settings
  #imageId
  #previousImageId

  static isSupported () {
    const term = process.env.TERM ?? ''
    const termProgram = process.env.TERM_PROGRAM ?? ''

    return (
      term === 'xterm-kitty' ||
      termProgram === 'ghostty' ||
      termProgram === 'WezTerm' ||
      Boolean(process.env.WEZTERM_EXECUTABLE)
    )
  }

  constructor (doom) {
    this.#doom = doom
    this.#imageId = 1
    this.#previousImageId = null
  }

  destroy () {
    if (this.#previousImageId !== null) {
      process.stdout.write(`\x1b_Ga=d,d=i,i=${this.#previousImageId},q=2;\x1b\\`)
      this.#previousImageId = null
    }
  }

  render () {
    const { frameWidth, frameHeight, targetCellX, targetCellY, targetCellWidth, targetCellHeight } = this.#settings

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

    process.stdout.write(`\x1b[${targetCellY + 1};${targetCellX + 1}H`)

    for (let i = 0; i < chunks.length; i++) {
      const more = i < chunks.length - 1 ? 1 : 0
      const header =
        i === 0
          ? `a=T,t=d,f=32,s=${frameWidth},v=${frameHeight},c=${targetCellWidth},r=${targetCellHeight},i=${imageId},q=2,m=${more}`
          : `m=${more}`

      process.stdout.write(`\x1b_G${header};${chunks[i]}\x1b\\`)
    }

    if (this.#previousImageId !== null) {
      process.stdout.write(`\x1b_Ga=d,d=i,i=${this.#previousImageId},q=2;\x1b\\`)
    }

    this.#previousImageId = imageId
  }

  setupFrameBuffer () {
    const rendererWidth = process.stdout.columns || 80
    const rendererHeight = process.stdout.rows || 24
    const frameWidth = this.#doom.getFrameWidth()
    const frameHeight = this.#doom.getFrameHeight()
    const terminalCellAspect = 2

    let targetCellHeight = rendererHeight
    let targetCellWidth = Math.floor(targetCellHeight * (frameWidth / frameHeight) * terminalCellAspect)

    if (targetCellWidth > rendererWidth) {
      targetCellWidth = rendererWidth
      targetCellHeight = Math.floor(targetCellWidth / ((frameWidth / frameHeight) * terminalCellAspect))
    }

    const targetCellX = Math.floor((rendererWidth - targetCellWidth) / 2)
    const targetCellY = Math.floor((rendererHeight - targetCellHeight) / 2)

    this.#frameBuffer = toBuffer(this.#doom.getFramebuffer(), frameWidth * frameHeight * 4, false)
    this.#rgbaFrame = Buffer.allocUnsafe(frameWidth * frameHeight * 4)
    this.#settings = { frameWidth, frameHeight, targetCellX, targetCellY, targetCellWidth, targetCellHeight }

    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[3J\x1b[H')
  }
}
