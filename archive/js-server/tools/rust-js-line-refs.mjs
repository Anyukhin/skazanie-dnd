// Ссылки на строки JS в комментариях Rust: находит упоминания строк
// `server/rules-engine.mjs` и `server/index.mjs` в `rust/crates/**/*.rs` и
// `rust/*.md` и сдвигает их по карте изменений этих файлов между двумя
// ревизиями (`git diff -U0`). Ссылка до места вставки не меняется.
//
//   node tools/rust-js-line-refs.mjs --from <ревизия> --to <ревизия> [--write] [--json]
//   node tools/rust-js-line-refs.mjs --merge <слияние> [--write]   # = --from <слияние>^1 --to <слияние>
//
// Однозначные ссылки:
//   - «привязанные»: имя файла и сразу номера — `index.mjs:296–310, 409–418`,
//     `` `server/rules-engine.mjs`, 3418 (`name`), 11237–11345 ``,
//     `` `index.mjs` 5530–5956 ``; список продолжается на следующей строке
//     комментария, если строка кончилась запятой;
//   - «по контексту»: голые номера в комментарии файла, где из всех `*.mjs`
//     упомянут только один из двух файлов, — `(26059–26089)`, `(1256)`,
//     `строки 4301–4320`.
// Остальное (голые номера в файлах с несколькими источниками JS) — в отчёте
// как неоднозначное, если номер попадает в сдвигаемую часть. Строки,
// изменённые коммитами после `--to`, не трогаются: их могли написать уже по
// новым номерам — они тоже в отчёте.
//
// Без --write ничего не пишет. Проверка: ссылка вида «`имя` (N)» сверяется —
// встречается ли имя в новой строке (±2) файла JS на ревизии HEAD.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const merge = option('--merge')
const from = option('--from') ?? (merge ? `${merge}^1` : undefined)
const to = option('--to') ?? merge
const write = argv.includes('--write')
const asJson = argv.includes('--json')
if (!from || !to) {
  process.stderr.write('Использование: node tools/rust-js-line-refs.mjs (--merge <слияние> | --from <ревизия> --to <ревизия>) [--write] [--json]\n')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const SOURCES = { 'rules-engine': 'server/rules-engine.mjs', index: 'server/index.mjs' }

// Карта изменений: ханки `@@ -a,b +c,d @@` по файлу.
function hunksFor(file) {
  const diff = git('diff', '-U0', from, to, '--', file)
  const hunks = []
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ oldStart: Number(match[1]), oldCount: match[2] == null ? 1 : Number(match[2]), newStart: Number(match[3]), newCount: match[4] == null ? 1 : Number(match[4]) })
  }
  return hunks
}
const maps = Object.fromEntries(Object.entries(SOURCES).map(([key, file]) => [key, hunksFor(file)]))
const lengths = Object.fromEntries(Object.entries(SOURCES).map(([key, file]) => [key, git('show', `${from}:${file}`).split('\n').length]))
const headText = Object.fromEntries(Object.entries(SOURCES).map(([key, file]) => [key, readFileSync(path.join(root, file), 'utf8').split('\n')]))
const fromText = Object.fromEntries(Object.entries(SOURCES).map(([key, file]) => [key, git('show', `${from}:${file}`).split('\n')]))
// Первая старая строка, которую сдвигает карта: до неё всё на месте.
const firstShifted = Object.fromEntries(Object.entries(maps).map(([key, hunks]) => [key, hunks.length ? (hunks[0].oldCount === 0 ? hunks[0].oldStart + 1 : hunks[0].oldStart) : Infinity]))

/** Старый номер строки → новый; `null` — строка удалена. */
function shift(key, line) {
  let delta = 0
  for (const hunk of maps[key]) {
    const end = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldCount - 1
    if (hunk.oldCount === 0 ? line <= hunk.oldStart : line < hunk.oldStart) break
    if (hunk.oldCount > 0 && line <= end) {
      const offset = line - hunk.oldStart
      return offset < hunk.newCount ? hunk.newStart + offset : null
    }
    delta += hunk.newCount - hunk.oldCount
  }
  return line + delta
}

// Файлы.
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (name === 'target' || name === 'node_modules') continue
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (name.endsWith('.rs')) out.push(full)
  }
  return out
}
const files = [
  ...walk(path.join(root, 'rust', 'crates'), []),
  ...readdirSync(path.join(root, 'rust')).filter((name) => name.endsWith('.md')).map((name) => path.join(root, 'rust', name)),
]

// Коммиты после `to`: строки, тронутые ими, не правим автоматически.
const later = new Set(git('rev-list', `${to}..HEAD`).split('\n').filter(Boolean))
function laterLines(relative) {
  if (!later.size) return new Set()
  const blame = git('blame', '--line-porcelain', 'HEAD', '--', relative)
  const lines = new Set()
  let lineNo = 0
  for (const row of blame.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row)
    if (header) {
      lineNo = Number(header[2])
      if (later.has(header[1])) lines.add(lineNo)
    }
  }
  return lines
}

const FILE_RE = /(?<![\w./-])(?:server\/)?(rules-engine|index)\.mjs/g
const ITEM_RE = /^(\d+)(?:\s*[–-]\s*(\d+))?/
const HTTP_STATUSES = new Set([200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429, 500, 502, 503])
const MJS_RE =/(?<![\w./-])((?:[\w-]+\/)*[\w-]+)\.mjs/g

/** Часть строки, которая является комментарием: [начало, текст]. */
function commentPart(line, isMarkdown) {
  if (isMarkdown) return [0, line]
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//')) return [line.length - trimmed.length, trimmed]
  const index = line.indexOf(' // ')
  return index >= 0 ? [index + 1, line.slice(index + 1)] : null
}

/** Источник JS по контексту файла: единственный из двух, без других `*.mjs`. */
function contextSource(text) {
  const names = new Set()
  for (const match of text.matchAll(MJS_RE)) {
    const name = match[1]
    if (name === 'rules-engine' || name === 'server/rules-engine') names.add('rules-engine')
    else if (name === 'index' || name === 'server/index') names.add('index')
    else names.add(`other:${name}`)
  }
  return names.size === 1 && !([...names][0].startsWith('other:')) ? [...names][0] : null
}

const report = { from, to, changed: [], unchanged: 0, skipped_later: [], ambiguous: [], invalid: [], checks: [] }
const relativeOf = (file) => path.relative(root, file).split(path.sep).join('/')

function verifyName(key, newLine, nameContext, lines = headText[key]) {
  if (!nameContext) return null
  for (let probe = newLine - 2; probe <= newLine + 2; probe += 1) {
    if (lines[probe - 1]?.includes(nameContext)) return true
  }
  return false
}

for (const file of files) {
  const relative = relativeOf(file)
  const original = readFileSync(file, 'utf8')
  if (!/(rules-engine|index)\.mjs/.test(original)) continue
  const isMarkdown = file.endsWith('.md')
  const lines = original.split('\n')
  const context = isMarkdown ? null : contextSource(original)
  const touchedLater = laterLines(relative)
  // Найденные ссылки: { line, start, end, key, numbers: [{start,end,value}], kind }
  const refs = []
  const consumed = lines.map(() => [])
  let carry = null
  for (let index = 0; index < lines.length; index += 1) {
    const part = commentPart(lines[index], isMarkdown)
    if (!part) {
      carry = null
      continue
    }
    const [offset, text] = part
    const parseList = (key, position) => {
      const numbers = []
      let cursor = position
      let continues = false
      for (;;) {
        const item = ITEM_RE.exec(text.slice(cursor))
        if (!item) break
        const a = { start: offset + cursor, end: offset + cursor + item[1].length, value: Number(item[1]) }
        numbers.push(a)
        if (item[2] != null) {
          const bStart = cursor + item[0].length - item[2].length
          numbers.push({ start: offset + bStart, end: offset + bStart + item[2].length, value: Number(item[2]) })
        }
        cursor += item[0].length
        const paren = /^ \([^()\d]*\)/.exec(text.slice(cursor))
        if (paren) cursor += paren[0].length
        const sep = /^(?:,\s*|\s+и\s+)(?=\d)/.exec(text.slice(cursor))
        if (sep) {
          cursor += sep[0].length
          continue
        }
        if (/^,\s*$/.test(text.slice(cursor))) continues = true
        break
      }
      for (const n of numbers) consumed[index].push([n.start, n.end])
      return { numbers, continues }
    }
    if (carry) {
      const lead = /^\/\/[!/]?\s*/.exec(text)
      const position = lead ? lead[0].length : 0
      if (/^\d/.test(text.slice(position))) {
        const { numbers, continues } = parseList(carry, position)
        if (numbers.length) refs.push({ line: index, key: carry, numbers, kind: 'attached' })
        carry = continues ? carry : null
      } else carry = null
    }
    for (const match of text.matchAll(FILE_RE)) {
      const key = match[1]
      let cursor = match.index + match[0].length
      const tail = text.slice(cursor)
      const sep = /^[`"]?(?::\s*|,\s+|\s+\(?|\s*\(|\s+)(?=\d)/.exec(tail) ?? /^[`"]?:(?=\d)/.exec(tail)
      if (!sep) continue
      cursor += sep[0].length
      const { numbers, continues } = parseList(key, cursor)
      if (numbers.length) refs.push({ line: index, key, numbers, kind: 'attached' })
      if (continues) carry = key
    }
    // Голые номера в комментарии.
    // Код в обратных кавычках (`slice(0, 120)`) — не ссылки.
    const spans = [...text.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length])
    const bare = [
      ...[...text.matchAll(/(?<![\w$.)\]])\((\d+(?:\s*[–-]\s*\d+)?(?:,\s*\d+(?:\s*[–-]\s*\d+)?)*)\)/g)].map((m) => [m.index + 1, m[1]]),
      ...[...text.matchAll(/(?:строк\S*|JS:?)\s+(\d+(?:\s*[–-]\s*\d+)?(?:,\s*\d+(?:\s*[–-]\s*\d+)?)*)/g)].map((m) => [m.index + m[0].length - m[1].length, m[1]]),
    ].filter(([position]) => !spans.some(([a, b]) => position > a && position < b))
    for (const [position, list] of bare) {
      const numbers = []
      for (const n of list.matchAll(/\d+/g)) {
        const start = offset + position + n.index
        if (consumed[index].some(([a, b]) => start >= a && start < b)) continue
        numbers.push({ start, end: start + n[0].length, value: Number(n[0]) })
      }
      if (!numbers.length) continue
      for (const n of numbers) consumed[index].push([n.start, n.end])
      // Источник по имени: «`name(…)` (N)», имя есть в старой строке N (±2)
      // ровно одного из двух файлов.
      const named = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`[^`(]{0,3}\($/.exec(text.slice(0, position))
      const byName = named ? Object.keys(SOURCES).filter((key) => numbers[0].value <= lengths[key] && verifyName(key, numbers[0].value, named[1], fromText[key])) : []
      // «(404)» без имени перед ним — скорее код HTTP, чем строка.
      if (!named && numbers.length === 1 && HTTP_STATUSES.has(numbers[0].value)) {
        report.ambiguous.push({ file: relative, line: index + 1, text: lines[index].trim(), reason: 'похоже на код HTTP' })
        continue
      }
      if (context) refs.push({ line: index, key: context, numbers, kind: 'context' })
      else if (byName.length === 1) refs.push({ line: index, key: byName[0], numbers, kind: 'by-name' })
      else if (numbers.some((n) => Object.values(firstShifted).some((first) => n.value >= first)) && /(rules-engine|index)\.mjs/.test(original)) {
        report.ambiguous.push({ file: relative, line: index + 1, text: lines[index].trim() })
      }
    }
  }

  // Применение.
  const edits = lines.map(() => [])
  for (const ref of refs) {
    const lineText = lines[ref.line]
    const needs = ref.numbers.filter((n) => n.value >= firstShifted[ref.key])
    if (ref.numbers.some((n) => n.value < 1 || n.value > lengths[ref.key])) {
      report.invalid.push({ file: relative, line: ref.line + 1, kind: ref.kind, source: ref.key, text: lineText.trim() })
      continue
    }
    if (!needs.length) {
      report.unchanged += 1
      continue
    }
    if (touchedLater.has(ref.line + 1)) {
      report.skipped_later.push({ file: relative, line: ref.line + 1, kind: ref.kind, source: ref.key, text: lineText.trim() })
      continue
    }
    const pairs = []
    for (const n of needs) {
      const next = shift(ref.key, n.value)
      if (next == null) {
        report.invalid.push({ file: relative, line: ref.line + 1, kind: ref.kind, source: ref.key, text: lineText.trim(), reason: `строка ${n.value} удалена` })
        continue
      }
      if (next !== n.value) {
        edits[ref.line].push({ start: n.start, end: n.end, value: String(next) })
        pairs.push(`${n.value}→${next}`)
        // Имя перед номером: «`name` (N)» или «`name` (N–M)».
        const before = lineText.slice(0, n.start)
        const named = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`\s*\($/.exec(before) ?? /([A-Za-z_$][\w$]{3,})\s*\($/.exec(before)
        if (named && n === ref.numbers.find((candidate) => candidate.start === n.start)) {
          const ok = verifyName(ref.key, next, named[1])
          if (ok != null) report.checks.push({ file: relative, line: ref.line + 1, name: named[1], old: n.value, new: next, ok, was_ok: verifyName(ref.key, n.value, named[1], fromText[ref.key]) })
        }
      }
    }
    if (pairs.length) report.changed.push({ file: relative, line: ref.line + 1, kind: ref.kind, source: ref.key, shifts: pairs, text: lineText.trim() })
  }
  if (write && edits.some((list) => list.length)) {
    const next = lines.map((text, index) => {
      let out = text
      for (const edit of [...edits[index]].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.value + out.slice(edit.end)
      return out
    })
    writeFileSync(file, next.join('\n'))
  }
}

const numbersChanged = report.changed.reduce((sum, entry) => sum + entry.shifts.length, 0)
if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  const failed = report.checks.filter((check) => !check.ok)
  process.stdout.write([
    `Карта: ${from}..${to}; первая сдвигаемая строка — rules-engine.mjs ${firstShifted['rules-engine']}, index.mjs ${firstShifted.index}`,
    `Ссылок со сдвигом: ${report.changed.length} (номеров ${numbersChanged}), без сдвига: ${report.unchanged}${write ? '' : ' — без --write ничего не записано'}`,
    `Проверка по имени: ${report.checks.length - failed.length} из ${report.checks.length} сошлись; регрессий (до сдвига сходилось, после — нет): ${failed.filter((check) => check.was_ok).length}`,
    ...failed.map((check) => `  не сошлось: ${check.file}:${check.line} \`${check.name}\` ${check.old}→${check.new}${check.was_ok ? ' — РЕГРЕССИЯ' : ' (и до сдвига имени рядом не было)'}`),
    `Строки после ${to} (не тронуты): ${report.skipped_later.length}`,
    ...report.skipped_later.map((entry) => `  ${entry.file}:${entry.line}  ${entry.text.slice(0, 140)}`),
    `Неоднозначные (голые номера при нескольких источниках JS): ${report.ambiguous.length}`,
    ...report.ambiguous.map((entry) => `  ${entry.file}:${entry.line}  ${entry.text.slice(0, 140)}`),
    `Вне файла (номер больше длины или 0): ${report.invalid.length}`,
    ...report.invalid.map((entry) => `  ${entry.file}:${entry.line}  ${entry.reason ?? ''} ${entry.text.slice(0, 140)}`),
    '',
  ].join('\n'))
}
