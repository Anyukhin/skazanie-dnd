// Эталон `server/usage-ledger.mjs` для `tests/usage_ledger_fixture.rs`.
//
// Случайные сценарии (seeded mulberry32): резерв, закрытие, неудача, отчёт,
// время (в том числе смена суток и срок хранения), перезапуск. После каждой
// операции записаны результат и SHA-256 файла учёта; Rust сравнивает файл
// байт в байт. Отдельно — `normalizeProviderUsage` и оценка входа
// `MeteredLLMClient` по байтам сообщений.
//
// Запуск из корня репозитория:
//   node rust/crates/sk-infra/fixtures/gen-usage-ledger.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DurableUsageLedger, MeteredLLMClient, normalizeProviderUsage } from '../../../../server/usage-ledger.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UNDEFINED = { undefined: true }
const pick = (random, list) => list[Math.floor(random() * list.length)]
const defined = (value) => (value === UNDEFINED ? undefined : value)

const IDS = ['a', 'b', 'c', 'd', '  spaced   id  ', '', '7', '12']
const ESTIMATES = [1, 5, 20, 50, 90, 120, 0, -1, 2.5]
const SCOPES = [UNDEFINED, 'campaign:a', 'campaign:b', '', '  x   y ', 'global']
const MODELS = [UNDEFINED, 'test', 'm', '', 'unknown']
const USAGES = [
  UNDEFINED, {}, null, 5,
  { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.004 },
  { input_tokens: 3, output_tokens: 4 },
  { total_tokens: 0 },
  { total_tokens: -5, cost: -1 },
  { cost: 0.1, total_cost: 0.2 },
  { total_cost: '0.3', input_tokens: '7' },
  { input_tokens: null, prompt_tokens: 9, output_tokens: 2.5, completion_tokens: 1 },
]
const CODES = [UNDEFINED, 'LLM_TIMEOUT', '', '   ', 'X'.repeat(100), 'LLM_JSON_INVALID']
const FAIL_USAGES = [UNDEFINED, null, { total_tokens: 100, cost: 0.25 }, [1], 'str', { prompt_tokens: 30 }]

async function run(seed) {
  const random = mulberry32(seed)
  const directory = mkdtempSync(join(tmpdir(), 'sk-infra-usage-'))
  const storageFile = join(directory, 'usage.json')
  let now = Date.parse('2026-07-24T12:00:00.000Z')
  const config = { daily_token_limit: pick(random, [100, 250, 1000]), reservation_ttl_ms: pick(random, [1_000, 60_000]), retention_days: pick(random, [UNDEFINED, 2, 31]) }
  const build = () => new DurableUsageLedger({
    storageFile,
    dailyTokenLimit: config.daily_token_limit,
    reservationTtlMs: config.reservation_ttl_ms,
    ...(config.retention_days === UNDEFINED ? {} : { retentionDays: config.retention_days }),
    now: () => now,
  })
  let ledger = build()
  const steps = []
  const count = 40 + Math.floor(random() * 40)
  for (let index = 0; index < count; index += 1) {
    const op = pick(random, ['reserve', 'reserve', 'reserve', 'settle', 'settle', 'fail', 'report', 'advance', 'restart'])
    const step = { op }
    try {
      if (op === 'reserve') {
        const scope = pick(random, SCOPES)
        const model = pick(random, MODELS)
        step.request = { request_id: pick(random, IDS), estimated_tokens: pick(random, ESTIMATES) }
        if (scope !== UNDEFINED) step.request.scope = scope
        if (model !== UNDEFINED) step.request.model = model
        step.result = ledger.reserve({ requestId: step.request.request_id, estimatedTokens: step.request.estimated_tokens, scope: step.request.scope, model: step.request.model })
      } else if (op === 'settle') {
        step.id = pick(random, IDS)
        const usage = pick(random, USAGES)
        if (usage !== UNDEFINED) step.usage = usage
        step.result = usage === UNDEFINED ? ledger.settle(step.id) : ledger.settle(step.id, usage)
      } else if (op === 'fail') {
        step.id = pick(random, IDS)
        const code = pick(random, CODES)
        const usage = pick(random, FAIL_USAGES)
        if (code !== UNDEFINED) step.code = code
        if (usage !== UNDEFINED) step.usage = usage
        step.result = ledger.fail(step.id, defined(code), defined(usage))
      } else if (op === 'report') {
        step.result = ledger.report()
      } else if (op === 'advance') {
        step.ms = pick(random, [0, 500, 1_000, 30_000, 12 * 3_600_000, 24 * 3_600_000, 3 * 24 * 3_600_000, 40 * 24 * 3_600_000])
        now += step.ms
      } else if (op === 'restart') {
        ledger = build()
      }
    } catch (error) {
      step.error = { code: error?.code ?? error?.name, message: error?.message }
      delete step.result
    }
    const file = existsSync(storageFile) ? readFileSync(storageFile, 'utf8') : null
    step.file_sha256 = file == null ? null : createHash('sha256').update(file, 'utf8').digest('hex')
    if (index === count - 1) step.file = file
    steps.push(step)
  }
  rmSync(directory, { recursive: true, force: true })
  const configOut = { ...config }
  if (configOut.retention_days === UNDEFINED) delete configOut.retention_days
  return { seed, config: configOut, steps }
}

// Оценка входа: `estimatedInputTokens` модуля не экспортирован, поэтому она
// снимается через MeteredLLMClient — заглушка поставщика видит резерв.
async function estimates() {
  const random = mulberry32(777)
  const directory = mkdtempSync(join(tmpdir(), 'sk-infra-usage-estimate-'))
  const ledger = new DurableUsageLedger({ storageFile: join(directory, 'usage.json'), dailyTokenLimit: 1_000_000_000 })
  const client = new MeteredLLMClient({ client: { model: 'fake', maxTokens: 10, complete: async () => ({ content: '{}', usage: {} }), probe: async () => [], health: () => [] }, ledger })
  const pieces = ['Привет', 'hello', '"кавычки"', 'line\nbreak', '\t', '🙂', 'ß', ' ', 'x'.repeat(50), '\\']
  const values = () => pick(random, [
    () => pick(random, pieces),
    () => pick(random, [0, 1, -3, 2.5, 1e21, 1e-7, 123456789]),
    () => pick(random, [true, false, null]),
  ])()
  const message = () => {
    const shape = pick(random, ['plain', 'nested', 'array'])
    if (shape === 'plain') return { role: pick(random, ['user', 'system']), content: Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(random, pieces)).join(' ') }
    if (shape === 'nested') return { role: 'tool', content: { a: values(), b: [values(), values()], 10: values(), 2: values() } }
    return [values(), values()]
  }
  const cases = []
  for (let index = 0; index < 150; index += 1) {
    const form = pick(random, ['array', 'object', 'object_null', 'empty_object', 'primitive'])
    const messages = Array.from({ length: Math.floor(random() * 4) }, message)
    const input = form === 'array' ? messages
      : form === 'object' ? { messages, maxTokens: pick(random, [5, 10]) }
        : form === 'object_null' ? { messages: null }
          : form === 'empty_object' ? {}
            : 'строка'
    const requestId = `estimate-${index}`
    await client.complete(input, { usageRequestId: requestId })
    const entry = JSON.parse(readFileSync(join(directory, 'usage.json'), 'utf8')).requests[requestId]
    cases.push({ input, max_output: typeof input === 'object' && input && !Array.isArray(input) && input.maxTokens ? input.maxTokens : 10, estimated_tokens: entry.estimated_tokens })
  }
  rmSync(directory, { recursive: true, force: true })
  return cases
}

function usages() {
  const random = mulberry32(4242)
  const field = () => pick(random, [UNDEFINED, null, 0, 3, -1, 2.5, '8', 'abc', 1e20, true])
  const cases = []
  for (let index = 0; index < 200; index += 1) {
    const usage = {}
    for (const key of ['input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens', 'total_tokens', 'cost', 'total_cost']) {
      const value = field()
      if (value !== UNDEFINED) usage[key] = key.includes('cost') && typeof value === 'number' ? value / 7 : value
    }
    const fallback = pick(random, [UNDEFINED, 0, 15, -2, 'x', null])
    const entry = { usage }
    if (fallback !== UNDEFINED) entry.fallback = fallback
    entry.result = fallback === UNDEFINED ? normalizeProviderUsage(usage) : normalizeProviderUsage(usage, fallback)
    cases.push(entry)
  }
  return cases
}

const scenarios = []
for (let seed = 1; seed <= 40; seed += 1) scenarios.push(await run(seed))
const fixture = { scenarios, estimates: await estimates(), usages: usages() }
writeFileSync(join(here, 'usage-ledger.json'), `${JSON.stringify(fixture)}\n`, 'utf8')
console.log(`usage-ledger: ${scenarios.length} сценариев, ${scenarios.reduce((total, entry) => total + entry.steps.length, 0)} операций, ${fixture.estimates.length} оценок, ${fixture.usages.length} usage`)
