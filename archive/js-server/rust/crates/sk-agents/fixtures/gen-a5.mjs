import '../../../fixtures-env.mjs'
// Эталоны задачи А5 (`sk-agents`, `server/narrator.mjs`).
//
//   node rust/crates/sk-agents/fixtures/gen-a5.mjs [--corpus <каталог corpus-v1>] [--skip-tests]
//
// Две части, обе — журналы вызовов рассказчика в порядке вызова (формат —
// `narrator-recording.mjs`):
//
// 1. Тесты JS о рассказчике: каждый файл из TEST_FILES прогоняется отдельным
//    процессом с `record-a5.mjs` — открытые функции и `render` записываются
//    вместе с ответами тестовых клиентов модели (куски потока, ошибки,
//    зависания до срока). Серверы игры эти тесты не поднимают.
// 2. Сценарии генератора: брифы из состояний и событий корпуса (бой,
//    исследование, социальные сцены, сценарий), синтетика и мусор; модель —
//    заглушка по сценарию (корректный текст, поток, битые ответы, запрещённое
//    содержимое — смерть, механика, поступок героя, чужая реакция,
//    отсутствующий ориентир, стоп-тема; отказ, срок, правка).
//
// Большие значения (бриф, запрос, итог) лежат один раз в таблице `blobs` по
// SHA-256 и заменены ссылкой `{ "$blob": sha }`. Выход — `a5.json.gz`.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const WRAPPER = new URL('./narrator-recording.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    const resolved = nextResolve(specifier, context)
    if (resolved.url.endsWith('/server/narrator.mjs') && context.parentURL !== WRAPPER) return { ...resolved, url: WRAPPER, shortCircuit: true }
    return resolved
  },
})
const storage = mkdtempSync(join(tmpdir(), 'sk-a5-'))
process.env.DND_STORAGE_DIR = storage
delete process.env.ROUTERAI_API_KEY

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpusRoot = flag('--corpus', 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1')
const skipTests = process.argv.includes('--skip-tests')

const TEST_FILES = [
  'narrator.test.mjs', 'narrator-craft.test.mjs', 'narrator-evidence-regression.test.mjs', 'narrator-experience.test.mjs',
  'narrator-grounding-regression.test.mjs', 'narrator-known-fates.test.mjs', 'narrator-response-plan.test.mjs',
  'narrator-streaming.test.mjs', 'narrator-token-usage.test.mjs', 'narrator-dialogue-routing.test.mjs',
  'deterministic-narration-combat-turn.test.mjs', 'deterministic-narration-framing.test.mjs', 'narration-reasoning-leak.test.mjs',
  'narration-npc-reactions.test.mjs', 'narration-story-context.test.mjs', 'llm-refusal-fallback.test.mjs', 'injection-surfaces.test.mjs',
  'dm-dialogue-upgrade.test.mjs', 'discovery-content.test.mjs', 'scene-canon.test.mjs', 'scene-summary.test.mjs', 'weather.test.mjs',
  'dialogue-interaction.test.mjs', 'free-action-discovery.test.mjs', 'free-action.test.mjs', 'free-action-hazard-contact.test.mjs',
  'free-action-wall-contact.test.mjs', 'game-orchestrator.test.mjs', 'game-flow-integration.test.mjs', 'persistent-campaign.test.mjs',
  'player-request-router.test.mjs', 'spell-by-words.test.mjs', 'intent-routing.test.mjs', 'check-discovery-replay.test.mjs',
  'combat-entry-routing.test.mjs', 'approach-attack.test.mjs', 'action-sequence-roll.test.mjs', 'compound-maneuver-preview.test.mjs',
  'tavern-life.test.mjs', 'blessings.test.mjs', 'beast-taming.test.mjs', 'world-memory-delivery.test.mjs', 'npc-social.test.mjs',
  'lore-voice.test.mjs', 'trace-store.test.mjs', 'authoritative-writers.test.mjs',
]

// --- журналы тестов JS ----------------------------------------------------------------

function recordTests() {
  const node = process.execPath
  const out = mkdtempSync(join(tmpdir(), 'sk-a5-rec-'))
  const processes = []
  for (const file of TEST_FILES) {
    const path = join(root, 'test', file)
    if (!existsSync(path)) continue
    const target = join(out, `${file}.json`)
    const run = spawnSync(node, ['--import', pathToFileURL(join(here, 'record-a5.mjs')).href, path], {
      cwd: root,
      env: { ...process.env, A5_RECORD_FILE: target, ROUTERAI_API_KEY: '', DND_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'sk-a5-st-')) },
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const summary = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/u.exec(run.stdout ?? '')
    if (!existsSync(target)) {
      console.error(`${file}: журнала нет (код ${run.status})`)
      continue
    }
    const events = JSON.parse(readFileSync(target, 'utf8'))
    console.error(`${file}: событий ${events.length}, тесты ${summary ? `${summary[1]} прошли, ${summary[2]} нет` : `код ${run.status}`}`)
    if (events.length) processes.push({ source: `test/${file}`, events })
  }
  rmSync(out, { recursive: true, force: true })
  return processes
}

// --- общие куски -------------------------------------------------------------------------

const blobs = {}
const BLOB_MIN = 1_024

function blobify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 2 * BLOB_MIN) return storeBlob(value)
    return value
  }
  const copy = Array.isArray(value) ? value.map(blobify) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, blobify(item)]))
  const text = JSON.stringify(copy)
  return text.length > BLOB_MIN ? storeBlob(copy, text) : copy
}

function storeBlob(value, text = JSON.stringify(value)) {
  const key = createHash('sha256').update(text).digest('hex').slice(0, 32)
  blobs[key] = value
  return { $blob: key }
}

function compactEvent(event) {
  const copy = { ...event }
  const wrapped = (slot) => (slot && typeof slot === 'object' && 'v' in slot ? { v: blobify(slot.v) } : slot)
  if (Array.isArray(copy.args)) copy.args = copy.args.map((slot) => (slot && 'resolver' in slot ? slot : wrapped(slot)))
  if (copy.out !== undefined) copy.out = copy.k === 'drainFeedback' ? blobify(copy.out) : wrapped(copy.out)
  if (copy.brief) copy.brief = wrapped(copy.brief)
  if (copy.result) copy.result = blobify(copy.result)
  if (copy.options) copy.options = Object.fromEntries(Object.entries(copy.options).map(([key, slot]) => [key, wrapped(slot)]))
  if (Array.isArray(copy.calls)) {
    copy.calls = copy.calls.map((call) => ({
      ...call,
      request: blobify(call.request),
      ...(call.outcome?.value !== undefined ? { outcome: { value: blobify(call.outcome.value) } } : {}),
    }))
  }
  if (copy.config?.feedback_results) {
    copy.config = { ...copy.config, feedback_results: copy.config.feedback_results.map((slot) => ('value' in slot ? { value: blobify(slot.value) } : slot)) }
  }
  return copy
}

// --- сборка ------------------------------------------------------------------------------

const processes = skipTests ? [] : recordTests()
const { generatedProcess } = await import('./gen-a5-scenarios.mjs')
processes.push(await generatedProcess({ corpusRoot }))

const fixture = {
  generator: 'rust/crates/sk-agents/fixtures/gen-a5.mjs',
  processes: processes.map((entry) => ({ source: entry.source, events: entry.events.map(compactEvent) })),
}
fixture.blobs = blobs
const text = JSON.stringify(fixture)
const packed = gzipSync(text, { level: 9 })
writeFileSync(join(here, 'a5.json.gz'), packed)
const counts = {}
for (const entry of fixture.processes) for (const event of entry.events) counts[event.k] = (counts[event.k] ?? 0) + 1
console.error(`a5.json.gz: ${processes.length} журналов, события ${JSON.stringify(counts)}, кусков ${Object.keys(blobs).length}, ${(text.length / 1e6).toFixed(1)} МБ → ${(packed.length / 1e6).toFixed(2)} МБ gzip`)
rmSync(storage, { recursive: true, force: true })
