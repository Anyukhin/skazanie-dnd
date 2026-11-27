// Общая часть генераторов эталонов sk-narration.
//
// - Перехват настоящих вызовов рассказчиков (`module.registerHooks`): хук
//   загрузки вставляет В НАЧАЛО модуля переприсваивание экспортов обёрткой.
//   Объявления функций всплывают, так что обёртку видят и импортёры, и
//   объекты, созданные при загрузке модуля (`registerDeterministicNarrator({
//   narrate: sceneNarration })`). Исходники `server/` на диске не меняются.
//   Как `rust/crates/sk-world-life/fixtures/hook.mjs`.
// - Корпус паритета (`tmp/corpus-v1`): события команды и состояние после неё.
// - Писатель эталона: таблица состояний (каждое — один раз) и случаи
//   `{ fn, args, result | error }`; аргумент-состояние — `{ "$state": i }`.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`; серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

export const TARGETS = {
  'server/combat-narration.mjs': [
    'encounterEndText', 'damageTypeLabel', 'tacticalNarrationParts', 'tacticalNarrationOr', 'combatJournalVoice',
    'encounterSetting', 'encounterIntro', 'hasCombatNarrationEvent', 'tacticalNarration',
  ],
  'server/scene-narration.mjs': ['hasSceneEvent', 'sceneNarration'],
  'server/encounter-narration.mjs': ['hasEncounterEvent', 'encounterNarration'],
  'server/scene-summary.mjs': ['eventsSinceSceneStart', 'notableSceneMoments', 'buildSceneSummaryText', 'sceneSummaryFor'],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__narrationWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name});`).join(' ')
    return { ...result, source: `${wraps}\n${source}` }
  },
})

const depth = new Map()

globalThis.__narrationWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__narrationRecorder
  if (!recorder || (depth.get(module) ?? 0) > 0) return fn(...args)
  depth.set(module, (depth.get(module) ?? 0) + 1)
  try {
    const call = recorder(module, name, args)
    const result = fn(...(call?.args ?? args))
    call?.done?.(result)
    return result
  } finally {
    depth.set(module, depth.get(module) - 1)
  }
}

/** Начать запись: `capture(module, name, args)` → `{ args?, done? }` или ничего. */
export function startCapture(capture) {
  globalThis.__narrationRecorder = capture
  return () => {
    globalThis.__narrationRecorder = undefined
  }
}

/** Выполнить `fn` без записи. */
export function quietly(fn) {
  const saved = globalThis.__narrationRecorder
  globalThis.__narrationRecorder = undefined
  try {
    return fn()
  } finally {
    globalThis.__narrationRecorder = saved
  }
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** Вход через JSON: то, что увидит Rust. */
export function viaJson(value) {
  if (value === undefined) return undefined
  const text = JSON.stringify(value, (_key, inner) => (inner instanceof Set ? [...inner] : inner instanceof Map ? Object.fromEntries(inner) : inner))
  return text === undefined ? undefined : JSON.parse(text)
}

export const UNDEFINED = '\u0000undefined'

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

export function chooser(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chance = (p) => random() < p
  return { int, pick, chance }
}

export const pickKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const result = {}
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key]
  return result
}

export const mapList = (value, fn) => (Array.isArray(value) ? value.map(fn) : value)

// ---------------------------------------------------------------------------
// Корпус
// ---------------------------------------------------------------------------

export const DEFAULT_CORPUS = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

export function corpusDir(argument) {
  const dir = argument ?? process.env.SK_NARRATION_CORPUS ?? DEFAULT_CORPUS
  return dir && existsSync(join(dir, 'states')) ? dir : null
}

/** Записи корпуса с успешным исходом: события команды и хеш состояния после неё. */
export function* corpusRecords(dir) {
  const after = new Map()
  for (const line of readFileSync(join(dir, 'after.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      after.set(`${entry.file}#${entry.row}`, entry.after)
    } catch { /* битая строка */ }
  }
  for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
    let row = 0
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      row += 1
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!record?.outcome?.ok || !Array.isArray(record.outcome.events)) continue
      yield { file, row, before: record.state, after: after.get(`${file}#${row}`) ?? null, events: record.outcome.events, command: record.command }
    }
  }
}

export function corpusState(dir, hash) {
  if (!hash) return null
  try {
    return JSON.parse(readFileSync(join(dir, 'states', `${hash}.json`), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Писатель
// ---------------------------------------------------------------------------

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * Исход вызова для эталона: `{ result }` (undefined — UNDEFINED) или
 * `{ error: true }`; для `tacticalNarrationOr` — ещё `seen`: sha256
 * `JSON.stringify` событий, отданных запасному рассказчику (null — не звали).
 */
export function outcomeOf(fn, args) {
  try {
    const value = fn(...args)
    return { result: value === undefined ? UNDEFINED : viaJson(value) }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return { error: true }
  }
}

export function fixtureWriter(module) {
  const states = []
  const stateIndex = new Map()
  const cases = []
  const seen = new Set()
  const perFn = new Map()
  let loneSurrogates = 0

  function stateRef(state) {
    const text = JSON.stringify(state)
    let index = stateIndex.get(text)
    if (index === undefined) {
      index = states.length
      states.push(JSON.parse(text))
      stateIndex.set(text, index)
    }
    return { $state: index }
  }

  /**
   * Записать случай. `stateArgs` — индексы аргументов-состояний; `outcome` —
   * уже снятый исход. Повтор того же входа не пишется.
   */
  function add(name, args, outcome, { stateArgs = [], cap = Infinity, source = null } = {}) {
    const recorded = args.map((arg, index) => (stateArgs.includes(index) && arg && typeof arg === 'object' ? stateRef(arg) : (arg === undefined ? UNDEFINED : arg)))
    const key = sha256(JSON.stringify([name, args]))
    if (seen.has(key)) return false
    if ((perFn.get(name) ?? 0) >= cap) return false
    seen.add(key)
    perFn.set(name, (perFn.get(name) ?? 0) + 1)
    const entry = { fn: name, args: recorded, ...outcome }
    if (source) entry.source = source
    // Одинокий суррогат (JS разрезал пару `slice` по единицам UTF-16) строка
    // Rust не удержит: такие случаи не пишутся, их считает `loneSurrogates`.
    if (/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/iu.test(JSON.stringify(entry))) {
      loneSurrogates += 1
      return false
    }
    cases.push(entry)
    return true
  }

  return {
    add,
    cases,
    counts: perFn,
    write(url) {
      const lines = [
        `"module": ${JSON.stringify(module)}`,
        `"states": [\n${states.map((state) => JSON.stringify(state)).join(',\n')}\n]`,
        `"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]`,
      ]
      // Эталон хранится в gzip, как у sk-world-time: текст JSON сжимается в разы.
      const packed = gzipSync(Buffer.from(`{\n${lines.join(',\n')}\n}\n`, 'utf8'), { level: 9 })
      writeFileSync(url, packed)
      const size = lines.reduce((total, line) => total + line.length, 0)
      console.log(`${url.pathname.split('/').at(-1)}: состояний ${states.length}, случаев ${cases.length}, ${(size / 1024 / 1024).toFixed(2)} МБ JSON, ${(packed.length / 1024 / 1024).toFixed(2)} МБ gzip`)
      if (loneSurrogates) console.log(`пропущено случаев с одиноким суррогатом: ${loneSurrogates}`)
      console.log([...perFn.entries()].map(([name, count]) => `${name} ${count}`).join(', '))
    },
  }
}

/**
 * Урезать аргументы-состояния: `strips` — от сильного к слабому; берётся
 * первое, на котором исход совпал с исходом на полном входе, иначе полный.
 */
export function stripArgs(fn, args, stateArgs, strips, stats) {
  const expected = outcomeOf(fn, args)
  for (const strip of strips) {
    const candidate = args.map((arg, index) => (stateArgs.includes(index) ? strip(arg) : arg))
    if (same(outcomeOf(fn, candidate), expected)) {
      if (stats) stats.stripped = (stats.stripped ?? 0) + 1
      return { args: candidate, outcome: expected }
    }
  }
  if (stats) stats.full = (stats.full ?? 0) + 1
  return { args, outcome: expected }
}

/** Запустить файлы тестов JS в этом процессе (node:test исполняет их по завершении загрузки). */
export async function runTestFiles(files) {
  const { run } = await import('node:test')
  await new Promise((resolve) => {
    const stream = run({ files, concurrency: 1, isolation: 'none' })
    stream.on('test:fail', (event) => {
      if (event?.details?.type !== 'suite') console.error(`  тест JS упал: ${event?.name}`)
    })
    stream.on('end', resolve)
    stream.on('error', resolve)
    stream.resume()
  })
}
