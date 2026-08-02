/**
 * Живой bounded-eval Арбитра свободного действия (задача 1.3 плана
 * `docs/experience-upgrade-plan.md`).
 *
 * Запуск одного замера:
 *   node eval/improvisation-eval.mjs --label v3 --output eval/improvisation-v3.json
 *
 * Пересчёт сохранённого отчёта без вызовов провайдера:
 *   node eval/improvisation-eval.mjs --rescore eval/improvisation-v3.json
 *
 * Сравнение двух прогонов:
 *   node eval/improvisation-eval.mjs --compare eval/improvisation-v2.json eval/improvisation-v3.json
 *
 * Раннер не читает и не меняет storage: сцены синтетические. Отчёт не содержит
 * ключей и содержимого .env. Модель вызывается тем же промптом и тем же брифом,
 * что и в бою (`adjudicationBrief`), но ответ оценивается **до**
 * `normalizeFreeActionReading` — нормализатор молча чинит мусор, и после него
 * структурная валидность всегда выглядела бы стопроцентной.
 */
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { adjudicationBrief } from '../server/action-adjudicator.mjs'
import { FallbackLLMClient, RouterAIClient } from '../server/llm-client.mjs'
import { buildDataOnlyContext } from '../server/security.mjs'
import {
  CATEGORY_LABELS,
  IMPROVISATION_CASES,
  expectationMisses,
  scoreImprovisationRun,
  structuralIssues,
} from './improvisation-scenarios.mjs'

const args = process.argv.slice(2)

function textOption(name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : fallback
}

function integerOption(name, fallback) {
  const value = Number(textOption(name, fallback))
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function printScore(label, score) {
  console.log(`${label}: структурно валидных ${score.structural_valid_pct}% | в ожиданиях ${score.in_expectation_pct}% | ложных отказов ${score.wrong_refusals}`)
  for (const [id, bucket] of Object.entries(score.categories)) {
    console.log(`  ${bucket.label} (${bucket.total}): валидных ${bucket.structural_valid_pct}%, в ожиданиях ${bucket.in_expectation_pct}%, ложных отказов ${bucket.wrong_refusals} [${id}]`)
  }
}

const rescoreIndex = args.indexOf('--rescore')
if (rescoreIndex >= 0) {
  const inputPath = args[rescoreIndex + 1]
  if (!inputPath) throw new Error('--rescore требует путь к JSON-отчёту')
  const outputPath = resolve(textOption('--output', inputPath))
  const report = JSON.parse(readFileSync(resolve(inputPath), 'utf8'))
  const byId = new Map(IMPROVISATION_CASES.map((testCase) => [testCase.id, testCase]))
  for (const sample of report.samples ?? []) {
    const testCase = byId.get(sample.id)
    if (!testCase) continue
    sample.structural_issues = structuralIssues(sample.raw)
    sample.expectation_misses = expectationMisses(testCase, sample.raw)
    sample.wrong_refusal = testCase.expect.no_refusal === true && String(sample.raw?.plausibility) === 'impossible_without_means'
  }
  report.score = scoreImprovisationRun(report.samples ?? [])
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  printScore(String(report.label ?? 'REPORT').toUpperCase(), report.score)
  console.log(`Пересчитан без provider-вызовов: ${outputPath}`)
  process.exit(0)
}

const compareIndex = args.indexOf('--compare')
if (compareIndex >= 0) {
  const beforePath = args[compareIndex + 1]
  const afterPath = args[compareIndex + 2]
  if (!beforePath || !afterPath) throw new Error('--compare требует два пути к JSON-отчётам')
  const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8'))
  const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8'))
  printScore('ДО', before.score)
  printScore('ПОСЛЕ', after.score)
  console.log(`Δ в ожиданиях: ${Math.round((after.score.in_expectation_pct - before.score.in_expectation_pct) * 10) / 10} п.п.; Δ ложных отказов: ${after.score.wrong_refusals - before.score.wrong_refusals}`)
  process.exit(0)
}

const LABEL = textOption('--label', 'run')
const OUTPUT = resolve(textOption('--output', `eval/improvisation-${LABEL}.json`))
// Запас на fallback-цепочку: один кейс может стоить второго вызова, если
// первая модель ответила невалидно. Без запаса последний кейс упирался в лимит
// и уходил в отчёт как промах — это артефакт замера, а не поведение модели.
const MAX_CALLS = integerOption('--max-calls', IMPROVISATION_CASES.length * 2)
const ONLY = textOption('--category', '')

if (!process.env.ROUTERAI_API_KEY) {
  console.error('ROUTERAI_API_KEY не настроен — живой eval импровизаций невозможен.')
  console.error('Положите .env рядом с проектом либо запустите --rescore на сохранённом отчёте.')
  process.exit(1)
}

const meter = { calls: 0, usage: { input: 0, output: 0 }, log: [] }

class MeteredModel extends RouterAIClient {
  async complete(input, options = {}) {
    if (meter.calls >= MAX_CALLS) {
      const error = new Error(`Достигнут предел живых вызовов (${MAX_CALLS})`)
      error.code = 'EVAL_CALL_LIMIT'
      throw error
    }
    meter.calls += 1
    const started = performance.now()
    try {
      const result = await super.complete(input, options)
      meter.usage.input += Number(result.usage?.prompt_tokens) || 0
      meter.usage.output += Number(result.usage?.completion_tokens) || 0
      meter.log.push({ model: this.model, ok: true, latency_ms: Math.round(performance.now() - started) })
      return result
    } catch (error) {
      meter.log.push({
        model: this.model,
        ok: false,
        latency_ms: Math.round(performance.now() - started),
        code: String(error?.code ?? error?.name ?? 'ERROR').slice(0, 80),
      })
      throw error
    }
  }
}

function reasoningForModel(modelId) {
  const requested = String(process.env.DND_AI_REASONING_EFFORT ?? '').trim().toLowerCase()
  if (requested === 'off') return { enabled: false }
  if (requested) return { effort: requested }
  return ['z-ai/glm-5.2', 'deepseek/deepseek-v4-flash'].includes(modelId) ? { enabled: false } : null
}

function productionChainClient() {
  const primary = process.env.DND_AI_MODEL ?? 'deepseek/deepseek-v4-flash'
  const fallbacks = String(process.env.DND_AI_FALLBACK_MODELS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const timeoutMs = Number(process.env.DND_AI_MODEL_TIMEOUT_MS) || 9_000
  return new FallbackLLMClient({
    clients: [primary, ...fallbacks].map((modelId) => new MeteredModel({
      model: modelId,
      timeoutMs,
      reasoning: reasoningForModel(modelId),
    })),
    probeTimeoutMs: Number(process.env.DND_AI_PROBE_TIMEOUT_MS) || 15_000,
    failureCooldownMs: Number(process.env.DND_AI_FAILURE_COOLDOWN_MS) || 120_000,
  })
}

// Промпт берётся из того же файла, что грузит боевой модуль: замер обязан
// проверять действующий контракт, а не свою копию.
const promptPath = new URL('../prompts/action_adjudicator/v3.txt', import.meta.url)
const prompt = readFileSync(promptPath, 'utf8')
const promptId = /^PROMPT_ID:\s*(\S+)/mu.exec(prompt)?.[1] ?? 'unknown'

const client = productionChainClient()
const cases = ONLY ? IMPROVISATION_CASES.filter((testCase) => testCase.category === ONLY) : IMPROVISATION_CASES
if (!cases.length) throw new Error(`Нет кейсов для категории ${ONLY}`)

const samples = []
for (const testCase of cases) {
  const started = performance.now()
  let raw = null
  let failure = null
  try {
    raw = await client.completeJson({
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: buildDataOnlyContext({ free_action_brief: adjudicationBrief(testCase.state, 'hero-1', testCase.text) }) },
      ],
      temperature: 0.2,
      maxTokens: 400,
    })
  } catch (error) {
    failure = String(error?.code ?? error?.name ?? 'ERROR').slice(0, 80)
  }
  const issues = failure ? [`вызов не удался: ${failure}`] : structuralIssues(raw)
  const misses = failure ? ['нет разбора'] : expectationMisses(testCase, raw)
  samples.push({
    id: testCase.id,
    category: testCase.category,
    text: testCase.text,
    scene: testCase.state.scene.location,
    raw,
    failure,
    structural_issues: issues,
    expectation_misses: misses,
    wrong_refusal: testCase.expect.no_refusal === true && String(raw?.plausibility) === 'impossible_without_means',
    latency_ms: Math.round(performance.now() - started),
  })
  const mark = issues.length === 0 && misses.length === 0 ? 'ok' : 'промах'
  console.log(`  ${testCase.id} [${CATEGORY_LABELS[testCase.category]}]: ${mark} — ${raw?.ability ?? '—'}/${raw?.skill ?? '—'}, ${raw?.plausibility ?? '—'}, risk ${raw?.risk ?? '—'}`)
}

const report = {
  schema_version: 1,
  label: LABEL,
  date: new Date().toISOString(),
  prompt_id: promptId,
  primary_model: process.env.DND_AI_MODEL ?? 'deepseek/deepseek-v4-flash',
  reasoning_effort: process.env.DND_AI_REASONING_EFFORT ?? 'по умолчанию модели',
  live_calls: meter.calls,
  tokens: meter.usage,
  provider_log: meter.log,
  samples,
  score: scoreImprovisationRun(samples),
}

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
printScore(LABEL.toUpperCase(), report.score)
console.log(`Живых provider-вызовов: ${report.live_calls}; токены: ${report.tokens.input}+${report.tokens.output}`)
if (report.score.misses.length) {
  console.log('Промахи:')
  for (const miss of report.score.misses) {
    console.log(`  ${miss.id}: ${[...miss.structural_issues, ...miss.expectation_misses].join('; ')}`)
  }
}
console.log(`Отчёт: ${OUTPUT}`)
