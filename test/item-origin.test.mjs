import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import {
  DEFAULT_ITEM_ORIGIN_KIND,
  ITEM_ORIGIN_KINDS,
  ITEM_ORIGIN_LABELS,
  PRIVATE_ITEM_ORIGIN_KINDS,
  materializeCatalogItem,
  normalizeItemOriginKind,
} from '../server/item-catalog.mjs'
import { inventoryItemFromInstance } from '../server/loot-containers.mjs'
import { inventoryStackKey, normalizeInventoryItem } from '../server/merchant-economy.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const ADMIN = Object.freeze({ id: 'gm', role: 'admin' })
const PLAYER_ONE = Object.freeze({ id: 'user-1', role: 'player' })
const PLAYER_TWO = Object.freeze({ id: 'user-2', role: 'player' })

function dice() {
  let id = 0
  return new DiceService({
    rng: { randint: (_minimum, maximum) => maximum },
    idFactory: () => `roll-${++id}`,
    now: () => '2026-08-16T00:00:00.000Z',
  })
}

function fixture(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'ORIGIN-UNIT',
    partyMemberIds: ['hero', 'ally'],
    members: [
      { user_id: 'user-1', hero_id: 'hero', role: 'player' },
      { user_id: 'user-2', hero_id: 'ally', role: 'player' },
    ],
    players: [
      { id: 'hero', character: 'Ильма', hp: 30, maxHp: 30, armor: 14, speed: 30, x: 1, y: 1,
        abilities: { str: 14, dex: 16, con: 12, int: 10, wis: 12, cha: 12 }, inventory: [] },
      { id: 'ally', character: 'Тарн', hp: 30, maxHp: 30, armor: 14, speed: 30, x: 2, y: 1,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [] },
    ],
    scene: { turn: 1, location: 'Рынок', cells: Array.from({ length: 36 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })) },
    ...overrides,
  })
}

function commit(state, command) {
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: `${command.command_type}-${Math.random().toString(36).slice(2, 10)}`, server_authoritative: true, ...command },
    state,
    { diceService: dice(), context: { isAdmin: true } },
  )
  return { events: result.events, state: result.events.reduce(applyGameEvent, state) }
}

const heroItems = (state, id = 'hero') => state.players.find((player) => player.id === id).inventory

// ---------------------------------------------------------------------------
// Словарь

test('словарь происхождения один на оба мира и полон подписями', () => {
  for (const kind of ITEM_ORIGIN_KINDS) {
    assert.equal(typeof ITEM_ORIGIN_LABELS[kind], 'string', `у вида ${kind} нет подписи`)
    assert.ok(ITEM_ORIGIN_LABELS[kind].length > 0)
  }
  assert.deepEqual(Object.keys(ITEM_ORIGIN_LABELS).sort(), [...ITEM_ORIGIN_KINDS].sort(),
    'подписи и словарь разошлись — за столом появился бы вид без имени')
  for (const kind of PRIVATE_ITEM_ORIGIN_KINDS) assert.ok(ITEM_ORIGIN_KINDS.includes(kind))

  assert.equal(normalizeItemOriginKind('stolen'), 'stolen')
  assert.equal(normalizeItemOriginKind('украдено'), DEFAULT_ITEM_ORIGIN_KIND, 'подпись — не ключ')
  assert.equal(normalizeItemOriginKind(undefined), 'unknown')
  assert.equal(normalizeItemOriginKind({ kind: 'stolen' }), 'unknown', 'объект вместо ключа не проходит')
  assert.equal(normalizeItemOriginKind('', 'gifted'), 'gifted')
})

test('вещь из старого сохранения честно говорит «неизвестно», а не притворяется купленной', () => {
  const legacy = normalizeInventoryItem({ id: 'old', name: 'Дедовский нож', type: 'weapon', quantity: 1 })
  assert.equal(legacy.origin, 'unknown')
  const state = fixture({ players: [{ id: 'hero', hp: 1, maxHp: 1, inventory: [{ id: 'old', name: 'Нож', type: 'weapon', quantity: 1 }] }] })
  assert.equal(heroItems(state)[0].origin, 'unknown', 'нормализация состояния проставляет вид всем')
})

test('происхождение входит в ключ стопки: краденое не слипается с купленным', () => {
  const base = { id: 'a', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, weight: 1 }
  const bought = normalizeInventoryItem({ ...base, origin: 'purchased' })
  const stolen = normalizeInventoryItem({ ...base, id: 'b', origin: 'stolen' })
  const alsoBought = normalizeInventoryItem({ ...base, id: 'c', origin: 'purchased' })
  assert.notEqual(inventoryStackKey(bought), inventoryStackKey(stolen), 'стопка молча отмывала бы краденое')
  assert.equal(inventoryStackKey(bought), inventoryStackKey(alsoBought))
})

test('материализация каталога не съедает происхождение', () => {
  // Через `materializeCatalogItem` идут покупка, награда, `GrantItem` по
  // каталогу и стартовый набор: без строки в белом списке все четыре пути
  // теряли бы историю вещи на самом входе в карман.
  const item = materializeCatalogItem('srd_5_2_1:dagger', { id: 'x', quantity: 1, origin: 'reward' })
  assert.equal(item.origin, 'reward')
})

// ---------------------------------------------------------------------------
// Пути перехода владения

test('покупка у торговца называет вещь купленной и переживает replay', () => {
  const state = fixture({
    merchants: [{
      id: 'merchant-1', name: 'Лавочник', location: 'Рынок', available: true, purse_cp: 100_000,
      stock: [{ stock_id: 'stock-1', catalog_id: 'srd_5_2_1:dagger', quantity: 3, name: 'Кинжал', type: 'weapon', weight: 1, rarity: 'обычный' }],
    }],
  })
  const funded = normalizeCampaignState({
    ...state,
    players: state.players.map((player) => player.id === 'hero' ? { ...player, currency: { copper: 0, silver: 0, gold: 500, platinum: 0 } } : player),
  })
  const bought = commit(funded, {
    command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'merchant-1', stock_id: 'stock-1', quantity: 1,
  })
  const item = heroItems(bought.state)[0]
  assert.equal(item.origin, 'purchased')
  assert.equal(replayEvents(funded, bought.events).players[0].inventory[0].origin, 'purchased')
})

test('снятое с тела и найденное в схроне называются по-разному', () => {
  const instance = {
    item_instance_id: 'inst-1', catalog_id: 'srd_5_2_1:dagger', quantity: 1,
    snapshot: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', weight: 1, description: '' },
    origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:goblin-warrior', source_id: '' },
  }
  assert.equal(inventoryItemFromInstance(instance, { id: 'a', quantity: 1, containerKind: 'corpse' }).origin, 'looted')
  assert.equal(inventoryItemFromInstance(instance, { id: 'b', quantity: 1, containerKind: 'cache' }).origin, 'found')
  assert.equal(inventoryItemFromInstance(instance, { id: 'c', quantity: 1, containerKind: 'abandoned' }).origin, 'found')
  // Вещь, у которой история уже названа своим видом, мешком не переписывается:
  // краденое остаётся краденым, полежав в схроне.
  assert.equal(inventoryItemFromInstance(
    { ...instance, origin: { kind: 'stolen', template_id: '', source_id: '' } },
    { id: 'd', quantity: 1, containerKind: 'cache' },
  ).origin, 'stolen')
})

test('выдача ведущего — подарок, и краденым её объявить нельзя', () => {
  const state = fixture()
  const gifted = commit(state, {
    command_type: 'GrantItem', actor_id: 'hero',
    item: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1 },
  })
  assert.equal(heroItems(gifted.state)[0].origin, 'gifted')

  const asReward = commit(state, {
    command_type: 'GrantItem', actor_id: 'hero',
    item: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, origin: 'reward' },
  })
  assert.equal(heroItems(asReward.state)[0].origin, 'reward')

  // Кража — поступок со своими свидетелями, а не строка в выдаче: объявить
  // вещь краденой рукой ведущего значило бы обойти и проверку, и скандал.
  const forged = commit(state, {
    command_type: 'GrantItem', actor_id: 'hero',
    item: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, origin: 'stolen' },
  })
  assert.equal(heroItems(forged.state)[0].origin, 'gifted')
})

test('передача между героями историю вещи не переписывает', () => {
  const state = fixture()
  const granted = commit(state, {
    command_type: 'GrantItem', actor_id: 'hero',
    item: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 1, origin: 'looted' },
  })
  const itemId = heroItems(granted.state)[0].id
  const passed = commit(granted.state, {
    command_type: 'TransferItem', actor_id: 'hero', recipient_id: 'ally', item_id: itemId, quantity: 1,
  })
  assert.equal(heroItems(passed.state, 'ally')[0].origin, 'looted',
    'снятое с тела не становится подарком оттого, что сменило карман')
  assert.deepEqual(heroItems(passed.state, 'hero'), [])
})

// ---------------------------------------------------------------------------
// Проекция

test('краденое видит только его владелец и ведущий', () => {
  const state = fixture()
  state.players[0].inventory = [normalizeInventoryItem({ id: 'loot-1', name: 'Кошель', type: 'treasure', quantity: 1, origin: 'stolen' })]
  state.players[0].inventory.push(normalizeInventoryItem({ id: 'buy-1', name: 'Кинжал', type: 'weapon', quantity: 1, origin: 'purchased' }))
  const normalized = normalizeCampaignState(state)

  const own = campaignStateForViewer(normalized, PLAYER_ONE, 'hero').players.find((player) => player.id === 'hero')
  assert.equal(own.inventory[0].origin, 'stolen', 'в своём кармане герой знает, что где взял')
  assert.equal(own.inventory[1].origin, 'purchased')

  const neighbour = campaignStateForViewer(normalized, PLAYER_TWO, 'ally').players.find((player) => player.id === 'hero')
  assert.equal(neighbour.inventory[0].origin, undefined, 'соседу по столу это знание не принадлежит')
  assert.equal(neighbour.inventory[1].origin, 'purchased', 'честное происхождение при этом видно')
  assert.equal(JSON.stringify(campaignStateForViewer(normalized, PLAYER_TWO, 'ally')).includes('stolen'), false)

  const gm = campaignStateForViewer(normalized, ADMIN, '').players.find((player) => player.id === 'hero')
  assert.equal(gm.inventory[0].origin, 'stolen', 'у ведущего закрытого нет')
})

test('метка краденого стоит на карточке вещи и приходит только своему игроку', () => {
  const inventoryView = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/inventory.css', import.meta.url), 'utf8')
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8')

  assert.match(inventoryView, /item\.origin === 'stolen' && <i className="item-stolen-mark"/u)
  assert.ok(styles.includes('.item-stolen-mark'), 'у метки нет своего правила стиля')
  assert.match(types, /origin\?: 'enemy_loadout' \| 'purchased'/u)

  // Клиент ничего не выводит сам: он рисует метку по серверному полю и по
  // одному-единственному его виду. Второго списка закрытых видов у него нет —
  // решение, кому что видно, целиком серверное.
  assert.doesNotMatch(inventoryView, /PRIVATE_ITEM_ORIGIN|origin !== 'purchased'/u)
})
