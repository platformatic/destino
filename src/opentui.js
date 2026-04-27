import { dlopen, getRawPointer, suffix, toBuffer } from 'node:ffi'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { getAssetsRoot } from './sea.js'

export class OpenTUI {
  #doom
  #lib
  #frameBuffer
  #renderer
  #settings
  #black
  #blackPointer

  #createRenderer
  #setClearOnShutdown
  #setupTerminal
  #getNextBuffer
  #bufferClear
  #bufferDrawText
  #bufferDrawSuperSampleBuffer
  #render
  #destroyRenderer

  constructor (doom) {
    this.#doom = doom

    let libPath

    if (isSea()) {
      libPath = resolve(getAssetsRoot(), `opentui.${suffix}`)
    } else {
      // Resolve and bind the platform-specific OpenTUI native library.
      const require = createRequire(import.meta.url)
      const openTUIPath = dirname(require.resolve(`@opentui/core-${process.platform}-${process.arch}`))
      libPath = resolve(import.meta.dirname, openTUIPath, `libopentui.${suffix}`)
    }

    console.log(`Loading OpenTUI from ${libPath}`)

    const {
      lib,
      functions: {
        createRenderer,
        setClearOnShutdown,
        setupTerminal,
        getNextBuffer,
        bufferClear,
        bufferDrawText,
        bufferDrawSuperSampleBuffer,
        render,
        destroyRenderer
      }
    } = dlopen(libPath, {
      createRenderer: {
        parameters: ['uint32', 'uint32', 'bool', 'bool'],
        result: 'pointer'
      },
      setClearOnShutdown: {
        parameters: ['pointer', 'bool'],
        result: 'void'
      },
      setupTerminal: {
        parameters: ['pointer', 'bool'],
        result: 'void'
      },
      getNextBuffer: {
        parameters: ['pointer'],
        result: 'pointer'
      },
      bufferClear: {
        parameters: ['pointer', 'pointer'],
        result: 'void'
      },
      bufferDrawText: {
        parameters: ['pointer', 'pointer', 'uint32', 'uint32', 'uint32', 'pointer', 'pointer', 'uint32'],
        result: 'void'
      },
      bufferDrawSuperSampleBuffer: {
        parameters: ['pointer', 'uint32', 'uint32', 'pointer', 'uint64', 'uint8', 'uint32'],
        result: 'void'
      },
      render: {
        parameters: ['pointer', 'bool'],
        result: 'void'
      },
      destroyRenderer: {
        parameters: ['pointer'],
        result: 'void'
      }
    })

    // Keep the library and symbols alive for the whole renderer lifetime.
    this.#lib = lib
    this.#createRenderer = createRenderer
    this.#setClearOnShutdown = setClearOnShutdown
    this.#setupTerminal = setupTerminal
    this.#getNextBuffer = getNextBuffer
    this.#bufferClear = bufferClear
    this.#bufferDrawText = bufferDrawText
    this.#bufferDrawSuperSampleBuffer = bufferDrawSuperSampleBuffer
    this.#render = render
    this.#destroyRenderer = destroyRenderer

    // OpenTUI colors are 5 float32 values: r, g, b, a, color tag.
    // The RGB color tag is 256.
    this.#black = Buffer.allocUnsafe(5 * 4)
    this.#black.writeFloatLE(0, 0)
    this.#black.writeFloatLE(0, 4)
    this.#black.writeFloatLE(0, 8)
    this.#black.writeFloatLE(1, 12)
    this.#black.writeFloatLE(256, 16)
    this.#blackPointer = getRawPointer(this.#black)
  }

  destroy () {
    // Tear down the OpenTUI renderer before closing its native library.
    this.#destroyRenderer(this.#renderer)
    this.#renderer = null
    this.#lib.close()
  }

  render () {
    // Draw into OpenTUI's next back buffer using precomputed scaling settings.
    const targetBuffer = this.#getNextBuffer(this.#renderer)
    const frameBuffer = this.#frameBuffer

    const {
      frameWidth,
      frameHeight,
      scaledFrame,
      scaledFramePointer,
      scaledFrameByteLength,
      scaledFrameWidth,
      scaledFrameHeight,
      scaledFrameBytesPerRow,
      targetCellX,
      targetCellY,
      targetCellHeight,
      rightBandCellX
    } = this.#settings

    if (this.#frameBuffer.length > 0) {
      // Nearest-neighbor scale Doom's BGRA framebuffer into a reusable JS buffer.
      for (let y = 0; y < scaledFrameHeight; y++) {
        const sourceY = Math.floor((y * frameHeight) / scaledFrameHeight)
        const sourceRow = sourceY * frameWidth * 4
        const targetRow = y * scaledFrameBytesPerRow

        for (let x = 0; x < scaledFrameWidth; x++) {
          const sourceX = Math.floor((x * frameWidth) / scaledFrameWidth)
          const sourceOffset = sourceRow + sourceX * 4
          const targetOffset = targetRow + x * 4

          scaledFrame[targetOffset] = frameBuffer[sourceOffset]
          scaledFrame[targetOffset + 1] = frameBuffer[sourceOffset + 1]
          scaledFrame[targetOffset + 2] = frameBuffer[sourceOffset + 2]
          scaledFrame[targetOffset + 3] = 0xff
        }
      }

      // OpenTUI consumes a 2x2 supersample pixel grid per terminal cell.
      this.#bufferDrawSuperSampleBuffer(
        targetBuffer,
        targetCellX,
        targetCellY,
        scaledFramePointer,
        scaledFrameByteLength,
        0,
        scaledFrameBytesPerRow
      )

      this.#render(this.#renderer, 1)

      if (rightBandCellX < process.stdout.columns) {
        // Clear only the trailing terminal margin; OpenTUI can leave stale cells there.
        let clearRightBand = ''

        for (let y = 0; y < targetCellHeight; y++) {
          clearRightBand += `\x1b[${targetCellY + y + 1};${rightBandCellX + 1}H\x1b[K`
        }

        process.stdout.write(clearRightBand)
      }
    }
  }

  setupFrameBuffer () {
    // Capture terminal and Doom dimensions once for the current renderer size.
    const rendererWidth = process.stdout.columns || 80
    const rendererHeight = process.stdout.rows || 24
    const frameWidth = this.#doom.getFrameWidth()
    const frameHeight = this.#doom.getFrameHeight()

    const samplesPerCellX = 2
    const samplesPerCellY = 2
    // Terminal cells are roughly twice as tall as they are wide.
    const terminalCellAspect = 2

    // Fit Doom's framebuffer into the terminal while preserving visual aspect.
    const maxSampleWidth = rendererWidth * samplesPerCellX
    const maxSampleHeight = rendererHeight * samplesPerCellY
    const frameSampleAspect = (frameWidth / frameHeight) * terminalCellAspect

    let scaledFrameWidth = maxSampleWidth
    let scaledFrameHeight = Math.floor(scaledFrameWidth / frameSampleAspect)

    if (scaledFrameHeight > maxSampleHeight) {
      scaledFrameHeight = maxSampleHeight
      scaledFrameWidth = Math.floor(scaledFrameHeight * frameSampleAspect)
    }

    // Keep dimensions aligned to OpenTUI's 2x2 supersample cell blocks.
    scaledFrameWidth = Math.max(samplesPerCellX, scaledFrameWidth - (scaledFrameWidth % samplesPerCellX))
    scaledFrameHeight = Math.max(samplesPerCellY, scaledFrameHeight - (scaledFrameHeight % samplesPerCellY))

    const targetCellWidth = scaledFrameWidth / samplesPerCellX
    const targetCellHeight = scaledFrameHeight / samplesPerCellY
    const targetCellX = Math.floor((rendererWidth - targetCellWidth) / 2)
    const targetCellY = Math.floor((rendererHeight - targetCellHeight) / 2)
    const rightBandCellX = targetCellX + targetCellWidth
    const scaledFrameBytesPerRow = scaledFrameWidth * 4
    const scaledFrame = Buffer.allocUnsafe(scaledFrameBytesPerRow * scaledFrameHeight)
    const scaledFramePointer = getRawPointer(scaledFrame)
    const scaledFrameByteLength = BigInt(scaledFrame.length)

    // Borrow Doom's native framebuffer zero-copy and reuse the scaled buffer every frame.
    this.#frameBuffer = toBuffer(this.#doom.getFramebuffer(), frameWidth * frameHeight * 4, false)
    this.#renderer = this.#createRenderer(rendererWidth, rendererHeight, 0, 0)
    this.#settings = {
      frameWidth,
      frameHeight,
      scaledFrame,
      scaledFramePointer,
      scaledFrameByteLength,
      scaledFrameWidth,
      scaledFrameHeight,
      scaledFrameBytesPerRow,
      targetCellX,
      targetCellY,
      targetCellHeight,
      rightBandCellX
    }

    this.#setClearOnShutdown(this.#renderer, 1)
    this.#setupTerminal(this.#renderer, 1)

    // Clear the terminal once before partial rectangle rendering starts.
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H')

    // Prime OpenTUI's internal buffers so untouched margins remain blank when
    // subsequent frames only draw the centered Doom rectangle.
    for (let i = 0; i < 2; i++) {
      const targetBuffer = this.#getNextBuffer(this.#renderer)
      this.#bufferClear(targetBuffer, this.#blackPointer)
      this.#render(this.#renderer, 1)
    }
  }
}
