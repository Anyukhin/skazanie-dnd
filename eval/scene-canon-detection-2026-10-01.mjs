// Замер проверки канона сцены ДО и ПОСЛЕ, без сети и без storage.
// node eval/scene-canon-detection-2026-10-01.mjs [--output eval/scene-canon-detection-2026-10-01.json] [--before-ref HEAD]
//
// ДО — verifyNarration из `git show <ref>:server/security.mjs` (по умолчанию HEAD),
// ПОСЛЕ — текущий server/security.mjs. Оба получают один и тот же NarrationBrief
// с `world_clock` в той форме, в которой его кладёт оркестратор.
//
// Две части:
// 1. Размеченный набор eval/scene-canon-cases-2026-10-01.json: полнота на
//    противоречиях и ложные срабатывания на чистых текстах.
// 2. Независимая выборка: все сохранённые тексты Рассказчика из eval/*.json
//    (поля narration, final_text, opening). Канона у них нет, поэтому каждый
//    текст прогоняется по сетке 4 времени суток × 5 погод × крыша/небо, а
//    сработавшие фрагменты для двух показательных канонов размечены вручную
//    (MANUAL_AUDIT ниже).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const output = opt('--output', 'eval/scene-canon-detection-2026-10-01.json')
const beforeRef = opt('--before-ref', 'HEAD')

const after = await import(new URL('server/security.mjs', root))
const { sceneCanonContradictions, sceneCanonFromEnvironment } = await import(new URL('server/scene-canon.mjs', root))
const weather = await import(new URL('server/weather.mjs', root))

// Прежний verifier поднимается из git во временный каталог; его единственный
// относительный импорт переписывается на абсолютный путь текущего rules-engine.
const beforeSource = execFileSync('git', ['show', `${beforeRef}:server/security.mjs`], { cwd: new URL('.', root), encoding: 'utf8' })
  .replaceAll("from './rules-engine.mjs'", `from '${new URL('server/rules-engine.mjs', root).href}'`)
const beforeDir = mkdtempSync(join(tmpdir(), 'scene-canon-before-'))
writeFileSync(join(beforeDir, 'security-before.mjs'), beforeSource)
const before = await import(pathToFileURL(join(beforeDir, 'security-before.mjs')).href)

function worldClock({ phase, clock, weather: weatherId, indoors }) {
  return {
    day: 1, clock, time_of_day: phase, time_of_day_label: weather.dayPhaseLabel(phase),
    weather: weatherId, weather_label: weather.weatherConditionLabel(weatherId), weather_summary: weather.weatherConditionSummary(weatherId),
    indoors: Boolean(indoors), effects: [],
  }
}

function briefFor(canon) {
  return after.buildNarrationBrief({
    known_environment: {
      scene: { title: canon.location ?? '', location: canon.location ?? '' },
      world_clock: worldClock(canon),
    },
    visible_events: [], visible_state_changes: [], permitted_npc_reactions: [],
    viewer: { playerId: 'hero', isPartyMember: true },
  })
}

const verdict = (verifier, text, brief) => {
  const result = verifier.verifyNarration(text, brief)
  return {
    any: !result.valid,
    canon: result.violations.some((violation) => violation.code === 'SCENE_CANON_CONTRADICTION'),
    codes: [...new Set(result.violations.map((violation) => violation.code))],
    matches: result.violations.filter((violation) => violation.code === 'SCENE_CANON_CONTRADICTION').map((violation) => violation.match),
  }
}

// ---------- часть 1: размеченный набор ----------
const caseFile = JSON.parse(readFileSync(new URL('eval/scene-canon-cases-2026-10-01.json', root), 'utf8'))
const rows = caseFile.cases.map((entry) => {
  const brief = briefFor(entry.canon)
  return { id: entry.id, label: entry.label, kind: entry.kind, text: entry.text, before: verdict(before, entry.text, brief), after: verdict(after, entry.text, brief) }
})
const rate = (part, total) => total ? Number((part / total).toFixed(3)) : null
function summary(side, field) {
  const contradictions = rows.filter((row) => row.label === 'contradiction')
  const clean = rows.filter((row) => row.label === 'clean')
  const byKind = {}
  for (const kind of [...new Set(contradictions.map((row) => row.kind))]) {
    const group = contradictions.filter((row) => row.kind === kind)
    byKind[kind] = { total: group.length, detected: group.filter((row) => row[side][field]).length }
  }
  const detected = contradictions.filter((row) => row[side][field]).length
  const falsePositives = clean.filter((row) => row[side][field]).length
  return {
    contradictions: contradictions.length, detected, recall: rate(detected, contradictions.length),
    clean: clean.length, false_positives: falsePositives, false_positive_rate: rate(falsePositives, clean.length),
    precision: rate(detected, detected + falsePositives), by_kind: byKind,
  }
}

// ---------- часть 2: сохранённые тексты ----------
const PHASE_CLOCKS = { morning: '08:00', day: '13:00', evening: '19:00', night: '01:00' }
const grid = []
for (const phase of Object.keys(PHASE_CLOCKS)) {
  for (const weatherId of weather.WEATHER_CONDITION_IDS) {
    for (const indoors of [false, true]) grid.push({ phase, clock: PHASE_CLOCKS[phase], weather: weatherId, indoors })
  }
}
const saved = new Map()
for (const file of readdirSync(new URL('eval/', root)).filter((name) => name.endsWith('.json') && !name.startsWith('scene-canon'))) {
  let json
  try { json = JSON.parse(readFileSync(new URL(`eval/${file}`, root), 'utf8')) } catch { continue }
  const visit = (value, key) => {
    if (typeof value === 'string') {
      const text = value.trim()
      if (['narration', 'final_text', 'opening'].includes(key) && text.length > 40 && /[а-яё]{3}/iu.test(text) && !saved.has(text)) saved.set(text, file)
      return
    }
    if (value && typeof value === 'object') for (const [childKey, child] of Object.entries(value)) visit(child, Array.isArray(value) ? key : childKey)
  }
  visit(json, '')
}
// Идентификатор — хеш текста: ручная разметка не должна съезжать, когда в eval/ появляются новые файлы.
const texts = [...saved.entries()].map(([text, file]) => ({ id: `saved-${createHash('sha256').update(text).digest('hex').slice(0, 10)}`, file, text }))
const perCanon = grid.map((canonInput) => {
  const canon = sceneCanonFromEnvironment({ world_clock: worldClock(canonInput), scene: {} })
  const flagged = texts.filter((entry) => sceneCanonContradictions(entry.text, canon).length > 0)
  return { canon: canonInput, flagged: flagged.length, rate: rate(flagged.length, texts.length) }
})
const unsatisfiable = texts.filter((entry) => grid.every((canonInput) => sceneCanonContradictions(entry.text, sceneCanonFromEnvironment({ world_clock: worldClock(canonInput), scene: {} })).length > 0))

// Ручная разметка срабатываний на двух канонах. `true` — текст действительно
// утверждает это состояние как нынешнее (верное срабатывание для такого
// канона), `false` — ошибка сопоставления (оборот, прошлое, чужие слова).
const MANUAL_AUDIT = JSON.parse(readFileSync(new URL('eval/scene-canon-detection-audit-2026-10-01.json', root), 'utf8')).labels
const auditCanons = {
  start_morning_clear_outdoors: { phase: 'morning', clock: '08:00', weather: 'clear', indoors: false },
  night_rain_outdoors: { phase: 'night', clock: '01:00', weather: 'rain', indoors: false },
}
const audit = {}
for (const [name, canonInput] of Object.entries(auditCanons)) {
  const canon = sceneCanonFromEnvironment({ world_clock: worldClock(canonInput), scene: {} })
  const flags = texts.flatMap((entry) => sceneCanonContradictions(entry.text, canon).map((found) => ({
    id: entry.id, file: entry.file, kind: found.kind, match: found.match,
    sentence: entry.text.split(/(?<=[.!?…])\s+|\n+/u).find((sentence) => sentence.includes(found.match))?.slice(0, 240) ?? '',
  })))
  const labeled = flags.map((flag) => ({ ...flag, genuine: MANUAL_AUDIT[`${flag.id}:${flag.match}`] ?? null }))
  const falseFlags = labeled.filter((flag) => flag.genuine === false)
  audit[name] = {
    canon: canonInput,
    flagged_texts: new Set(flags.map((flag) => flag.id)).size,
    flags: labeled.length,
    genuine: labeled.filter((flag) => flag.genuine === true).length,
    matcher_errors: falseFlags.length,
    unlabeled: labeled.filter((flag) => flag.genuine == null).length,
    matcher_error_rate_per_text: rate(new Set(falseFlags.map((flag) => flag.id)).size, texts.length),
    items: labeled,
  }
}

// Все различные срабатывания по всей сетке: разметка та же, ключ — текст и фрагмент.
const distinct = new Map()
for (const canonInput of grid) {
  const canon = sceneCanonFromEnvironment({ world_clock: worldClock(canonInput), scene: {} })
  for (const entry of texts) {
    for (const found of sceneCanonContradictions(entry.text, canon)) {
      const key = `${entry.id}:${found.match}`
      if (!distinct.has(key)) distinct.set(key, { key, file: entry.file, kind: found.kind, match: found.match, genuine: MANUAL_AUDIT[key] ?? null })
    }
  }
}
const distinctItems = [...distinct.values()]
audit.grid_distinct = {
  flags: distinctItems.length,
  genuine: distinctItems.filter((item) => item.genuine === true).length,
  matcher_errors: distinctItems.filter((item) => item.genuine === false).length,
  unlabeled: distinctItems.filter((item) => item.genuine == null).length,
  texts_with_matcher_error: new Set(distinctItems.filter((item) => item.genuine === false).map((item) => item.key.split(':')[0])).size,
  items: distinctItems,
}
audit.grid_distinct.precision = rate(audit.grid_distinct.genuine, audit.grid_distinct.genuine + audit.grid_distinct.matcher_errors)
audit.grid_distinct.matcher_error_rate_per_text = rate(audit.grid_distinct.texts_with_matcher_error, texts.length)

// ---------- отчёт ----------
const report = {
  schema_version: 1,
  created_at: new Date().toISOString(),
  method: 'Детерминированный прогон без сети. ДО — verifyNarration из git ' + beforeRef + ', ПОСЛЕ — текущий. Brief несёт world_clock в форме оркестратора.',
  labeled_set: {
    file: 'eval/scene-canon-cases-2026-10-01.json',
    before_any_violation: summary('before', 'any'),
    before_scene_canon: summary('before', 'canon'),
    after_any_violation: summary('after', 'any'),
    after_scene_canon: summary('after', 'canon'),
    missed_after: rows.filter((row) => row.label === 'contradiction' && !row.after.canon).map((row) => ({ id: row.id, kind: row.kind, text: row.text })),
    false_positives_after: rows.filter((row) => row.label === 'clean' && row.after.canon).map((row) => ({ id: row.id, text: row.text, matches: row.after.matches })),
    rows,
  },
  saved_narrations: {
    texts: texts.length,
    files: new Set(texts.map((entry) => entry.file)).size,
    note: 'У сохранённых текстов канона нет. Флаг по сетке показывает, сколько текстов противоречили бы такому канону; «неудовлетворимые» — тексты, которым не подходит ни один из 40 канонов, то есть ошибки сопоставления либо самопротиворечивые тексты.',
    before_flags_any_canon: 0,
    per_canon: perCanon,
    unsatisfiable: unsatisfiable.map((entry) => ({ id: entry.id, file: entry.file, text: entry.text.slice(0, 400) })),
    manual_audit: audit,
  },
}
writeFileSync(new URL(output, root), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({
  before: report.labeled_set.before_any_violation,
  after: report.labeled_set.after_scene_canon,
  saved: { texts: texts.length, unsatisfiable: unsatisfiable.length, max_rate: Math.max(...perCanon.map((entry) => entry.rate)), audit: Object.fromEntries(Object.entries(audit).map(([name, value]) => [name, { flagged_texts: value.flagged_texts, flags: value.flags, genuine: value.genuine, matcher_errors: value.matcher_errors, unlabeled: value.unlabeled }])) },
}, (key, value) => key === 'by_kind' ? undefined : value, 2))
