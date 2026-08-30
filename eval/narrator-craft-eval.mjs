/**
 * Живой bounded-eval ремесла Рассказчика.
 *
 * Запуск одного замера:
 *   node eval/narrator-craft-eval.mjs --label baseline \
 *     --output eval/narrator-craft-baseline.json --max-calls 10
 *
 * Повторный расчёт уже сохранённых результатов не вызывает провайдера:
 *   node eval/narrator-craft-eval.mjs --compare \
 *     eval/narrator-craft-baseline.json eval/narrator-craft-after.json
 *
 * Safety-output текущего production Narrator можно переиграть на сохранённых
 * финальных production outputs без сети. v5 не делает repair-вызов: первый
 * безопасный вариант остаётся текстом хода, а художественный verdict пишется
 * отдельно в `async_feedback`:
 *   node eval/narrator-craft-eval.mjs --replay \
 *     eval/narrator-craft-after.json \
 *     --output eval/narrator-craft-production-after.json
 *
 * Раннер не читает и не меняет storage. Все сцены синтетические, живые вызовы
 * ограничены `--max-calls`, а отчёт не содержит ключей или содержимого .env.
 */
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { FallbackLLMClient, RouterAIClient } from '../server/llm-client.mjs'
import { reasoningProfileFor } from '../server/model-style-profiles.mjs'
import { NARRATOR_PROMPT_VERSION, Narrator } from '../server/narrator.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import { buildNarrationBrief } from '../server/security.mjs'
import { compareNarratorCraftReports, measureNarratorCraft } from './narrator-craft-metrics.mjs'

const args = process.argv.slice(2)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedTextSha256(url) {
  return sha256(readFileSync(url, 'utf8').replace(/\r\n/gu, '\n'))
}

function textOption(name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : fallback
}

function integerOption(name, fallback) {
  const value = Number(textOption(name, fallback))
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function printMetricLine(label, metrics) {
  console.log(
    `${label}: n-граммы ${metrics.ngram_overlap.pairwise_jaccard_pct}% | `
    + `клише ${metrics.cliches.occurrences} | память ${metrics.memory.recall_pct}% | `
    + `голоса ${metrics.voices.distinct_pct}% | конкретика ${metrics.suggestions.specific_pct}%`,
  )
  console.log(
    `  крючок ${metrics.suggestions.forward_coverage_pct}% | `
    + `личная идея ${metrics.suggestions.personal_coverage_pct}% | `
    + `лимиты ${metrics.suggestions.bounded_pct}%`,
  )
}

const compareIndex = args.indexOf('--compare')
if (compareIndex >= 0) {
  const beforePath = args[compareIndex + 1]
  const afterPath = args[compareIndex + 2]
  if (!beforePath || !afterPath) throw new Error('--compare требует два пути к JSON-отчётам')
  const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8'))
  const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8'))
  const comparison = compareNarratorCraftReports(before, after)
  printMetricLine('ДО', comparison.before)
  printMetricLine('ПОСЛЕ', comparison.after)
  console.log(`Δ: ${JSON.stringify(comparison.delta)}`)
  process.exit(0)
}

const recalculateIndex = args.indexOf('--recalculate')
if (recalculateIndex >= 0) {
  const inputPath = args[recalculateIndex + 1]
  if (!inputPath) throw new Error('--recalculate требует путь к JSON-отчёту')
  const outputPath = resolve(textOption('--output', inputPath))
  const report = JSON.parse(readFileSync(resolve(inputPath), 'utf8'))
  report.metrics = measureNarratorCraft(report.samples ?? [])
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  printMetricLine(String(report.label ?? 'REPORT').toUpperCase(), report.metrics)
  console.log(`Пересчитан без provider-вызовов: ${outputPath}`)
  process.exit(0)
}

const LABEL = textOption('--label', 'run')
const OUTPUT = resolve(textOption('--output', `eval/narrator-craft-${LABEL}.json`))
const MAX_CALLS = integerOption('--max-calls', 10)

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

/**
 * `DND_AI_REASONING_EFFORT` задаёт уровень явно: `off` — выключить,
 * `low`/`medium`/`high`/`max` — попросить провайдера. Без переменной сохраняется
 * прежнее поведение: у GLM и DeepSeek reasoning выключен (это их продакшн-режим
 * в горячем пути хода), у остальных моделей параметр не отправляется.
 *
 * @param {string} modelId
 * @returns {{ enabled: false } | { effort: string } | null}
 */
function reasoningForModel(modelId) {
  const requested = String(process.env.DND_AI_REASONING_EFFORT ?? '').trim().toLowerCase()
  if (requested === 'off') return { enabled: false }
  if (requested) return { effort: requested }
  return reasoningProfileFor(modelId)
}

function productionChainClient() {
  const primary = process.env.DND_AI_MODEL ?? 'deepseek/deepseek-v4-flash'
  const fallbacks = String(process.env.DND_AI_FALLBACK_MODELS ?? '').split(',').map((id) => id.trim()).filter(Boolean)
  const timeoutMs = Number(process.env.DND_AI_MODEL_TIMEOUT_MS) || 9_000
  return new FallbackLLMClient({
    clients: [primary, ...fallbacks].map((modelId) => new MeteredModel({
      model: modelId,
      timeoutMs,
      // Уровень рассуждения — часть замера, а не умолчание провайдера. Без
      // него сравнение получается нечестным: у GLM в продакшне reasoning
      // выключен явно, а модель без параметра работает на своём умолчании.
      reasoning: reasoningForModel(modelId),
    })),
    probeTimeoutMs: Number(process.env.DND_AI_PROBE_TIMEOUT_MS) || 15_000,
    failureCooldownMs: Number(process.env.DND_AI_FAILURE_COOLDOWN_MS) || 120_000,
  })
}

const viewer = { playerId: 'hero:ada', partyIds: ['hero:ada', 'hero:ren'], isPartyMember: true }

const baseHeroes = [
  {
    id: 'hero:ada',
    name: 'Ада',
    class_name: 'следопыт',
    background: 'бывшая проводница караванов',
    personal_history: 'Ада настояла не бросать след у каменного льва.',
    is_viewer: true,
  },
  { id: 'hero:ren', name: 'Рен', class_name: 'плут', is_viewer: false },
]

const baseNpcs = [
  {
    id: 'npc:mira',
    name: 'Мира',
    role: 'хозяйка трактира',
    public_summary: 'Двадцать лет знает путников северного тракта.',
    voice: 'Живая разговорная манера.',
    speech_profile: {
      pace: 'быстро, короткими фразами',
      lexicon: 'простые дорожные слова и прибаутки',
      mannerism: 'важную мысль начинает словами «Ну-ка»',
    },
    relationship: 'friendly',
  },
  {
    id: 'npc:borin',
    name: 'Борин',
    role: 'архивариус заставы',
    public_summary: 'Сверяет каждое свидетельство с журналом ворот.',
    voice: 'Сдержанная осведомлённая манера.',
    speech_profile: {
      pace: 'медленно, с заметными паузами',
      lexicon: 'книжные и точные слова',
      mannerism: 'перед выводом говорит «Заметьте»',
    },
    relationship: 'neutral',
  },
]

const baseQuest = {
  title: 'Пропавший караван',
  summary: 'Караван из Волчьего брода исчез за Северными воротами.',
  objectives: ['Сверить след синей нити', 'Узнать, кто открыл старую заставу'],
}

function storyContext(overrides = {}) {
  return {
    active_quests: [baseQuest],
    active_threads: [{
      title: 'Сгоревшая мельница',
      summary: 'Ночью у мельницы видели телегу с меткой каравана.',
    }],
    recent_summaries: [
      {
        id: 'summary:n-minus-2',
        kind: 'scene',
        title: 'Каменный лев',
        summary: 'Две сцены назад Рен перевязал сломанную печать синей нитью у каменного льва.',
      },
      {
        id: 'summary:n-minus-1',
        kind: 'scene',
        title: 'Северный тракт',
        summary: 'След телеги привёл отряд обратно к воротам.',
      },
    ],
    recent_decisions: [{
      title: 'Каменный лев',
      location: 'Северный тракт',
      objective: 'Не бросать след',
      outcome: 'Ада настояла сохранить синюю нить как улику.',
    }],
    heroes: baseHeroes,
    present_npcs: baseNpcs,
    open_promises: [{
      npc: 'Мира',
      direction: 'npc_to_party',
      text: 'Мира обещала оставить карту старых троп под медной кружкой.',
      due_hint: 'к вечеру',
    }],
    recent_interactions: [{
      npc: 'Борин',
      hero: 'Рен',
      player_message: 'Кто дежурил в ночь пропажи?',
      npc_reply: 'После третьего колокола журнал заполнял сам начальник стражи.',
      stance: 'guarded',
    }],
    ...overrides,
  }
}

function environment(overrides = {}) {
  return {
    scene: {
      title: 'Тишина у Северных ворот',
      location: 'Северные ворота',
      mood: 'люди говорят вполголоса после тревоги',
      objective: 'Связать след у ворот с пропавшим караваном',
    },
    campaign_premise: {
      tone: 'приземлённое тёмное фэнтези без пафоса',
      premise: 'Пограничный город зависит от северного тракта.',
    },
    world_memory: {
      facts: [{
        id: 'fact:thread',
        subject: 'Засов Северных ворот',
        predicate: 'matching_trace',
        summary: 'На засове застряла такая же синяя нить, как у каменного льва.',
      }],
    },
    story_context: storyContext(),
    social_consequences: [],
    ...overrides,
  }
}

function event(eventType, payload, actorId = 'hero:ada', targetIds = []) {
  return {
    event_type: eventType,
    actor_id: actorId,
    target_ids: targetIds,
    payload,
    visibility: 'public',
    source_rule_ids: ['srd:ability-check'],
  }
}

const suggestionAnchors = [
  'мир[аеуыой]?', 'борин(?:а|у|ом)?', 'карава', 'северн.{0,24}ворот',
  'син(?:яя|ей|юю|ей)?\\s+нит', 'медн(?:ая|ой|ую)\\s+круж',
  'каменн(?:ый|ого|ому)\\s+льв', 'сгоревш(?:ая|ей|ую)\\s+мельниц',
  'начальник.{0,16}страж', 'трет(?:ий|ьего)\\s+колокол',
]
const forwardAnchors = ['карава', 'северн.{0,24}ворот', 'сгоревш.{0,16}мельниц', 'стар(?:ая|ой|ую)\\s+застав', 'след']
const personalAnchors = ['ад[аеуыой]?', 'проводниц', 'следопыт', 'решени', 'син(?:яя|ей|юю)?\\s+нит']

const NARRATOR_CASES = [
  {
    id: 'decision-n-minus-2',
    brief: buildNarrationBrief({
      visible_events: [event('AbilityCheckResolved', { ability: 'wis', success: true })],
      visible_state_changes: [],
      known_environment: environment(),
      permitted_npc_reactions: [],
      narration_constraints: [],
      viewer,
    }),
    memory_anchors: ['син(?:яя|ей|юю)?\\s+нит', 'каменн(?:ый|ого)\\s+льв', 'не\\s+броса.{0,20}след'],
  },
  {
    id: 'open-promise',
    brief: buildNarrationBrief({
      visible_events: [event('AbilityCheckResolved', { ability: 'int', success: true })],
      visible_state_changes: [],
      known_environment: environment({
        scene: {
          title: 'Стойка «Пустого кубка»',
          location: 'Трактир «Пустой кубок»',
          mood: 'посетители торопливо расходятся',
          objective: 'Забрать обещанную карту старых троп',
        },
      }),
      permitted_npc_reactions: [],
      narration_constraints: [],
      viewer,
    }),
    memory_anchors: ['медн(?:ая|ой|ую)\\s+круж', 'обеща.{0,28}карт', 'карт.{0,28}обеща'],
  },
  {
    id: 'past-meeting',
    brief: buildNarrationBrief({
      visible_events: [event('AbilityCheckResolved', { ability: 'cha', success: true })],
      visible_state_changes: [],
      known_environment: environment({
        world_memory: {
          facts: [{
            id: 'fact:watch',
            subject: 'Журнал ворот',
            predicate: 'missing_page',
            summary: 'Из журнала вырвана страница после третьего колокола.',
          }],
        },
      }),
      permitted_npc_reactions: [],
      narration_constraints: [],
      viewer,
    }),
    memory_anchors: ['трет(?:ий|ьего)\\s+колокол', 'борин.{0,32}журнал', 'начальник.{0,20}страж'],
  },
  {
    id: 'forward-hook',
    brief: buildNarrationBrief({
      visible_events: [event('AbilityCheckResolved', { ability: 'dex', success: false })],
      visible_state_changes: [],
      known_environment: environment({
        scene: {
          title: 'Двор сгоревшей мельницы',
          location: 'Сгоревшая мельница',
          mood: 'в золе ещё видны свежие колеи',
          objective: 'Понять, куда ушла телега с меткой каравана',
        },
      }),
      permitted_npc_reactions: [],
      narration_constraints: [],
      viewer,
    }),
    memory_anchors: [],
  },
]

function socialState() {
  return {
    scene: {
      title: 'Тишина у Северных ворот',
      location: 'Северные ворота',
      mood: 'настороженно',
      objective: 'Узнать, кто открыл старую заставу',
    },
    players: [
      { id: 'hero:ada', character: 'Ада', characterClass: 'ranger', background: 'бывшая проводница караванов' },
      { id: 'hero:ren', character: 'Рен', characterClass: 'rogue' },
    ],
    campaignConcept: {
      tone: 'приземлённое тёмное фэнтези без пафоса',
      premise: 'Пограничный город зависит от северного тракта.',
    },
    worldMemory: {
      entities: [
        { id: 'npc:mira', kind: 'npc', name: 'Мира', summary: 'Хозяйка трактира.', visibility: 'party' },
        { id: 'npc:borin', kind: 'npc', name: 'Борин', summary: 'Архивариус заставы.', visibility: 'party' },
        { id: 'location:gates', kind: 'location', name: 'Северные ворота', summary: 'Старая застава.', visibility: 'party' },
      ],
      facts: [{
        id: 'fact:watch',
        subject_id: 'location:gates',
        predicate: 'witnessed',
        object: 'Начальник стражи открыл ворота после третьего колокола.',
        summary: 'Начальник стражи открыл ворота после третьего колокола.',
        visibility: 'party',
        status: 'active',
        source_event_ids: ['event:watch'],
        recorded_at_minutes: 0,
      }],
      relationships: [],
      quests: [],
      threads: [],
      epistemic_claims: [],
      summaries: [],
      knowledge_ledger: [],
    },
    social: {
      npcs: baseNpcs.map((npc) => ({
        ...npc,
        location: 'Северные ворота',
        known_fact_ids: ['fact:watch'],
        visibility: 'party',
        available: true,
      })),
      relationships: { 'npc:mira': { 'hero:ada': 25 }, 'npc:borin': { 'hero:ada': 0 } },
      promises: [],
      conversations: [],
    },
  }
}

const replayIndex = args.indexOf('--replay')
if (replayIndex >= 0) {
  const sourcePathArgument = args[replayIndex + 1]
  if (!sourcePathArgument) throw new Error('--replay требует путь к сохранённому JSON-отчёту')
  const sourcePath = resolve(sourcePathArgument)
  const sourceBytes = readFileSync(sourcePath)
  const sourceReport = JSON.parse(sourceBytes.toString('utf8'))
  const sourceSamples = Array.isArray(sourceReport.samples) ? sourceReport.samples : []
  const sourceById = new Map(sourceSamples.map((sample) => [sample?.id, sample]))
  const sourceNarratorSamples = sourceSamples.filter((sample) => sample?.kind === 'narrator')
  const sourceOutputKind = (sample) => String(sample?.provider ?? '').startsWith('deterministic')
    ? 'deterministic-fallback'
    : 'provider-model'
  const sourceOutputMix = {
    provider_model: sourceNarratorSamples.filter((sample) => sourceOutputKind(sample) === 'provider-model').length,
    deterministic_fallback: sourceNarratorSamples.filter((sample) => sourceOutputKind(sample) === 'deterministic-fallback').length,
  }
  const sourceProviderModelMetrics = measureNarratorCraft(sourceSamples.filter((sample) => (
    sample?.kind !== 'narrator' || sourceOutputKind(sample) === 'provider-model'
  )))
  const samples = []
  const recentNarrations = []

  class SavedFinalOutputReplayClient {
    constructor(sample) {
      this.sample = sample
      this.calls = 0
    }

    async completeJson() {
      this.calls += 1
      if (this.calls > 1) throw new Error('Narrator v5 не должен делать второй provider-вызов')
      return {
        narration: String(this.sample?.text ?? ''),
        suggestions: Array.isArray(this.sample?.suggestions) ? [...this.sample.suggestions] : [],
      }
    }
  }

  for (const scenario of NARRATOR_CASES) {
    const sourceSample = sourceById.get(scenario.id)
    if (!sourceSample || sourceSample.kind !== 'narrator') {
      throw new Error(`В исходном отчёте нет narrator-сценария ${scenario.id}`)
    }
    const client = new SavedFinalOutputReplayClient(sourceSample)
    const narrator = new Narrator({ llmClient: client })
    const result = await narrator.render(scenario.brief, {
      knownRuleIds: ['srd:ability-check'],
      recentNarrations,
    })
    const asyncFeedback = await narrator.awaitFeedback(result.narration)
    samples.push({
      id: scenario.id,
      kind: 'narrator',
      text: result.narration,
      suggestions: result.suggestions,
      memory_anchors: scenario.memory_anchors,
      specific_anchors: suggestionAnchors,
      forward_anchors: forwardAnchors,
      personal_anchors: personalAnchors,
      provider: result.provider,
      prompt_version: result.prompt_version,
      verification: result.verification,
      async_feedback: asyncFeedback,
      replay_source: {
        stage: 'saved-final-production-output-as-offline-candidate',
        source_output_kind: sourceOutputKind(sourceSample),
        text_sha256: sha256(String(sourceSample.text ?? '')),
        suggestions_sha256: sha256(JSON.stringify(Array.isArray(sourceSample.suggestions) ? sourceSample.suggestions : [])),
        provider: sourceSample.provider ?? null,
        prompt_version: sourceSample.prompt_version ?? null,
        offline_pipeline_attempts: client.calls,
        saved_final_source_outputs_available: 1,
        repair_model_outputs_available: 0,
      },
    })
    recentNarrations.push(result.narration)
    if (recentNarrations.length > 3) recentNarrations.shift()
  }

  for (const sourceSample of sourceSamples.filter((sample) => sample?.kind !== 'narrator')) {
    samples.push({
      ...sourceSample,
      replay_source: {
        stage: 'unchanged-non-narrator-output',
        text_sha256: sha256(String(sourceSample.text ?? '')),
      },
    })
  }

  const report = {
    schema_version: 3,
    label: textOption('--label', 'production-single-pass-after-offline-replay'),
    date: new Date().toISOString(),
    live_calls: 0,
    tokens: { input: 0, output: 0 },
    provider_log: [],
    provenance: {
      method: 'offline-replay-current-production-single-pass-path',
      source_path: sourcePathArgument.replaceAll('\\', '/'),
      source_sha256: sha256(sourceBytes),
      source_json_sha256: sha256(JSON.stringify(sourceReport)),
      source_schema_version: sourceReport.schema_version ?? null,
      source_label: sourceReport.label ?? null,
      source_date: sourceReport.date ?? null,
      source_live_calls: sourceReport.live_calls ?? null,
      source_tokens: sourceReport.tokens ?? null,
      replay_prompt_version: NARRATOR_PROMPT_VERSION,
      replay_max_attempts: 1,
      source_outputs_are_final_production_outputs: true,
      source_narrator_output_mix: sourceOutputMix,
      source_all_final_outputs_ngram_jaccard_pct: sourceReport.metrics?.ngram_overlap?.pairwise_jaccard_pct ?? null,
      source_provider_model_only_ngram: {
        narrator_samples: sourceProviderModelMetrics.ngram_overlap.narrator_samples,
        pairwise_jaccard_pct: sourceProviderModelMetrics.ngram_overlap.pairwise_jaccard_pct,
      },
      saved_final_source_outputs_per_narrator_scenario: 1,
      repair_model_outputs_replayed: 0,
      recent_narration_window: 3,
      narrator_scenarios_replayed: NARRATOR_CASES.length,
      non_narrator_samples_copied_unchanged: samples.length - NARRATOR_CASES.length,
      network_calls: 0,
      implementation_sha256_normalized_lf: {
        narrator_module: normalizedTextSha256(new URL('../server/narrator.mjs', import.meta.url)),
        narrator_prompt: normalizedTextSha256(new URL('../prompts/narrator/v6.txt', import.meta.url)),
        metrics_module: normalizedTextSha256(new URL('./narrator-craft-metrics.mjs', import.meta.url)),
        replay_runner: normalizedTextSha256(new URL(import.meta.url)),
      },
      note: 'Источник хранит финальные production outputs: три provider model outputs и один прежний deterministic-fallback. Offline harness подаёт каждый текст как единственный candidate narrator/v6. Авторитетные нарушения по-прежнему дают deterministic-fallback, но художественные замечания не запускают repair: они записаны в async_feedback и предназначены для следующего хода.',
    },
    samples,
    metrics: measureNarratorCraft(samples),
  }
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
  printMetricLine(report.label.toUpperCase(), report.metrics)
  console.log(`Offline replay: 0 provider-вызовов; source SHA-256 ${report.provenance.source_sha256}`)
  console.log(`Отчёт: ${OUTPUT}`)
  process.exit(0)
}

if (!process.env.ROUTERAI_API_KEY) {
  console.error('ROUTERAI_API_KEY не настроен — живой craft-eval невозможен.')
  process.exit(1)
}

const client = productionChainClient()
// Один вызов на сцену: безопасность отдельно держат unit-тесты, а bounded
// craft-eval не должен тратить второй платный вызов на ремонт формулировки.
const narrator = new Narrator({ llmClient: client, maxAttempts: 1 })
const npcController = new NpcSocialController({ llmClient: client })
const samples = []
const recentNarrations = []

for (const scenario of NARRATOR_CASES) {
  const started = performance.now()
  const result = await narrator.render(scenario.brief, {
    knownRuleIds: ['srd:ability-check'],
    recentNarrations,
  })
  const asyncFeedback = await narrator.awaitFeedback(result.narration)
  samples.push({
    id: scenario.id,
    kind: 'narrator',
    text: result.narration,
    suggestions: result.suggestions,
    memory_anchors: scenario.memory_anchors,
    specific_anchors: suggestionAnchors,
    forward_anchors: forwardAnchors,
    personal_anchors: personalAnchors,
    provider: result.provider,
    prompt_version: result.prompt_version,
    verification: result.verification,
    async_feedback: asyncFeedback,
    latency_ms: Math.round(performance.now() - started),
  })
  recentNarrations.push(result.narration)
  if (recentNarrations.length > 3) recentNarrations.shift()
}

for (const voice of [
  { id: 'voice-mira', npcId: 'npc:mira', markers: ['ну-ка', 'милок', 'дорожн.{0,12}слов', 'прибаут'] },
  { id: 'voice-borin', npcId: 'npc:borin', markers: ['заметьте', 'полагаю', 'следует', 'однако'] },
]) {
  const started = performance.now()
  const result = await npcController.respond({
    state: socialState(),
    playerId: 'hero:ada',
    npcId: voice.npcId,
    message: 'Кто открыл ворота после третьего колокола?',
    turnId: `craft-${LABEL}-${voice.id}`,
  })
  samples.push({
    id: voice.id,
    kind: 'npc',
    text: result.reply,
    suggestions: [],
    voice_pair: 'gates-dialogue',
    voice_markers: voice.markers,
    provider: result.provider,
    latency_ms: Math.round(performance.now() - started),
  })
}

const report = {
  schema_version: 1,
  label: LABEL,
  date: new Date().toISOString(),
  primary_model: process.env.DND_AI_MODEL ?? 'deepseek/deepseek-v4-flash',
  reasoning_effort: process.env.DND_AI_REASONING_EFFORT ?? 'по умолчанию модели',
  model_timeout_ms: Number(process.env.DND_AI_MODEL_TIMEOUT_MS) || 9_000,
  live_calls: meter.calls,
  tokens: meter.usage,
  provider_log: meter.log,
  samples,
  metrics: measureNarratorCraft(samples),
}

writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
printMetricLine(LABEL.toUpperCase(), report.metrics)
console.log(`Живых provider-вызовов: ${report.live_calls}; токены: ${report.tokens.input}+${report.tokens.output}`)
for (const sample of samples) {
  console.log(`  ${sample.id}: ${sample.provider}, ${sample.latency_ms} ms — «${sample.text.slice(0, 120)}»`)
}
console.log(`Отчёт: ${OUTPUT}`)
