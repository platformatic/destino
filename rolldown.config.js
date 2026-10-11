import { defineConfig } from 'rolldown'

export default defineConfig({
  input: 'src/index.js',
  output: {
    file: 'dist/index.js',
    format: 'esm'
  },
  external: id => id.startsWith('node:')
})
