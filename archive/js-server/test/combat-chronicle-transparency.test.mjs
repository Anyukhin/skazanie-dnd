import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { enemyLoadoutFor } from '../server/enemy-loadouts.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

/**
 * Сторож прозрачности боевой хроники.
 *
 * Повод — живая партия: багбир метнул копьё с 25 футов, событие честно несло и
 * название действия, и вид урона, а строка журнала напечатала «атакует», и стол
 * принял дальний бросок за удар вплотную. Причина была не в тексте: сервер
 * вообще не называл вид атаки. Флаг `thrown` рядом описывает **режим оружия
 * героя** и у действия существа не заполняется никогда.
 *
 * Здесь проверяется серверная половина: вид атаки одним словом для обеих
 * сторон стола, расстояние и признак дальнего выстрела — и то, что все три
 * доезжают до игрока, ничего закрытого за собой не притащив. Клиентскую
 * половину держит `test/battle-event-text.test.mjs`.
 */

const NPC_CONTEXT = { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true }
const HERO_CONTEXT = { serverAuthoritativeCombat: true, isAdmin: true }

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `chronicle-roll-${++id}`, now: () => '2026-08-21T12:00:00.000Z' })
}

function cells(width = 40, height = 3) {
  return Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
}

const SWORD = {
  id: 'sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon', quantity: 1,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
}
const JAVELIN = {
  id: 'javelin', catalog_id: 'srd_5_2_1:javelin', name: 'Дротик', type: 'weapon', quantity: 1,
  combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'piercing', normalRange: 30 },
}
const BOW = {
  id: 'bow', catalog_id: 'srd_5_2_1:longbow', name: 'Длинный лук', type: 'weapon', quantity: 1,
  combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600, ammunition: true },
}
const ARROWS = {
  id: 'arrows', catalog_id: 'srd_5_2_1:arrows-20', name: 'Стрелы (20)', type: 'consumable', quantity: 1,
  charges: { current: 20, max: 20 },
}

/**
 * Герой в (0,0), противник в `enemyAt`. Клетка — 5 футов. Оружие в руках
 * называется параметром: смена экипированного клинка стоит действия, и без
 * этого половина проверок падала бы на `WEAPON_SWAP_REQUIRED`, не дойдя до
 * проверяемого поля.
 */
function heroBattle({ enemyAt = { x: 1, y: 0 }, enemyKnown = false, equipped = 'sword' } = {}) {
  const inventory = [SWORD, JAVELIN, BOW, ARROWS].map((item) => item.type === 'weapon'
    ? { ...item, equipped: item.id === equipped }
    : item)
  return normalizeCampaignState({
    sessionCode: 'CHRON-1',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Мирра', characterClass: 'ranger', level: 5, hp: 40, maxHp: 40,
      armor: 15, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 16, con: 14, int: 10, wis: 12, cha: 10 },
      inventory, x: 0, y: 0,
    }],
    enemies: [{
      id: 'goblin', name: 'Гоблин 2', creature_type: 'humanoid', hp: 20, maxHp: 20, armor: 13, speed: 30,
      abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
      x: enemyAt.x, y: enemyAt.y, alive: true,
    }],
    scene: { title: 'Тракт', location: 'Тракт', turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'goblin', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
      ...(enemyKnown ? { enemy_knowledge: { goblin: { hp: 'exact', armor_class: 'exact' } } } : {}),
    },
  })
}

/** Багбир из того самого случая: копьё в стат-блоке записано дальним действием. */
function bugbearBattle({ enemyAt = { x: 5, y: 0 } } = {}) {
  const statBlockId = 'srd_5_2_1:bugbear'
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return normalizeCampaignState({
    sessionCode: 'CHRON-2',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Тэсса', characterClass: 'fighter', level: 5, hp: 30, maxHp: 30,
      armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [], x: 0, y: 0,
    }],
    enemies: [{
      id: 'foe', name: 'Багбир 1', creature_type: block.creature_type,
      hp: block.hp, maxHp: block.hp, armor: block.armor, speed: block.speed,
      abilities: { ...block.abilities },
      x: enemyAt.x, y: enemyAt.y, alive: true,
      stat_block_id: statBlockId,
      action_profiles: block.action_profiles,
      traits: block.traits ?? [],
      loadout: enemyLoadoutFor({ statBlockId, block, ownerId: 'foe', seed: 'chronicle' }),
    }],
    scene: { title: 'Тракт', location: 'Тракт', turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'foe', total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

function strike(state, command, { values = [12, 4], context = HERO_CONTEXT } = {}) {
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: `attack-${Math.random().toString(36).slice(2, 10)}`, server_authoritative: true, ...command },
    state,
    { diceService: dice(values), context },
  )
  const payload = result.events.find((event) => event.event_type === 'AttackResolved')?.payload
  assert.ok(payload, 'команда обязана дать подтверждённую атаку')
  return { payload, state: result.events.reduce(applyGameEvent, state) }
}

const lastAttack = (state) => state.battleLog.filter((entry) => entry.type === 'attack').at(-1)

test('удар героя оружием в упор называется ближним', () => {
  const { payload, state } = strike(heroBattle(), { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'sword' })
  assert.equal(payload.attack_kind, 'melee')
  assert.equal(payload.distance_feet, 5)
  assert.equal(payload.long_range, false)

  const entry = lastAttack(state)
  assert.equal(entry.attackKind, 'melee')
  assert.equal(entry.distanceFeet, 5)
  assert.equal(entry.longRange, undefined, 'у ближнего удара признака дальнего выстрела быть не может')
  assert.equal(entry.itemName, 'Длинный меч')
})

test('то же оружие в метательном режиме называется броском, а не выстрелом', () => {
  const { payload, state } = strike(
    heroBattle({ enemyAt: { x: 4, y: 0 }, equipped: 'javelin' }),
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'javelin', attack_mode: 'thrown' },
  )
  // Режим у метательного оружия ранговый (`kind: 'ranged'`), и один `kind`
  // спутал бы брошенный дротик с выстрелом из лука. Различает их `thrown`.
  assert.equal(payload.attack_kind, 'thrown')
  assert.equal(payload.thrown, true)
  assert.equal(payload.distance_feet, 20)
  assert.equal(lastAttack(state).attackKind, 'thrown')
})

test('тот же дротик в руке остаётся ближним ударом', () => {
  const { payload } = strike(heroBattle({ equipped: 'javelin' }), { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'javelin', attack_mode: 'melee' })
  assert.equal(payload.attack_kind, 'melee')
  assert.equal(payload.thrown, undefined)
})

test('выстрел за обычную дальность помечен и видом атаки, и помехой', () => {
  const { payload, state } = strike(
    heroBattle({ enemyAt: { x: 35, y: 0 }, equipped: 'bow' }),
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'bow' },
    { values: [12, 9, 4] },
  )
  assert.equal(payload.attack_kind, 'ranged')
  assert.equal(payload.distance_feet, 175)
  assert.equal(payload.long_range, true)
  assert.equal(payload.mode, 'disadvantage')
  assert.ok(payload.disadvantage_sources.includes('дальний диапазон'))

  const entry = lastAttack(state)
  assert.equal(entry.attackKind, 'ranged')
  assert.equal(entry.distanceFeet, 175)
  assert.equal(entry.longRange, true)
  assert.ok(entry.disadvantageReasons.includes('дальний диапазон'))
})

test('копьё багбира с 25 футов приезжает броском, а не безымянной атакой', () => {
  const state = bugbearBattle()
  const javelin = state.enemies[0].action_profiles.find((profile) => profile.id === 'javelin')
  assert.ok(javelin, 'в стат-блоке багбира обязано быть метательное копьё')
  assert.equal(javelin.kind, 'ranged', 'стат-блок называет копьё дальним действием — на этом и сломалась хроника')

  const { payload, state: after } = strike(
    state,
    { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'javelin' },
    { context: NPC_CONTEXT },
  )
  assert.equal(payload.attack_kind, 'thrown')
  assert.equal(payload.distance_feet, 25)
  assert.equal(payload.action_name, 'Метательное копьё')
  // Флаг режима оружия героя у действия существа по-прежнему пуст: именно
  // поэтому вид атаки едет отдельным полем, а не выводится из него.
  assert.equal(payload.thrown, undefined)

  const entry = lastAttack(after)
  assert.equal(entry.attackKind, 'thrown')
  assert.equal(entry.distanceFeet, 25)
  assert.equal(entry.actionName, 'Метательное копьё')
  assert.equal(entry.damageType, 'piercing')
})

test('ближнее действие того же существа остаётся ближним', () => {
  const { payload } = strike(
    bugbearBattle({ enemyAt: { x: 1, y: 0 } }),
    { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'morningstar' },
    { context: NPC_CONTEXT, values: [12, 4, 4, 4, 4, 4, 4] },
  )
  assert.equal(payload.attack_kind, 'melee')
})

test('вид атаки и расстояние доезжают до стола, а закрытое остаётся закрытым', () => {
  const { state } = strike(
    bugbearBattle(),
    { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'hero', action_id: 'javelin' },
    { context: NPC_CONTEXT },
  )
  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  const entry = projected.battleLog.filter((item) => item.type === 'attack').at(-1)

  // Новое — публично: стол видит бросок, расстояние и имя действия.
  assert.equal(entry.attackKind, 'thrown')
  assert.equal(entry.distanceFeet, 25)
  assert.equal(entry.actionName, 'Метательное копьё')
  assert.equal(entry.damageType, 'piercing')
  // Старая граница не сдвинулась: модификатор атаки существа — число его
  // стат-блока, и проекция по-прежнему оставляет один итог.
  assert.deepEqual(Object.keys(entry.roll).sort(), ['hit', 'total'])
  assert.equal(entry.roll.die, undefined)
  assert.equal(entry.roll.modifier, undefined)
  assert.equal(entry.rollDice, undefined)
  // И ничего из закрытого инвентаря существа: привязка к вещи каталога
  // участвует только в вычислении вида атаки и наружу не выходит.
  const serialized = JSON.stringify(entry)
  assert.equal(serialized.includes('catalog_id'), false)
  assert.equal(serialized.includes('srd_5_2_1'), false)
  assert.equal(entry.itemId, undefined)
  assert.equal(entry.itemName, undefined)
})

test('КД неопознанного противника не открывается вместе с расстоянием', () => {
  const { state } = strike(
    heroBattle({ enemyAt: { x: 4, y: 0 }, equipped: 'javelin' }),
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'goblin', item_id: 'javelin', attack_mode: 'thrown' },
  )
  const projected = campaignStateForViewer(state, { role: 'player', heroIds: ['hero'] }, 'hero')
  const entry = projected.battleLog.filter((item) => item.type === 'attack').at(-1)

  assert.equal(entry.attackKind, 'thrown')
  assert.equal(entry.distanceFeet, 20)
  assert.equal(entry.roll.difficulty, undefined, 'КД неопознанного противника закрыт как и прежде')
  assert.equal(entry.hpAfter, undefined)
})

test('реакция уезжает в журнал вместе со своим именем', () => {
  const state = normalizeCampaignState({
    sessionCode: 'CHRON-3',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 20, maxHp: 30, abilities: {} }],
    enemies: [],
    scene: { turn: 1, cells: [] },
    battleLog: [],
    mechanics: { combat: { active: true, round: 1, initiative: [], active_index: -1, action_economy: {}, reaction_window: null } },
  })
  const after = applyGameEvent(state, {
    event_id: 'reaction-1',
    command_id: 'reaction-command',
    event_type: 'ReactionDamageReduced',
    actor_id: 'hero',
    target_ids: ['hero'],
    payload: { action_id: 'uncanny-dodge', name: 'Невероятное уклонение', prevented_amount: 5, hp_after: 20 },
  })
  const entry = after.battleLog.at(-1)
  assert.equal(entry.type, 'reaction')
  assert.equal(entry.actionId, 'uncanny-dodge')
  assert.equal(entry.actionName, 'Невероятное уклонение')
  assert.equal(entry.preventedDamage, 5)
})

test('областной бросок называет СЛ спасброска и вид урона', () => {
  const state = normalizeCampaignState({
    sessionCode: 'CHRON-4',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', characterClass: 'rogue', level: 3, hp: 24, maxHp: 24, armor: 14, speed: 30, proficiency: 2,
      abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 12, cha: 10 },
      x: 0, y: 0,
      inventory: [{
        id: 'bomb', name: 'Алхимическая граната', type: 'consumable', quantity: 2,
        combat: { kind: 'thrown-area', ability: 'dex', damage: '2d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex', saveDc: 12, halfOnSave: true },
      }],
    }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 12, maxHp: 12, armor: 13, abilities: { dex: 12 }, x: 4, y: 0, alive: true }],
    scene: { title: 'Тракт', location: 'Тракт', turn: 1, cells: cells() },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'goblin', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: 'area-1', server_authoritative: true, command_type: 'MakeAreaAttack', actor_id: 'hero', item_id: 'bomb', to: { x: 4, y: 0 } },
    state,
    { diceService: dice([4, 4, 10]), context: HERO_CONTEXT },
  )
  const payload = result.events.find((event) => event.event_type === 'AreaAttackResolved').payload
  assert.equal(payload.save_ability, 'dex')
  assert.equal(payload.save_dc, 12)
  assert.equal(payload.damage_type, 'fire')

  const entry = result.events.reduce(applyGameEvent, state).battleLog.find((item) => item.type === 'area-attack')
  assert.equal(entry.ability, 'dex')
  assert.equal(entry.savingThrowDifficulty, 12)
  assert.equal(entry.damageType, 'fire')
})

test('запись боя, сыгранного до этой правки, остаётся собой', () => {
  // Реплей старого события не выдумывает ни вида атаки, ни расстояния: полей в
  // нём нет, и хроника обязана вернуться к прежней нейтральной строке.
  const state = normalizeCampaignState({
    sessionCode: 'CHRON-5',
    players: [{ id: 'hero', character: 'Ада', hp: 20, maxHp: 20, abilities: {} }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10, armor: 13, alive: true }],
    scene: { turn: 1, cells: [] },
    battleLog: [],
    mechanics: { combat: { active: true, round: 1, initiative: [], active_index: -1, action_economy: {}, reaction_window: null } },
  })
  const after = applyGameEvent(state, {
    event_id: 'legacy-attack',
    command_id: 'legacy-command',
    event_type: 'AttackResolved',
    actor_id: 'hero',
    target_ids: ['goblin'],
    payload: { kept: 14, modifier: 4, total: 18, armor_class: 16, hit: true },
  })
  const entry = after.battleLog.at(-1)
  assert.equal(entry.attackKind, undefined)
  assert.equal(entry.distanceFeet, undefined)
  assert.equal(entry.longRange, undefined)
})
