import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { COMBAT_NARRATION_EVENT_TYPES, combatNarration } from '../server/combat-narration.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { DiceService } from '../server/dice-service.mjs'
import {
  MONSTER_SPELL_AT_WILL,
  monsterCombatSpellFor,
  monsterSpellRefusalFor,
  monsterSpellcastingIssues,
} from '../server/combat-spells.mjs'
import {
  LEGENDARY_CONTROL_CONDITIONS,
  chooseLegendaryAction,
  isBossActor,
  legendaryProfileFor,
  legendaryResistanceDecision,
} from '../server/legendary-actions.mjs'
import { planLegendaryAction, planNpcTurn, runNpcTurnScheduler } from '../server/npc-turn-scheduler.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, validateCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

/**
 * Стат-блоки здесь синтетические и в бестиарий не заводятся намеренно.
 *
 * Провайдер портретов недоступен, а сторож `srd-creature-expansion` требует у
 * каждой записи allowlist уникальный портрет 512×512 с зарегистрированными
 * правами. Механика боссов от записи в каталоге не зависит: движок читает
 * `spellcasting` и `legendary` с самого существа, поэтому проверять её честнее
 * на собственных блоках, чем растить бестиарий ради теста.
 */
const NPC_CONTEXT = Object.freeze({ isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true })
const PLAYER = Object.freeze({ id: 'user-1', role: 'player' })

class MaximumRng {
  randint(_minimum, maximum) { return maximum }
}

class MinimumRng {
  randint(minimum) { return minimum }
}

function dice(rng = new MaximumRng()) {
  let id = 0
  return new DiceService({ rng, idFactory: () => `roll-${++id}`, now: () => '2026-08-16T00:00:00.000Z' })
}

function cells(width = 12, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
  }))
}

const SPELLCASTER = Object.freeze({
  ability: 'cha',
  save_dc: 17,
  attack_bonus: 9,
  spells: [
    { id: 'fire-bolt', uses: MONSTER_SPELL_AT_WILL },
    { id: 'hold-person', uses: 1 },
    { id: 'cure-wounds', uses: 2 },
  ],
})

const LEGENDARY = Object.freeze({
  uses: 3,
  resistance: 2,
  actions: [
    { id: 'tail', name: 'Удар хвостом', cost: 1, kind: 'attack', attack_modifier: 9, damage_expression: '2d8+5', damage_type: 'bludgeoning', range_feet: 15 },
    { id: 'wings', name: 'Взмах крыльев', cost: 2, kind: 'save', save_ability: 'dex', save_dc: 17, damage_expression: '2d6+5', damage_type: 'bludgeoning', half_on_save: true, radius_feet: 15 },
  ],
})

/**
 * Порядок инициативы задан так, что герой ходит первым, а босс — вторым:
 * легендарное действие тем и легендарно, что совершается вне своего хода, и
 * проверять его надо ровно в тот момент, когда очередь стоит на герое.
 */
function fixture({ boss = {}, enemies = [], activeIndex = 0, round = 1 } = {}) {
  const bossActor = {
    id: 'boss', name: 'Владыка кургана', hp: 120, maxHp: 120, armor: 18, speed: 30, proficiency: 4, creature_type: 'humanoid',
    abilities: { str: 20, dex: 14, con: 18, int: 16, wis: 15, cha: 19 },
    attackBonus: 9, damageDice: 8, damageBonus: 5, x: 6, y: 2, alive: true,
    action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 9, damage_expression: '2d6+5', damage_type: 'slashing', range_feet: 5 }],
    ...boss,
  }
  const initiative = [
    { actor_id: 'hero', total: 22 },
    { actor_id: 'boss', total: 12 },
    ...enemies.map((enemy, index) => ({ actor_id: enemy.id, total: 8 - index })),
  ]
  return normalizeCampaignState({
    sessionCode: 'BOSS-UNIT',
    partyMemberIds: ['hero', 'ally'],
    members: [{ user_id: 'user-1', hero_id: 'hero', role: 'player' }],
    players: [
      { id: 'hero', name: 'Ильма', hp: 44, maxHp: 44, armor: 16, speed: 30, proficiency: 3, level: 5,
        abilities: { str: 14, dex: 16, con: 14, int: 10, wis: 12, cha: 10 },
        attackBonus: 7, damageDice: 8, damageBonus: 3, x: 4, y: 2 },
      { id: 'ally', name: 'Тарн', hp: 38, maxHp: 38, armor: 15, speed: 30, proficiency: 3, level: 5,
        abilities: { str: 16, dex: 12, con: 15, int: 10, wis: 11, cha: 9 },
        attackBonus: 6, damageDice: 8, damageBonus: 3, x: 5, y: 3 },
    ],
    enemies: [bossActor, ...enemies],
    scene: { turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round, active_index: activeIndex, initiative,
        action_economy: Object.fromEntries([...initiative.map((entry) => [entry.actor_id,
          { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])]),
      },
    },
  })
}

function commit(state, command, { rng = new MaximumRng(), context = NPC_CONTEXT, id = null } = {}) {
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: id ?? `${command.command_type}-${Math.random().toString(36).slice(2, 10)}`, server_authoritative: true, ...command },
    state,
    { diceService: dice(rng), context },
  )
  return { events: result.events, rolls: result.rolls ?? [], state: result.events.reduce(applyGameEvent, state) }
}

function rejects(state, command, code, context = NPC_CONTEXT) {
  assert.throws(
    () => validateCommand({ campaign_id: 'campaign-1', server_authoritative: true, command_id: 'cmd-1', ...command }, state, context),
    (error) => error.code === code,
    `${command.command_type} ожидал ${code}`,
  )
}

const eventTypes = (events) => events.map((event) => event.event_type)
const conditionsOf = (state, id) => (state.mechanics.conditions[id] ?? []).map((condition) => String(condition?.id ?? condition))

/** Следующий ход того же существа: экономика обнуляется, всё прочее остаётся. */
function refreshedTurn(state, id, extra = {}) {
  return normalizeCampaignState({
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: {
        ...state.mechanics.combat,
        ...extra,
        turn_completed: [],
        action_economy: {
          ...state.mechanics.combat.action_economy,
          [id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Стат-блок: что объявлено, то и исполнимо

test('блок заклинаний читается из стат-блока, а не выводится из роли существа', () => {
  const enemy = { id: 'mage', name: 'Маг культа', spellcasting: SPELLCASTER }
  const bolt = monsterCombatSpellFor(enemy, 'fire-bolt')
  assert.equal(bolt.id, 'fire-bolt')
  assert.equal(bolt.slotResource, null, 'у стат-блока нет ячеек: предел записан «X в день»')
  assert.equal(bolt.monsterSpell.saveDc, 17, 'СЛ берётся из блока, а не считается по формуле героя')
  assert.equal(bolt.monsterSpell.attackBonus, 9)
  assert.equal(bolt.monsterSpell.perDay, null, '«неограниченно» — это отсутствие предела')
  assert.equal(monsterCombatSpellFor(enemy, 'hold-person').monsterSpell.perDay, 1)
  assert.equal(monsterCombatSpellFor(enemy, 'fireball'), null, 'чего нет в блоке, того существо не знает')
  assert.equal(monsterCombatSpellFor({ id: 'wolf' }, 'fire-bolt'), null)
})

test('неизвестное каталогу заклинание в стат-блоке — честный отказ, а не тихое «нельзя»', () => {
  const broken = { id: 'mage', spellcasting: { save_dc: 15, attack_bonus: 7, spells: [{ id: 'сглаз-по-кличке', uses: 1 }] } }
  assert.deepEqual(monsterSpellcastingIssues(broken), ['сглаз-по-кличке'])
  assert.deepEqual(monsterSpellRefusalFor(broken, 'сглаз-по-кличке')[1], 'MONSTER_SPELL_UNKNOWN')
  // Отсутствие в блоке и дефект блока — два разных ответа. Иначе опечатка в
  // записи бестиария читалась бы как решение автора не давать заклинание.
  assert.deepEqual(monsterSpellRefusalFor(broken, 'fireball')[1], 'MONSTER_SPELL_NOT_IN_STAT_BLOCK')
  assert.deepEqual(monsterSpellcastingIssues({ id: 'mage', spellcasting: SPELLCASTER }), [])

  const state = fixture({ boss: { spellcasting: broken.spellcasting }, activeIndex: 1 })
  rejects(state, { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'сглаз-по-кличке', target_id: 'hero' }, 'MONSTER_SPELL_UNKNOWN')
})

test('ни одна запись бестиария босса пока не объявляет, но дверь для неё открыта', () => {
  // Утверждение из README и `docs/known-limitations.md` держится тестом, а не
  // памятью: сторож портретов не пускает новых существ, пока недоступен
  // провайдер изображений, поэтому боссов в каталоге нет — и когда появятся,
  // этот тест придётся осознанно переписать вместе с документацией.
  const declared = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)
    .filter(([, block]) => block.spellcasting || block.legendary)
    .map(([id]) => id)
  assert.deepEqual(declared, [], 'запись бестиария с боссом появилась — обновите README и known-limitations')

  // Перенос при сборке встречи объявлен здесь же: без него первая запись с
  // боссом собралась бы молча обычным существом.
  const assembler = readFileSync(new URL('../server/encounter-assembler.mjs', import.meta.url), 'utf8')
  assert.match(assembler, /\.\.\.\(block\.spellcasting \? \{ spellcasting: cloneCatalogValue\(block\.spellcasting\) \} : \{\}\)/u)
  assert.match(assembler, /\.\.\.\(block\.legendary \? \{ legendary: cloneCatalogValue\(block\.legendary\) \} : \{\}\)/u)
})

test('босс — это существо с легендарными действиями, и никакого второго признака у него нет', () => {
  assert.equal(isBossActor({ id: 'boss', legendary: LEGENDARY }), true)
  assert.equal(isBossActor({ id: 'wolf' }), false)
  assert.equal(isBossActor({ id: 'fake', legendary: { uses: 3, actions: [] } }), false, 'пустой список действий боссом не делает')
  assert.equal(isBossActor({ id: 'fake', legendary: { uses: 3, actions: [{ id: 'x', kind: 'телепортация-души' }] } }), false,
    'неисполнимый вид отбрасывается на нормализации, а не отказом посреди боя')
  assert.equal(legendaryProfileFor({ id: 'boss', legendary: LEGENDARY }).actions.length, 2)
})

// ---------------------------------------------------------------------------
// Каст врага: расход, предел и закрытая дверь

test('каст врага тратит применение «X в день» и второй раз за день не проходит', () => {
  const state = fixture({ boss: { spellcasting: SPELLCASTER }, activeIndex: 1 })
  const first = commit(state, { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'hold-person', target_id: 'hero' })
  assert.ok(eventTypes(first.events).includes('SpellCast'))
  assert.deepEqual(conditionsOf(first.state, 'boss'), ['monster-spell-used:hold-person#1'])
  assert.equal(first.events.some((event) => event.event_type === 'ResourceSpent'), false,
    'у стат-блока нет ячеек — тратить нечего')

  rejects(refreshedTurn(first.state, 'boss'), { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'hold-person', target_id: 'hero' }, 'MONSTER_SPELL_USES_SPENT')
  // «Неограниченно» пределом не ограничено ни на первом применении, ни на пятом.
  let unlimited = first.state
  for (let attempt = 0; attempt < 3; attempt += 1) {
    unlimited = commit(refreshedTurn(unlimited, 'boss'), { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'fire-bolt', target_id: 'hero' }).state
  }
  assert.equal(conditionsOf(unlimited, 'boss').filter((condition) => condition.startsWith('monster-spell-used:fire-bolt')).length, 0)
})

test('игрок и администратор не кастуют за врага: дверь открыта только планировщику', () => {
  const state = fixture({ boss: { spellcasting: SPELLCASTER }, activeIndex: 1 })
  const command = { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'fire-bolt', target_id: 'hero' }
  rejects(state, command, 'NPC_SPELL_CAST_FORBIDDEN', { allowedActorIds: ['hero'], serverAuthoritativeCombat: true })
  rejects(state, command, 'NPC_SPELL_CAST_FORBIDDEN', { isAdmin: true, serverAuthoritativeCombat: true })
  rejects(state, command, 'NPC_SPELL_CAST_FORBIDDEN', { serverAuthoritativeCombat: true })
  assert.ok(validateCommand({ campaign_id: 'campaign-1', command_id: 'cmd-1', server_authoritative: true, ...command }, state, NPC_CONTEXT))
})

test('планировщик выбирает заклинание закрытым правилом: лечение, контроль, область, урон', () => {
  const wounded = { id: 'acolyte', name: 'Служка', hp: 6, maxHp: 40, armor: 13, speed: 30, x: 7, y: 2, alive: true,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    action_profiles: [{ id: 'club', name: 'Дубинка', kind: 'melee', attack_modifier: 3, damage_expression: '1d6', damage_type: 'bludgeoning', range_feet: 5 }] }

  const healing = planNpcTurn(fixture({ boss: { spellcasting: SPELLCASTER }, enemies: [wounded], activeIndex: 1 }), 'boss')
  const heal = healing.find((command) => command.command_type === 'CastSpell')
  assert.equal(heal?.spell_id, 'cure-wounds', 'раненый до половины союзник важнее удара')
  assert.equal(heal.target_id, 'acolyte')

  const control = planNpcTurn(fixture({ boss: { spellcasting: SPELLCASTER }, activeIndex: 1 }), 'boss')
  const held = control.find((command) => command.command_type === 'CastSpell')
  assert.equal(held?.spell_id, 'hold-person', 'контроль идёт раньше урона, пока состояния на цели нет')

  // Уже скованную цель сковывать второй раз — выброшенное применение.
  const already = fixture({ boss: { spellcasting: SPELLCASTER }, activeIndex: 1 })
  already.mechanics.conditions.hero = [{ id: 'paralyzed' }]
  already.mechanics.conditions.ally = [{ id: 'paralyzed' }]
  const damage = planNpcTurn(already, 'boss').find((command) => command.command_type === 'CastSpell')
  assert.equal(damage?.spell_id, 'fire-bolt')

  // Исчерпанное «X в день» из плана выпадает так же, как пустой колчан.
  const spent = fixture({ boss: { spellcasting: SPELLCASTER }, activeIndex: 1 })
  spent.mechanics.conditions.boss = [{ id: 'monster-spell-used:hold-person#1' }]
  assert.equal(planNpcTurn(spent, 'boss').find((command) => command.command_type === 'CastSpell')?.spell_id, 'fire-bolt')
})

test('область не летит в своих: Огненный шар по собственному отряду планом не становится', () => {
  const blaster = { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [{ id: 'fireball', uses: 2 }] }
  const apart = fixture({ boss: { spellcasting: blaster, x: 11, y: 5 }, activeIndex: 1 })
  const cast = planNpcTurn(apart, 'boss').find((command) => command.command_type === 'CastSpell')
  assert.equal(cast?.spell_id, 'fireball', 'двое героев рядом — область стоит своего применения')
  // Обе клетки накрывают двоих, и выбор между ними закрыт меньшим
  // идентификатором: повтор плана обязан дать ту же клетку.
  assert.deepEqual(cast.to, { x: 5, y: 3 })

  const crowded = fixture({
    boss: { spellcasting: blaster, x: 11, y: 5 },
    enemies: [{ id: 'thrall', name: 'Прислужник', hp: 20, maxHp: 20, armor: 12, speed: 30, x: 5, y: 2, alive: true,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 3, damage_expression: '1d4', damage_type: 'slashing', range_feet: 5 }] }],
    activeIndex: 1,
  })
  assert.equal(planNpcTurn(crowded, 'boss').some((command) => command.command_type === 'CastSpell'), false,
    'свой в радиусе закрывает область целиком')
})

// ---------------------------------------------------------------------------
// Легендарные действия

test('легендарное действие тратится вне своего хода, а в свой ход — отказ', () => {
  const state = fixture({ boss: { legendary: LEGENDARY } })
  const command = { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' }
  const result = commit(state, command)
  assert.deepEqual(eventTypes(result.events).slice(0, 2), ['ConditionAdded', 'LegendaryActionUsed'])
  assert.deepEqual(conditionsOf(result.state, 'boss'), ['legendary-action-used:1:r1i0'])
  assert.ok(eventTypes(result.events).includes('AttackResolved'))
  assert.ok(eventTypes(result.events).includes('DamageApplied'))
  assert.equal(result.state.mechanics.combat.action_economy.boss.action, true,
    'экономика собственного хода легендарным действием не тратится — в этом и правило')

  const ownTurn = fixture({ boss: { legendary: LEGENDARY }, activeIndex: 1 })
  rejects(ownTurn, command, 'LEGENDARY_ACTION_OWN_TURN')
  rejects(state, command, 'LEGENDARY_ACTION_FORBIDDEN', { isAdmin: true, serverAuthoritativeCombat: true })
  rejects(state, { ...command, legendary_action_id: 'дыхание-бездны' }, 'LEGENDARY_ACTION_UNKNOWN')
  rejects(fixture({ boss: {} }), command, 'LEGENDARY_ACTIONS_ABSENT')

  // Вторая дверь — HTTP: команда не входит ни в один набор, принимаемый от
  // браузера, поэтому до движка она оттуда не доходит вовсе. Отказ выше — это
  // сторож на случай, если набор когда-нибудь расширят.
  const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')
  assert.equal(server.includes('UseLegendaryAction'), false, 'легендарное действие не принимается по HTTP ни от кого')
})

test('одно окно — одно действие, а весь запас кончается и восстанавливается началом хода босса', () => {
  const state = fixture({ boss: { legendary: LEGENDARY } })
  const command = { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' }
  const first = commit(state, command)
  rejects(first.state, command, 'LEGENDARY_ACTION_WINDOW_SPENT')
  assert.equal(planLegendaryAction(first.state, 'boss'), null, 'планировщик не предлагает того, на что движок ответит отказом')

  // Следующее окно — следующий чужой ход. Дорогое действие берётся первым:
  // придерживать его не за чем, запас всё равно сгорит в начале своего хода.
  const nextWindow = normalizeCampaignState({ ...first.state, mechanics: { ...first.state.mechanics, combat: { ...first.state.mechanics.combat, active_index: 2 } } })
  const planned = planLegendaryAction(nextWindow, 'boss')
  assert.equal(planned.legendary_action_id, 'wings')
  const second = commit(nextWindow, planned)
  assert.deepEqual(conditionsOf(second.state, 'boss').sort(), ['legendary-action-used:1:r1i0', 'legendary-action-used:2:r1i2', 'legendary-action-used:3:r1i2'])

  const third = normalizeCampaignState({ ...second.state, mechanics: { ...second.state.mechanics, combat: { ...second.state.mechanics.combat, active_index: 3 } } })
  rejects(third, command, 'LEGENDARY_ACTIONS_SPENT')
  assert.equal(planLegendaryAction(third, 'boss'), null)

  // Начало хода босса возвращает запас — и только его: суточное сопротивление
  // кругом боя не восстанавливается.
  const exhausted = normalizeCampaignState({
    ...third,
    mechanics: { ...third.mechanics, conditions: { ...third.mechanics.conditions, boss: [...(third.mechanics.conditions.boss ?? []), { id: 'legendary-resistance-used:1' }] },
      combat: { ...third.mechanics.combat, active_index: 0 } },
  })
  const turn = commit(exhausted, { command_type: 'EndTurn', actor_id: 'hero' })
  assert.ok(eventTypes(turn.events).includes('LegendaryActionsReset'))
  assert.deepEqual(conditionsOf(turn.state, 'boss'), ['legendary-resistance-used:1'])
})

test('площадное легендарное действие бьёт всех в радиусе и щадит устоявших наполовину', () => {
  const state = fixture({ boss: { legendary: LEGENDARY } })
  const result = commit(state, { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'wings', target_id: 'hero' }, { rng: new MinimumRng() })
  const saves = result.events.filter((event) => event.event_type === 'SavingThrowResolved')
  assert.deepEqual(saves.map((event) => event.target_ids[0]).sort(), ['ally', 'hero'], 'взмах крыльев не выбирает, кого задеть')
  assert.equal(result.events.filter((event) => event.event_type === 'DamageApplied').length, 2)
  assert.deepEqual(conditionsOf(result.state, 'boss').sort(), ['legendary-action-used:1:r1i0', 'legendary-action-used:2:r1i0'],
    'действие за две единицы тратит две — пипсы и replay считают одинаково')
})

// ---------------------------------------------------------------------------
// Легендарное сопротивление

test('легендарное сопротивление жжётся по правилу — на контроль и на смертельное, и кончается', () => {
  const control = legendaryResistanceDecision({ actor: { legendary: LEGENDARY }, spentUses: 0, conditions: ['paralyzed'], damage: 0, hpBefore: 120 })
  assert.equal(control.reason, 'control')
  const lethal = legendaryResistanceDecision({ actor: { legendary: LEGENDARY }, spentUses: 0, conditions: [], damage: 130, hpBefore: 120 })
  assert.equal(lethal.reason, 'lethal')
  assert.equal(legendaryResistanceDecision({ actor: { legendary: LEGENDARY }, spentUses: 0, conditions: [], damage: 9, hpBefore: 120 }), null,
    'половина урона от одной стрелы суточного ресурса не стоит')
  assert.equal(legendaryResistanceDecision({ actor: { legendary: LEGENDARY }, spentUses: 2, conditions: ['stunned'], hpBefore: 120 }), null, 'запас кончается')
  assert.equal(legendaryResistanceDecision({ actor: { legendary: { ...LEGENDARY, resistance: 0 } }, conditions: ['stunned'], hpBefore: 120 }), null)
  assert.ok(LEGENDARY_CONTROL_CONDITIONS.includes('paralyzed') && LEGENDARY_CONTROL_CONDITIONS.includes('stunned'))
})

test('провал спасброска босса объявляется успехом, пока запас есть', () => {
  const caster = fixture({ boss: { legendary: LEGENDARY } })
  caster.players[0].characterClass = 'wizard'
  caster.players[0].level = 5
  caster.players[0].knownSpellIds = ['hold-person']
  caster.players[0].preparedSpellIds = ['hold-person']
  const command = { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'hold-person', target_id: 'boss' }
  const first = commit(caster, command, { rng: new MinimumRng(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  const save = first.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.saved, true, 'провал объявляется успехом')
  assert.equal(save.payload.legendary_resistance, true)
  assert.ok(eventTypes(first.events).includes('LegendaryResistanceUsed'))
  assert.equal(first.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'paralyzed'), false)
  assert.deepEqual(conditionsOf(first.state, 'boss'), ['legendary-resistance-used:1'])

  // Второе применение — последнее: третий провал ложится как есть.
  const second = commit(refreshedTurn(first.state, 'hero'), command, { rng: new MinimumRng(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.deepEqual(conditionsOf(second.state, 'boss').sort(), ['legendary-resistance-used:1', 'legendary-resistance-used:2'])
  const third = commit(refreshedTurn(second.state, 'hero'), command, { rng: new MinimumRng(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
  assert.equal(third.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.saved, false)
  assert.equal(third.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'paralyzed'), true)
})

// ---------------------------------------------------------------------------
// Replay и проекция

test('легендарные действия и каст врага переживают replay без расхождений', () => {
  const state = fixture({ boss: { legendary: LEGENDARY, spellcasting: SPELLCASTER } })
  const legendary = commit(state, { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' })
  const spell = commit(
    normalizeCampaignState({ ...legendary.state, mechanics: { ...legendary.state.mechanics, combat: { ...legendary.state.mechanics.combat, active_index: 1 } } }),
    { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'hold-person', target_id: 'hero' },
  )
  const all = [...legendary.events, ...spell.events]
  assert.deepEqual(
    replayEvents(state, all).mechanics.conditions.boss.map((condition) => condition.id).sort(),
    ['legendary-action-used:1:r1i0', 'monster-spell-used:hold-person#1'],
  )
  // Повтор той же свёртки даёт то же состояние: маркеры идемпотентны по имени.
  assert.deepEqual(replayEvents(state, all).enemies[0].hp, replayEvents(state, [...all, ...all]).enemies[0].hp)
})

test('проекция чиста: блок заклинаний, СЛ и бухгалтерия запаса до игрока не доезжают', () => {
  const state = fixture({ boss: { legendary: LEGENDARY, spellcasting: SPELLCASTER } })
  const legendary = commit(state, { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' })
  const spell = commit(
    normalizeCampaignState({ ...legendary.state, mechanics: { ...legendary.state.mechanics, combat: { ...legendary.state.mechanics.combat, active_index: 1 } } }),
    { command_type: 'CastSpell', actor_id: 'boss', spell_id: 'hold-person', target_id: 'hero' },
  )
  const room = campaignStateForViewer(spell.state, PLAYER, 'hero')
  const events = mechanicsForViewer([...legendary.events, ...spell.events], PLAYER, 'hero', spell.state)

  // Поверхности берутся адресно, а не всей комнатой: у благословений отряда
  // есть свой честный `attack_bonus`, и общий поиск по всему срезу нашёл бы
  // его вместо чужого. Ищется то, что принадлежит противнику.
  const enemySurfaces = { enemies: room.enemies, conditions: room.mechanics.conditions, resources: room.mechanics.resources }
  for (const [label, surface] of [['состояние кампании', enemySurfaces], ['события', events]]) {
    const json = JSON.stringify(surface)
    for (const secret of ['spellcasting', 'save_dc', 'attack_bonus', 'monster-spell-used', 'legendary-action-used', 'legendary-resistance-used', 'legendary_action_id']) {
      assert.equal(json.includes(secret), false, `${label}: утекло ${secret}`)
    }
    // СЛ 17 и бонус атаки 9 ищутся значениями полей, а не подстрокой.
    for (const number of [17, 9]) {
      assert.doesNotMatch(json, new RegExp(`"(?:difficulty|save_dc|attack_bonus)"\\s*:\\s*${number}(?=\\s*[,}])`, 'u'), `${label}: утекло число ${number}`)
    }
  }
  // Ключи, которых в честном срезе нет ни у кого, ищутся по всей комнате:
  // адресная выборка выше сторожит только те карты, которые я назвал, а блок
  // заклинаний мог бы всплыть в любой соседней — например во frozen-копии
  // состава встречи.
  const wholeRoom = JSON.stringify(room)
  for (const secret of ['spellcasting', 'monster-spell-used', 'legendary-action-used', 'legendary-resistance-used', 'legendary_action_id']) {
    assert.equal(wholeRoom.includes(secret), false, `весь срез комнаты: утекло ${secret}`)
  }
  const savingThrow = events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(savingThrow.payload.difficulty, undefined, 'СЛ заклинаний босса игроку не принадлежит')
  assert.equal(typeof savingThrow.payload.saved, 'boolean', 'а исход — принадлежит')
  assert.equal(events.some((event) => event.event_type === 'ConditionAdded'
    && String(event.payload.condition ?? '').startsWith('legendary-')), false, 'служебные маркеры не всплывают над клеткой')
  assert.deepEqual(room.mechanics.conditions.boss ?? [], [], 'бухгалтерия запаса состоянием тоже не уезжает')
})

test('карточка босса уезжает игроку рамкой и пипсами, но без единого числа стат-блока', () => {
  const state = fixture({ boss: { legendary: LEGENDARY, spellcasting: SPELLCASTER } })
  const plain = campaignStateForViewer(state, PLAYER, 'hero').enemies[0]
  assert.equal(plain.boss, true)
  assert.deepEqual(plain.legendary, { uses: 3, used: 0 })
  assert.equal(plain.hp, undefined, 'пипсы — качественная величина, точные ОЗ ею не становятся')

  const used = commit(state, { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'wings', target_id: 'hero' })
  const spent = campaignStateForViewer(used.state, PLAYER, 'hero').enemies[0]
  assert.deepEqual(spent.legendary, { uses: 3, used: 2 })

  const ordinary = campaignStateForViewer(fixture({ boss: {} }), PLAYER, 'hero').enemies[0]
  assert.equal(ordinary.boss, undefined, 'обычное существо рамки босса не получает')
  assert.equal(ordinary.legendary, undefined)
})

test('босс бьёт после чужого хода, а не посреди него, и одним действием на окно', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-boss-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = () => new RulesEngine({ diceService: dice(new MaximumRng()) })
  const store = async (name) => {
    const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
    await eventStore.initializeCampaign({ campaign_id: name, initial_state: fixture({ boss: { legendary: LEGENDARY } }) })
    return eventStore
  }

  // Середина чужого хода: герой сходил, но ход не закрыл. `advanceNpc: false`
  // — ровно этот случай (`server/index.mjs` поднимает флаг только на
  // `EndTurn`, начале боя и разрешённой реакции), и легендарное действие здесь
  // означало бы удар между шагом героя и его же атакой.
  const mid = await runNpcTurnScheduler({ campaignId: 'BOSS-MID', eventStore: await store('BOSS-MID'), rulesEngine: engine(), advanceNpc: false })
  assert.deepEqual(mid.turns, [], 'посреди чужого хода босс не действует')
  assert.deepEqual(mid.events, [])

  // Ход кончился — окно открылось. Действие ровно одно: второй проход
  // планировщика по тому же состоянию его не повторяет и цикл не наматывает.
  const eventStore = await store('BOSS-WINDOW')
  const opened = await runNpcTurnScheduler({ campaignId: 'BOSS-WINDOW', eventStore, rulesEngine: engine(), advanceNpc: true })
  const legendary = opened.turns.filter((turn) => turn.kind === 'legendary-action')
  assert.equal(legendary.length, 1, 'одно окно — одно легендарное действие')
  assert.equal(legendary[0].actor_id, 'boss')
  assert.ok(opened.events.some((event) => event.event_type === 'LegendaryActionUsed'))
  const again = await runNpcTurnScheduler({ campaignId: 'BOSS-WINDOW', eventStore, rulesEngine: engine(), advanceNpc: true })
  assert.deepEqual(again.turns.filter((turn) => turn.kind === 'legendary-action'), [], 'повтор прохода второго действия не выдаёт')
})

test('боевой текст называет удар вне очереди и устоявшего босса — качественно и без чисел', () => {
  const state = fixture({ boss: { legendary: LEGENDARY } })
  const result = commit(state, { command_type: 'UseLegendaryAction', actor_id: 'boss', legendary_action_id: 'tail', target_id: 'hero' })
  const text = combatNarration(result.events, result.state)
  assert.match(text, /Вне очереди: Владыка кургана — «Удар хвостом»/u)
  // Урон и КД в тексте боя были и остаются — закрыта именно бухгалтерия
  // запаса: цена действия и остаток читаются пипсами, а не строкой.
  assert.doesNotMatch(text, /(?:стоимость|цена|осталось|запас)/u, 'цена и остаток запаса в текст не уходят')

  const resistance = combatNarration([{
    event_type: 'LegendaryResistanceUsed', actor_id: 'hero', target_ids: ['boss'], visibility: 'public',
    payload: { reason: 'control', condition: 'paralyzed' },
  }], state)
  assert.match(resistance, /Владыка кургана стряхивает с себя чары/u)
  assert.match(combatNarration([{
    event_type: 'LegendaryResistanceUsed', actor_id: 'hero', target_ids: ['boss'], visibility: 'public', payload: { reason: 'lethal' },
  }], state), /должен был пасть — и устоял/u)
  for (const type of ['LegendaryActionUsed', 'LegendaryActionsReset', 'LegendaryResistanceUsed']) {
    assert.ok(COMBAT_NARRATION_EVENT_TYPES.has(type), `рассказчик не знает про ${type}`)
  }
})

test('выбор легендарного действия детерминирован и не тратит запас на недосягаемое', () => {
  const boss = { id: 'boss', legendary: LEGENDARY }
  const near = chooseLegendaryAction({ actor: boss, remainingUses: 3, targets: [{ id: 'hero', distanceFeet: 10 }, { id: 'ally', distanceFeet: 5 }] })
  assert.equal(near.action.id, 'wings', 'двое в радиусе — дорогое действие берётся первым')
  assert.equal(near.target_id, 'ally')
  const single = chooseLegendaryAction({ actor: boss, remainingUses: 3, targets: [{ id: 'hero', distanceFeet: 10 }] })
  assert.equal(single.action.id, 'tail', 'одиночная цель дорогого взмаха не стоит')
  assert.equal(chooseLegendaryAction({ actor: boss, remainingUses: 1, targets: [{ id: 'hero', distanceFeet: 10 }] }).action.id, 'tail')
  assert.equal(chooseLegendaryAction({ actor: boss, remainingUses: 3, targets: [{ id: 'hero', distanceFeet: 90 }] }), null)
  assert.equal(chooseLegendaryAction({ actor: boss, remainingUses: 0, targets: [{ id: 'hero', distanceFeet: 5 }] }), null)
})
