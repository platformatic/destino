// SPDX-License-Identifier: MIT

export class DependencyError extends Error {
  constructor (message) {
    super(message)
    this.name = 'DependencyError'
    this.code = 'DESTINO_DEPENDENCY'
  }
}

export class AudioError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'AudioError'
    this.code = 'DESTINO_AUDIO'
  }
}

export class InputError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'InputError'
    this.code = 'DESTINO_INPUT'
  }
}

export class VideoError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'VideoError'
    this.code = 'DESTINO_VIDEO'
  }
}

export class LoaderError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'LoaderError'
    this.code = 'DESTINO_LOADER'
  }
}
