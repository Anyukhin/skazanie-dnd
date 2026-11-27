import assert from 'node:assert/strict'
import test from 'node:test'

import { PROJECTED_STATE_KEYS, campaignStateForViewer } from '../server/viewer-projection.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

/**
 * Автономный слой — рабочая память Ведущего. До 2026-07-28 он уезжал игроку
 * целиком: заготовленные повороты сюжета, нераскрытые расписания NPC и
 * рассуждения Режиссёра. Раскрытие любого из них обесценивает игру ещё до
 * того, как она случилась.
 */

const SPOILER = 'СПОЙЛЕР-ПРЕДАТЕЛЬ-КАПИТАН-СТРАЖИ'
const SCHEDULE_SECRET = 'ТАЙНАЯ-ЯВКА-В-ПОДВАЛЕ'
const DIRECTOR_SECRET = 'ЗАМЫСЕЛ-ВЕДУЩЕГО'
const WITNESS_SECRET = 'КТО-ВИДЕЛ-УБИЙСТВО'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'AUTONOMY',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    scene: { title: 'Двор', location: 'Двор', cells: [] },
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    autonomy: {
      hooks: [{ id: 'hook-1', text: SPOILER }],
      npc_schedules: { 'npc:spy': { entries: [{ at_minutes: 120, action: 'move', location: SCHEDULE_SECRET, summary: SCHEDULE_SECRET }] } },
      director_history: [{ intent_type: 'request_encounter', reason: DIRECTOR_SECRET }],
      director_outcomes: [{ outcome: DIRECTOR_SECRET }],
      witness_graph: [{ witness_ids: ['npc:spy'], note: WITNESS_SECRET }],
      transitions: [{ transition_id: 't1', hook: SPOILER }],
      encounter_outcomes: [{ encounter_id: 'e1', note: DIRECTOR_SECRET }],
      random_encounters: [{ theme: 'undead', note: DIRECTOR_SECRET }],
      npc_actions: [{ npc_id: 'npc:spy', summary: SCHEDULE_SECRET }],
      // Отдых отряд прожил сам — он публичен, поэтому и без секретной пометки.
      downtime_history: [{ duration_minutes: 480, participant_ids: ['hero'] }],
      applied_consequences: [DIRECTOR_SECRET],
      reputations: { guild: -40, watch: 60 },
      pacing: { beat: 3, phase: 'escalation', tension: 55 },
      travel_history: [{ from: 'Двор', to: 'Ворота' }],
    },
  })
}

const asPlayer = (state) => campaignStateForViewer(state, { role: 'player', id: 'u1' }, 'hero')

test('замысел Ведущего не доезжает до игрока ни одной строкой', () => {
  const payload = JSON.stringify(asPlayer(campaign()))
  for (const secret of [SPOILER, SCHEDULE_SECRET, DIRECTOR_SECRET, WITNESS_SECRET]) {
    assert.equal(payload.includes(secret), false, `утечка: ${secret}`)
  }
})

test('игрок видит только пережитое самим отрядом и славу ступенями', () => {
  const autonomy = asPlayer(campaign()).autonomy
  assert.deepEqual(
    Object.keys(autonomy).sort(),
    ['downtime_history', 'pacing', 'reputation_standing', 'schema_version', 'travel_history'],
  )
  assert.equal(autonomy.pacing.phase, 'escalation')
  assert.equal(autonomy.pacing.tension, 55)
  assert.equal(autonomy.travel_history.length, 1)
  // Граница проходит по источнику: путь и привал отряд прожил, замысел — нет.
  assert.equal(autonomy.downtime_history.at(-1).duration_minutes, 480)
})

test('слава приходит ступенями, а не числом — отряд чувствует отношение, а не читает счёт', () => {
  const standing = asPlayer(campaign()).autonomy.reputation_standing
  assert.deepEqual(standing, [
    { faction_id: 'guild', tier: 'distrusted' },
    { faction_id: 'watch', tier: 'honoured' },
  ])
  assert.equal(JSON.stringify(standing).includes('-40'), false, 'сырой счёт репутации игроку не показывается')
})

test('администратор по-прежнему видит всё: это его рабочая память', () => {
  const admin = campaignStateForViewer(campaign(), { role: 'admin', id: 'u0' }, '')
  assert.ok(JSON.stringify(admin).includes(SPOILER))
  assert.ok(Array.isArray(admin.autonomy.hooks))
})

test('кампания без автономного слоя не ломается и поля не выдумывает', () => {
  const bare = normalizeCampaignState({
    sessionCode: 'BARE', partyMemberIds: ['hero'], players: [{ id: 'hero', character: 'Ада', hp: 5, maxHp: 5, inventory: [] }],
    scene: { title: 'S', location: 'L', cells: [] },
  })
  const projected = asPlayer(bare)
  assert.deepEqual(projected.autonomy.reputation_standing, [])
  assert.equal(projected.autonomy.pacing.beat, 0)
})

/**
 * Сторож против повторения. Проекция собирается спредом с последующим
 * переопределением по доменам, поэтому новый ключ верхнего уровня проходит
 * сырым и никто этого не замечает — ровно так утёк `autonomy`. Тест падает,
 * как только в состоянии появляется ключ без осознанного решения.
 */
test('каждый ключ состояния имеет осознанное решение в проекции', () => {
  const known = new Set(PROJECTED_STATE_KEYS)
  const stateKeys = Object.keys(campaign())
  const projectedKeys = Object.keys(asPlayer(campaign()))

  const undecidedInState = stateKeys.filter((key) => !known.has(key)).sort()
  assert.deepEqual(
    undecidedInState, [],
    'новый ключ состояния не описан в PROJECTED_STATE_KEYS: решите, что с ним делает проекция игрока, и добавьте его туда',
  )
  const undecidedInProjection = projectedKeys.filter((key) => !known.has(key)).sort()
  assert.deepEqual(undecidedInProjection, [], 'проекция отдаёт ключ, которого нет в списке решений')
})
