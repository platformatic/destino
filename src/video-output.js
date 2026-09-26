// SPDX-License-Identifier: MIT

import { toBuffer } from 'node:ffi'
import { writeSync } from 'node:fs'
import { VideoError } from './errors.js'

// Ported from Principe: rewrite placement headers only. Image payloads and all
// other native output remain byte-for-byte intact, including synchronized output.
export function fixVideoIndex (data) {
  const start = Buffer.from('\x1b_G')
  const stop = Buffer.from('\x1b\\')
  const parts = []
  let copied = 0
  let offset = 0
  while ((offset = data.indexOf(start, offset)) !== -1) {
    const end = data.indexOf(stop, offset + start.length)
    if (end === -1) {
      break
    }
    const separator = data.indexOf(59, offset + start.length)
    const headerEnd = separator >= 0 && separator < end ? separator : end
    const headerStart = offset + start.length
    const header = data.toString('ascii', headerStart, headerEnd)
    if (/(?:^|,)a=p(?:,|$)/.test(header)) {
      const match = /(?:^|,)z=(-?\d+)(?=,|$)/.exec(header)
      if (match && match[1] !== '-1') {
        const valueStart = headerStart + match.index + match[0].length - match[1].length
        parts.push(data.subarray(copied, valueStart), Buffer.from('-1'))
        copied = valueStart + match[1].length
      }
    }
    offset = end + stop.length
  }
  if (!parts.length) {
    return data
  }
  parts.push(data.subarray(copied))
  return Buffer.concat(parts)
}

export class VideoOutput {
  #lib
  #functions
  #callback
  #state
  #spans = Buffer.alloc(24 * 64)
  #fixIndex
  feed

  constructor (lib, fixIndex) {
    // Borrow the renderer's library: opening a VFS library twice can materialize
    // two independent images, whose native handles and output state cannot mix.
    this.#lib = lib
    this.#fixIndex = fixIndex
    try {
      this.#functions = lib.getFunctions({
        createNativeSpanFeed: { arguments: ['pointer'], return: 'pointer' },
        streamSetCallback: { arguments: ['pointer', 'pointer'], return: 'void' },
        attachNativeSpanFeed: { arguments: ['pointer'], return: 'int32' },
        streamDrainSpans: { arguments: ['pointer', 'pointer', 'uint32'], return: 'uint32' },
        destroyNativeSpanFeed: { arguments: ['pointer'], return: 'void' }
      })
      // SAFETY: OpenTUI 0.5.11 uses 64-bit pointers and 24-byte feed options.
      const options = Buffer.alloc(24)
      options.writeUInt32LE(65536, 0)
      options.writeUInt32LE(2, 4)
      options.writeBigUInt64LE(32n * 1024n * 1024n, 8)
      options[17] = 1
      options.writeUInt32LE(512, 20)
      this.feed = this.#functions.createNativeSpanFeed(options)
      if (!this.feed) {
        throw new VideoError('Could not create OpenTUI output feed')
      }
      this.#callback = lib.registerCallback(
        { arguments: ['uint64', 'uint32', 'uint64', 'uint64'], return: 'void' },
        (stream, event, pointer, size) => {
          if (event === 8) {
            // SAFETY: StateBuffer is owned by the feed. Renderer threads are
            // disabled, and this view is discarded before destroying the feed.
            this.#state = toBuffer(pointer, Number(size), false)
          }
        }
      )
      this.#functions.streamSetCallback(this.feed, this.#callback)
      if (this.#functions.attachNativeSpanFeed(this.feed) !== 0) {
        throw new VideoError('Could not attach OpenTUI output feed')
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  flush (operation) {
    const chunks = []
    let count
    while ((count = this.#functions.streamDrainSpans(this.feed, this.#spans, 64)) > 0) {
      for (let i = 0; i < count; i++) {
        const offset = i * 24
        const pointer = this.#spans.readBigUInt64LE(offset)
        const start = this.#spans.readUInt32LE(offset + 8)
        const length = this.#spans.readUInt32LE(offset + 12)
        const index = this.#spans.readUInt32LE(offset + 16)
        if (!this.#state || index >= this.#state.length || this.#state[index] === 0) {
          throw new VideoError('Invalid OpenTUI output span ownership')
        }
        // SAFETY: Copy each pinned native span before releasing its chunk.
        chunks.push(Buffer.from(toBuffer(pointer + BigInt(start), length, false)))
        this.#state[index]--
      }
    }
    if (!chunks.length) {
      return
    }
    const data = Buffer.concat(chunks)
    // Transform complete native render transactions, never individual spans.
    const output = operation === 'render' && this.#fixIndex ? fixVideoIndex(data) : data
    let offset = 0
    while (offset < output.length) {
      offset += writeSync(process.stdout.fd, output, offset, output.length - offset)
    }
  }

  close () {
    if (this.feed) {
      this.#functions.streamSetCallback(this.feed, null)
      this.#functions.destroyNativeSpanFeed(this.feed)
      this.feed = null
      this.#state = null
    }
    if (this.#callback) {
      this.#lib.unregisterCallback(this.#callback)
      this.#callback = null
    }
  }
}
