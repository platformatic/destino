import { writeFile } from 'node:fs/promises'
import { defaultConfig, serializeConfig } from '../config.js'
import { ConfigError } from '../errors.js'
import { configPath, findWadPath } from '../loader.js'
import { configureInput } from './input.js'

export async function bootstrap (path = configPath(), { setupInput = configureInput } = {}) {
  const config = { ...defaultConfig, wadPath: (await findWadPath()) ?? defaultConfig.wadPath }

  try {
    // Bootstrap resets the entire configuration before starting keyboard setup.
    await writeFile(path, serializeConfig(config), 'utf8')
  } catch (error) {
    throw new ConfigError(`Cannot write config file: ${path}`, { cause: error })
  }

  console.log(`Wrote default config to ${path}.`)

  // The reset is already persisted; cancellation keeps defaults rather than restoring the old file.
  await setupInput({ config: path, explicitConfig: true })
}
