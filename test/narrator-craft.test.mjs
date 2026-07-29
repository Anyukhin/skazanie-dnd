import assert from 'node:assert/strict'
import test from 'node:test'

import { measureNarratorCraft } from '../eval/narrator-craft-metrics.mjs'
import {
  NARRATOR_PROMPT_VERSION,
  Narrator,
  deterministicNarration,
  narratorMemoryFocus,
  narratorSuggestions,
} from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

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

test('сервер заменяет общие suggestions на крючок вперёд и личную идею', async () => {
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
  assert.equal(result.suggestions.length, 2)
  assert.ok(result.suggestions.every((entry) => entry.length <= 120))
  assert.ok(result.suggestions.some((entry) => /Мир/u.test(entry) && /син|караван/u.test(entry)), result.suggestions)
  assert.ok(result.suggestions.some((entry) => /Ада/u.test(entry) && /проводниц/u.test(entry)), result.suggestions)
  assert.doesNotMatch(result.suggestions.join('\n'), /^(?:Осмотреться|Идти дальше|Продолжить)$/mu)

  const systemPrompt = requests[0].messages[0].content
  assert.match(systemPrompt, /PROMPT_ID: narrator\/v3/u)
  assert.match(systemPrompt, /не используй каталог клише/u)
  assert.match(systemPrompt, /не называй видимые числа броска/u)
  assert.match(requests[0].messages[1].content, /"memory_focus"/u)
  assert.match(requests[0].messages[1].content, /Ада сохранила синюю нить как улику/u)
})

test('контекстные модельные suggestions сохраняются без потери двух ролей', () => {
  const suggestions = [
    'Спросить Миру о синей нити из пропавшего каравана',
    'Ада: применить опыт проводницы к следу у синей нити',
    'Сверить синюю нить с отметиной у Трактира «Пустой кубок»',
  ]
  assert.deepEqual(narratorSuggestions(craftBrief(), suggestions), suggestions.slice(0, 2))
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
      narration: 'Мира кивает на кружку: обещанное уже на месте. Ада проверяет карту.',
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
