import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { lootOwnerId, partyOrderIds } from '../server/autonomous-orchestrator.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `recovery-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const applyAll = (state, events) => events.reduce(applyGameEvent, state)

/**
 * The battle is won and the party is out of combat, but one hero is still at 0
 * hit points and stable.  This is the state the autonomous loop reaches after a
 * hard fight, and the order of what happens next is the whole point: a long
 * rest is worth nothing until that hero is conscious again.
 */
function afterVictory() {
  return normalizeCampaignState({
    sessionCode: 'RECOVERY-1',
    partyMemberIds: ['warden', 'fallen'],
    players: [
      { id: 'warden', character: 'Страж', characterClass: 'fighter', level: 5, hp: 18, maxHp: 40, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'fallen', character: 'Павший', characterClass: 'rogue', level: 5, hp: 0, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 12 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [],
    scene: { turn: 1, cells: Array.from({ length: 20 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true })) },
    mechanics: {
      conditions: { fallen: [{ id: 'unconscious' }] },
      death: { saving_throws: { fallen: { successes: 3, failures: 0, stable: true } }, heroes: {}, campaign_status: 'active' },
      world_time: { elapsed_minutes: 0 },
      combat: { active: false, round: 0, initiative: [], active_index: -1, action_economy: {}, reaction_window: null },
    },
  })
}

test('длительный отдых недоступен герою с 0 ОЗ — правило ruleset остаётся в силе', () => {
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), afterVictory(), options(dice())),
    (error) => error.code === 'REST_ACTOR_INCAPACITATED',
  )
})

test('четыре часа поднимают стабильного героя до 1 ОЗ, и отдых становится доступен', () => {
  const state = afterVictory()
  // 1к4 часа — не больше четырёх, поэтому 240 минут гарантированно закрывают срок.
  const advanced = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 240, unit: 'minute' }), state, options(dice([4])))
  const scheduled = advanced.events.find((event) => event.event_type === 'StableRecoveryScheduled')
  assert.equal(scheduled.payload.recovery_hours, 4)
  const healed = advanced.events.find((event) => event.event_type === 'HealingApplied' && event.target_ids.includes('fallen'))
  assert.equal(healed.payload.reason, 'stable-recovery-after-1d4-hours')
  assert.equal(healed.payload.hp_after, 1)

  const awake = applyAll(state, advanced.events)
  assert.equal(awake.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.deepEqual(replayEvents(state, advanced.events), awake)

  const rest = resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), awake, options(dice()))
  assert.ok(rest.events.some((event) => event.event_type === 'RestStarted'))
})

test('добыча после победы достаётся живому герою, а не первому в списке', () => {
  const state = afterVictory()
  assert.deepEqual(partyOrderIds(state), ['warden', 'fallen'])
  assert.equal(lootOwnerId(state), 'warden', 'без погибших добычу берёт первый по списку')

  const wardenFell = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, death: { ...state.mechanics.death, heroes: { warden: { status: 'dead' } } } },
  })
  assert.equal(lootOwnerId(wardenFell), 'fallen', 'погибший не может быть автором команды выдачи предмета')

  const everyoneFell = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, death: { ...state.mechanics.death, heroes: { warden: { status: 'dead' }, fallen: { status: 'dead' } } } },
  })
  assert.equal(lootOwnerId(everyoneFell), 'warden', 'если живых нет, выбор остаётся детерминированным')
})

test('короткого ожидания не хватает: срок только уменьшается, отдых по-прежнему закрыт', () => {
  const state = afterVictory()
  const advanced = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 60, unit: 'minute' }), state, options(dice([3])))
  const progressed = advanced.events.find((event) => event.event_type === 'StableRecoveryProgressed')
  assert.equal(progressed.payload.recovery_minutes_before, 180)
  assert.equal(progressed.payload.recovery_minutes_remaining, 120)
  const waiting = applyAll(state, advanced.events)
  assert.equal(waiting.players.find((hero) => hero.id === 'fallen').hp, 0)
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'StartRest', actor_id: 'fallen', kind: 'long' }), waiting, options(dice())),
    (error) => error.code === 'REST_ACTOR_INCAPACITATED',
  )
})

const wolf = { id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, speed: 40, initiativeBonus: 2, attackBonus: 4, damageDice: 4, damageBonus: 2, damageType: 'piercing', attackRange: 5, abilities: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 }, x: 4, y: 3 }

test('герой без сознания бросает инициативу: поднятый лечением ходит, упавший — делает спасброски', () => {
  // Прогон Асстохана (сид 2, 2026-10-05): бой начался, пока воин лежал на 0 ОЗ
  // после прошлого поражения, и в очередь его не взяли. Жрица подняла его
  // лечением, но ходить он не мог; упав снова, не бросал спасброски, и бой
  // закрылся, оставив его умирать на 0 ОЗ навсегда.
  const state = normalizeCampaignState({ ...afterVictory(), enemies: [wolf] })
  const started = resolveCommand(authoritative({ command_type: 'StartCombat', command_id: 'start-with-fallen', actor_id: 'warden' }), state, options(dice([10, 10, 10])))
  const combat = started.events.find((event) => event.event_type === 'CombatStarted').payload
  assert.ok(combat.party_ids.includes('fallen'), 'лежащий без сознания герой — участник боя')
  assert.ok(combat.initiative.some((entry) => entry.actor_id === 'fallen'))

  const dead = normalizeCampaignState({ ...afterVictory(), enemies: [wolf], mechanics: { ...afterVictory().mechanics, death: { saving_throws: {}, heroes: { fallen: { status: 'dead' } }, campaign_status: 'active' } } })
  const withoutDead = resolveCommand(authoritative({ command_type: 'StartCombat', command_id: 'start-without-dead', actor_id: 'warden' }), dead, options(dice([10, 10])))
  assert.equal(withoutDead.events.find((event) => event.event_type === 'CombatStarted').payload.party_ids.includes('fallen'), false, 'погибший в бой не встаёт')
})

test('встречу без единого героя в сознании движок отклоняет понятной фразой, а не служебной ошибкой сборщика', () => {
  const state = afterVictory()
  const everyoneDown = normalizeCampaignState({ ...state, players: state.players.map((hero) => ({ ...hero, hp: 0 })) })
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'CreateEncounter', command_id: 'empty-party', actor_id: 'warden', difficulty: 'easy', theme: 'beasts', seed: 'empty' }), everyoneDown, options(dice())),
    (error) => error.code === 'PARTY_UNAVAILABLE' && /без сознания/u.test(error.message),
  )
})

test('цель длиннее предела обрезается по слову с многоточием', () => {
  const objective = 'Найти в «Пепельная застава» другой путь к разгадке: Саргат разоряет равнины и собирает сведения о героях, а три донесения связывают его'
  const result = resolveCommand(authoritative({ command_type: 'UpdateObjective', command_id: 'long-objective', objective }), afterVictory(), options(dice()))
  const saved = result.events.find((event) => event.event_type === 'ObjectiveUpdated').payload.objective
  assert.ok(saved.length <= 120, saved)
  assert.match(saved, /…$/u)
  assert.ok(objective.startsWith(saved.slice(0, -1)), 'обрезка не меняет слов')
  assert.match(saved.slice(0, -1), /\p{L}$/u)
  assert.equal(objective[saved.length - 1], ' ', `обрыв на полуслове: ${saved}`)
})
