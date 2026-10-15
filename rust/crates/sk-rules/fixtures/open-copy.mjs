// «Открытая копия» `server/rules-engine.mjs` для эталонов приватных функций.
//
// Движок экспортирует около полусотни имён, а перенос сверяет и приватные
// помощники (`normalizeCommand`, `eventFrom`, классы пауз, кости-стенограмму).
// Генератор копирует файл в `$TEMP`, переписывает относительные импорты на
// абсолютные `file://` (копия грузит те же модули сервера, что и оригинал) и
// дописывает `export { … }` для всех имён верхнего уровня, которых нет в
// экспорте. Исходник не меняется.
//
// `randomUUID` в копии подменяем: если задан `globalThis.__SK_OPEN_COPY_UUID__`,
// копия берёт id у него, иначе — у `node:crypto` (как оригинал).
//
//   import { loadOpenCopy } from './open-copy.mjs'
//   const engine = await loadOpenCopy()
//
// Запуск напрямую печатает путь копии и число открытых имён:
//   node rust/crates/sk-rules/fixtures/open-copy.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = new URL('../../../../', import.meta.url)
export const SOURCE_URL = new URL('server/rules-engine.mjs', root)
const SERVER_URL = new URL('server/', root)

/** sha256 исходника — эталоны записывают, с какой версии JS они сняты. */
export function sourceSha256() {
  return createHash('sha256').update(readFileSync(SOURCE_URL)).digest('hex')
}

/** Имена верхнего уровня: объявления с нулевым отступом. */
export function topLevelNames(source) {
  const declared = []
  const exported = new Set()
  for (const line of source.split('\n')) {
    let match = /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (match) { exported.add(match[1]); continue }
    match = /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^class\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)
    if (match) declared.push(match[1])
  }
  return { private: [...new Set(declared)].filter((name) => !exported.has(name)), exported: [...exported] }
}

/** Текст открытой копии. */
export function openCopySource() {
  let source = readFileSync(SOURCE_URL, 'utf8')
  source = source.replace(/(\bfrom\s+)(['"])(\.\.?\/[^'"]+)\2/g, (_, keyword, quote, specifier) => `${keyword}${quote}${new URL(specifier, SERVER_URL).href}${quote}`)
  const cryptoImport = "import { createHash, randomUUID } from 'node:crypto'"
  if (!source.includes(cryptoImport)) throw new Error('open-copy: импорт node:crypto изменился — обновите генератор')
  source = source.replace(cryptoImport, [
    "import { createHash, randomUUID as __openCopyRandomUUID } from 'node:crypto'",
    'const randomUUID = (...args) => (globalThis.__SK_OPEN_COPY_UUID__ ?? __openCopyRandomUUID)(...args)',
  ].join('\n'))
  const { private: names } = topLevelNames(source)
  return `${source}\n// --- open-copy: приватные имена верхнего уровня ---\nexport { ${names.join(', ')} }\n`
}

let loaded = null

/** Модуль открытой копии (один на процесс). */
export async function loadOpenCopy() {
  if (loaded) return loaded
  const directory = join(tmpdir(), 'sk-rules-open-copy')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `rules-engine.open.${sourceSha256().slice(0, 12)}.mjs`)
  writeFileSync(path, openCopySource())
  loaded = await import(pathToFileURL(path).href)
  return loaded
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const engine = await loadOpenCopy()
  const { private: names } = topLevelNames(readFileSync(SOURCE_URL, 'utf8'))
  console.log(`открытая копия: ${Object.keys(engine).length} имён (приватных ${names.length}), sha256 ${sourceSha256().slice(0, 16)}`)
}
