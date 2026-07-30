import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { measureNarratorCraft } from '../eval/narrator-craft-metrics.mjs'
import {
  NARRATOR_PROMPT_VERSION,
  Narrator,
  deterministicNarration,
  narratorMemoryFocus,
} from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

function craftBrief() {
  return buildNarrationBrief({
    visible_events: [],
    visible_state_changes: [],
    known_environment: {
      scene: {
        title: 'Вечер в «Пустом кубке»',
        location: 'Трактир «Пустой кубок»',
        objective: 'Узнать, куда пропал караван',
      },
      world_memory: {
        facts: [{
          subject: 'синяя нить',
          summary: 'Синяя нить найдена на телеге пропавшего каравана.',
        }],
      },
      story_context: {
        active_quests: [{
          title: 'Пропавший караван',
          summary: 'Караван из Волчьего брода исчез у Северных ворот.',
          objectives: ['Сверить след синей нити'],
        }],
        active_threads: [],
        recent_summaries: [],
        recent_decisions: [{
          title: 'Каменный лев',
          location: 'Северный тракт',
          objective: 'Не бросать след',
          outcome: 'Ада сохранила синюю нить как улику.',
        }],
        heroes: [{
          id: 'hero:ada',
          name: 'Ада',
          is_viewer: true,
          class_name: 'следопыт',
          background: 'бывшая проводница караванов',
        }],
        present_npcs: [{
          id: 'npc:mira',
          name: 'Мира',
          role: 'хозяйка трактира',
          public_summary: 'Знает путников северного тракта.',
          voice: 'Говорит быстро.',
          speech_profile: {
            pace: 'быстро, короткими фразами',
            lexicon: 'дорожные слова',
            mannerism: 'начинает важную мысль со слов «Ну-ка»',
          },
          relationship: 'friendly',
        }],
        open_promises: [],
        recent_interactions: [],
      },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

test('сервер не сохраняет предложенные моделью варианты действий', async () => {
  const brief = craftBrief()
  const requests = []
  const llmClient = {
    completeJson: async (input) => {
      requests.push(input)
      return {
        narration: deterministicNarration(brief).narration,
        suggestions: ['Осмотреться', 'Идти дальше', 'Продолжить'],
      }
    },
  }
  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

  assert.equal(result.prompt_version, NARRATOR_PROMPT_VERSION)
  assert.equal(result.verification.valid, true)
  assert.equal(Object.hasOwn(result, 'suggestions'), false)

  const systemPrompt = requests[0].messages[0].content
  assert.match(systemPrompt, /PROMPT_ID: narrator\/v4/u)
  assert.match(systemPrompt, /не используй каталог клише/u)
  assert.match(systemPrompt, /не называй видимые числа броска/u)
  assert.doesNotMatch(systemPrompt, /"suggestions"/u)
  assert.match(requests[0].messages[1].content, /"memory_focus"/u)
  assert.match(requests[0].messages[1].content, /Ада сохранила синюю нить как улику/u)
})

test('memory_focus выбирает N-2, обещание и прошлую встречу по явной связи сцены', () => {
  const rich = craftBrief()
  const story = rich.known_environment.story_context
  story.recent_summaries = [
    {
      id: 'summary:n-minus-2', title: 'Каменный лев',
      summary: 'Рен перевязал сломанную печать синей нитью у каменного льва.',
    },
    {
      id: 'summary:n-minus-1', title: 'Северный тракт',
      summary: 'След телеги привёл отряд обратно к воротам.',
    },
  ]
  story.open_promises = [{
    npc: 'Мира',
    text: 'Мира обещала оставить карту старых троп под медной кружкой.',
    due_hint: 'к вечеру',
  }]
  story.recent_interactions = [{
    npc: 'Борин',
    player_message: 'Кто дежурил в ночь пропажи?',
    npc_reply: 'После третьего колокола журнал заполнял начальник стражи.',
  }]
  rich.known_environment.world_memory.facts = [{
    subject: 'Засов Северных ворот',
    summary: 'На засове застряла такая же синяя нить, как у каменного льва.',
  }]

  assert.equal(narratorMemoryFocus(rich).kind, 'summary')
  assert.equal(narratorMemoryFocus(rich).source_id, 'summary:n-minus-2')

  const promiseBrief = structuredClone(rich)
  promiseBrief.known_environment.scene.objective = 'Забрать обещанную карту старых троп'
  assert.equal(narratorMemoryFocus(promiseBrief).kind, 'promise')

  const meetingBrief = structuredClone(rich)
  meetingBrief.known_environment.world_memory.facts = [{
    subject: 'Журнал ворот',
    summary: 'Из журнала вырвана страница после третьего колокола.',
  }]
  assert.equal(narratorMemoryFocus(meetingBrief).kind, 'interaction')
})

test('локальная craft-проверка блокирует действия героев, реакции NPC и мнимое исполнение обещания', async () => {
  const brief = craftBrief()
  brief.known_environment.story_context.open_promises = [{
    npc: 'Мира',
    text: 'Мира обещала оставить карту старых троп под медной кружкой.',
  }]
  const llmClient = {
    completeJson: async () => ({
      narration: 'Карта лежит под медной кружкой. Мира кивает. Ада проверяет карту.',
      suggestions: [],
    }),
  }
  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

  assert.equal(result.provider, 'deterministic-fallback')
  assert.equal(result.verification.valid, true)
  assert.doesNotMatch(result.narration, /кивает|на месте|Ада проверяет/u)
  assert.deepEqual(
    new Set(result.verification.repaired_from.map((entry) => entry.code)),
    new Set([
      'HERO_AGENCY_NOT_IN_BRIEF',
      'NPC_REACTION_NOT_PERMITTED',
      'PROMISE_RESOLUTION_NOT_IN_BRIEF',
      'LINKED_MEMORY_OMITTED',
    ]),
  )
})

test('craft-проверка сверяет каждую реакцию NPC с непустым allowlist и её описанием', async () => {
  const brief = craftBrief()
  brief.known_environment.story_context.present_npcs.push({
    id: 'npc:borin',
    name: 'Борин',
    role: 'начальник стражи',
    public_summary: 'Следит за порядком.',
    voice: 'Говорит отрывисто.',
    speech_profile: { pace: '', lexicon: '', mannerism: '' },
    relationship: 'neutral',
  })
  brief.permitted_npc_reactions = [{
    npc_id: 'npc:mira',
    name: 'Мира',
    reaction: 'attentive',
    description: 'молча наблюдает за разговором',
  }]
  const llmClient = {
    completeJson: async () => ({
      narration: `${deterministicNarration(brief).narration} Мира кивает. Борин улыбается.`,
      suggestions: [],
    }),
  }

  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

  assert.equal(result.provider, 'deterministic-fallback')
  assert.deepEqual(
    new Set(result.verification.repaired_from.map((entry) => entry.code)),
    new Set(['NPC_REACTION_MISMATCH', 'NPC_REACTION_NOT_PERMITTED']),
  )
})

test('craft-проверка принимает реакцию NPC, совпадающую с allowlist', async () => {
  const brief = craftBrief()
  brief.permitted_npc_reactions = [{
    npc_id: 'npc:mira',
    name: 'Мира',
    reaction: 'attentive',
    description: 'молча наблюдает за разговором',
  }]
  const llmClient = {
    completeJson: async () => ({
      narration: `${deterministicNarration(brief).narration} Мира молча наблюдает за разговором.`,
      suggestions: [],
    }),
  }

  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

  assert.equal(result.provider, 'Object')
  assert.equal(result.verification.valid, true, JSON.stringify(result.verification))
})

test('craft-проверка отклоняет реакцию выдуманного имени при непустом allowlist', async () => {
  const brief = craftBrief()
  brief.permitted_npc_reactions = [{
    npc_id: 'npc:mira',
    name: 'Мира',
    reaction: 'attentive',
    description: 'молча наблюдает за разговором',
  }]
  const llmClient = {
    completeJson: async () => ({
      narration: `${deterministicNarration(brief).narration} Селин кивает.`,
      suggestions: [],
    }),
  }

  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

  assert.equal(result.provider, 'deterministic-fallback')
  assert.ok(result.verification.repaired_from
    .some((entry) => entry.code === 'NPC_REACTION_NOT_PERMITTED'))
})

test('lexical craft-guard блокирует явные действия героя с дверью и уходом', async () => {
  for (const action of [
    'Ада отпирает дверь и уходит.',
    'Ада закрывает ставни и выходит во двор.',
  ]) {
    const brief = craftBrief()
    const llmClient = {
      completeJson: async () => ({
        narration: `${deterministicNarration(brief).narration} ${action}`,
        suggestions: [],
      }),
    }

    const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

    assert.equal(result.provider, 'deterministic-fallback', action)
    assert.ok(result.verification.repaired_from
      .some((entry) => entry.code === 'HERO_AGENCY_NOT_IN_BRIEF'), action)
  }
})

test('lexical craft-guard блокирует явный разворот и уход NPC вне allowlist', async () => {
  for (const reaction of [
    'Мира отворачивается и уходит.',
    'Мира встаёт и покидает трактир.',
  ]) {
    const brief = craftBrief()
    const llmClient = {
      completeJson: async () => ({
        narration: `${deterministicNarration(brief).narration} ${reaction}`,
        suggestions: [],
      }),
    }

    const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief)

    assert.equal(result.provider, 'deterministic-fallback', reaction)
    assert.ok(result.verification.repaired_from
      .some((entry) => entry.code === 'NPC_REACTION_NOT_PERMITTED'), reaction)
  }
})

test('craft-проверка отклоняет повтор недавнего текста, а fallback снижает тот же Jaccard 3-грамм', async () => {
  const brief = craftBrief()
  const recent = deterministicNarration(brief).narration
  const llmClient = {
    completeJson: async () => ({
      narration: recent,
      suggestions: [],
    }),
  }
  const result = await new Narrator({ llmClient, maxAttempts: 1 }).render(brief, {
    recentNarrations: [recent],
  })
  const metrics = measureNarratorCraft([
    { id: 'recent', kind: 'narrator', text: recent, suggestions: [] },
    { id: 'fallback', kind: 'narrator', text: result.narration, suggestions: [] },
  ])

  assert.equal(result.provider, 'deterministic-fallback')
  assert.equal(result.verification.valid, true, JSON.stringify(result.verification))
  assert.notEqual(result.narration, recent)
  assert.ok(
    result.verification.repaired_from.some((entry) => entry.code === 'RECENT_NARRATION_REPETITION'),
    result.verification.repaired_from,
  )
  assert.ok(metrics.ngram_overlap.pairwise_jaccard_pct <= 5, metrics.ngram_overlap)
})

test('offline safety replay не вызывает сеть, проходит production repair path и не выдаёт fallback за model repair', () => {
  const sourcePath = join(PROJECT_ROOT, 'eval', 'narrator-craft-after.json')
  const baselinePath = join(PROJECT_ROOT, 'eval', 'narrator-craft-baseline.json')
  const outputPath = join(mkdtempSync(join(tmpdir(), 'skazanie-narrator-replay-')), 'production-after.json')
  const sourceBefore = readFileSync(sourcePath)
  const sourceSha256 = createHash('sha256').update(sourceBefore).digest('hex')

  execFileSync(process.execPath, [
    join(PROJECT_ROOT, 'eval', 'narrator-craft-eval.mjs'),
    '--replay',
    sourcePath,
    '--label',
    'test-production-after',
    '--output',
    outputPath,
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ROUTERAI_API_KEY: '' },
    stdio: 'pipe',
  })

  const sourceAfter = readFileSync(sourcePath)
  const report = JSON.parse(readFileSync(outputPath, 'utf8'))
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const samples = new Map(report.samples.map((sample) => [sample.id, sample]))
  const promise = samples.get('open-promise')
  const meeting = samples.get('past-meeting')

  assert.equal(createHash('sha256').update(sourceAfter).digest('hex'), sourceSha256)
  assert.equal(report.provenance.source_sha256, sourceSha256)
  assert.equal(report.provenance.method, 'offline-replay-current-production-safety-path')
  assert.equal(report.provenance.replay_max_attempts, 2)
  assert.equal(report.provenance.source_outputs_are_final_production_outputs, true)
  assert.deepEqual(report.provenance.source_narrator_output_mix, {
    provider_model: 3,
    deterministic_fallback: 1,
  })
  assert.equal(report.provenance.source_all_final_outputs_ngram_jaccard_pct, 3.73)
  assert.deepEqual(report.provenance.source_provider_model_only_ngram, {
    narrator_samples: 3,
    pairwise_jaccard_pct: 6.41,
  })
  assert.equal(report.provenance.saved_final_source_outputs_per_narrator_scenario, 1)
  assert.equal(report.provenance.repair_model_outputs_replayed, 0)
  assert.match(report.provenance.note, /три принятых provider model outputs.+один.+deterministic-fallback/iu)
  assert.match(report.provenance.note, /финальный safety-output.+не качество model repair|не качество model repair.+финальный safety-output/iu)
  assert.equal(report.provenance.network_calls, 0)
  assert.equal(report.live_calls, 0)
  assert.deepEqual(report.provider_log, [])
  assert.ok(
    report.metrics.ngram_overlap.pairwise_jaccard_pct
      < baseline.metrics.ngram_overlap.pairwise_jaccard_pct,
    { before: baseline.metrics.ngram_overlap, after: report.metrics.ngram_overlap },
  )
  assert.equal(report.metrics.quality_gate.passed, true)
  const narratorSamples = report.samples.filter((sample) => sample.kind === 'narrator')
  assert.ok(narratorSamples.every((sample) => sample.verification?.valid === true))
  assert.ok(narratorSamples.every((sample) => sample.provider === 'deterministic-provider-fallback'))
  assert.ok(narratorSamples.every((sample) => (
    sample.verification?.provider_error === 'OFFLINE_REPLAY_REPAIR_OUTPUT_UNAVAILABLE'
    && sample.verification?.repaired_from?.length > 0
    && sample.replay_source?.offline_pipeline_attempts === 2
    && sample.replay_source?.stage === 'saved-final-production-output-as-offline-candidate'
  )))
  assert.equal(samples.get('forward-hook').replay_source.source_output_kind, 'deterministic-fallback')
  assert.ok(['decision-n-minus-2', 'open-promise', 'past-meeting']
    .every((id) => samples.get(id).replay_source.source_output_kind === 'provider-model'))

  for (const sourceSample of JSON.parse(sourceBefore.toString('utf8')).samples.filter((sample) => sample.kind !== 'narrator')) {
    const replayed = samples.get(sourceSample.id)
    assert.equal(replayed.text, sourceSample.text)
    assert.deepEqual(replayed.suggestions, sourceSample.suggestions)
    assert.equal(replayed.replay_source.stage, 'unchanged-non-narrator-output')
  }

  assert.match(promise.text, /обещал[а-яё]* оставить карту старых троп под медной кружкой/iu)
  assert.doesNotMatch(promise.text, /кива|на месте|Ада проверяет|доста[её]т|забира/iu)
  assert.match(promise.text, /успех/iu)
  assert.match(meeting.text, /после третьего колокола журнал заполнял сам начальник стражи/iu)
  assert.doesNotMatch(meeting.text, /кива|перелистыва/iu)
  assert.match(meeting.text, /успех/iu)
  assert.match(samples.get('decision-n-minus-2').text, /успех/iu)
  assert.match(samples.get('forward-hook').text, /неудач/iu)
})

test('craft-метрики измеряют клише, память, различимость голосов и конкретику', () => {
  const metrics = measureNarratorCraft([
    {
      id: 'narrator:one',
      kind: 'narrator',
      text: 'Повисает тишина, но синяя нить напоминает о сохранённой печати.',
      memory_anchors: ['синяя\\s+нить'],
      suggestions: ['Спросить Миру о синей нити', 'Ада: применить опыт проводницы к синей нити'],
      specific_anchors: ['Мир', 'син'],
      forward_anchors: ['Мир'],
      personal_anchors: ['Ада'],
    },
    {
      id: 'narrator:two',
      kind: 'narrator',
      text: 'След у ворот ведёт к Волчьему броду.',
      memory_anchors: [],
      suggestions: ['Проверить след у ворот'],
      specific_anchors: ['след', 'ворот'],
      forward_anchors: ['след'],
      personal_anchors: ['Рен'],
    },
    {
      id: 'voice:mira',
      kind: 'social',
      text: 'Ну-ка, путник, дорога сама правду не скажет.',
      voice_pair: 'tavern',
      voice_markers: ['Ну-ка'],
    },
    {
      id: 'voice:orin',
      kind: 'social',
      text: 'Заметьте: согласно записи, свидетельство требует сверки.',
      voice_pair: 'tavern',
      voice_markers: ['согласно\\s+записи'],
    },
  ])

  assert.equal(metrics.cliches.occurrences, 1)
  assert.equal(metrics.memory.recall_pct, 100)
  assert.equal(metrics.voices.distinct_pct, 100)
  assert.equal(metrics.suggestions.specific_pct, 100)
  assert.equal(metrics.suggestions.forward_coverage_pct, 100)
  assert.equal(metrics.suggestions.personal_coverage_pct, 50)
})
