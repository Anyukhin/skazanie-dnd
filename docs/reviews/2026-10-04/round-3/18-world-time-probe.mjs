import assert from 'node:assert/strict'

import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { planCaptiveNeglectCommands } from '../../../../server/captives.mjs'
import { planCourierLetterTicks } from '../../../../server/courier-letters.mjs'
import { npcProfileAtWorldTime } from '../../../../server/npc-social.mjs'
import {
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../../../../server/rules-engine.mjs'

const dice = () => new DiceService({ rng: new SequenceDiceRng(Array.from({ length: 64 }, () => 3)) })

function state({ promises = [], letters = [], captives = [], worldMinutes = 0 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'ROUND3-WORLD-TIME-PROBE',
    partyMemberIds: ['cleric', 'fighter'],
    players: [
      {
        id: 'cleric', character: 'Жрица', characterClass: 'cleric', level: 3,
        proficiency: 2, hp: 21, maxHp: 21, armor: 15, speed: 30, x: 1, y: 1,
        abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 16, cha: 10 },
        preparedSpellIds: ['prayer-of-healing'], knownSpellIds: ['prayer-of-healing'], inventory: [],
      },
      {
        id: 'fighter', character: 'Воин', characterClass: 'fighter', level: 3,
        proficiency: 2, hp: 9, maxHp: 30, armor: 16, speed: 30, x: 2, y: 1,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
      },
    ],
    scene: { title: 'Проба', location: 'Проба', turn: 1, cells: [] },
    mechanics: {
      world_time: { elapsed_minutes: worldMinutes },
      resources: { cleric: { spell_slots_2: { current: 2, max: 2 } } },
      combat: { active: false, round: 0, active_index: -1, initiative: [], action_economy: {} },
    },
    social: {
      npcs: [{ id: 'mira', name: 'Мира', role: 'npc', visibility: 'party', available: true }],
      relationships: { mira: { cleric: 0 } }, conversations: [], promises,
    },
    npc_world: { vitals: { mira: { alive: true, hp: 10 } } },
    courier_letters: { schema_version: 1, letters },
    captives: { schema_version: 1, captives },
  })
}

function resolve(stateValue, command) {
  return resolveCommand({ server_authoritative: true, actor_id: 'cleric', ...command }, stateValue, {
    diceService: dice(),
    context: { isAdmin: true, isDirector: true, serverAuthoritativeCombat: true, allowedActorIds: ['cleric', 'fighter'] },
  })
}

// Длительное накладывание идёт через нижний слой часов. Срок обещания
// наступает внутри десятиминутного действия; контроль — обычный AdvanceTime.
{
  const initial = state({ promises: [{
    id: 'promise:long-cast', npc_id: 'mira', hero_id: 'cleric', direction: 'party_to_npc',
    text: 'Вернуть книгу', due_hint: 'через 5 минут', status: 'open', visibility: 'party',
    created_at_minutes: 0, deadline_minutes: 5,
  }] })
  const result = resolve(initial, { command_type: 'CastSpell', command_id: 'long-cast', spell_id: 'prayer-of-healing', target_id: 'fighter', target_ids: ['fighter'] })
  const after = replayEvents(initial, result.events)
  assert.equal(after.mechanics.world_time.elapsed_minutes, 10)
  assert.equal(result.events.some((event) => event.event_type === 'NpcPromiseResolved'), false)
  assert.equal(after.social.promises[0].status, 'open')
  const control = resolve(initial, { command_type: 'AdvanceTime', command_id: 'control-time', amount: 10, unit: 'minute' })
  assert.equal(control.events.some((event) => event.event_type === 'NpcPromiseResolved'), true)
  assert.notEqual(replayEvents(initial, control.events).social.promises[0].status, 'open')
}

// Письмо создаёт обещание после прохода старых сроков: новый срок остаётся
// открытым внутри одного большого скачка исходного состояния.
{
  const initial = state({ letters: [{
    id: 'letter:promise', hero_id: 'cleric', hero_name: 'Жрица', addressee_kind: 'npc',
    addressee_id: 'mira', addressee_name: 'Мира', place_name: 'Дом', leagues: 2, fee_cp: 70,
    body: 'Верну книгу', promise_text: 'Вернуть книгу', promise_due_hint: 'через 1 час',
    status: 'in_transit', sent_at_minutes: 0, delivery_due_minutes: 480,
    reply_due_minutes: 1_680, tone: 'plain', reply_draft: '', reply_draft_tone: '', reply_provider: '',
  }] })
  const result = resolve(initial, { command_type: 'AdvanceTime', command_id: 'courier-promise', amount: 1_440, unit: 'minute' })
  const after = replayEvents(initial, result.events)
  assert.equal(after.mechanics.world_time.elapsed_minutes, 1_440)
  assert.equal(after.social.promises[0].deadline_minutes, 540)
  assert.equal(after.social.promises[0].status, 'open')
  assert.equal(result.events.some((event) => event.event_type === 'NpcPromiseResolved'), false)
}

// Доступность адресата оценивается в начале скачка, а не в момент доставки.
{
  const profile = {
    id: 'mira', name: 'Мира', role: 'npc', visibility: 'party', available: true,
    schedule: [
      { id: 'night', start_minute: 0, end_minute: 480, location: 'Уехала', available: false },
      { id: 'day', start_minute: 480, end_minute: 1_440, location: 'Дом', available: true },
    ],
  }
  const courierState = {
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [profile], relationships: { mira: { hero: 0 } }, promises: [], conversations: [] },
    npc_world: { vitals: { mira: { alive: true, hp: 10 } } },
    courier_letters: { schema_version: 1, letters: [{
      id: 'letter:schedule', hero_id: 'cleric', hero_name: 'Жрица', addressee_kind: 'npc',
      addressee_id: 'mira', addressee_name: 'Мира', place_name: 'Дом', leagues: 2, fee_cp: 70,
      body: 'Письмо', status: 'in_transit', sent_at_minutes: 0, delivery_due_minutes: 480,
      reply_due_minutes: 1_680, tone: 'plain', reply_draft: '', reply_draft_tone: '', reply_provider: '',
    }] },
  }
  assert.equal(npcProfileAtWorldTime(profile, 480).available, true)
  const [draft] = planCourierLetterTicks(courierState, { elapsedMinutes: 480 })
  assert.equal(draft.event_type, 'CourierLetterReturned')
  assert.equal(draft.payload.reason, 'gone')
}

// Голод пленного планируется внешним проходом после сохранения; в batch
// AdvanceTime и его отдельном replay такого события ещё нет.
{
  const initial = state({ captives: [{ id: 'captive:one', npc_id: 'npc:one', status: 'held', taken_at_minutes: 0, last_fed_at_minutes: 0 }] })
  const result = resolve(initial, { command_type: 'AdvanceTime', command_id: 'captive-clock', amount: 1_440, unit: 'minute' })
  const after = replayEvents(initial, result.events)
  assert.equal(result.events.some((event) => event.event_type === 'CaptiveNeglected'), false)
  assert.equal(after.captives.captives[0].neglected_at_minutes, null)
  assert.equal(planCaptiveNeglectCommands(after, { worldMinute: 1_440 }).length, 1)
}

console.log('round-3 world-time probe: 4 boundary behaviours reproduced')
