// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events'
import { InputError } from './errors.js'

export const doomKeys = {
  moveForward: 173,
  moveBackward: 175,
  turnLeft: 172,
  turnRight: 174,
  strafeLeft: 160,
  strafeRight: 161,
  fire: 163,
  use: 162,
  menu: 27,
  pause: 255,
  confirm: 13,
  abort: 27,
  yes: 121,
  no: 110
}

export class TerminalParser extends EventEmitter {
  #stdin
  #stdout
  #keybindings
  #enabled
  #onData
  #inputBuffer
  #flushTimer
  #maxBufferLength
  #startup
  #startupTimer
  #wasRaw

  constructor (keybindings) {
    super()
    this.#keybindings = new Map()

    for (const [action, keys] of Object.entries(keybindings ?? {})) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const actions = this.#keybindings.get(key) ?? []
        actions.push(action)
        this.#keybindings.set(key, actions)
      }
    }

    this.#stdin = process.stdin
    this.#stdout = process.stdout
    this.#enabled = false
    this.#onData = this.#handleData.bind(this)
    this.#inputBuffer = Buffer.alloc(0)
    this.#flushTimer = null
    this.#maxBufferLength = 4096
  }

  async start () {
    if (this.#enabled) {
      return this.#startup?.promise
    }

    if (!this.#stdin.isTTY || !this.#stdout.isTTY || typeof this.#stdin.setRawMode !== 'function') {
      throw new InputError('Kitty keyboard input requires a TTY on stdin and stdout')
    }

    this.#enabled = true
    this.#wasRaw = this.#stdin.isRaw
    this.#startup = Promise.withResolvers()
    const startup = this.#startup
    // Query the enabled flags. Device-attribute replies may also come from
    // OpenTUI's startup queries, so only the flags response completes detection.
    // https://sw.kovidgoyal.net/kitty/keyboard-protocol/#detection-of-support-for-this-protocol
    this.#startupTimer = setTimeout(() => {
      startup.reject(new InputError('Terminal did not confirm Kitty keyboard protocol support within 1500ms'))
    }, 1500)
    try {
      this.#stdin.setRawMode(true)
      this.#stdin.resume()
      this.#stdin.on('data', this.#onData)
      // 1: disambiguation, 2: press/repeat/release, 8: encode every key.
      this.#stdout.write('\x1b[>11u\x1b[?u\x1b[c')
      await startup.promise
    } catch (error) {
      this.stop()
      throw error
    } finally {
      clearTimeout(this.#startupTimer)
      this.#startup = null
    }
  }

  stop () {
    if (!this.#enabled) {
      return
    }

    this.#enabled = false
    clearTimeout(this.#startupTimer)
    this.#startup?.reject(new InputError('Kitty keyboard initialization was interrupted'))
    this.#stdout.write('\x1b[<u')
    this.#stdin.off('data', this.#onData)
    this.#stdin.setRawMode(this.#wasRaw ?? false)
    this.#stdin.pause()

    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }

    this.#inputBuffer = Buffer.alloc(0)
  }

  destroy () {
    this.stop()
  }

  #handleData (buf) {
    this.#inputBuffer = Buffer.concat([this.#inputBuffer, buf])

    if (this.#inputBuffer.length > this.#maxBufferLength) {
      this.#inputBuffer = this.#inputBuffer.subarray(-this.#maxBufferLength)
    }

    this.#drainInputBuffer()
  }

  #drainInputBuffer () {
    while (this.#inputBuffer.length > 0) {
      const result = this.#parseNext(this.#inputBuffer)

      if (result.status === 'incomplete') {
        this.#scheduleIncompleteFlush()
        return
      }

      if (this.#flushTimer !== null) {
        clearTimeout(this.#flushTimer)
        this.#flushTimer = null
      }

      if (result.status === 'invalid') {
        this.#inputBuffer = this.#inputBuffer.subarray(1)
        continue
      }

      this.#inputBuffer = this.#inputBuffer.subarray(result.length)
      if (result.event !== null && this.#startup === null) {
        this.#emitParsedEvent(result.event)
      }
    }
  }

  #scheduleIncompleteFlush () {
    if (this.#flushTimer !== null) {
      return
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null

      if (this.#inputBuffer.length === 0) {
        return
      }

      // Kitty encodes Escape explicitly; an incomplete sequence is never a key.
      this.#inputBuffer = Buffer.alloc(0)
    }, 1500)

    this.#flushTimer.unref()
  }

  #emitParsedEvent (ev) {
    if (ev.event === 'repeat') {
      ev = { ...ev, event: 'press' }
    }

    if (ev.event !== 'press' && ev.event !== 'release') {
      return
    }

    if (ev.event === 'press' && ev.key === 'c' && ev.ctrl) {
      this.emit('quit')
      return
    }

    const parts = []

    if (ev.ctrl) {
      parts.push('ctrl')
    }

    if (ev.shift) {
      parts.push('shift')
    }

    if (ev.alt) {
      parts.push('alt')
    }

    if (ev.meta || ev.super) {
      parts.push('meta')
    }

    parts.push(ev.key)

    const actions = this.#keybindings.get(parts.join('+')) ?? []
    const emitted = new Set()

    for (const action of actions) {
      const doomKey = doomKeys[action]

      if (doomKey !== undefined && !emitted.has(doomKey)) {
        emitted.add(doomKey)
        this.emit(ev.event, doomKey)
      }
    }
  }

  #parseNext (raw) {
    if (raw.length === 0) {
      return { status: 'incomplete' }
    }

    if (raw[0] !== 0x1b) {
      return { status: 'invalid' }
    }

    if (raw.length === 1) {
      return { status: 'incomplete' }
    }

    if (raw[1] !== 0x5b) {
      return { status: 'invalid' }
    }

    if (raw.length < 3) {
      return { status: 'incomplete' }
    }

    if (raw[2] >= 0x41 && raw[2] <= 0x5a) {
      const event = this.#parse(raw.subarray(0, 3))

      return event === null ? { status: 'invalid' } : { status: 'complete', length: 3, event }
    }

    const terminatorIndex = raw.findIndex((byte, index) => {
      return index >= 2 && byte >= 0x40 && byte <= 0x7e
    })

    if (terminatorIndex !== -1) {
      const event = this.#parse(raw.subarray(0, terminatorIndex + 1))

      return { status: 'complete', length: terminatorIndex + 1, event }
    }

    for (let i = 2; i < raw.length; i++) {
      const byte = raw[i]
      const valid = byte >= 0x20 && byte <= 0x3f

      if (!valid) {
        return { status: 'invalid' }
      }
    }

    return { status: 'incomplete' }
  }

  #parse (raw) {
    const s = raw.toString('utf8')

    // Terminal replies are control messages, never game input.
    // eslint-disable-next-line no-control-regex
    const flags = /^\x1b\[\?(\d+)u$/.exec(s)
    if (flags) {
      if ((Number(flags[1]) & 11) === 11) {
        this.#startup?.resolve()
      }
      // OpenTUI may have queried the old flags before we enabled ours. Ignore
      // that stale reply and let the startup deadline reject unsupported modes.
      return null
    }
    // eslint-disable-next-line no-control-regex
    if (/^\x1b\[\?[\d;]*c$/.test(s)) {
      return null
    }

    // Kitty CSI u:
    // ESC [ codepoint u
    // ESC [ codepoint ; modifiers u
    // ESC [ codepoint ; modifiers : event u
    // eslint-disable-next-line no-control-regex
    let m = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(s)

    if (m) {
      const codepoint = Number(m[1])
      const modifiers = Number(m[2] ?? 1)
      let event

      switch (Number(m[3] ?? 1)) {
        case 2:
          event = 'repeat'
          break
        case 3:
          event = 'release'
          break
        default:
          event = 'press'
          break
      }

      return {
        event,
        key: this.#codepointToKey(codepoint),
        ...this.#parseModifiers(modifiers),
        raw
      }
    }

    // Kitty retains these CSI encodings for cursor/navigation keys.
    // ESC [ A
    // ESC [ 1 ; modifiers A
    // ESC [ 1 ; modifiers : event A
    // eslint-disable-next-line no-control-regex
    m = /^\x1b\[(?:1(?:;(\d+)(?::([123]))?)?)?([ABCDHF])$/.exec(s)

    if (m) {
      const keys = {
        A: 'up',
        B: 'down',
        C: 'right',
        D: 'left',
        H: 'home',
        F: 'end'
      }

      let event

      switch (Number(m[2] ?? 1)) {
        case 2:
          event = 'repeat'
          break
        case 3:
          event = 'release'
          break
        default:
          event = 'press'
          break
      }

      return {
        event,
        key: keys[m[3]],
        ...this.#parseModifiers(m[1] ?? 1),
        raw
      }
    }

    // Insert/Delete/Page keys use Kitty's tilde form, including event types.
    // eslint-disable-next-line no-control-regex
    m = /^\x1b\[(2|3|5|6|7|8)(?:;(\d+)(?::([123]))?)?~$/.exec(s)
    if (m) {
      const keys = { 2: 'insert', 3: 'delete', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' }
      return {
        event: m[3] === '3' ? 'release' : 'press',
        key: keys[m[1]],
        ...this.#parseModifiers(m[2] ?? 1),
        raw
      }
    }

    return null
  }

  #codepointToKey (cp) {
    switch (cp) {
      case 9:
        return 'tab'
      case 13:
        return 'enter'
      case 27:
        return 'escape'
      case 32:
        return 'space'
      case 127:
        return 'backspace'
      default:
        if (cp >= 32 && cp <= 0x10ffff) {
          return String.fromCodePoint(cp).toLowerCase()
        }
        return `codepoint:${cp}`
    }
  }

  #parseModifiers (mod = 1) {
    const mask = Number(mod) - 1

    return {
      shift: Boolean(mask & 1),
      alt: Boolean(mask & 2),
      ctrl: Boolean(mask & 4),
      super: Boolean(mask & 8),
      hyper: Boolean(mask & 16),
      meta: Boolean(mask & 32)
    }
  }
}
