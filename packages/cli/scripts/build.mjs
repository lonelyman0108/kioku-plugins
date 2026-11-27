// 构建 @kioku-memory/cli：把 TypeScript 源码与 core 运行时打进 dist/index.mjs，
// 并把内置的 agy / gemini / zcode 插件静态复制到 assets/plugins/，保证单包发布后无外部依赖即可运行。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'tsdown'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(cliRoot, '..', '..')

await build({
  cwd: cliRoot,
  entry: { index: 'src/index.ts' },
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  deps: { alwaysBundle: [/.*/] },
  dts: false,
})

const bundlePath = join(cliRoot, 'dist', 'index.mjs')
const bundleText = readFileSync(bundlePath, 'utf8')
if (/from\s+['"]\.\.\/|import\s*\(\s*['"]\.\.\//.test(bundleText)) {
  throw new Error('构建产物 dist/index.mjs 不应包含包外相对路径导入')
}

const EXCLUDE_NAMES = new Set(['node_modules', '__tests__', '.vitest', '.DS_Store', 'coverage'])
const assetsPluginsDir = join(cliRoot, 'assets', 'plugins')
rmSync(assetsPluginsDir, { recursive: true, force: true })
mkdirSync(assetsPluginsDir, { recursive: true })

for (const name of ['agy', 'gemini', 'zcode']) {
  const srcDir = join(repoRoot, 'plugins', name)
  if (!existsSync(srcDir)) {
    throw new Error(`找不到内置插件目录：${srcDir}`)
  }
  const destDir = join(assetsPluginsDir, name)
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => !EXCLUDE_NAMES.has(basename(src)),
  })
}
