// Ось «воспроизводимость»: «Replay одного потока событий обязан давать то же
// состояние. Перезапуск, повторный запрос и параллельные команды не должны
// менять уже полученный исход».
//
// Сторож устроен резко: на время повтора часы и случайность **отбираются**.
// Редьюсер, который заглянет в `Date.now`, `new Date` или `Math.random`, даст
// при следующем повторе другое состояние — и упадёт здесь, а не через месяц на
// расхождении replay с сохранённой кампанией.
//
// Проверяется именно повтор потока: команды числа получают законно, через
// внедрённый Dice Service, и всё случайное оседает в payload события.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function cells(width = 9, height = 3) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'REPLAY-DET',
    campaign_id: 'REPLAY-DET',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'cleric', level: 3, proficiency: 2,
      hp: 24, maxHp: 24, armor: 12, speed: 30,
      abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 16, cha: 10 },
      attackBonus: 7, damageDice: 6, damageBonus: 2, x: 1, y: 1,
      preparedSpellIds: ['sacred-flame'], inventory: [],
    }],
    enemies: [{
      id: 'wolf', name: 'Волк', hp: 20, maxHp: 20, armor: 11, speed: 40, attackBonus: 4,
      damageDice: 4, damageBonus: 1,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 2, y: 1, alive: true,
    }],
    scene: { turn: 1, location: 'Тракт', title: 'Тракт', cells: cells() },
    worldMemory: {
      entities: [{ id: 'trakt', kind: 'location', name: 'Тракт', summary: '', aliases: [], visibility: 'party', tags: [] }],
      facts: [], quests: [], knowledge: {},
    },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 21 }, { actor_id: 'wolf', total: 11 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

/** Поток событий разного рода: удар, спасбросок, состояние, время, память мира. */
function recordedStream() {
  let id = 0
  const engine = new RulesEngine({
    diceService: new DiceService({
      rng: new SequenceDiceRng(Array.from({ length: 200 }, (_, index) => index % 3 === 0 ? 17 : 4)),
      idFactory: () => `replay-roll-${++id}`,
      now: () => '2026-07-27T00:00:00.000Z',
    }),
  })
  const plans = [
    [{ command_type: 'MakeAttack', actor_id: 'hero', target_id: 'wolf', server_authoritative: true }],
    [{ command_type: 'AddCondition', actor_id: 'hero', target_id: 'wolf', condition: 'prone' }],
    [{ command_type: 'EndTurn', actor_id: 'hero', server_authoritative: true },
      { command_type: 'EndTurn', actor_id: 'wolf', server_authoritative: true }],
    [{ command_type: 'CastSpell', actor_id: 'hero', target_id: 'wolf', spell_id: 'sacred-flame', server_authoritative: true }],
    [{ command_type: 'AdvanceTime', amount: 30, unit: 'minute' }],
    [{
      command_type: 'RecordWorldFact',
      fact: {
        id: 'fact-wolf', subject_id: 'trakt', predicate: 'событие',
        object: 'Волк ранен', summary: 'Волк ранен на тракте', visibility: 'party',
      },
    }],
  ]
  let state = campaign()
  const events = []
  for (const commands of plans) {
    const result = engine.resolvePlan({ commands }, state, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })
    events.push(...result.events)
    state = result.state
  }
  return { events, finalState: state }
}

/** Повтор при отобранных часах и случайности. */
function replayWithoutClockOrRandomness(events) {
  const realNow = Date.now
  const realRandom = Math.random
  const RealDate = globalThis.Date
  const touched = []
  Date.now = () => { touched.push('Date.now'); return 0 }
  Math.random = () => { touched.push('Math.random'); return 0 }
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (!args.length) touched.push('new Date()')
      super(...args)
    }
  }
  globalThis.Date.now = Date.now
  try {
    let state = campaign()
    for (const event of events) state = applyGameEvent(state, event)
    return { state, touched }
  } finally {
    globalThis.Date = RealDate
    Date.now = realNow
    Math.random = realRandom
  }
}

test('повтор потока событий не заглядывает ни в часы, ни в случайность', () => {
  const { events } = recordedStream()
  assert.ok(events.length >= 8, 'поток должен быть достаточно разнообразным, чтобы проверка что-то значила')
  const { touched } = replayWithoutClockOrRandomness(events)
  assert.deepEqual([...new Set(touched)], [], 'редьюсер обратился к недетерминированному источнику')
})

test('повтор потока событий даёт то же состояние, что и исполнение команд', () => {
  const { events, finalState } = recordedStream()
  let replayed = campaign()
  for (const event of events) replayed = applyGameEvent(replayed, event)
  assert.deepEqual(replayed, finalState)
})

test('повтор идемпотентен: второй прогон того же потока даёт то же состояние', () => {
  const { events } = recordedStream()
  const once = replayWithoutClockOrRandomness(events).state
  const twice = replayWithoutClockOrRandomness(events).state
  assert.deepEqual(twice, once)
})
