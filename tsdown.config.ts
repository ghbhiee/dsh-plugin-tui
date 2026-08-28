import type { UserConfig } from 'tsdown'

// Host-only plugin: a plain ESM library the cordis Loader imports. No browser
// half, so none of the frozen-module-table contract from the web shell applies.
export default {
  name: 'dsh-plugin-tui/host',
  entry: ['src/index.ts', 'src/startup.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
} satisfies UserConfig
