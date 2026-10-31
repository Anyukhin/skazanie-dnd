// Общие помощники генераторов эталонов sk-director.
//
// Крупный выход (сериализованные карты, клетки, итог перехода) хранится
// хешем: SHA-256 строки `JSON.stringify(value)` — Rust сравнивает тот же хеш
// от своей строки JSON, то есть вместе с порядком ключей и записью чисел.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

/** SHA-256 строки `JSON.stringify(value)`. */
export function hash(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
}

/** Снимок значения через JSON: `undefined` выпадает, как на границе Rust. */
export const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Исключение вызова в форме эталона. */
export const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

/** Детерминированный ГПСЧ mulberry32. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Помощники случайного выбора поверх ГПСЧ. */
export function picker(random) {
  const int = (n) => Math.floor(random() * n)
  return {
    int,
    pick: (items) => items[int(items.length)],
    chance: (p) => random() < p,
  }
}

/** Аргументы вызова: значения и позиции `undefined` (их JSON не держит). */
export function argsOf(args) {
  const undef = []
  const values = args.map((value, index) => {
    if (value === undefined) undef.push(index)
    return value === undefined ? null : plain(value)
  })
  return undef.length ? { args: values, undef } : { args: values }
}

/** Обратное `argsOf`. */
export function argsFrom(entry) {
  const args = structuredClone(entry.args)
  for (const index of entry.undef ?? []) args[index] = undefined
  return args
}

/**
 * Перехват вызовов модулей из тестов JS (`capture-modules.mjs`) в отдельном
 * процессе: `targets` — `{ '/server/x.mjs': ['fn'] }`, итог — записи
 * `{ fn, test, args, undef? }`.
 */
export async function captureTests(tests, targets, { limit = 400 } = {}) {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = new URL('../../../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'sk-director-capture-'))
  const file = join(dir, 'capture.jsonl')
  try {
    execFileSync(process.execPath, [
      '--import', new URL('./capture-modules.mjs', import.meta.url).href,
      '--test', '--test-isolation=none', '--test-reporter=dot',
      ...tests.map((name) => new URL(`test/${name}.test.mjs`, root).pathname.replace(/^\/([A-Za-z]:)/u, '$1')),
    ], {
      cwd: new URL('.', root),
      env: { ...process.env, SK_CAPTURE: file, SK_CAPTURE_TARGETS: JSON.stringify(targets), SK_CAPTURE_LIMIT: String(limit) },
      stdio: ['ignore', 'ignore', 'inherit'],
      maxBuffer: 1 << 30,
    })
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Записать эталон: секции по случаю на строку, чтобы diff читался. */
export function writeFixture(url, sections, { gzip = false } = {}) {
  const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
    ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
    : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
  const text = `{\n${lines.join(',\n')}\n}\n`
  writeFileSync(url, gzip ? gzipSync(text, { level: 9 }) : text)
  const counts = Object.entries(sections).filter(([, value]) => Array.isArray(value)).map(([key, value]) => `${key} ${value.length}`)
  console.log(`${url.pathname.split('/').at(-1)}: ${counts.join(', ')} (${(text.length / 1e6).toFixed(1)} МБ текста)`)
}
