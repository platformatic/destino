import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigError } from '../errors.js'

export const usage = `Usage: destino [CONFIG]
       destino -b | --bootstrap [CONFIG]
       destino -i | --input [--probe] [CONFIG]
       destino -a | --audio
       destino -h | --help`

export function parseCommandLine (args = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        bootstrap: { type: 'boolean', short: 'b' },
        input: { type: 'boolean', short: 'i' },
        probe: { type: 'boolean' },
        audio: { type: 'boolean', short: 'a' },
        help: { type: 'boolean', short: 'h' }
      }
    })

    // Validate modes before dispatch so argument order cannot change their meaning.
    const bootstrap = values.bootstrap ?? false
    if ([bootstrap, values.input, values.audio].filter(Boolean).length > 1) {
      throw new ConfigError('--bootstrap, --input and --audio cannot be combined')
    }

    if (values.probe && !values.input) {
      throw new ConfigError('--probe requires --input')
    }

    if (positionals.length > 1 || positionals[0] === '') {
      throw new ConfigError('Expected at most one non-empty config file path.')
    }

    // Track an explicit path separately: only an implicit missing config can use probe defaults.
    return {
      config: resolve(positionals[0] ?? 'destino.json'),
      explicitConfig: positionals.length > 0,
      bootstrap,
      input: values.input ?? false,
      probe: values.probe ?? false,
      audio: values.audio ?? false,
      help: values.help ?? false
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error
    }
    throw new ConfigError(`Invalid command-line arguments: ${error.message}`, { cause: error })
  }
}
