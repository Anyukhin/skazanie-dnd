/**
 * Расход боеприпасов у героя.
 *
 * До 2026-08-18 асимметрия была прямая: пустой колчан закрывал дальнее действие
 * противника (`server/npc-equipment.mjs`), а герой стрелял бесконечно. Здесь
 * проверяется, что оба стреляют по одному правилу: выстрел снимает снаряд,
 * промах тратит его наравне с попаданием, пустой колчан закрывает атаку до
 * броска, а выпущенная стрела не воскресает при повторе.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { AMMUNITION_BY_WEAPON } from '../server/enemy-loadouts.mjs'
import {
  AMMUNITION_CATALOG_BY_WEAPON,
  ammunitionShotsLeft,
  itemViewerCapabilities,
  materializeCatalogItem,
} from '../server/item-catalog.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `ammunition-roll-${++id}`,
    now: () => '2026-08-18T12:00:00.000Z',
  })
}

const authoritative = (values = []) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true } })
const applyAll = (state, events) => events.reduce(applyGameEvent, state)

const BOW = () => ({ ...materializeCatalogItem('srd_5_2_1:shortbow', { id: 'bow' }), equipped: true })
const QUIVER = (overrides = {}) => materializeCatalogItem('srd_5_2_1:arrows-20', { id: 'quiver', quantity: 1, ...overrides })

function archerState({ inventory = [BOW(), QUIVER()] } = {}) {
  const cells = Array.from({ length: 6 * 3 }, (_, index) => ({
    x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'AMMUNITION',
    partyMemberIds: ['archer'],
    players: [{
      id: 'archer', character: 'Лира', characterClass: 'ranger', role: 'Следопыт · ур. 3', level: 3,
      hp: 24, maxHp: 24, armor: 14, speed: 30, proficiency: 2,
      abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 14, cha: 10 },
      inventory, x: 0, y: 1,
    }],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 20, maxHp: 20, armor: 12, speed: 30, alive: true, x: 4, y: 1 }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1,
        initiative: [{ actor_id: 'archer', total: 18 }, { actor_id: 'goblin', total: 10 }],
        active_index: 0,
        action_economy: { archer: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const shoot = { command_type: 'MakeAttack', actor_id: 'archer', target_id: 'goblin', item_id: 'bow', server_authoritative: true }
const quiverOf = (state) => state.players[0].inventory.find((item) => item.catalog_id === 'srd_5_2_1:arrows-20') ?? null

test('таблица «оружие → боеприпас» одна и та же для героя и для существа', () => {
  // Каталог не может импортировать `enemy-loadouts` (тот сам импортирует
  // каталог), поэтому таблиц две. Разойдись они — герой и разведчик стреляли бы
  // разными стрелами из одного и того же лука.
  assert.deepEqual({ ...AMMUNITION_CATALOG_BY_WEAPON }, { ...AMMUNITION_BY_WEAPON })
})

test('выстрел снимает одну стрелу, а не пачку', () => {
  const state = archerState()
  const result = resolveCommand(shoot, state, authoritative([18, 5]))
  const attack = result.events.find((event) => event.event_type === 'AttackResolved')
  const spent = result.events.find((event) => event.event_type === 'AmmunitionSpent')

  assert.equal(attack.payload.hit, true)
  assert.equal(spent.payload.owner_id, 'archer')
  assert.equal(spent.payload.catalog_id, 'srd_5_2_1:arrows-20')
  assert.equal(spent.payload.weapon_item_id, 'bow')
  assert.deepEqual(
    [spent.payload.shots_before, spent.payload.shots_after, spent.payload.quantity_after, spent.payload.capacity_after],
    [20, 19, 1, 20],
  )

  const after = applyAll(state, result.events)
  assert.equal(quiverOf(after).quantity, 1, 'пачка остаётся в сумке')
  assert.equal(ammunitionShotsLeft(quiverOf(after)), 19)
})

test('промах тратит стрелу наравне с попаданием', () => {
  const state = archerState()
  const result = resolveCommand(shoot, state, authoritative([2]))
  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
  assert.equal(result.events.find((event) => event.event_type === 'AmmunitionSpent').payload.shots_after, 19)
})

test('пустой колчан закрывает выстрел до броска и с названной причиной', () => {
  const state = archerState({ inventory: [BOW()] })
  const before = structuredClone(state)
  assert.throws(
    () => resolveCommand(shoot, state, authoritative([18, 5])),
    (error) => error instanceof RulesValidationError
      && error.code === 'AMMUNITION_SPENT'
      && /колчан пуст/iu.test(error.message)
      && /Стрелы/u.test(error.message),
  )
  assert.deepEqual(state, before, 'отказ не меняет состояние')
})

test('последняя стрела уносит пачку из сумки — выпущенная не воскресает', () => {
  let state = archerState({ inventory: [BOW(), QUIVER({ charges: { current: 1, max: 20 } })] })
  assert.equal(ammunitionShotsLeft(quiverOf(state)), 1)
  state = applyAll(state, resolveCommand(shoot, state, authoritative([18, 5])).events)

  assert.equal(quiverOf(state), null, 'пустая пачка исчезает целиком')
  // Свежий ход: отказать обязан именно колчан, а не потраченное действие.
  state.mechanics.combat.action_economy.archer = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  assert.throws(
    () => resolveCommand(shoot, state, authoritative([18, 5])),
    (error) => error.code === 'AMMUNITION_SPENT',
  )
})

test('replay и повтор события дают тот же остаток, а не второй выстрел', () => {
  const state = archerState()
  const result = resolveCommand(shoot, state, authoritative([18, 5]))
  const reduced = applyAll(state, result.events)
  assert.deepEqual(replayEvents(state, result.events), reduced)

  const spent = result.events.find((event) => event.event_type === 'AmmunitionSpent')
  const replayedTwice = applyGameEvent(reduced, spent)
  assert.equal(ammunitionShotsLeft(quiverOf(replayedTwice)), 19, 'абсолютный остаток повтор не сдвигает')
})

test('докупленная пачка складывается со стреляным колчаном, а не теряется', () => {
  const state = archerState()
  const fired = applyAll(state, resolveCommand(shoot, state, authoritative([18, 5])).events)
  const restocked = { ...quiverOf(fired), quantity: 2 }

  assert.equal(ammunitionShotsLeft(restocked), 39, '19 своих плюс 20 купленных')
  const next = archerState({ inventory: [BOW(), restocked] })
  const spent = resolveCommand(shoot, next, authoritative([18, 5])).events
    .find((event) => event.event_type === 'AmmunitionSpent')
  assert.deepEqual(
    [spent.payload.shots_before, spent.payload.shots_after, spent.payload.quantity_after, spent.payload.capacity_after],
    [39, 38, 2, 40],
  )
})

test('метательное оружие боеприпаса не просит: у брошенного копья своя механика', () => {
  const spear = { ...materializeCatalogItem('srd_5_2_1:spear', { id: 'spear' }), equipped: true }
  const state = archerState({ inventory: [spear] })
  const result = resolveCommand({
    command_type: 'MakeAttack', actor_id: 'archer', target_id: 'goblin',
    item_id: 'spear', attack_mode: 'thrown', server_authoritative: true,
  }, state, authoritative([18, 5]))

  assert.equal(result.events.find((event) => event.event_type === 'AttackResolved').payload.hit, true)
  assert.equal(result.events.some((event) => event.event_type === 'AmmunitionSpent'), false)
})

test('стартовый набор лучника несёт колчан, а меч — нет', () => {
  const ranger = withStarterKit({ id: 'lira', role: 'Следопыт' })
  const quiver = ranger.inventory.find((item) => item.catalog_id === 'srd_5_2_1:arrows-20')
  assert.ok(ranger.inventory.some((item) => item.catalog_id === 'srd_5_2_1:shortbow'), 'лук на месте')
  assert.ok(quiver, 'лук без стрел на старте недопустим')
  assert.equal(ammunitionShotsLeft(quiver), 20)

  const fighter = withStarterKit({ id: 'brann', role: 'Воин' })
  assert.equal(fighter.inventory.some((item) => item.catalog_id === 'srd_5_2_1:arrows-20'), false)

  // Готовый лист не переписывается: импортированный герой сохраняет свой карман.
  const imported = withStarterKit({ id: 'own', role: 'Следопыт', inventory: [{ id: 'own-bow', name: 'Свой лук', type: 'weapon', quantity: 1 }] })
  assert.deepEqual(imported.inventory.map((item) => item.id), ['own-bow'])
})

test('проекция сама считает боеприпасы: у пачки остаток, у оружия — какой снаряд', () => {
  const quiver = itemViewerCapabilities(QUIVER({ charges: { current: 7, max: 20 } }))
  assert.deepEqual(quiver.ammunition, { role: 'ammunition', shots: 7, per_bundle: 20, unit: 'стрела' })

  const fresh = itemViewerCapabilities(QUIVER())
  assert.equal(fresh.ammunition.shots, 20)

  const bow = itemViewerCapabilities(BOW())
  assert.deepEqual(bow.ammunition, { role: 'weapon', catalog_id: 'srd_5_2_1:arrows-20', unit: 'стрела' })

  const sword = itemViewerCapabilities(materializeCatalogItem('srd_5_2_1:longsword', { id: 'sword' }))
  assert.equal(sword.ammunition, undefined, 'ближнее оружие о боеприпасах не рассказывает')
})

test('хотбар считает боеприпасы серверными числами и объясняет пустой колчан', () => {
  const board = readFileSync(new URL('../src/DungeonMap.tsx', import.meta.url), 'utf8')
  // Счётчик обязан идти от проекции: своя таблица «лук → стрелы» в браузере
  // разошлась бы с серверным отказом ровно в тот момент, когда это важно.
  assert.match(board, /item\.capabilities\?\.ammunition/u)
  assert.match(board, /pack\.role !== 'ammunition'/u)
  assert.match(board, /candidate\.catalog_id !== weapon\.catalog_id/u)
  assert.doesNotMatch(board, /arrows-20|bolts-20|sling-bullets-20/u, 'каталог боеприпасов в клиенте не дублируется')
  // Плитка гаснет и называет причину тем же механизмом, каким хотбар уже
  // объясняет любую недоступность: `disabled` плюс `title`.
  assert.match(board, /quiverEmpty = Boolean\(ammunition && ammunition\.shots <= 0\)/u)
  assert.match(board, /actionsLocked \|\| quiverEmpty/u)
  assert.match(board, /колчан пуст — для выстрела нужен боеприпас/u)
  assert.match(board, /\$\{ammunition\.shots\}×\$\{ammunition\.unit\}/u)
})
