import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignStateForViewer, mechanicsForViewer, turnResultForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }

function privateState() {
  return {
    sessionCode: 'VISIBLE',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Лира', inventory: [] }],
    scene: {
      title: 'Архив', location: 'Норвин', mood: 'Тихо', objective: 'Найти печать', turn: 2,
      gm_only: { boss: 'дракон' }, hidden_information: { trap: 'руна' },
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: false, feature: 'enemy', secret: 'засада' },
        { x: 1, y: 0, type: 'floor', revealed: true, feature: 'torch' },
      ],
    },
    locationMaps: {
      norvin: {
        version: 1,
        cells: [{ x: 0, y: 0, type: 'floor', revealed: false, feature: 'hidden-map-secret' }],
      },
    },
    adventure: {
      chapter: 2, currentHook: 'Публичный след печати', visitedLocations: ['Норвин'], unresolvedThreads: ['Открыть печать'],
      history: [{ chapter: 1, title: 'Склеп', location: 'Склеп', objective: 'Выйти', outcome: 'Герои вышли', gm_only: 'предательство' }],
      gm_only: { villain: 'канцлер' }, hidden_information: { trueDoor: 'север' }, private_notes: 'не показывать',
    },
    worldMap: {
      version: 1, seed: 'visible-map', name: 'Известные земли', width: 1000, height: 640, currentLocationId: 'norvin',
      regions: [
        { id: 'north', name: 'Север', biome: 'forest', x: 100, y: 100, radius: 80 },
        { id: 'hidden-region', name: 'Тайная область', biome: 'void', x: 800, y: 500, radius: 80 },
      ],
      locations: [
        { id: 'norvin', name: 'Норвин', kind: 'city', x: 100, y: 100, regionId: 'north', summary: 'Текущий город', known: true, visited: true },
        { id: 'secret-vault', name: 'Тайное хранилище', kind: 'dungeon', x: 220, y: 140, regionId: 'north', summary: 'Скрытая база канцлера', known: false, visited: false },
      ],
      routes: [
        { id: 'secret-road', from: 'norvin', to: 'secret-vault', kind: 'trail', distance: 2, danger: 'high', discovered: false },
      ],
    },
    merchants: [
      {
        id: 'here', name: 'Марта', title: 'Торговец', location: '  НОРВИН ', available: true,
        stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'gear', quantity: 2, base_price_cp: 1, secret_supplier: 'культ' }],
        pricing: { mode: 'catalog', agent_adjustment_bps: -500, bargain_dc: 1 }, bargains: { hero: { success: true } }, secret: 'контрабанда',
      },
      { id: 'far', name: 'Дальний', location: 'Лес', available: true, stock: [], pricing: {} },
    ],
    enemies: [{
      id: 'goblin-secret', name: 'Гоблин-воин', hp: 7, maxHp: 11, armor: 15, speed: 30,
      stat_block_id: 'srd:secret-goblin', attack_bonus: 4, x: 3, y: 2, alive: true,
    }],
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 1,
        initiative: [
          { actor_id: 'hero', roll: 12, modifier: 2, total: 14 },
          { actor_id: 'goblin-secret', roll: 18, modifier: 4, total: 22 },
        ],
      },
    },
    battleLog: [{
      id: 'battle-secret', type: 'attack', actorId: 'hero', actorKind: 'player',
      targetId: 'goblin-secret', damage: 4, hpBefore: 11, hpAfter: 7,
      roll: { die: 12, modifier: 5, total: 17, difficulty: 15, hit: true },
    }],
    messages: [{
      id: 'combat-secret', speaker: 'system', author: 'Система боя',
      text: 'Лира атакует Гоблин-воин: 17 против КД 15 — попадание. Гоблин-воин получает 4 урона; ОЗ 11 → 7.',
    }],
  }
}

test('player campaign projection hides private memory, fog features and remote merchant internals', () => {
  const projected = campaignStateForViewer(privateState(), user, 'hero')
  const encoded = JSON.stringify(projected)
  assert.doesNotMatch(encoded, /дракон|засада|предательство|канцлер|trueDoor|контрабанда|secret_supplier|bargains|agent_adjustment_bps/u)
  assert.equal(projected.locationMaps, undefined)
  assert.equal(projected.scene.cells[0].feature, undefined)
  assert.equal(projected.scene.cells[1].feature, 'torch')
  assert.deepEqual(projected.merchants.map((merchant) => merchant.id), ['here'])
  assert.equal(projected.adventure.currentHook, 'Публичный след печати')
  assert.equal(projected.adventure.history[0].outcome, 'Герои вышли')
  assert.deepEqual(projected.worldMap.locations.map((location) => location.id), ['norvin'])
  assert.deepEqual(projected.worldMap.routes, [])
  assert.equal(projected.worldMap.seed, undefined)
  assert.deepEqual(projected.worldMap.regions.map((region) => region.id), ['north'])
  assert.doesNotMatch(encoded, /Тайное хранилище|Скрытая база канцлера|secret-vault|secret-road|hidden-region|Тайная область|visible-map/u)
  assert.deepEqual(projected.enemies[0], {
    id: 'goblin-secret', name: 'Гоблин-воин', x: 3, y: 2, alive: true, healthStatus: 'wounded', healthKnown: 'banded',
  })
  assert.deepEqual(projected.mechanics.combat.initiative[1], { actor_id: 'goblin-secret' })
  assert.equal(projected.battleLog[0].hpBefore, undefined)
  assert.equal(projected.battleLog[0].hpAfter, undefined)
  assert.equal(projected.battleLog[0].roll.difficulty, undefined)
  assert.doesNotMatch(projected.messages[0].text, /КД 15|ОЗ 11|→ 7/u)
})

test('enemy facts remain qualitative until an explicit server-side knowledge record reveals them', () => {
  const state = privateState()
  const hidden = campaignStateForViewer(state, user, 'hero').enemies[0]
  assert.equal(hidden.hp, undefined)
  assert.equal(hidden.maxHp, undefined)
  assert.equal(hidden.armor, undefined)
  assert.equal(hidden.speed, undefined)
  assert.equal(hidden.stat_block_id, undefined)

  state.mechanics.enemy_knowledge = {
    version: 1,
    party: {
      'goblin-secret': {
        health: 'exact',
        armor_class: 'exact',
        speed: 'exact',
        stat_block: 'exact',
        source_event_ids: ['fact-revealed'],
      },
    },
  }
  const revealed = campaignStateForViewer(state, user, 'hero').enemies[0]
  assert.equal(revealed.hp, 7)
  assert.equal(revealed.healthKnown, 'exact')
  assert.equal(revealed.maxHp, 11)
  assert.equal(revealed.armor, 15)
  assert.equal(revealed.speed, 30)
  assert.equal(revealed.stat_block_id, 'srd:secret-goblin')
  assert.equal(campaignStateForViewer(state, user, 'hero').mechanics.enemy_knowledge, undefined)
})

test('combat event projection removes enemy HP, armor class and initiative modifiers', () => {
  const state = privateState()
  const events = mechanicsForViewer([
    {
      event_type: 'DamageApplied', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public',
      payload: { target_id: 'goblin-secret', applied_amount: 4, hp_before: 11, hp_after: 7, temporary_hp_before: 0, temporary_hp_after: 0 },
    },
    {
      event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public',
      payload: { target_id: 'goblin-secret', kept: 12, modifier: 5, total: 17, armor_class: 15, hit: true },
    },
    {
      event_type: 'CombatStarted', actor_id: 'hero', target_ids: ['hero', 'goblin-secret'], visibility: 'public',
      payload: { initiative: state.mechanics.combat.initiative, round: 1, active_index: 1 },
    },
  ], user, 'hero', state)
  assert.deepEqual(events[0].payload, { target_id: 'goblin-secret', applied_amount: 4 })
  assert.equal(events[1].payload.armor_class, undefined)
  assert.deepEqual(events[2].payload.initiative[1], { actor_id: 'goblin-secret' })
})

// Спасбросок врага — единственный бросок, который делает враг, но инициирует
// герой: actor_id события — заклинатель, а бросает цель. Оба сторожа
// проверяли «враг — действующее лицо», поэтому модификатор характеристики
// врага уезжал игроку и в событии, и в боевом журнале. Продуктовые принципы
// требуют скрывать модификаторы врага до факта раскрытия в enemy_knowledge.
test('enemy saving throws do not reveal the enemy ability modifier', () => {
  const state = privateState()
  const save = {
    roll_id: 'roll-1', expression: '1d20+4', dice: [9], kept: 9, mode: 'normal', modifier: 4, total: 13,
    purpose: 'spell_save:sacred-flame:dex', actor_id: 'goblin-secret', spell_id: 'sacred-flame',
    ability: 'dex', difficulty: 13, saved: true,
  }
  const events = mechanicsForViewer([
    { event_type: 'SpellSavingThrowResolved', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public', payload: { ...save } },
    { event_type: 'ConcentrationSavingThrowResolved', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public', payload: { ...save, ability: 'con' } },
  ], user, 'hero', state)
  for (const event of events) {
    for (const key of ['modifier', 'kept', 'dice', 'expression', 'roll_id']) {
      assert.equal(event.payload[key], undefined, `${event.event_type}.${key} раскрывает бросок врага`)
    }
    // Исход виден: игрок обязан понимать, устоял враг или нет.
    assert.equal(event.payload.total, 13)
    assert.equal(event.payload.saved, true)
  }
})

test('battle log hides the ability modifier of an enemy saving throw', () => {
  const state = privateState()
  state.battleLog = [
    {
      id: 'log-1', type: 'spell-save', actorId: 'hero', actorKind: 'player', targetId: 'goblin-secret',
      spellId: 'sacred-flame', ability: 'dex', result: 'success',
      roll: { die: 9, modifier: 4, total: 13, difficulty: 13, hit: true },
    },
    {
      id: 'log-2', type: 'attack', actorId: 'hero', actorKind: 'player', targetId: 'goblin-secret',
      roll: { die: 12, modifier: 5, total: 17, difficulty: 15, hit: true },
    },
    {
      id: 'log-3', type: 'attack', actorId: 'goblin-secret', actorKind: 'enemy', targetId: 'hero',
      roll: { die: 17, modifier: 4, total: 21, difficulty: 16, hit: true },
      rollMode: 'advantage', rollDice: [8, 17], advantageReasons: ['тактика стаи'],
    },
  ]
  const [save, attack, enemyAttack] = campaignStateForViewer(state, user, 'hero').battleLog
  assert.equal(save.roll.modifier, undefined)
  assert.equal(save.roll.die, undefined)
  assert.equal(save.roll.total, 13)
  assert.equal(save.roll.hit, true)
  // Свой бросок атаки герой по-прежнему видит целиком, кроме КД врага.
  assert.equal(attack.roll.modifier, 5)
  assert.equal(attack.roll.die, 12)
  assert.equal(attack.roll.difficulty, undefined)
  assert.equal(enemyAttack.rollDice, undefined, 'кости NPC не должны раскрывать его модификатор')
  assert.equal(enemyAttack.rollMode, 'advantage')
  assert.deepEqual(enemyAttack.advantageReasons, ['тактика стаи'])
})

test('player event projection sanitizes SceneAdvanced and MerchantCreated payloads', () => {
  const state = privateState()
  const events = mechanicsForViewer([
    { event_type: 'SceneAdvanced', visibility: 'public', payload: { scene: state.scene, adventure: state.adventure } },
    { event_type: 'MerchantCreated', visibility: 'public', payload: { merchant: state.merchants[0] } },
    { event_type: 'GmSecret', visibility: 'gm_only', payload: { secret: 'никогда' } },
  ], user, 'hero')
  assert.deepEqual(events.map((event) => event.event_type), ['SceneAdvanced', 'MerchantCreated'])
  assert.equal(events[0].payload.scene.cells[0].feature, undefined)
  assert.equal(events[0].payload.adventure.gm_only, undefined)
  assert.equal(events[1].payload.merchant.bargains, undefined)
  assert.doesNotMatch(JSON.stringify(events), /никогда|канцлер|контрабанда/u)
})

test('admin projection remains the trusted object', () => {
  const state = privateState()
  assert.equal(campaignStateForViewer(state, { role: 'admin' }, 'hero'), state)
})

test('turn result projection covers authoritative state, mechanics and effects.scene', () => {
  const state = privateState()
  const projected = turnResultForViewer({
    authoritative_state: state,
    mechanics: [{ event_type: 'SceneAdvanced', payload: { scene: state.scene, adventure: state.adventure } }],
    effects: { scene: { scene: state.scene, adventure: state.adventure, transition: 'Переход', arrival: 'Прибытие', suggestions: [], entrance: { x: 1, y: 1 } } },
  }, user, 'hero')
  const encoded = JSON.stringify(projected)
  assert.doesNotMatch(encoded, /дракон|канцлер|засада|hidden_information|gm_only/u)
  assert.equal(projected.authoritative_state.scene.cells[0].feature, undefined)
  assert.equal(projected.mechanics[0].payload.scene.cells[0].feature, undefined)
  assert.equal(projected.effects.scene.scene.cells[0].feature, undefined)
})

test('карта в проекции игрока не выдаёт нераскрытую часть', async () => {
  const { publicSceneFor } = await import('../server/viewer-projection.mjs')
  const { cellAt, deserializeTacticalMap, edgeList, tacticalMapFromLegacyCells, addProp, serializeTacticalMap, setDoor, setEdge } =
    await import('../server/tactical-map.mjs')

  const cells = []
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      cells.push({ x, y, type: 'floor', revealed: y === 0, material: 'wood', variant: 3, pattern: 'small-room' })
    }
  }
  const map = tacticalMapFromLegacyCells(cells)
  addProp(map, {
    id: 'seen', assetId: 'table', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }],
    interaction: {
      kind: 'search', verbs: ['inspect'], pointOfInterest: true,
      detailKey: 'secret-cache-under-table', rewardKey: 'server-loot-table:rope',
    },
  })
  addProp(map, { id: 'hidden', assetId: 'chest', x: 1.5, y: 2.5, footprint: [{ x: 1, y: 2 }] })
  setEdge(map, 0, 2, 1, 2, { kind: 'wall' })
  setEdge(map, 0, 0, 1, 0, { kind: 'wall' })
  setDoor(map, { id: 'hidden-door', x: 2, y: 2, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })

  const projected = publicSceneFor({ title: 'Комната', cells, map: serializeTacticalMap(map) })
  assert.ok(projected.map, 'карта обязана попасть в проекцию')
  assert.deepEqual(projected.map.props[0].interaction, {
    kind: 'lore', verbs: ['inspect'], pointOfInterest: true,
  }, 'проекция оставляет глаголы, но скрывает ключи детали и награды')
  assert.equal(projected.map.props[0].interactive, true)
  assert.doesNotMatch(JSON.stringify(projected), /secret-cache-under-table|server-loot-table:rope/u)
  const visible = deserializeTacticalMap(projected.map)

  assert.equal(cellAt(visible, 1, 0)?.material, 'wood', 'раскрытая клетка сохраняет материал')
  assert.equal(cellAt(visible, 1, 0)?.variant, 3)
  assert.equal(cellAt(visible, 1, 2)?.material, 'stone', 'нераскрытая клетка теряет материал')
  assert.equal(cellAt(visible, 1, 2)?.variant, 0, 'нераскрытая клетка теряет вариант тайла')
  assert.ok(cellAt(visible, 1, 2), 'форма карты обязана сохраниться целиком')

  assert.deepEqual(visible.props.map((prop) => prop.assetId), ['table'], 'предмет на нераскрытой клетке не передаётся')
  const edges = edgeList(visible).map((edge) => `${edge.x},${edge.y},${edge.dir}`)
  assert.ok(edges.includes('0,0,e'), 'ребро у раскрытой клетки видно')
  assert.equal(edges.includes('0,2,e'), false, 'ребро между двумя нераскрытыми клетками не передаётся')
  assert.deepEqual(visible.doors, [], 'дверь на нераскрытом ребре не передаётся')
})

test('сцена без карты проецируется как прежде', async () => {
  const { publicSceneFor } = await import('../server/viewer-projection.mjs')
  const projected = publicSceneFor({ title: 'Без карты', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] })
  assert.equal('map' in projected, false)
  assert.equal(projected.cells.length, 1)
})

test('массив клеток и карта скрывают одно и то же', async () => {
  const { publicSceneFor } = await import('../server/viewer-projection.mjs')
  const { cellAt, deserializeTacticalMap, serializeTacticalMap, tacticalMapFromLegacyCells } =
    await import('../server/tactical-map.mjs')

  const cells = [
    { x: 0, y: 0, type: 'floor', revealed: true, material: 'wood', variant: 4, pattern: 'small-room' },
    { x: 1, y: 0, type: 'floor', revealed: false, material: 'marble', variant: 5, pattern: 'small-room' },
  ]
  const projected = publicSceneFor({ cells, map: serializeTacticalMap(tacticalMapFromLegacyCells(cells)) })
  const visible = deserializeTacticalMap(projected.map)

  const openCell = projected.cells.find((cell) => cell.x === 0)
  const hiddenCell = projected.cells.find((cell) => cell.x === 1)
  assert.equal(openCell.material, 'wood')
  assert.equal(openCell.variant, 4)
  assert.equal('material' in hiddenCell, false, 'нераскрытая клетка не должна отдавать материал')
  assert.equal('variant' in hiddenCell, false, 'нераскрытая клетка не должна отдавать вариант тайла')

  // Обе проекции обязаны сходиться: расхождение означало бы второй набор
  // правил видимости, и игрок увидел бы через более щедрый из них.
  assert.equal(cellAt(visible, 0, 0)?.material, openCell.material)
  assert.equal(cellAt(visible, 0, 0)?.variant, openCell.variant)
  assert.equal(cellAt(visible, 1, 0)?.material, 'stone', 'карта обнуляет материал нераскрытой клетки')
  assert.equal(cellAt(visible, 1, 0)?.variant, 0)
})
