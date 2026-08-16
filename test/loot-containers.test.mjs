import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import { enemyLoadoutFor } from '../server/enemy-loadouts.mjs'
import { bindFreeActionReadingToState, interpretFreeAction, resolveCorpseSearch } from '../server/free-action-adjudication.mjs'
import {
  LOOT_CONTAINER_REACH_FEET,
  MAX_LOOT_CONTAINERS,
  lootCommitTouchesContainers,
  lootContainerList,
  lootContainersForViewer,
  lootContainersInScene,
  lootItemForViewer,
  normalizeLootContainersState,
  sceneLootLocationKey,
} from '../server/loot-containers.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
  resolveCommands,
  validateCommand,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const CONTEXT = { allowedActorIds: ['hero', 'mate'] }

function dice(values = []) {
  return new DiceService({ rng: new SequenceDiceRng(values) })
}

function cells(width = 10, height = 6) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', revealed: true })
  }
  return grid
}

/** Разбойник с настоящим инвентарём: скимитар, арбалет и болты. */
function bandit(id, { x = 2, y = 1, hp = 11, seed = 'loot-seed' } = {}) {
  const statBlockId = 'srd_5_2_1:bandit'
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return {
    id,
    name: `Разбойник ${id.slice(-1)}`,
    creature_type: block.creature_type,
    hp,
    maxHp: block.hp,
    armor: block.armor,
    speed: block.speed,
    abilities: { ...block.abilities },
    x,
    y,
    alive: hp > 0,
    stat_block_id: statBlockId,
    provenance: { xp: block.xp },
    action_profiles: block.action_profiles,
    loadout: enemyLoadoutFor({ statBlockId, block, ownerId: id, seed }),
  }
}

function campaign({ combat = true, enemies = [bandit('foe-1')], heroX = 2, heroStr = 16, mateStr = 16, heroInventory = [] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'LOOT',
    campaign: 'Контейнеры добычи',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'mate'],
    partyName: 'Отряд героев',
    scene: {
      title: 'Разграбленный склад',
      location: 'Склад',
      location_id: 'warehouse',
      turn: 1,
      grid: { width: 10, height: 6 },
      cells: cells(),
    },
    players: [
      {
        id: 'hero',
        character: 'Ада',
        characterClass: 'fighter',
        level: 3,
        hp: 24,
        maxHp: 24,
        armor: 16,
        speed: 30,
        proficiency: 2,
        abilities: { str: heroStr, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: heroInventory,
        x: heroX,
        y: 2,
      },
      {
        id: 'mate',
        character: 'Борх',
        characterClass: 'fighter',
        level: 3,
        hp: 24,
        maxHp: 24,
        armor: 16,
        speed: 30,
        proficiency: 2,
        abilities: { str: mateStr, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [],
        x: 6,
        y: 4,
      },
    ],
    enemies,
    worldMap: {
      seed: 'loot-world',
      locations: [{ id: 'warehouse', name: 'Склад', kind: 'ruin', x: 10, y: 10 }],
      routes: [],
    },
    mechanics: {
      world_time: { elapsed_minutes: 120 },
      encounter: { id: 'enc-1', encounter_id: 'enc-1', status: 'active', enemy_ids: enemies.map((enemy) => enemy.id) },
      combat: combat
        ? {
            active: true,
            round: 2,
            active_index: 0,
            initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'foe-1', total: 6 }],
            action_economy: {
              hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
              mate: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
            },
          }
        : { active: false, round: 0, initiative: [], active_index: -1, action_economy: {} },
    },
  })
}

/** Тот же склад, но отряд — один волшебник: нужен настоящий площадной урон. */
function arcane(enemies) {
  return normalizeCampaignState({
    sessionCode: 'LOOT',
    campaign: 'Контейнеры добычи',
    activePlayerId: 'mage',
    partyMemberIds: ['mage'],
    partyName: 'Отряд героев',
    scene: {
      title: 'Разграбленный склад',
      location: 'Склад',
      location_id: 'warehouse',
      turn: 1,
      grid: { width: 10, height: 6 },
      cells: cells(),
    },
    players: [{
      id: 'mage',
      character: 'Мира',
      role: 'Волшебник',
      level: 5,
      hp: 20,
      maxHp: 20,
      armor: 12,
      speed: 30,
      proficiency: 3,
      abilities: { str: 8, dex: 12, con: 12, int: 18, wis: 10, cha: 10 },
      inventory: [],
      x: 0,
      y: 5,
    }],
    enemies,
    worldMap: {
      seed: 'loot-world',
      locations: [{ id: 'warehouse', name: 'Склад', kind: 'ruin', x: 10, y: 10 }],
      routes: [],
    },
    mechanics: {
      world_time: { elapsed_minutes: 120 },
      encounter: { id: 'enc-1', encounter_id: 'enc-1', status: 'active', enemy_ids: enemies.map((enemy) => enemy.id) },
      combat: {
        active: true,
        round: 1,
        active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }],
        action_economy: { mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

function commit(state, command, { rng = [], context = CONTEXT } = {}) {
  const result = resolveCommand(
    { campaign_id: 'LOOT', command_id: `${command.command_type}-${state.state_version}-${Math.random().toString(36).slice(2, 8)}`, ...command },
    state,
    { diceService: dice(rng), context },
  )
  return { ...result, state: result.events.reduce(applyGameEvent, state) }
}

function kill(state, enemyId, { actorId = 'hero' } = {}) {
  const enemy = state.enemies.find((candidate) => candidate.id === enemyId)
  return commit(state, {
    command_type: 'ApplyDamage',
    actor_id: actorId,
    target_id: enemyId,
    amount: Math.max(1, enemy.hp),
    damage_type: 'slashing',
  })
}

function containerOf(state, kind = 'corpse') {
  return lootContainerList(state).find((container) => container.kind === kind) ?? null
}

/** Обыскать тело дочиста одной командой. */
function commitAllOf(killed) {
  const container = containerOf(killed.state)
  return commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
  })
}

// ---------------------------------------------------------------------------
// 1. Контейнер рождается в том же коммите, что и выбытие

test('смерть врага в той же фиксации создаёт контейнер и переносит в него остаток', () => {
  const before = campaign()
  const source = before.enemies[0]
  assert.ok(source.loadout.items.length >= 2, 'разбойник обязан прийти в бой с инвентарём')

  const killed = kill(before, 'foe-1')
  const created = killed.events.filter((event) => event.event_type === 'LootContainerCreated')
  assert.equal(created.length, 1, 'контейнер обязан появиться той же фиксацией, что и смерть')
  assert.equal(created[0].visibility, 'party')
  assert.ok(killed.events.findIndex((event) => event.event_type === 'DamageApplied')
    < killed.events.findIndex((event) => event.event_type === 'LootContainerCreated'))

  const container = containerOf(killed.state)
  assert.ok(container, 'контейнер обязан лежать в состоянии кампании')
  assert.equal(container.kind, 'corpse')
  assert.equal(container.source_enemy_id, 'foe-1')
  assert.equal(container.encounter_id, 'enc-1')
  assert.equal(container.status, 'available')
  assert.deepEqual({ x: container.x, y: container.y }, { x: source.x, y: source.y })

  // Вещь переехала, а не скопировалась: у противника её больше нет.
  const lootable = source.loadout.items.filter((item) => item.lootable === true)
  assert.deepEqual(
    container.items.map((item) => item.item_instance_id).sort(),
    lootable.map((item) => item.item_instance_id).sort(),
  )
  const enemyAfter = killed.state.enemies.find((enemy) => enemy.id === 'foe-1')
  assert.equal(
    enemyAfter.loadout.items.some((item) => lootable.some((moved) => moved.item_instance_id === item.item_instance_id)),
    false,
    'lootable-остаток обязан покинуть инвентарь противника',
  )
  assert.equal(container.items.every((item) => item.owner.kind === 'container'), true)
  assert.equal(container.items.every((item) => item.owner.actor_id === container.id), true)
})

test('израсходованное не воскресает: потраченный болт не появляется в контейнере', () => {
  const before = campaign()
  const bolts = before.enemies[0].loadout.items.find((item) => item.catalog_id === 'srd_5_2_1:bolts-20')
  assert.ok(bolts, 'арбалетчик обязан прийти с болтами')

  // Тот же инвентарь, но половина болтов уже улетела в отряд.
  const spent = normalizeCampaignState({
    ...before,
    enemies: [{
      ...before.enemies[0],
      loadout: {
        ...before.enemies[0].loadout,
        items: before.enemies[0].loadout.items
          .map((item) => item.item_instance_id === bolts.item_instance_id
            ? { ...item, quantity: Math.max(1, bolts.quantity - 1) }
            : item)
          // Скимитар выбит из рук и потерян вовсе.
          .filter((item) => item.catalog_id !== 'srd_5_2_1:scimitar'),
      },
    }],
  })
  const container = containerOf(kill(spent, 'foe-1').state)
  assert.equal(container.items.some((item) => item.catalog_id === 'srd_5_2_1:scimitar'), false)
  assert.equal(
    container.items.find((item) => item.catalog_id === 'srd_5_2_1:bolts-20').quantity,
    Math.max(1, bolts.quantity - 1),
    'в контейнер переезжает остаток, а не запись шаблона',
  )
})

test('обобранное тело не запрещает новое с тем же идентификатором', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const first = containerOf(killed.state)
  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: first.id,
    lines: first.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
  })
  assert.equal(containerOf(looted.state).status, 'emptied')

  // Идентификатор противника — чистая функция сида встречи (`enemyFrom`,
  // `server/encounter-assembler.mjs`), а сид ведущий вправе прислать в
  // `/encounters/assemble` явно. Тот же сид, тот же зал, тот же отряд — тот же
  // `foe-1` и тот же id контейнера. Пока сторожем дублей был весь реестр
  // кампании, второе тело не появлялось вовсе: остаток так и оставался внутри
  // `enemy.loadout` и не доставался ни одной командой.
  const again = normalizeCampaignState({ ...looted.state, enemies: [bandit('foe-1')] })
  const repeated = kill(again, 'foe-1')
  assert.equal(
    repeated.events.filter((event) => event.event_type === 'LootContainerCreated').length,
    1,
    'опустошённое тело не должно запрещать новое',
  )
  const second = lootContainerList(repeated.state).find((container) => container.status === 'available')
  assert.ok(second, 'новое тело обязано лежать в реестре доступным')
  assert.equal(second.id, first.id, 'проба имеет смысл только на совпавшем идентификаторе')
  assert.ok(second.items.length >= 2)
  assert.equal(
    repeated.state.enemies.find((enemy) => enemy.id === 'foe-1').loadout.items.some((item) => item.lootable === true),
    false,
    'lootable-остаток обязан покинуть инвентарь противника и во второй раз',
  )
})

test('переполнение реестра вытесняет обобранное, а невзятое остаётся', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const untouched = containerOf(killed.state)
  // Невзятое тело — самая старая запись, и обычный `slice(-N)` срезал бы
  // именно его: без события, без следа и без единого красного теста.
  const emptied = Array.from({ length: MAX_LOOT_CONTAINERS + 2 }, (_, index) => ({
    schema_version: 1,
    id: `loot:corpse:filler-${index}`,
    kind: 'corpse',
    name: `Тело ${index}`,
    location_id: 'warehouse',
    status: 'emptied',
    items: [],
  }))
  const crowded = normalizeLootContainersState({ containers: [untouched, ...emptied] })
  assert.equal(crowded.containers.length, MAX_LOOT_CONTAINERS)
  assert.ok(
    crowded.containers.some((container) => container.id === untouched.id),
    'невзятое тело обязано пережить переполнение',
  )
  assert.equal(crowded.containers.filter((container) => container.status === 'available').length, 1)

  // Когда невзятого больше бюджета, уступает самое старое из него — но только
  // после того, как ушли все опустошённые.
  const many = Array.from({ length: MAX_LOOT_CONTAINERS + 1 }, (_, index) => ({
    ...untouched,
    id: `loot:corpse:full-${String(index).padStart(3, '0')}`,
  }))
  const overfull = normalizeLootContainersState({ containers: [...many, ...emptied] })
  assert.equal(overfull.containers.length, MAX_LOOT_CONTAINERS)
  assert.equal(overfull.containers.every((container) => container.status === 'available'), true)
  assert.equal(overfull.containers.some((container) => container.id === 'loot:corpse:full-000'), false)
})

test('пустой инвентарь контейнера не создаёт', () => {
  const wolf = {
    id: 'foe-wolf',
    name: 'Волк',
    creature_type: 'beast',
    hp: 11,
    maxHp: 11,
    armor: 13,
    x: 2,
    y: 1,
    alive: true,
    stat_block_id: 'srd_5_2_1:wolf',
  }
  const killed = kill(campaign({ enemies: [wolf] }), 'foe-wolf')
  assert.equal(killed.events.some((event) => event.event_type === 'LootContainerCreated'), false)
  assert.equal(lootContainerList(killed.state).length, 0)
})

// ---------------------------------------------------------------------------
// 2. Обыск: набор переезжает целиком

test('обыск переносит выбранный набор получателю и опустошает контейнер', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const lines = container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity }))

  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    recipient_id: 'mate',
    lines,
  })
  const taken = looted.events.find((event) => event.event_type === 'LootContainerTaken')
  assert.ok(taken, 'обыск обязан выпустить событие')
  assert.equal(taken.payload.status_after, 'emptied')
  assert.equal(taken.payload.combat_action, null, 'вне боя обыск действия не стоит')

  const mate = looted.state.players.find((player) => player.id === 'mate')
  assert.equal(mate.inventory.length, lines.length)
  assert.deepEqual(
    mate.inventory.map((item) => item.catalog_id).sort(),
    container.items.map((item) => item.catalog_id).sort(),
  )
  assert.equal(looted.state.players.find((player) => player.id === 'hero').inventory.length, 0)

  // Опустошённый контейнер остаётся в состоянии, но со сцены исчезает.
  const after = containerOf(looted.state)
  assert.equal(after.status, 'emptied')
  assert.deepEqual(lootContainersInScene(looted.state), [])
})

test('часть стопки переезжает, остальное остаётся в контейнере', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const bolts = container.items.find((item) => item.catalog_id === 'srd_5_2_1:bolts-20')
  assert.ok(bolts.quantity >= 1)

  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: [{ item_instance_id: bolts.item_instance_id, quantity: 1 }],
  })
  const after = containerOf(looted.state)
  assert.equal(after.status, bolts.quantity > 1 || container.items.length > 1 ? 'available' : 'emptied')
  const remainingBolts = after.items.find((item) => item.item_instance_id === bolts.item_instance_id)
  if (bolts.quantity > 1) assert.equal(remainingBolts.quantity, bolts.quantity - 1)
  else assert.equal(remainingBolts, undefined)
  assert.equal(looted.state.players.find((player) => player.id === 'hero').inventory[0].quantity, 1)
})

test('клиент не называет вещь: лишнее поле команды отклоняется', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT',
      command_type: 'LootContainer',
      actor_id: 'hero',
      container_id: container.id,
      lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }],
      name: 'Меч +3',
    }, killed.state, CONTEXT),
    (error) => error.code === 'LOOT_COMMAND_UNKNOWN_FIELD',
  )
})

// ---------------------------------------------------------------------------
// 3. Отказы: всё или ничего, и действие не тратится

test('перегруз отменяет весь набор и не тратит действия', () => {
  // Сила 1 — грузоподъёмность 15 фунтов, и почти всё уже занято наковальней.
  const killed = kill(campaign({
    heroStr: 1,
    heroInventory: [{ id: 'anvil', name: 'Наковальня', type: 'gear', quantity: 1, weight: 12 }],
  }), 'foe-1')
  const container = containerOf(killed.state)
  const lines = container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity }))
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT', command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines,
    }, killed.state, CONTEXT),
    (error) => error.code === 'CARRYING_CAPACITY_EXCEEDED',
  )
  // Ни одной вещи не взято, действие цело.
  assert.equal(killed.state.players.find((player) => player.id === 'hero').inventory.length, 1)
  assert.equal(killed.state.mechanics.combat.action_economy.hero.action, true)
  assert.equal(containerOf(killed.state).items.length, container.items.length)

  // Одна вещь полегче проходит — отменялся именно набор, а не сам обыск.
  const lightest = [...container.items].sort((left, right) => (left.snapshot.weight ?? 0) - (right.snapshot.weight ?? 0))[0]
  assert.doesNotThrow(() => validateCommand({
    campaign_id: 'LOOT',
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: [{ item_instance_id: lightest.item_instance_id, quantity: 1 }],
  }, killed.state, CONTEXT))
})

test('обыск проверяет досягаемость, состав контейнера и получателя', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const line = { item_instance_id: container.items[0].item_instance_id, quantity: 1 }
  const reject = (command, code, state = killed.state) => assert.throws(
    () => validateCommand({ campaign_id: 'LOOT', command_type: 'LootContainer', ...command }, state, CONTEXT),
    (error) => error.code === code,
    `ожидался ${code}`,
  )

  // Соратник стоит в другом конце склада.
  reject({ actor_id: 'mate', container_id: container.id, lines: [line] }, 'LOOT_CONTAINER_OUT_OF_REACH')
  reject({ actor_id: 'hero', container_id: 'loot:corpse:нет-такого', lines: [line] }, 'LOOT_CONTAINER_NOT_FOUND')
  reject({ actor_id: 'hero', container_id: container.id, lines: [] }, 'LOOT_LINES_REQUIRED')
  reject({ actor_id: 'hero', container_id: container.id, lines: [{ item_instance_id: 'нет-такого', quantity: 1 }] }, 'LOOT_ITEM_GONE')
  reject({ actor_id: 'hero', container_id: container.id, lines: [{ ...line, quantity: 99 }] }, 'LOOT_QUANTITY_INVALID')
  reject({ actor_id: 'hero', container_id: container.id, lines: [line, line] }, 'LOOT_LINE_DUPLICATE')
  reject({ actor_id: 'hero', container_id: container.id, recipient_id: 'foe-1', lines: [line] }, 'LOOT_RECIPIENT_INVALID')
  reject({ actor_id: 'foe-1', container_id: container.id, lines: [line] }, 'ACTOR_FORBIDDEN')

  // Пять футов — это своя клетка или соседняя, и ни футом больше.
  assert.equal(LOOT_CONTAINER_REACH_FEET, 5)
  const adjacent = normalizeCampaignState({
    ...killed.state,
    mechanics: { ...killed.state.mechanics, positions: { ...killed.state.mechanics.positions, mate: { x: container.x + 1, y: container.y } } },
  })
  assert.doesNotThrow(() => validateCommand({
    campaign_id: 'LOOT', command_type: 'LootContainer', actor_id: 'mate', container_id: container.id, lines: [line],
  }, adjacent, CONTEXT))
})

test('опустошённый контейнер второй раз не обыскивается', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const lines = container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity }))
  const looted = commit(killed.state, {
    command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines,
  })
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT', command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines,
    }, looted.state, CONTEXT),
    (error) => error.code === 'LOOT_CONTAINER_EMPTY',
  )
})

// ---------------------------------------------------------------------------
// 4. Экономика хода

test('в бою обыск одного контейнера стоит действия, вне боя — нет', () => {
  const killed = kill(campaign(), 'foe-1')
  const container = containerOf(killed.state)
  const line = { item_instance_id: container.items[0].item_instance_id, quantity: 1 }
  const looted = commit(killed.state, {
    command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines: [line],
  })
  assert.equal(looted.events.find((event) => event.event_type === 'LootContainerTaken').payload.combat_action, 'action')
  assert.equal(looted.state.mechanics.combat.action_economy.hero.action, false)

  // Второй обыск в тот же ход упирается в потраченное действие.
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT',
      command_type: 'LootContainer',
      actor_id: 'hero',
      container_id: container.id,
      lines: [{ item_instance_id: container.items[1].item_instance_id, quantity: 1 }],
    }, looted.state, CONTEXT),
    (error) => error.code === 'ACTION_SPENT',
  )
})

test('в бою добыча достаётся тому, кто обыскивает', () => {
  const killed = kill(campaign(), 'foe-1')
  const container = containerOf(killed.state)
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT',
      command_type: 'LootContainer',
      actor_id: 'hero',
      container_id: container.id,
      recipient_id: 'mate',
      lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }],
    }, killed.state, CONTEXT),
    (error) => error.code === 'LOOT_RECIPIENT_DURING_COMBAT',
  )
})

test('вне боя добыча достаётся любому герою отряда — как и при передаче предмета', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const line = { item_instance_id: container.items[0].item_instance_id, quantity: 1 }
  const command = (extra) => ({
    campaign_id: 'LOOT', command_type: 'LootContainer', container_id: container.id, lines: [line], ...extra,
  })

  // Соратник стоит в другом конце склада: сам он до тела не дотянется.
  assert.throws(
    () => validateCommand(command({ actor_id: 'mate' }), killed.state, CONTEXT),
    (error) => error.code === 'LOOT_CONTAINER_OUT_OF_REACH',
  )
  // Но получить добычу из рук того, кто нагнулся, он вправе, и это решение, а
  // не пропуск: `TransferItem` вне боя тоже не меряет расстояние между героями
  // (`server/item-lifecycle.mjs`), и своё правило досягаемости означало бы
  // отказ обыском и немедленное разрешение следующей же командой передачи.
  assert.doesNotThrow(() => validateCommand(command({ actor_id: 'hero', recipient_id: 'mate' }), killed.state, CONTEXT))
})

test('падение героя не оплачивает пересборку состояния добычи', () => {
  const before = campaign()
  const zeroed = (actorId) => [{ event_type: 'DamageApplied', target_ids: [actorId], payload: { hp_after: 0 } }]
  // Самый частый ноль в бою — это ноль у героя, и он не рождает ни одного
  // контейнера. Дешёвый гейт обязан отсеять его до дорогого `replayEvents`.
  assert.equal(lootCommitTouchesContainers(before, zeroed('hero')), false)
  assert.equal(lootCommitTouchesContainers(before, zeroed('mate')), false)
  // Ноль у вооружённого противника гейт по-прежнему пропускает.
  assert.equal(lootCommitTouchesContainers(before, zeroed('foe-1')), true)
  assert.equal(lootCommitTouchesContainers(before, [{ event_type: 'CaptiveTaken', payload: {} }]), true)

  // Настоящая фиксация это подтверждает: герой упал — тела нет, противник
  // упал — тело есть.
  const heroDown = commit(before, {
    command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'hero', amount: 99, damage_type: 'slashing',
  })
  assert.equal(heroDown.events.some((event) => event.event_type === 'LootContainerCreated'), false)
  assert.equal(lootContainerList(heroDown.state).length, 0)
  assert.equal(kill(before, 'foe-1').events.some((event) => event.event_type === 'LootContainerCreated'), true)
})

test('площадное заклинание кладёт двоих — и оба оставляют тела', () => {
  // Гейт верит инварианту «обнулённый актор лежит в `target_ids` своего
  // события», а держат этот инвариант десятки мест выпуска `DamageApplied`.
  // Режим отказа у него тихий: событие с пустым `target_ids` или с атакующим
  // вместо жертвы означает, что тел не будет вовсе, и ни одна проверка
  // синтетических событий этого не заметит. Поэтому здесь настоящий путь.
  const before = arcane([bandit('foe-1', { x: 6, y: 1, hp: 1 }), bandit('foe-2', { x: 5, y: 1, hp: 1 })])
  const blast = commit(
    before,
    { command_type: 'CastSpell', actor_id: 'mage', spell_id: 'fireball', to: { x: 6, y: 1 }, server_authoritative: true },
    { rng: [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2], context: { allowedActorIds: ['mage'], serverAuthoritativeCombat: true } },
  )
  const zeroed = blast.events.filter((event) => event.payload?.hp_after === 0 && event.event_type === 'DamageApplied')
  assert.equal(zeroed.length, 2, 'оба разбойника обязаны обнулиться одним заклинанием')
  // Ровно один — и именно павший, а не заклинатель: на этом стоит весь гейт.
  assert.deepEqual(zeroed.map((event) => event.target_ids).sort(), [['foe-1'], ['foe-2']])
  assert.equal(lootCommitTouchesContainers(before, blast.events), true, 'дешёвый гейт обязан пропустить площадную смерть')
  assert.equal(blast.events.filter((event) => event.event_type === 'LootContainerCreated').length, 2)
  assert.deepEqual(
    lootContainerList(blast.state).map((container) => container.source_enemy_id).sort(),
    ['foe-1', 'foe-2'],
  )
})

test('повторяющийся урон зоны в конце хода тоже оставляет тело', () => {
  // Вторая настоящая ветка: `DamageApplied` выпускает не команда атаки, а тик
  // длящейся области (`lingeringAreaDamage`) на закрытии хода противника.
  const base = campaign({ enemies: [bandit('foe-1', { hp: 4 })] })
  const before = {
    ...base,
    mechanics: {
      ...base.mechanics,
      // Указатель инициативы стоит на разбойнике: закрывает ход он.
      combat: { ...base.mechanics.combat, active_index: 1 },
      active_effects: [{
        id: 'burning-oil', effect_id: 'burning-oil', spell_id: 'item:oil-flask',
        source_actor: 'hero', center: { x: 2, y: 1 }, cells: [{ x: 2, y: 1 }],
        area_shape: 'line', radius_feet: 5, trigger_on_enter: true, trigger_on_turn_end: true,
        save_ability: null, save_dc: 10, damage: null, damage_amount: 5, damage_type: 'fire',
        half_on_save: false, follows_source: false, concentration: false, open_flame: true,
        expires_round: 99,
      }],
    },
  }
  const burned = commit(before, { command_type: 'EndTurn', actor_id: 'foe-1', server_authoritative: true }, {
    context: { isAdmin: true, serverAuthoritativeCombat: true },
  })
  const zeroed = burned.events.find((event) => event.event_type === 'DamageApplied' && event.payload?.hp_after === 0)
  assert.ok(zeroed, 'горящее масло обязано добить разбойника на закрытии его хода')
  assert.deepEqual(zeroed.target_ids, ['foe-1'], 'жертва тика обязана лежать в target_ids')
  assert.equal(lootCommitTouchesContainers(before, burned.events), true)
  assert.equal(containerOf(burned.state)?.source_enemy_id, 'foe-1')
})

// ---------------------------------------------------------------------------
// 5. Replay и идемпотентность потока

test('повторное проигрывание потока даёт то же состояние', () => {
  const before = campaign({ combat: false })
  const killed = kill(before, 'foe-1')
  const container = containerOf(killed.state)
  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
  })
  const events = [...killed.events, ...looted.events]
  const replayed = replayEvents(before, events)
  assert.deepEqual(replayed.loot_containers, looted.state.loot_containers)
  assert.deepEqual(
    replayed.players.find((player) => player.id === 'hero').inventory,
    looted.state.players.find((player) => player.id === 'hero').inventory,
  )
  // Второй прогон того же потока ничего не удваивает.
  assert.deepEqual(replayEvents(before, events).loot_containers, replayed.loot_containers)
})

test('то же событие, применённое второй раз, не выдаёт добычу дважды', () => {
  // Обещание шапки редьюсера. Живой путь закрыт транспортом
  // (`assertLootIdempotency`), но обещание обязано держаться и без него: остаток
  // контейнера приезжает списком, а поднятая вещь узнаётся по детерминированному
  // `id`. Без этого повтор складывал количества и давал скимитар ×2.
  const before = campaign({ combat: false })
  const killed = kill(before, 'foe-1')
  const container = containerOf(killed.state)
  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
  })
  // Сравнивается счёт, а не запись целиком: `normalizeCampaignState` дообогащает
  // вещи каталогом на первом же повторном проходе, и это к идемпотентности
  // добычи отношения не имеет.
  const bag = (state) => state.players.find((player) => player.id === 'hero').inventory
    .map((item) => `${item.id}·${item.catalog_id}·${item.quantity}`).sort()
  const first = bag(looted.state)
  assert.ok(first.length > 0, 'первое применение обязано выдать добычу')

  // Ровно то же событие поверх уже применённого состояния.
  assert.deepEqual(bag(looted.events.reduce(applyGameEvent, looted.state)), first)

  // И весь поток целиком: `LootContainerCreated` возвращает контейнер к полному
  // содержимому, поэтому сторож остатка здесь не срабатывает — вещь узнаётся по
  // своему `id` в сумке.
  const twice = [...killed.events, ...looted.events].reduce(applyGameEvent, looted.state)
  assert.deepEqual(bag(twice), first)
  assert.deepEqual(twice.loot_containers, looted.state.loot_containers)
})

test('повтор поверх уже слитой стопки тоже не удваивает добычу', () => {
  // Дыра, которую одним `id` не закрыть: если у героя уже лежала такая же вещь,
  // поднятая сливается с ней в стопку и **теряет** свой идентификатор — узнавать
  // повтор становится нечем. Поэтому второй сторож смотрит не в сумку, а в
  // контейнер: он уже стоит на остатке этого события, значит обыск состоялся.
  const sample = (() => {
    const first = commitAllOf(kill(campaign({ combat: false }), 'foe-1'))
    return first.state.players.find((player) => player.id === 'hero').inventory
      .find((item) => item.catalog_id === 'srd_5_2_1:scimitar')
  })()
  assert.ok(sample, 'скимитар обязан доехать до сумки героя')

  const withStack = campaign({ combat: false, heroInventory: [{ ...sample, id: 'own-scimitar', quantity: 1 }] })
  const killed = kill(withStack, 'foe-1')
  const container = containerOf(killed.state)
  const scimitar = container.items.find((item) => item.catalog_id === 'srd_5_2_1:scimitar')
  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: [{ item_instance_id: scimitar.item_instance_id, quantity: 1 }],
  })
  const stack = (state) => state.players.find((player) => player.id === 'hero').inventory
    .find((item) => item.id === 'own-scimitar')
  assert.equal(stack(looted.state)?.quantity, 2, 'поднятый скимитар обязан слиться со своим же в сумке')
  // Идентификатор поднятого в сумке не остался — узнать повтор можно только по
  // контейнеру.
  assert.equal(looted.state.players.find((player) => player.id === 'hero').inventory.length, 1)
  assert.equal(stack(looted.events.reduce(applyGameEvent, looted.state)).quantity, 2)
})

test('летопись обыска отличает неполный обыск от опустошённого тела', () => {
  // Признак нужен интерфейсу: `loot-taken` пишется и при неполном обыске, и без
  // остатка панель рисовала бы «уже забрал такой-то» над телом, на котором
  // осталось ещё две вещи (`vanishedLootFrom`, `src/loot-panel-rules.mjs`).
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  assert.ok(container.items.length >= 2, 'разбойник обязан прийти с несколькими вещами')

  const taken = (state, lines) => commit(state, {
    command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines,
  })
  const record = (state) => state.battleLog.filter((entry) => entry.type === 'loot-taken').at(-1)

  const partial = taken(killed.state, [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }])
  const first = record(partial.state)
  assert.equal(first.containerId, container.id)
  assert.equal(first.statusAfter, 'available')
  assert.ok(first.remainingCount > 0, 'остаток обязан приехать числом')
  // Содержимого в летописи по-прежнему нет — только счёт.
  assert.equal(JSON.stringify(first).includes('scimitar'), false)
  assert.ok(lootContainersInScene(partial.state).some((entry) => entry.id === container.id))

  const rest = containerOf(partial.state)
  const emptied = taken(partial.state, rest.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })))
  const last = record(emptied.state)
  assert.equal(last.statusAfter, 'emptied')
  assert.equal(last.remainingCount, 0)
  assert.equal(lootContainersInScene(emptied.state).length, 0, 'опустошённое тело уходит из сцены')
})

test('гонка за один предмет: устаревшая версия получает конфликт', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const line = { item_instance_id: container.items[0].item_instance_id, quantity: 1 }
  const staleVersion = killed.state.state_version
  const first = commit(killed.state, {
    command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines: [line],
  })
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT',
      command_type: 'LootContainer',
      actor_id: 'hero',
      container_id: container.id,
      lines: [line],
      expected_state_version: staleVersion,
    }, first.state, CONTEXT),
    (error) => error.code === 'STATE_VERSION_CONFLICT',
  )
  // Свежая версия честно сообщает, что вещи уже нет.
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT', command_type: 'LootContainer', actor_id: 'hero', container_id: container.id, lines: [line],
    }, first.state, CONTEXT),
    (error) => error.code === 'LOOT_ITEM_GONE',
  )
})

// ---------------------------------------------------------------------------
// 6. Проекция и санитайзер событий

test('игрок видит контейнер сцены, а содержимое — только вблизи', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const room = campaignStateForViewer(killed.state, { role: 'player', id: 'u1' }, 'hero')
  assert.equal(room.loot_containers.containers.length, 1)
  const [card] = room.loot_containers.containers
  assert.equal(card.can_inspect, true)
  assert.ok(Array.isArray(card.items) && card.items.length)
  assert.ok(card.item_count > 0)

  const far = campaignStateForViewer(killed.state, { role: 'player', id: 'u2' }, 'mate')
  const [farCard] = far.loot_containers.containers
  assert.equal(farCard.can_inspect, false)
  assert.equal(farCard.items, undefined, 'содержимое отдаётся только по защищённому чтению')
  assert.equal(farCard.item_count, card.item_count, 'сам факт добычи виден со всей сцены')
})

test('состояния кнопки обыска решает сервер: цена хода, футы и портрет павшего', () => {
  // Вне боя обыск не стоит ничего, и цену называет проекция, а не браузер.
  const peace = kill(campaign({ combat: false }), 'foe-1')
  const peaceRoom = campaignStateForViewer(peace.state, { role: 'player', id: 'u1' }, 'hero')
  assert.equal(peaceRoom.loot_containers.action_cost, null)
  assert.equal(peaceRoom.loot_containers.reach_feet, LOOT_CONTAINER_REACH_FEET)

  // В бою тот же контейнер стоит действия — тем же признаком, которым это
  // решает правило (`validateLootContainerCommand`).
  const fight = kill(campaign({ combat: true }), 'foe-1')
  assert.equal(campaignStateForViewer(fight.state, { role: 'player', id: 'u1' }, 'hero').loot_containers.action_cost, 'action')

  // Расстояние приезжает готовым числом: браузеру незачем заводить вторую
  // геометрию доски, чтобы объяснить «подойдите ближе».
  const [near] = peaceRoom.loot_containers.containers
  assert.equal(near.distance_feet, 5, 'герой стоит в клетке по диагонали от тела')
  assert.equal(near.can_inspect, true)
  assert.equal(near.source_enemy_id, 'foe-1', 'по этому ключу карточка находит портрет павшего')

  const [far] = campaignStateForViewer(peace.state, { role: 'player', id: 'u2' }, 'mate').loot_containers.containers
  assert.ok(far.distance_feet > LOOT_CONTAINER_REACH_FEET, 'далёкий герой обязан видеть, насколько он далёк')
  assert.equal(far.can_inspect, false)

  // Стат-блок павшего ключом контейнера не открывается.
  assert.equal(JSON.stringify(peaceRoom.loot_containers).includes('srd_5_2_1:bandit'), false)
})

test('свободное действие «обыскиваю тело» ведёт к контейнеру, а не к прежнему отказу', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const text = 'Обыскиваю тело разбойника'
  const reading = bindFreeActionReadingToState(killed.state, 'hero', text, interpretFreeAction(text))
  const answer = resolveCorpseSearch(killed.state, text, reading)
  assert.equal(answer.server_owned_contents, true)
  assert.equal(answer.loot_container_id, container.id)
  assert.match(answer.narration, /панель добычи/u)
  assert.doesNotMatch(answer.narration, /команды извлечения/u)

  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: container.items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
  })
  const afterAnswer = resolveCorpseSearch(looted.state, text, bindFreeActionReadingToState(looted.state, 'hero', text, interpretFreeAction(text)))
  assert.equal(afterAnswer.server_owned_contents, false)
  assert.match(afterAnswer.narration, /уже всё сняли/u)
})

test('подсказка зовёт обыскать тело и честна про досягаемость', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const near = campaignStateForViewer(killed.state, { role: 'player', id: 'u1' }, 'hero').suggested_actions ?? []
  // Вид контейнера уже стоит в его имени, поэтому подсказка склеивает не
  // «Можно обыскать: Тело: Разбойник», а глагол вида с именем павшего.
  assert.ok(near.some((hint) => /Можно обыскать тело: /u.test(hint.text)), JSON.stringify(near))
  assert.equal(near.some((hint) => /обыскать: Тело/u.test(hint.text)), false, 'вид не должен повторяться дважды')
  const far = campaignStateForViewer(killed.state, { role: 'player', id: 'u2' }, 'mate').suggested_actions ?? []
  assert.ok(far.some((hint) => /надо подойти вплотную/u.test(hint.text)), JSON.stringify(far))
})

test('сырой реестр контейнеров игроку не уезжает и не несёт стат-блок', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const room = campaignStateForViewer(killed.state, { role: 'player', id: 'u1' }, 'hero')
  const serialized = JSON.stringify(room.loot_containers)
  assert.equal(serialized.includes('srd_5_2_1:bandit'), false, 'template_id стат-блока в проекции недопустим')
  assert.equal(serialized.includes('"origin"'), false)
  assert.equal(serialized.includes('"owner"'), false)
  // Реестр целиком принадлежит ведущему.
  assert.equal(campaignStateForViewer(killed.state, { role: 'admin', id: 'gm' }, '').loot_containers.containers.length, 1)
})

test('санитайзер событий не отдаёт ни содержимое рождения, ни остаток тела', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const created = mechanicsForViewer(killed.events, { role: 'player', id: 'u1' }, 'hero', killed.state)
    .find((event) => event.event_type === 'LootContainerCreated')
  assert.ok(created)
  assert.equal(created.payload.container.items, undefined, 'что внутри — узнают, подойдя')
  assert.equal(JSON.stringify(created.payload).includes('srd_5_2_1:bandit'), false)

  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }],
  })
  const taken = mechanicsForViewer(looted.events, { role: 'player', id: 'u1' }, 'hero', looted.state)
    .find((event) => event.event_type === 'LootContainerTaken')
  assert.ok(taken)
  assert.equal(taken.payload.remaining_items, undefined, 'остаток тела читается только обыском')
  assert.equal(taken.payload.items.length, 1, 'взятое отряд видит: оно уже у него в сумке')
  assert.equal(JSON.stringify(taken.payload).includes('srd_5_2_1:bandit'), false)
})

test('карточка обещает ровно ту цену, что придёт в сумку героя', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const scimitar = container.items.find((item) => item.catalog_id === 'srd_5_2_1:scimitar')
  assert.ok(scimitar, 'разбойник обязан прийти со скимитаром')
  assert.ok(scimitar.snapshot.base_price_cp > 0, 'в снимке экземпляра каталожная цена есть')

  // Торгового каталога скимитар не знает, и `normalizeInventoryItem` выдаст
  // вещь без цены. Карточка обязана молчать ровно там же, где молчит сумка.
  assert.equal(lootItemForViewer(scimitar).base_price_cp, undefined)
  const looted = commit(killed.state, {
    command_type: 'LootContainer',
    actor_id: 'hero',
    container_id: container.id,
    lines: [{ item_instance_id: scimitar.item_instance_id, quantity: 1 }],
  })
  const inBag = looted.state.players.find((player) => player.id === 'hero').inventory
    .find((item) => item.catalog_id === 'srd_5_2_1:scimitar')
  assert.ok(inBag)
  assert.equal(inBag.base_price_cp, undefined, 'иначе карточка обещала бы то, чего движок не выдаёт')

  // Вещь, которую торговый каталог знает, цену сохраняет в обоих местах.
  const dagger = lootItemForViewer({
    item_instance_id: 'probe-dagger',
    catalog_id: 'srd_5_2_1:dagger',
    quantity: 1,
    snapshot: { name: 'Кинжал', type: 'weapon', weight: 1, base_price_cp: 999_999 },
  })
  assert.ok(dagger.base_price_cp > 0)
  assert.notEqual(dagger.base_price_cp, 999_999, 'цену решает политика каталога, а не снимок')
})

// ---------------------------------------------------------------------------
// 7. Контейнер переживает уход со сцены

test('контейнер помнит ярус: этажом выше его не видно и не обыскать', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  assert.equal(container.location_id, 'warehouse', 'на нулевом ярусе ключ — сам идентификатор локации')

  // Ключ строится из `scene.level.index` — тем же `levelKey`, которым подписана
  // карта яруса. Потеря или переименование поля роняла бы многоэтажную добычу
  // молча, поэтому его читает тест, а не только человек.
  const upstairs = normalizeCampaignState({
    ...killed.state,
    scene: { ...killed.state.scene, level: { index: 2, label: 'Второй ярус' } },
  })
  assert.equal(sceneLootLocationKey(upstairs), 'warehouse@L2')
  assert.deepEqual(lootContainersInScene(upstairs), [], 'тело осталось этажом ниже')
  assert.equal(lootContainersForViewer(upstairs, { actorId: 'hero' }).containers.length, 0)
  assert.throws(
    () => validateCommand({
      campaign_id: 'LOOT',
      command_type: 'LootContainer',
      actor_id: 'hero',
      container_id: container.id,
      lines: [{ item_instance_id: container.items[0].item_instance_id, quantity: 1 }],
    }, upstairs, CONTEXT),
    (error) => error.code === 'LOOT_CONTAINER_NOT_IN_SCENE',
  )

  const back = normalizeCampaignState({ ...upstairs, scene: killed.state.scene })
  assert.equal(lootContainersInScene(back).length, 1)
  assert.equal(lootContainersInScene(back)[0].id, container.id)

  // И наоборот: тело, оставленное на втором ярусе, подписано этим ярусом.
  const fought = kill(normalizeCampaignState({
    ...campaign({ combat: false }),
    scene: { ...campaign({ combat: false }).scene, level: { index: 2, label: 'Второй ярус' } },
  }), 'foe-1')
  assert.equal(containerOf(fought.state).location_id, 'warehouse@L2')
})

test('невзятое переживает смену сцены и находится по возвращении', () => {
  const killed = kill(campaign({ combat: false }), 'foe-1')
  const container = containerOf(killed.state)
  const elsewhere = normalizeCampaignState({
    ...killed.state,
    enemies: [],
    scene: { ...killed.state.scene, title: 'Дорога', location: 'Дорога', location_id: 'road' },
  })
  assert.equal(lootContainerList(elsewhere).length, 1, 'контейнер живёт в состоянии кампании, а не в сцене')
  assert.deepEqual(lootContainersInScene(elsewhere), [], 'на другой сцене его не видно')
  assert.equal(
    lootContainersForViewer(elsewhere, { actorId: 'hero' }).containers.length,
    0,
  )

  const back = normalizeCampaignState({ ...elsewhere, scene: killed.state.scene })
  assert.equal(lootContainersInScene(back).length, 1)
  assert.equal(lootContainersInScene(back)[0].id, container.id)
})

// ---------------------------------------------------------------------------
// 8. Плен и парлей

test('пленный приходит на допрос обезоруженным, а карман остаётся при нём', () => {
  const surrendered = bandit('foe-1', { x: 2, y: 1, hp: 6 })
  const state = normalizeCampaignState({
    ...campaign({ enemies: [surrendered] }),
    mechanics: {
      ...campaign({ enemies: [surrendered] }).mechanics,
      conditions: { 'foe-1': [{ id: 'surrendered' }] },
    },
  })
  const ended = resolveCommands([{
    command_type: 'EndCombat', actor_id: 'hero', reason: 'enemies_defeated', command_id: 'cmd-end', campaign_id: 'LOOT',
  }], state, { diceService: dice(), context: CONTEXT })

  const container = containerOf(ended.state, 'captive')
  assert.ok(container, 'разоружение обязано случиться в той же фиксации, что и плен')
  assert.equal(container.source_enemy_id, 'foe-1')
  assert.equal(container.items.every((item) => item.snapshot.type === 'weapon'), true, 'в контейнер уходит только оружие')
  assert.ok(container.items.some((item) => item.catalog_id === 'srd_5_2_1:scimitar'))
  const enemyAfter = ended.state.enemies.find((enemy) => enemy.id === 'foe-1')
  assert.equal(enemyAfter.loadout.items.some((item) => item.catalog_id === 'srd_5_2_1:scimitar'), false)
  assert.equal(
    enemyAfter.loadout.items.some((item) => item.catalog_id === 'srd_5_2_1:bolts-20'),
    true,
    'не-оружие остаётся у пленного: разоружают, а не обшаривают',
  )
})

test('уговор «уходят, оставив добычу» оставляет отряду брошенный тюк', () => {
  const foes = [bandit('foe-1', { x: 4, y: 1, hp: 4 }), bandit('foe-2', { x: 5, y: 1, hp: 4, seed: 'loot-seed-2' })]
  const base = campaign({ enemies: foes })
  const state = normalizeCampaignState({
    ...base,
    social: {
      npcs: [{
        id: 'foe-1',
        name: 'Атаман',
        role: 'предводитель',
        location: 'Склад',
        visibility: 'party',
        available: false,
        tags: ['parley-leader'],
      }],
    },
    mechanics: {
      ...base.mechanics,
      combat: {
        ...base.mechanics.combat,
        truce: {
          schema_version: 1,
          leader_id: 'foe-1',
          leader_name: 'Атаман',
          round: 2,
          outcomes: ['resume', 'withdraw', 'tribute'],
          tribute_cp: 40,
          policy_id: 'skazanie:parley-v1',
        },
      },
    },
  })
  const settled = commit(state, {
    command_type: 'SettleParley', actor_id: 'hero', outcome: 'tribute',
  })
  const container = containerOf(settled.state, 'abandoned')
  assert.ok(container, 'уговор «оставив добычу» обязан оставить контейнер')
  assert.deepEqual(container.source_enemy_ids.sort(), ['foe-1', 'foe-2'])
  assert.ok(container.items.length >= 2)
  assert.equal(settled.state.enemies.every((enemy) => enemy.loadout.items.every((item) => item.lootable !== true)), true)
})

test('уговор «разойтись миром» добычи не оставляет', () => {
  const foes = [bandit('foe-1', { x: 4, y: 1, hp: 4 })]
  const base = campaign({ enemies: foes })
  const state = normalizeCampaignState({
    ...base,
    mechanics: {
      ...base.mechanics,
      combat: {
        ...base.mechanics.combat,
        truce: {
          schema_version: 1,
          leader_id: 'foe-1',
          leader_name: 'Атаман',
          round: 2,
          outcomes: ['resume', 'withdraw'],
          tribute_cp: 0,
          policy_id: 'skazanie:parley-v1',
        },
      },
    },
  })
  const settled = commit(state, { command_type: 'SettleParley', actor_id: 'hero', outcome: 'withdraw' })
  assert.equal(lootContainerList(settled.state).length, 0, 'ушедшие с миром уносят своё')
})
