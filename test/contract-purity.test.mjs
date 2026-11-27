// Контракт на чистом HTTP: ни один тест из test/contract-rust.list не тянет
// JS-библиотеку `server/` (и архив JS-сервера) — ни сам, ни через набор
// `test/kit`. Входы контрактный тест готовит кодом Rust (`test/kit/fixtures.mjs`
// → `skazanie-server fixture`), а проверяет по ответам сервера. Иначе вход
// строил бы не тот код, что его исполняет, и расхождение JS и Rust пряталось
// бы в самом тесте.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { contractFiles } from './kit/run-contract.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FORBIDDEN = ['server/', 'archive/']
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.ts', '.tsx']

/** Относительные спецификаторы модуля: `import … from`, `export … from`, `import('…')`. */
function relativeImports(/** @type {string} */ source) {
  const specifiers = new Set()
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gsu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]
  // Комментарии не считаются: в них имена модулей упоминаются словами.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1')
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match[1].startsWith('.')) specifiers.add(match[1])
    }
  }
  return [...specifiers]
}

/**
 * Первая цепочка импортов от `entry` до запрещённого модуля или `null`.
 *
 * @param {string} entry путь от корня репозитория
 * @param {Map<string, string[] | null>} memo
 */
function forbiddenChain(entry, memo, stack = new Set()) {
  if (memo.has(entry)) return memo.get(entry) ?? null
  if (FORBIDDEN.some((prefix) => entry.startsWith(prefix))) return [entry]
  if (stack.has(entry)) return null
  stack.add(entry)
  /** @type {string[] | null} */
  let found = null
  const file = join(ROOT, entry)
  if (existsSync(file) && SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      const path = resolve(dirname(file), specifier)
      const source = existsSync(path) ? path : SOURCE_EXTENSIONS.map((extension) => path + extension).find(existsSync) ?? path
      const target = relative(ROOT, source).replaceAll('\\', '/')
      const chain = forbiddenChain(target, memo, stack)
      if (chain) {
        found = [entry, ...chain]
        break
      }
    }
  }
  stack.delete(entry)
  memo.set(entry, found)
  return found
}

test('контрактные тесты не импортируют server/ и архив JS — ни сами, ни через набор', () => {
  const files = contractFiles(readFileSync(join(ROOT, 'test', 'contract-rust.list'), 'utf8'))
  assert.ok(files.length > 50, `контрактных файлов ${files.length}`)
  const memo = new Map()
  const offenders = files.map((file) => forbiddenChain(file, memo)).filter((chain) => chain !== null)
  assert.deepEqual(offenders.map((chain) => chain.join(' → ')), [], 'контрактный тест готовит входы через test/kit/fixtures.mjs, а не JS-библиотекой')
})

test('стенд Асстохана не импортирует JS-сервер даже через вспомогательные модули', () => {
  // Рецепты героя подгружаются через compileClientModules, поэтому их
  // исходник проверяется как отдельная точка входа.
  const entries = ['eval/astohan-playthrough.mjs', 'src/astohan-pilot-builds.ts']
  const memo = new Map()
  const offenders = entries.map((entry) => forbiddenChain(entry, memo)).filter((chain) => chain !== null)
  assert.deepEqual(offenders.map((chain) => chain.join(' → ')), [])
})

test('сторож видит статический, реэкспортный и динамический импорт, но не комментарий', () => {
  const source = [
    "import { a } from '../server/a.mjs'",
    "export * from './kit/b.mjs'",
    "const c = await import('../server/c.mjs')",
    "import '../server/d.mjs'",
    '// раньше: import { e } from "../server/e.mjs"',
    "import {\n  f,\n  g,\n} from '../server/f.mjs'",
    "import x from 'node:fs'",
  ].join('\n')
  assert.deepEqual(relativeImports(source).sort(), ['../server/a.mjs', '../server/c.mjs', '../server/d.mjs', '../server/f.mjs', './kit/b.mjs'])
})
