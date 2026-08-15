// esbuild bundler for the VS Code extension.
// Two outputs: the extension host bundle (Node, CJS for VS Code <1.99 compat) and a stripped spike build.
import esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  external: ['vscode'],
  logLevel: 'info',
  legalComments: 'none',
}

if (watch) {
  const ctx = await esbuild.context(extensionOptions)
  await ctx.watch()
  console.log('[esbuild] watching...')
} else {
  await esbuild.build(extensionOptions)
  console.log('[esbuild] built dist/extension.js')
}
