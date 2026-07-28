import assert from 'node:assert/strict'
import test from 'node:test'

import { deterministicNarration } from '../server/narrator.mjs'
import { buildNarrationBrief, verifyNarration } from '../server/security.mjs'

function brief({ events = [], scene = {}, story = null } = {}) {
  return buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: {
      scene: { title: 'Вечер в «Пустом кубке»', location: 'Трактир «Пустой кубок»', mood: 'настороженно', ...scene },
      ...(story ? { story_context: story } : {}),
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

const STORY = {
  active_quests: [{ title: 'Пропавший караван', summary: 'Караван не дошёл до города.', objectives: [] }],
  active_threads: [], recent_summaries: [], heroes: [{ id: 'hero', name: 'Ада' }],
  present_npcs: [{ id: 'npc:mira', name: 'Мира', role: 'хозяйка', public_summary: '', voice: '', relationship: 'friendly' }],
  open_promises: [],
}

const CHECK_EVENT = {
  event_type: 'AbilityCheckResolved', actor_id: 'hero', target_ids: [],
  payload: { ability: 'cha', total: 15, difficulty: 12, success: true },
  visibility: 'public', source_rule_ids: ['srd:ability-check'],
}

test('пустой ход без модели больше не выглядит отказом игры', () => {
  const { narration } = deterministicNarration(brief({ story: STORY }))
  assert.match(narration, /Трактир «Пустой кубок», настороженно\./u)
  assert.match(narration, /Рядом Мира\./u)
  assert.match(narration, /Пропавший караван/u)
  assert.doesNotMatch(narration, /механических последствий/u)
})

test('обрамление добавляется и к механическому исходу, не заменяя его', () => {
  const { narration } = deterministicNarration(brief({ events: [CHECK_EVENT], story: STORY }))
  assert.match(narration, /Трактир «Пустой кубок»/u)
  assert.match(narration, /15/u, 'подтверждённый исход обязан остаться в тексте')
})

test('без story_context и сцены текст остаётся осмысленным', () => {
  const bare = buildNarrationBrief({
    visible_events: [], visible_state_changes: [], known_environment: {},
    permitted_npc_reactions: [], narration_constraints: [],
  })
  const { narration } = deterministicNarration(bare)
  assert.equal(narration, 'Пока ничего не меняется: следующий шаг за отрядом.')
})

test('текст детерминирован: тот же brief даёт ту же строку', () => {
  const first = deterministicNarration(brief({ events: [CHECK_EVENT], story: STORY })).narration
  const second = deterministicNarration(brief({ events: [CHECK_EVENT], story: STORY })).narration
  assert.equal(first, second)
})

test('обрамление не нарушает собственный Verifier — иначе отказ модели портил бы трассу', () => {
  for (const constraints of [[], ['no-unconfirmed-world-changes']]) {
    const value = buildNarrationBrief({
      visible_events: [], visible_state_changes: [],
      known_environment: { scene: { location: 'Трактир «Пустой кубок»', mood: 'настороженно' }, story_context: STORY },
      permitted_npc_reactions: [], narration_constraints: constraints,
    })
    const { narration } = deterministicNarration(value)
    const verification = verifyNarration(narration, value)
    assert.equal(verification.valid, true, `${JSON.stringify(constraints)}: ${JSON.stringify(verification.violations)}`)
  }
})
