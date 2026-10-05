import assert from 'node:assert/strict'
import test from 'node:test'

import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { RulesEngine, heroReactionModesFor, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { planReactionByPreference, normalizeReactionPreferences } from '../server/reaction-preferences.mjs'
import { tacticalNarrationParts } from '../server/combat-narration.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { dice as kitDice } from './kit/dice.mjs'
import { applyAll, createCampaignStore } from './kit/engine.mjs'

const sword = {
  id: 'sword', name: 'Длинный меч', type: 'weapon', equipped: true, quantity: 1,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
}
const floor = Array.from({ length: 12 * 12 }, (_, index) => ({
  x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true,
}))

// Счётчик общий у бросков и команд, как и прежде: id не повторяются между костями.
let serial = 0
const dice = (values = []) => kitDice(values, {
  idFactory: () => `reaction-preference-roll-${++serial}`,
  now: '2026-10-04T12:00:00.000Z',
})

function resolve(state, command, values = [], context = {}) {
  return resolveCommand({
    command_id: `reaction-preference-command-${++serial}`,
    server_authoritative: true,
    ...command,
  }, state, {
    diceService: dice(values),
    context: { serverAuthoritativeCombat: true, ...context },
  })
}

const apply = (state, result) => applyAll(state, result.events)
const restart = (state) => normalizeCampaignState(JSON.parse(JSON.stringify(state)))

// Волшебник со «Щитом» и мечом рядом с бойцом: тот же стенд, что у
// `reaction-attack-continuation.test.mjs`, — уход героя провоцирует удар
// врага, а попадание открывает окно «Щита».
function reactionState({ activeIndex = 1, preferences = undefined } = {}) {
  return normalizeCampaignState({
    sessionCode: 'REACTION-PREFERENCE-TEST',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Мирелла', characterClass: 'wizard',
      level: 5, hp: 20, maxHp: 20, armor: 16, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 16, wis: 10, cha: 10 },
      knownSpellIds: ['shield'], preparedSpellIds: ['shield'], inventory: [sword], x: 1, y: 1,
    }],
    enemies: [{
      id: 'enemy', name: 'Наёмник', characterClass: 'fighter', level: 5, hp: 20, maxHp: 20,
      armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [sword], alive: true, x: 2, y: 1,
      attack_profile: { name: 'Меч', attack_modifier: 5, damage_expression: '1d8', damage_type: 'slashing', range_feet: 5 },
    }],
    scene: { cells: floor },
    mechanics: {
      ...(preferences ? { reaction_preferences: preferences } : {}),
      resources: { hero: { spell_slots_1: { current: 1, max: 1 } } },
      combat: {
        active: true, round: 1,
        initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 10 }],
        active_index: activeIndex,
        action_economy: {
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const setMode = (state, reaction_id, mode) => resolve(state, { command_type: 'SetReactionPreference', actor_id: 'hero', reaction_id, mode })
const leaveReach = (state, values) => resolve(state, { command_type: 'MoveActor', actor_id: 'hero', to: { x: 4, y: 1 } }, values)

test('политика режимов: «сразу» выбирает, «никогда» отказывает, смешанное окно спрашивает', () => {
  const window = { actor_id: 'hero', trigger: 'attack-protective-choice', action_ids: ['cast:shield', 'uncanny-dodge'] }
  assert.equal(planReactionByPreference({}, window), null, 'по умолчанию — спрашивать')
  assert.deepEqual(planReactionByPreference({ hero: { 'uncanny-dodge': 'auto' } }, window), { mode: 'auto', action_id: 'uncanny-dodge' })
  assert.deepEqual(planReactionByPreference({ hero: { 'cast:shield': 'auto', 'uncanny-dodge': 'auto' } }, window), { mode: 'auto', action_id: 'cast:shield' }, 'из двух «сразу» — то, что отменяет попадание')
  assert.equal(planReactionByPreference({ hero: { 'cast:shield': 'never' } }, window), null, 'второй вариант всё ещё спрашивает')
  assert.deepEqual(planReactionByPreference({ hero: { 'cast:shield': 'never', 'uncanny-dodge': 'never' } }, window), { mode: 'never', action_id: 'decline-reaction' })
  // Заготовку игрок сделал сам, а «Несгибаемый» и бонус спасброска — не реакции.
  assert.equal(planReactionByPreference({ hero: { 'opportunity-attack': 'never' } }, { actor_id: 'hero', action_ids: ['opportunity-attack', 'readied-attack'] }), null)
  assert.equal(planReactionByPreference({ hero: { 'opportunity-attack': 'auto' } }, { actor_id: 'hero', trigger: 'failed-saving-throw', action_ids: ['opportunity-attack'] }), null)
  assert.equal(planReactionByPreference({ hero: { 'opportunity-attack': 'auto' } }, { actor_id: 'hero', free_choice: true, action_ids: ['opportunity-attack'] }), null)
  // «Спрашивать» не хранится, мусор отбрасывается.
  assert.deepEqual(normalizeReactionPreferences({ hero: { 'cast:shield': 'ask', parry: 'auto', 'cast:fireball': 'auto', riposte: 'sometimes' }, ghost: {} }), { hero: { parry: 'auto' } })
})

test('SetReactionPreference меняет режим вне очереди хода, «спрашивать» стирает запись, replay сходится', () => {
  const initial = reactionState({ activeIndex: 0 })
  assert.deepEqual(heroReactionModesFor(initial, 'hero').map((entry) => `${entry.id}:${entry.mode}`), ['opportunity-attack:ask', 'cast:shield:ask'])

  const never = setMode(initial, 'cast:shield', 'never')
  assert.deepEqual(never.events.map((event) => event.event_type), ['ReactionPreferenceChanged'])
  assert.deepEqual(never.events[0].payload, { reaction_id: 'cast:shield', mode: 'never', schema_version: 1 })
  const afterNever = apply(initial, never)
  assert.deepEqual(afterNever.mechanics.reaction_preferences, { hero: { 'cast:shield': 'never' } })
  assert.deepEqual(restart(afterNever).mechanics.reaction_preferences, afterNever.mechanics.reaction_preferences, 'режим переживает перезапуск')
  assert.equal(heroReactionModesFor(afterNever, 'hero').find((entry) => entry.id === 'cast:shield').mode, 'never')

  const back = setMode(afterNever, 'cast:shield', 'ask')
  const afterAsk = apply(afterNever, back)
  assert.equal(afterAsk.mechanics.reaction_preferences, undefined, 'без настроек состояние выглядит как раньше')
  assert.deepEqual(apply(initial, { events: [...never.events, ...back.events] }), afterAsk, 'replay тех же событий даёт то же состояние')
})

test('SetReactionPreference отклоняет чужую реакцию, неизвестный режим и противника', () => {
  const state = reactionState()
  for (const [command, label] of [
    [{ reaction_id: 'cast:counterspell', mode: 'auto' }, 'заклинания нет в книге'],
    [{ reaction_id: 'cast:fireball', mode: 'auto' }, 'не реакция'],
    [{ reaction_id: 'cast:shield', mode: 'sometimes' }, 'нет такого режима'],
  ]) {
    assert.throws(() => resolve(state, { command_type: 'SetReactionPreference', actor_id: 'hero', ...command }), (error) => error.code === 'REACTION_PREFERENCE_INVALID', label)
  }
  assert.throws(() => resolve(state, { command_type: 'SetReactionPreference', actor_id: 'enemy', reaction_id: 'opportunity-attack', mode: 'never' }, [], { isAdmin: true }), (error) => error.code === 'REACTION_PREFERENCE_INVALID')
})

test('«спрашивать» по умолчанию: окно «Щита» ждёт игрока', () => {
  const initial = reactionState()
  const opened = leaveReach(initial, [12])
  const waiting = apply(initial, opened)
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice')
  assert.equal(waiting.players[0].x, 1, 'перемещение ждёт ответа')
})

test('«никогда» для «Щита»: окно закрывается отказом в той же команде, удар проходит, ход не продлевается', () => {
  const initial = apply(reactionState(), setMode(reactionState(), 'cast:shield', 'never'))
  const result = leaveReach(initial, [12, 8])
  const final = apply(initial, result)
  const types = result.events.map((event) => event.event_type)
  assert.ok(types.includes('ReactionWindowOpened'))
  const closed = result.events.find((event) => event.event_type === 'ReactionWindowClosed')
  assert.equal(closed.payload.accepted, false)
  assert.equal(closed.payload.auto_decline_reason, 'reaction-preference')
  assert.equal(closed.payload.reaction_preference, 'never')
  assert.equal(final.mechanics.combat.reaction_window, null, 'окна у игрока нет')
  assert.equal(final.players[0].x, 4, 'перемещение завершилось')
  assert.equal(final.players[0].hp, 9, 'удар по возможности нанёс урон')
  assert.equal(final.mechanics.resources.hero.spell_slots_1.current, 1, 'ячейка не потрачена')
  assert.equal(final.mechanics.combat.action_economy.hero.reaction, true, 'реакция героя осталась')
  assert.equal(final.mechanics.combat.turn_reaction_extensions ?? 0, 0, 'ожидания не было — продлевать ход нечего')
  assert.deepEqual(restart(final), normalizeCampaignState(JSON.parse(JSON.stringify(applyAll(initial, result.events)))), 'replay сходится')

  const { main } = tacticalNarrationParts(result.events, final)
  assert.doesNotMatch(main, /получает возможность/u, 'вопроса, которого не было, хроника не пишет')
  assert.doesNotMatch(main, /не использует реакцию/u)
})

test('«сразу» для «Щита»: сервер поднимает Щит сам, тратит ячейку и реакцию, удар отбит', () => {
  const initial = apply(reactionState(), setMode(reactionState(), 'cast:shield', 'auto'))
  const result = leaveReach(initial, [12])
  const final = apply(initial, result)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.players[0].x, 4)
  assert.equal(final.players[0].hp, 20, '+5 КД превратил попадание в промах')
  assert.equal(final.mechanics.resources.hero.spell_slots_1.current, 0)
  assert.equal(final.mechanics.combat.action_economy.hero.reaction, false)
  const used = result.events.find((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'cast:shield')
  assert.equal(used.payload.reaction_preference, 'auto')

  const { main } = tacticalNarrationParts(result.events, final)
  assert.match(main, /сразу использует реакцию «Щит»/u)
  assert.match(main, /17 против КД 21 с «Щитом» — промах/u, 'хроника сравнивает бросок с КД под Щитом')
  assert.doesNotMatch(main, /получает возможность/u)
})

test('режим, выбранный при открытом окне, отвечает на это окно сразу', () => {
  const initial = reactionState()
  const waiting = apply(initial, leaveReach(initial, [12]))
  assert.equal(waiting.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice')
  const result = setMode(waiting, 'cast:shield', 'auto')
  const final = apply(waiting, result)
  assert.equal(result.events[0].event_type, 'ReactionPreferenceChanged')
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.equal(final.players[0].x, 4, 'прерванное перемещение продолжилось')
  assert.equal(final.players[0].hp, 20)
})

test('если ответ по режиму не проходит проверку движка, окно остаётся и спрашивает', () => {
  const initial = reactionState()
  const waiting = apply(initial, leaveReach(initial, [12]))
  // Ячейки кончились, пока окно ждало: «Щит» больше нечем оплатить.
  for (const resource of Object.keys(waiting.mechanics.resources.hero)) {
    if (resource.startsWith('spell_slots_')) waiting.mechanics.resources.hero[resource].current = 0
  }
  const result = setMode(waiting, 'cast:shield', 'auto')
  assert.deepEqual(result.events.map((event) => event.event_type), ['ReactionPreferenceChanged'], 'режим сохранён, ответа за игрока нет')
  const final = apply(waiting, result)
  assert.equal(final.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice', 'окно по-прежнему ждёт игрока')
})

test('«сразу» для атаки по возможности: враг уходит из досягаемости — герой бьёт сам', () => {
  const base = reactionState({ activeIndex: 0 })
  const initial = apply(base, setMode(base, 'opportunity-attack', 'auto'))
  const result = resolve(initial, { command_type: 'MoveActor', actor_id: 'enemy', to: { x: 5, y: 1 } }, [15, 6], { isNpcScheduler: true, isAdmin: true })
  const final = apply(initial, result)
  const opened = result.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.equal(opened?.payload.trigger, 'enemy-left-reach')
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.ok(result.events.some((event) => event.event_type === 'AttackResolved' && event.actor_id === 'hero'), 'герой ударил')
  assert.equal(final.mechanics.combat.action_economy.hero.reaction, false)
  assert.equal(final.enemies[0].x, 5, 'враг дошёл, куда шёл')
})

test('«никогда» для атаки по возможности: враг уходит без удара и без окна', () => {
  const base = reactionState({ activeIndex: 0 })
  const initial = apply(base, setMode(base, 'opportunity-attack', 'never'))
  const result = resolve(initial, { command_type: 'MoveActor', actor_id: 'enemy', to: { x: 5, y: 1 } }, [], { isNpcScheduler: true, isAdmin: true })
  const final = apply(initial, result)
  assert.equal(final.mechanics.combat.reaction_window, null)
  assert.ok(!result.events.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(final.mechanics.combat.action_economy.hero.reaction, true)
  assert.equal(final.enemies[0].x, 5)
})

test('проекция: свои режимы — списком у героя, чужие не уходят', () => {
  const base = reactionState()
  const state = apply(base, setMode(base, 'cast:shield', 'never'))
  state.players.push({ ...state.players[0], id: 'friend', character: 'Друг', x: 1, y: 3 })
  state.mechanics.reaction_preferences.friend = { 'opportunity-attack': 'never' }

  const mine = campaignStateForViewer(state, { id: 'user-hero', role: 'player' }, 'hero')
  const hero = mine.players.find((player) => player.id === 'hero')
  assert.deepEqual(hero.reactionModes.map((entry) => `${entry.id}:${entry.mode}`), ['opportunity-attack:ask', 'cast:shield:never'])
  assert.equal(mine.players.find((player) => player.id === 'friend').reactionModes, undefined, 'чужие режимы не уходят')
  assert.deepEqual(mine.mechanics.reaction_preferences, { hero: { 'cast:shield': 'never' } })

  const gm = campaignStateForViewer(state, { id: 'gm', role: 'admin' }, '')
  assert.deepEqual(Object.keys(gm.mechanics.reaction_preferences).sort(), ['friend', 'hero'])
})

// Ход врага идёт планом «удар + конец хода». Прежде окно «спрашивать» на этом
// ударе откатывало весь план (`COMBAT_REACTION_PENDING` на конце хода), и
// координатор повторял его, пока кубики не давали исход без окна: игрока так
// и не спрашивали, а бой стоял.
async function npcTurnStore(t, preferences) {
  const initial = reactionState({ activeIndex: 0, preferences })
  initial.enemies[0].level = 1 // одна атака за ход: план врага — удар и конец хода
  return createCampaignStore(t, 'REACTION-NPC', initial, { prefix: 'skazanie-reaction-npc-' })
}
const activeActor = (state) => state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id

test('«спрашивать» на ходу врага: удар останавливается на окне «Щита», ответ игрока доводит ход до конца', async (t) => {
  const eventStore = await npcTurnStore(t)
  // 12 + 5 = 17 против КД 16 — попадание, которое «Щит» (+5) превращает в промах.
  const first = await runNpcTurnScheduler({ campaignId: 'REACTION-NPC', eventStore, rulesEngine: new RulesEngine({ diceService: dice([12, 8]) }) })
  assert.equal(first.turns.length, 1)
  let loaded = await eventStore.load('REACTION-NPC')
  assert.equal(loaded.state.mechanics.combat.reaction_window?.trigger, 'attack-shield-choice', 'игроку задан вопрос')
  assert.equal(activeActor(loaded.state), 'enemy', 'ход врага ждёт ответа, а не закончен за него')

  const executor = new AuthoritativeExecutor({ eventStore, rulesEngine: new RulesEngine({ diceService: dice([]) }) })
  await executor.executeCommands({
    campaignId: 'REACTION-NPC',
    idempotencyKey: 'answer-shield',
    commands: [{ command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:shield', server_authoritative: true, campaign_id: 'REACTION-NPC', command_id: 'answer-shield:1' }],
    context: { serverAuthoritativeCombat: true },
  })
  loaded = await eventStore.load('REACTION-NPC')
  assert.equal(loaded.state.mechanics.combat.reaction_window, null)
  assert.equal(loaded.state.players[0].hp, 20, 'Щит отбил удар')

  await runNpcTurnScheduler({ campaignId: 'REACTION-NPC', eventStore, rulesEngine: new RulesEngine({ diceService: dice([]) }) })
  loaded = await eventStore.load('REACTION-NPC')
  assert.equal(activeActor(loaded.state), 'hero', 'планировщик довёл ход врага до конца')
})

test('«сразу» на ходу врага: Щит поднимается в том же ходе, окно не ждёт никого', async (t) => {
  const eventStore = await npcTurnStore(t, { hero: { 'cast:shield': 'auto' } })
  const result = await runNpcTurnScheduler({ campaignId: 'REACTION-NPC', eventStore, rulesEngine: new RulesEngine({ diceService: dice([12, 8]) }) })
  const loaded = await eventStore.load('REACTION-NPC')
  assert.equal(loaded.state.mechanics.combat.reaction_window, null)
  assert.equal(loaded.state.players[0].hp, 20)
  // Реакция героя восстановится в начале его хода, поэтому смотрим на само событие.
  assert.ok(result.events.some((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'cast:shield' && event.payload.reaction_preference === 'auto'))
  assert.equal(activeActor(loaded.state), 'hero', 'ход врага закончился без паузы')
})
