import { randomUUID } from 'node:crypto'
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { defaultConfig, serializeConfig } from '../config.js'
import { ConfigError, InputError } from '../errors.js'
import { doomKeys, TerminalParser } from '../input.js'

const groups = [
  { title: 'Movement', actions: ['moveForward', 'moveBackward', 'turnLeft', 'turnRight', 'strafeLeft', 'strafeRight'] },
  { title: 'Game controls', actions: ['fire', 'use', 'menu', 'pause'] },
  { title: 'Menu controls', actions: ['confirm', 'abort', 'yes', 'no'] }
]

export function inputBindings (parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('Configuration must be a JSON object')
  }

  const bindings = parsed.keybindings
  if (bindings !== undefined && (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))) {
    throw new ConfigError('keybindings must be an object')
  }

  // Validate only input settings so this mode remains independent of game assets and audio.
  for (const [action, keys] of Object.entries(bindings ?? {})) {
    if (
      !Object.hasOwn(doomKeys, action) || !Array.isArray(keys) || keys.length === 0 ||
      keys.some(key => typeof key !== 'string' || key.length === 0)
    ) {
      throw new ConfigError(`Invalid keybindings for ${action}`)
    }
  }

  // Capture edits a private map; defaults and the original parsed config stay unchanged.
  return structuredClone({ ...defaultConfig.keybindings, ...bindings })
}

export async function saveInputBindings (path, original, parsed, keybindings) {
  let temporary

  try {
    // Preserve unrelated configuration and refuse edits made during the wizard.
    if ((await readFile(path, 'utf8')) !== original) {
      throw new ConfigError('Configuration changed during input capture; no changes saved')
    }

    // Stage beside the destination to preserve permissions and publish with an atomic rename.
    const { mode } = await stat(path)
    const candidate = `${path}.${randomUUID()}.tmp`
    const file = await open(candidate, 'wx', mode)
    temporary = candidate

    try {
      await file.writeFile(serializeConfig({ ...parsed, keybindings }) + '\n')
    } finally {
      await file.close()
    }

    await rename(temporary, path)
    temporary = undefined
  } catch (error) {
    throw error instanceof ConfigError ? error : new ConfigError(error.message, { cause: error })
  } finally {
    if (temporary) {
      await unlink(temporary)
    }
  }
}

export async function configureInput ({ config, explicitConfig = true, probe = false }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new InputError('--input requires an interactive terminal supporting Kitty keyboard')
  }

  // Keep the original bytes for conflict detection and resolve symlinks before saving.
  let path = config
  let original
  let parsed = {}

  try {
    original = await readFile(path, 'utf8')
    parsed = JSON.parse(original)
    path = await realpath(path)
  } catch (error) {
    // Only probe with the implicit missing config may fall back to defaults.
    if (!probe || explicitConfig || error.code !== 'ENOENT') {
      throw new ConfigError(`Cannot load input configuration: ${path}`, { cause: error })
    }
  }

  const keybindings = inputBindings(parsed)
  const stopped = Promise.withResolvers()
  let capture
  let interrupted = false
  const input = new TerminalParser(keybindings, { capture: true })

  // All cancellation paths settle pending capture and negotiation before restoring the terminal.
  const stop = () => {
    interrupted = true
    capture?.resolve(null)
    stopped.resolve()
    input.stop()
  }

  const onKey = ({ key, chord }) => {
    if (interrupted) {
      return
    }

    if (probe) {
      const actions = Object.entries(keybindings).filter(([, keys]) => keys.includes(chord)).map(([action]) => action)
      process.stdout.write(`  ${chord.padEnd(24)} ${actions.join(' / ') || 'Not assigned'}\r\n`)
    } else if (!/^(?:(?:left|right)(?:shift|alt|ctrl|super|hyper|meta)|isolevel[35]shift)$/.test(key)) {
      capture?.resolve(chord)
    }
  }

  input.on('key', onKey)
  input.on('quit', stop)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.stdin.on('end', stop)

  try {
    // Cancellation during Kitty negotiation is not a setup failure.
    try {
      await input.start()
    } catch (error) {
      if (!interrupted) {
        throw error
      }
    }

    if (probe && !interrupted) {
      process.stdout.write('\r\nKeyboard probe\r\nPress a key or shortcut. Ctrl+C or Ctrl+D exits.\r\n\r\n')
      process.stdout.write(`  ${'KEY / SHORTCUT'.padEnd(24)} ACTION\r\n`)
      await stopped.promise
    } else if (!interrupted) {
      process.stdout.write(`\r\nKeyboard setup\r\nConfiguration: ${path}\r\n\r\n`)
      process.stdout.write('Press a key or shortcut for each action. Wait 5 seconds to keep its bindings.\r\n')
      process.stdout.write('Ctrl+C or Ctrl+D cancels without saving. Changes are saved only when setup finishes.\r\n')

      for (const group of groups) {
        if (interrupted) {
          break
        }

        process.stdout.write(`\r\n${group.title}\r\n`)

        for (const action of group.actions) {
          let accepted = false

          while (!accepted && !interrupted) {
            // Each attempt races a captured chord against the countdown to retain current bindings.
            capture = Promise.withResolvers()
            let seconds = 5
            const prompt = () => {
              process.stdout.write(`\r\x1b[2K${action} — Current: ${keybindings[action].join(' / ')} — Keep in ${seconds}s: `)
            }
            prompt()
            const timer = setInterval(() => {
              seconds--
              if (seconds === 0) {
                capture.resolve(null)
              } else {
                prompt()
              }
            }, 1000)

            let chord
            try {
              chord = await capture.promise
            } finally {
              clearInterval(timer)
              capture = undefined
            }

            process.stdout.write('\r\n')
            if (interrupted) {
              break
            }

            // Existing shared bindings (for example Escape) remain valid; new conflicts are rejected.
            const conflict = chord && !keybindings[action].includes(chord) && Object.entries(keybindings)
              .find(([other, keys]) => other !== action && keys.includes(chord))
            if (conflict) {
              process.stdout.write(`  ${chord} is already used for ${conflict[0]}. Please choose another key.\r\n`)
              continue
            }

            if (chord) {
              keybindings[action] = [chord]
            }

            process.stdout.write(`  ${chord ? `Assigned: ${chord}` : `Kept: ${keybindings[action].join(' / ')}`}\r\n`)
            accepted = true
          }

          if (interrupted) {
            break
          }
        }
      }
    }
  } finally {
    input.destroy()
    input.off('key', onKey)
    input.off('quit', stop)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.stdin.off('end', stop)
  }

  // Probe and cancellation are read-only; persist only after every action completes.
  if (probe || interrupted) {
    console.log(probe ? '\nKeyboard probe closed.' : '\nSetup cancelled. No configuration changes were saved.')
    return
  }

  await saveInputBindings(path, original, parsed, keybindings)
  console.log(`\nKeyboard setup complete. Bindings saved to ${path}`)
}
