import { EventEmitter } from 'node:events'

const emptyModifiers = {
  shift: false,
  alt: false,
  ctrl: false,
  super: false,
  hyper: false,
  meta: false
}

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
  #ignoreUntil

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

  start () {
    if (this.#enabled) {
      return
    }

    if (!this.#stdin.isTTY || typeof this.#stdin.setRawMode !== 'function') {
      throw new Error('stdin is not a TTY')
    }

    this.#enabled = true
    this.#stdin.setRawMode(true)
    this.#stdin.resume()
    this.#stdin.on('data', this.#onData)
    this.#stdout.write('\x1b[>11u')
    // Drop terminal protocol responses and stale input emitted during startup.
    this.#ignoreUntil = Date.now() + 100
  }

  stop () {
    if (!this.#enabled) {
      return
    }

    this.#enabled = false
    this.#stdout.write('\x1b[<u')
    this.#stdin.off('data', this.#onData)
    this.#stdin.setRawMode(false)
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
    if (Date.now() < this.#ignoreUntil) {
      this.#inputBuffer = Buffer.alloc(0)
      return
    }

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
      this.#emitParsedEvent(result.event)
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

      if (this.#inputBuffer.length === 1 && this.#inputBuffer[0] === 0x1b) {
        this.#inputBuffer = this.#inputBuffer.subarray(1)
        this.#emitParsedEvent(this.#baseKey('escape', Buffer.from([0x1b])))
        this.#drainInputBuffer()
      } else if (this.#inputBuffer[0] === 0x1b) {
        // Timed-out partial escape sequences are terminal noise, not Escape keys.
        this.#inputBuffer = Buffer.alloc(0)
      }
    }, 10)

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
      const event = this.#parse(raw.subarray(0, 1))

      return event === null ? { status: 'invalid' } : { status: 'complete', length: 1, event }
    }

    if (raw.length === 1) {
      return { status: 'incomplete' }
    }

    if (raw[1] !== 0x5b) {
      const length = raw.length >= 2 ? 2 : 1
      const event = this.#parse(raw.subarray(0, length))

      return event === null ? { status: 'invalid' } : { status: 'complete', length, event }
    }

    if (raw.length < 3) {
      return { status: 'incomplete' }
    }

    if (raw[2] >= 0x41 && raw[2] <= 0x5a) {
      const event = this.#parse(raw.subarray(0, 3))

      return event === null ? { status: 'invalid' } : { status: 'complete', length: 3, event }
    }

    const terminatorIndex = raw.findIndex((byte, index) => {
      return index >= 2 && (byte === 0x7e || byte === 0x75 || (byte >= 0x41 && byte <= 0x5a))
    })

    if (terminatorIndex !== -1) {
      const event = this.#parse(raw.subarray(0, terminatorIndex + 1))

      return event === null ? { status: 'invalid' } : { status: 'complete', length: terminatorIndex + 1, event }
    }

    for (let i = 2; i < raw.length; i++) {
      const byte = raw[i]
      const valid = (byte >= 0x30 && byte <= 0x39) || byte === 0x3b || byte === 0x3a || (byte >= 0x41 && byte <= 0x5a)

      if (!valid) {
        return { status: 'invalid' }
      }
    }

    return { status: 'incomplete' }
  }

  #parse (raw) {
    const s = raw.toString('utf8')

    // Kitty CSI u:
    // ESC [ codepoint u
    // ESC [ codepoint ; modifiers u
    // ESC [ codepoint ; modifiers : event u
    // eslint-disable-next-line no-control-regex
    let m = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(s)

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

    // xterm modified key:
    // ESC [ 27 ; modifier ; keycode ~
    // eslint-disable-next-line no-control-regex
    m = /^\x1b\[27;(\d+);(\d+)~$/.exec(s)

    if (m) {
      const codepoint = Number(m[2])

      return {
        event: 'press',
        key: this.#codepointToKey(codepoint),
        ...this.#parseModifiers(m[1]),
        raw
      }
    }

    // CSI cursor/navigation keys, including Kitty-style event suffixes:
    // ESC [ A
    // ESC [ 1 ; modifiers A
    // ESC [ 1 ; modifiers : event A
    // eslint-disable-next-line no-control-regex
    m = /^\x1b\[(?:\d+(?:;(\d+)(?::(\d+))?)?)?([ABCDHF])$/.exec(s)

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

    // Common ANSI escape sequences
    const ansi = {
      '\x1b[A': 'up',
      '\x1b[B': 'down',
      '\x1b[C': 'right',
      '\x1b[D': 'left',
      '\x1b[3~': 'delete',
      '\x1b[H': 'home',
      '\x1b[F': 'end'
    }

    if (ansi[s]) {
      return this.#baseKey(ansi[s], raw)
    }

    // Alt + ASCII char = ESC prefix
    if (raw.length === 2 && raw[0] === 0x1b) {
      return {
        event: 'press',
        key: String.fromCharCode(raw[1]).toLowerCase(),
        ...emptyModifiers,
        alt: true,
        shift: raw[1] >= 65 && raw[1] <= 90,
        raw
      }
    }

    if (raw.length === 1) {
      const b = raw[0]

      switch (b) {
        case 0x1b:
          return this.#baseKey('escape', raw)
        case 0x7f:
          return this.#baseKey('backspace', raw)
        case 0x09:
          return this.#baseKey('tab', raw)
        case 0x0d:
        case 0x0a:
          return this.#baseKey('enter', raw)
        case 0x20:
          return this.#baseKey('space', raw)
      }

      // Ctrl+[a-z]
      if (b >= 1 && b <= 26) {
        return {
          key: String.fromCharCode(b + 96),
          event: 'press',
          ...emptyModifiers,
          ctrl: true,
          raw
        }
      }

      // ASCII
      if (b >= 0x20 && b <= 0x7e) {
        const ch = String.fromCharCode(b)

        return {
          key: ch.toLowerCase(),
          event: 'press',
          ...emptyModifiers,
          ctrl: false,
          alt: false,
          shift: raw[0] >= 65 && raw[0] <= 90,
          raw
        }
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

  #baseKey (key, raw) {
    return {
      event: 'press',
      key,
      ...emptyModifiers,
      raw
    }
  }
}
