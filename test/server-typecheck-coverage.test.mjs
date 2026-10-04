import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Аудит PR #131, QA-02 (docs/reviews/2026-10-04/round-7/34-baseline-and-reuse.md).
 *
 * `pnpm typecheck:server` проверяет только файлы с `// @ts-check`, попавшие в
 * программу `tsconfig.server.json`. Файл с пометкой, но вне программы, молча
 * не проверялся: так выпали пять модулей. Сторож держит явный `include` равным
 * списку файлов с пометкой — в обе стороны — и сверяет программу самим `tsc`.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const toPosix = (path) => path.split(sep).join('/')

function tsCheckFiles() {
  return readdirSync(resolve(root, 'server'), { recursive: true })
    .map((entry) => `server/${toPosix(String(entry))}`)
    .filter((path) => path.endsWith('.mjs'))
    .filter((path) => /^\/\/ @ts-check\b/mu.test(readFileSync(resolve(root, path), 'utf8')))
    .sort()
}

const config = JSON.parse(readFileSync(resolve(root, 'tsconfig.server.json'), 'utf8'))

test('каждый файл server/ с // @ts-check перечислен в include tsconfig.server.json', () => {
  const marked = tsCheckFiles()
  assert.ok(marked.length > 0, 'файлы с // @ts-check не найдены')
  const included = [...config.include].sort()
  assert.deepEqual(
    marked.filter((path) => !included.includes(path)),
    [],
    'добавьте эти файлы в include tsconfig.server.json — иначе их пометка ничего не проверяет',
  )
  assert.deepEqual(
    included.filter((path) => !marked.includes(path)),
    [],
    'в include лежат файлы без // @ts-check (или отсутствующие): при checkJs: false они не проверяются',
  )
  assert.equal(config.compilerOptions.checkJs, false, 'проверка по одному файлу держится на checkJs: false')
  assert.equal(config.exclude, undefined, 'exclude вычитал бы файлы из include')
  assert.equal(config.files, undefined, 'список программы держит include')
})

test('программа tsc содержит все файлы с // @ts-check', () => {
  const compiler = resolve(root, 'node_modules/typescript/bin/tsc')
  assert.ok(existsSync(compiler), 'typescript не установлен')
  const listed = spawnSync(process.execPath, [compiler, '-p', resolve(root, 'tsconfig.server.json'), '--listFilesOnly'], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr || listed.stdout)
  const program = new Set(listed.stdout.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => toPosix(relative(root, resolve(line)))))
  assert.deepEqual(tsCheckFiles().filter((path) => !program.has(path)), [])
})
