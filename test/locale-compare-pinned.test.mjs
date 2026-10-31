// Порядок игры не зависит от локали процесса. `localeCompare()` и
// `Intl.Collator()` без локали берут локаль процесса: на Windows владельца это
// ru-RU (кириллица раньше латиницы), в Docker — en-US. Из-за этого при равной
// цене выбор легендарного действия, порядок кандидатов встречи и лента розыска
// различались между машиной разработки и боевым сервером (находка переноса на
// Rust, docs/rust-port-js-findings.md). Каждое сравнение в server/ называет
// локаль явно: 'en' — порядок корневого ICU, как у Rust
// (`sk_core::text::locale_compare`) и у эталонов (`rust/fixtures-env.mjs`).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const BACKSLASH = '\\'

/** Аргументы вызова, начинающегося с `(` в позиции `open`: есть ли запятая верхнего уровня. */
function callHasSecondArgument(source, open) {
  let depth = 0
  let quote = null
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === BACKSLASH) index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return false
    } else if (char === ',' && depth === 1) return true
  }
  return false
}

function unpinnedCalls(source, needle) {
  const lines = []
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
    const open = at + needle.length - 1
    // `new Intl.Collator()` — пустые скобки тоже без локали.
    if (!callHasSecondArgument(source, open) && (needle === '.localeCompare(' || source[open + 1] === ')')) {
      lines.push(source.slice(0, at).split('\n').length)
    }
  }
  return lines
}

test('сравнение строк в server/ всегда с явной локалью', () => {
  const offenders = []
  for (const name of readdirSync(new URL('../server/', import.meta.url), { recursive: true })) {
    if (!String(name).endsWith('.mjs')) continue
    const source = readFileSync(new URL(`../server/${String(name).replaceAll(BACKSLASH, '/')}`, import.meta.url), 'utf8')
    for (const line of unpinnedCalls(source, '.localeCompare(')) offenders.push(`server/${name}:${line} localeCompare`)
    for (const line of unpinnedCalls(source, 'Intl.Collator(')) offenders.push(`server/${name}:${line} Intl.Collator`)
  }
  assert.deepEqual(offenders, [], 'без локали порядок зависит от машины')
})

test('закреплённая локаль ставит латиницу раньше кириллицы на любой машине', () => {
  assert.ok('z'.localeCompare('а', 'en') < 0)
  assert.ok(new Intl.Collator('en').compare('z', 'а') < 0)
})
