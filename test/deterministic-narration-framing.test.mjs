import assert from 'node:assert/strict'
import test from 'node:test'

import { deterministicNarration } from '../server/narrator.mjs'
import { actorNameResolver } from '../server/rules-engine.mjs'
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

test('скудный механический исход остаётся коротким и не получает атмосферу', () => {
  const { narration } = deterministicNarration(brief({ events: [CHECK_EVENT], story: STORY }))
  assert.equal(narration, 'Проверка «Харизма» завершилась успехом.')
  assert.doesNotMatch(narration, /\d/u, 'числа проверки уже видны в интерфейсе')
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

test('запасной текст называет героя по имени, а не служебным идентификатором', () => {
  const fallen = buildNarrationBrief({
    visible_events: [{
      event_type: 'HitPointsReducedToZero', actor_id: 'enemy:wolf', target_ids: ['hero'],
      payload: { target_id: 'hero' }, visibility: 'public', source_rule_ids: ['srd:zero-hp'],
    }],
    visible_state_changes: [],
    known_environment: {
      scene: { location: 'Северные ворота', mood: 'отчаянно' },
      // Форма критического момента: имена приходят в participants, а не в story_context.
      participants: { heroes: [{ id: 'hero', name: 'Ада' }], enemies: [{ id: 'enemy:wolf', name: 'Матёрый волк' }] },
    },
    permitted_npc_reactions: [], narration_constraints: [],
  })
  const { narration } = deterministicNarration(fallen)
  assert.match(narration, /Ада/u)
  assert.doesNotMatch(narration, /\bhero\b/u, 'служебный идентификатор не должен доезжать до игрока')
})

test('шаг Режиссёра «открыть разговор» звучит по-русски и с именем NPC, а не именем события', () => {
  const opened = buildNarrationBrief({
    visible_events: [{
      event_type: 'SocialSceneOpened', actor_id: null, target_ids: ['npc-finn'],
      payload: { npc_id: 'npc-finn', server_check_required: true }, visibility: 'party', source_rule_ids: [],
    }],
    visible_state_changes: [], known_environment: {}, permitted_npc_reactions: [], narration_constraints: [],
  })
  const resolver = actorNameResolver({ social: { npcs: [{ id: 'npc-finn', name: 'Старый Финн' }] } })
  const { narration } = deterministicNarration(opened, resolver)
  assert.match(narration, /Старый Финн неподалёку — можно заговорить/u)
  assert.doesNotMatch(narration, /SocialSceneOpened|npc-finn/u)
})

// Живой прогон Асстохана 2026-10-07: «Вея Тихая Река занимает пост в сцене.
// Вея Тихая Река рядом — самое время заговорить». Появление и приглашение о
// том же NPC — одна фраза, без языка движка.
test('появление NPC и приглашение к разговору с ним звучат одной фразой', () => {
  const opened = buildNarrationBrief({
    visible_events: [
      { event_type: 'NpcPlaced', actor_id: null, target_ids: ['npc-finn'], payload: { npc_id: 'npc-finn', npc_name: 'Старый Финн' }, visibility: 'party', source_rule_ids: [] },
      { event_type: 'SocialSceneOpened', actor_id: null, target_ids: ['npc-finn'], payload: { npc_id: 'npc-finn' }, visibility: 'party', source_rule_ids: [] },
    ],
    visible_state_changes: [], known_environment: {}, permitted_npc_reactions: [], narration_constraints: [],
  })
  const resolver = actorNameResolver({ social: { npcs: [{ id: 'npc-finn', name: 'Старый Финн' }] } })
  const { narration } = deterministicNarration(opened, resolver)
  assert.equal(narration.match(/Старый Финн/gu)?.length, 1, narration)
  assert.doesNotMatch(narration, /занимает пост|в сцене/u)
})

test('событие без русской строки молчит, а не печатает игроку служебное имя', () => {
  const internal = buildNarrationBrief({
    visible_events: [
      { event_type: 'SomeInternalBookkeeping', actor_id: null, target_ids: [], payload: {}, visibility: 'party', source_rule_ids: [] },
      { event_type: 'WorldEntityUpserted', actor_id: null, target_ids: [], payload: { entity: { id: 'e1', name: 'Причал' } }, visibility: 'party', source_rule_ids: [] },
    ],
    visible_state_changes: [], known_environment: {}, permitted_npc_reactions: [], narration_constraints: [],
  })
  const { narration } = deterministicNarration(internal)
  assert.doesNotMatch(narration, /SomeInternalBookkeeping|World entity updated/u)
  assert.match(narration, /[А-Яа-яЁё]/u, 'ход всё равно получает осмысленную русскую строку')
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
