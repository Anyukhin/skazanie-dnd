import assert from 'node:assert/strict'
import test from 'node:test'

import { deterministicNarration } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

// Боевой плейтест 2026-10-03: запасной рассказчик после хода ветерана сказал
// «summon-hero-slot-acb-a-feb6dfba завершает ход. Начинается ход Воитель-
// ветеран…», а то, что воин упал без сознания, в четыре фразы не влезло.

const SUMMON_ID = 'summon-hero-slot-1-a87423c4-4919-44b2-a767-fc7ebf3df6ba-1'
const event = (event_type, actor_id, target_ids = [], payload = {}) => ({
  event_type, actor_id, target_ids, payload, visibility: 'public', source_rule_ids: ['srd:combat'],
})

function brief(events) {
  return buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: {
      scene: { title: 'Окраина', location: 'Пограничный город', mood: 'тревожно' },
      story_context: {
        active_quests: [], active_threads: [], recent_summaries: [], open_promises: [], present_npcs: [],
        heroes: [{ id: 'fighter', name: 'Торвальд' }],
      },
      participants: { heroes: [{ id: 'fighter', name: 'Торвальд' }], enemies: [{ id: 'veteran', name: 'Ветеран' }] },
    },
    permitted_npc_reactions: [],
    narration_constraints: [],
  })
}

const ENEMY_TURN = [
  event('TurnEnded', SUMMON_ID),
  event('TurnStarted', 'veteran', ['veteran']),
  event('ActorMoved', 'veteran'),
  event('AttackResolved', 'veteran', ['fighter'], { hit: true }),
  event('DieRolled', 'veteran'),
  event('DamageApplied', 'veteran', ['fighter'], { applied_amount: 34 }),
  event('HitPointsReducedToZero', 'veteran', ['fighter'], { condition: 'unconscious', successes: 0, failures: 0 }),
  event('TurnEnded', 'veteran'),
]

test('неизвестный брифу призыв не попадает в рассказ сырым идентификатором', () => {
  const { narration } = deterministicNarration(brief([event('TurnEnded', SUMMON_ID)]))
  assert.doesNotMatch(narration, /summon|hero-slot/u)
  assert.match(narration, /Участник завершает ход/u)
})

test('падение героя без сознания звучит, а служебные события уступают ему место', () => {
  const { narration } = deterministicNarration(brief(ENEMY_TURN))
  assert.match(narration, /Торвальд падает без сознания/u)
  assert.doesNotMatch(narration, /завершает ход|Начинается ход|Бросок завершён/u)
})

test('ход времени не оставляет обрубка «Проходит сек.»', () => {
  const { narration } = deterministicNarration(brief([
    event('TimeAdvanced', 'fighter', [], { amount: 6, unit: 'second' }),
    event('AttackResolved', 'veteran', ['fighter'], { hit: true }),
  ]))
  assert.doesNotMatch(narration, /Проходит/u)
  assert.match(narration, /Ветеран поражает Торвальд/u)
})

test('враг на нуле выбывает из боя, а смерть рассказчик не объявляет', () => {
  const { narration } = deterministicNarration(brief([
    event('HitPointsReducedToZero', 'fighter', ['veteran'], { condition: 'unconscious' }),
  ]))
  assert.match(narration, /Ветеран выбывает из боя/u)
  assert.doesNotMatch(narration, /погиб|умер|мёртв|убит/iu)
})
