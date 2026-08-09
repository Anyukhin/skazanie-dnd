import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignStateForViewer, mechanicsForViewer, publicWorldMapFor, turnExplanationForViewer, turnResultForViewer } from '../server/viewer-projection.mjs'

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

/**
 * Ровно то выражение, которым клиент строит адрес картинки локации
 * (`src/App.tsx`; сторож его формы — `test/scene-interaction-ui-contract.test.mjs`).
 * Здесь оно применяется к настоящей проекции, а не к тексту исходника.
 */
function locationArtIdFor(projected) {
  return String(projected.scene.location_id ?? projected.worldMap?.currentLocationId ?? '')
}

test('у игрока остаётся непустой источник иллюстрации локации даже на длинной кампании', () => {
  const authored = privateState()
  authored.scene.location_id = 'norvin'
  const projected = campaignStateForViewer(authored, user, 'hero')
  // Публичная сцена id локации не несёт — он есть только у ведущего. Значит у
  // игрока остаётся ровно одно поле, и его пустота означает шапку сцены с
  // библиотечной подложкой вместо картинки и карту мира без метки «вы здесь».
  assert.equal(projected.scene.location_id, undefined)
  assert.equal(locationArtIdFor(projected), 'norvin')

  // Полсотни известных мест — обычная длинная кампания: `reconcileWorldMap`
  // заводит точку на каждую посещённую локацию. Текущая точка уезжала за
  // границу среза в `publicWorldMapFor`, и игроки молча оставались без
  // иллюстраций, пока ведущий видел их как обычно.
  const long = privateState()
  long.worldMap.locations = [
    ...Array.from({ length: 64 }, (_, index) => ({
      id: `chronicle-${index}`, name: `Место ${index}`, kind: 'landmark', x: index, y: index,
      regionId: 'north', summary: 'Место, сохранённое в хронике кампании.', known: true, visited: true,
    })),
    ...long.worldMap.locations,
  ]
  const far = campaignStateForViewer(long, user, 'hero')
  assert.equal(locationArtIdFor(far), 'norvin')
  assert.ok(far.worldMap.locations.some((location) => location.id === 'norvin'),
    'текущая точка обязана остаться в списке — по ней рисуется метка «вы здесь»')
  assert.ok(far.worldMap.locations.length <= 50, 'лимит публичной карты мира остаётся прежним')
  assert.doesNotMatch(JSON.stringify(far.worldMap), /secret-vault|hidden-region/u)
})

test('кампания без текущей локации получает обычный срез, а не поднятую пустую точку', () => {
  // `worldMap.currentLocationId` — поле необязательное, и пустая строка тут
  // норма. Локация с пустым id за границей среза — редкость, но проверка
  // «текущая ушла за предел» обязана быть ложной в обоих случаях: иначе
  // мусорная запись встаёт в карту игрока вместо честной пятидесятой.
  const locations = Array.from({ length: 60 }, (_, index) => ({
    id: index === 54 ? '' : `loc-${index}`, name: `Место ${index}`, x: index, y: index, known: true,
  }))
  const projected = publicWorldMapFor({ locations })

  assert.equal(projected.currentLocationId, '')
  assert.equal(projected.locations.length, 50)
  assert.deepEqual(
    projected.locations.map((location) => location.id),
    Array.from({ length: 50 }, (_, index) => `loc-${index}`),
  )
})

test('за пределом среза место уступает пятидесятая точка — вместе со своими маршрутами', () => {
  // Цена перестановки, названная явно: лимит в полсотни точек никуда не делся,
  // и текущая локация входит в срез не сверх него, а вместо последней.
  const locations = Array.from({ length: 60 }, (_, index) => ({
    id: `loc-${index}`, name: `Место ${index}`, x: index, y: index, known: true,
  }))
  const projected = publicWorldMapFor({
    currentLocationId: 'loc-55',
    locations,
    routes: [
      { id: 'route-near', from: 'loc-0', to: 'loc-1', kind: 'road', distance: 2 },
      { id: 'route-dropped', from: 'loc-48', to: 'loc-49', kind: 'road', distance: 2 },
    ],
  })

  assert.equal(projected.currentLocationId, 'loc-55')
  assert.equal(projected.locations.length, 50)
  assert.equal(projected.locations.at(-1).id, 'loc-55')
  assert.equal(projected.locations.some((location) => location.id === 'loc-49'), false)
  assert.deepEqual(projected.routes.map((route) => route.id), ['route-near'])
})

test('player inventory projection derives safe catalog capabilities without hydrating snapshots', () => {
  const raw = privateState()
  raw.players[0].inventory = [
    {
      id: 'legacy-kit',
      catalog_id: 'srd_5_2_1:healers-kit',
      name: 'Старый набор лекаря',
      type: 'gear',
      quantity: 1,
    },
    {
      id: 'legacy-weapon',
      name: 'Старый клинок',
      type: 'weapon',
      quantity: 1,
      combat: { kind: 'melee', ability: 'str', damage: '1d6', damageType: 'slashing', normalRange: 5 },
    },
    {
      id: 'mislabelled-torch',
      catalog_id: 'srd_5_2_1:torch',
      name: 'Факел',
      type: 'weapon',
      quantity: 1,
      combat: { kind: 'melee', damage: '99d99' },
      requires_attunement: true,
    },
    {
      id: 'legacy-ring',
      catalog_id: 'srd_5_2_1:ring-of-protection',
      name: 'Кольцо защиты',
      type: 'other',
      quantity: 1,
      mechanics_status: 'verified',
      limitation: 'Поддельное ограничение',
    },
    {
      id: 'homebrew-attunement',
      name: 'Домашний талисман',
      type: 'other',
      quantity: 1,
      requires_attunement: true,
    },
  ]

  const projected = campaignStateForViewer(raw, user, 'hero')
  const kit = projected.players[0].inventory.find((item) => item.id === 'legacy-kit')
  const legacyWeapon = projected.players[0].inventory.find((item) => item.id === 'legacy-weapon')
  const torch = projected.players[0].inventory.find((item) => item.id === 'mislabelled-torch')
  const ring = projected.players[0].inventory.find((item) => item.id === 'legacy-ring')
  const homebrew = projected.players[0].inventory.find((item) => item.id === 'homebrew-attunement')

  assert.deepEqual(kit.capabilities.charges, { current: 10, max: 10 })
  assert.deepEqual(kit.capabilities.use, {
    kind: 'stabilize',
    action_type: 'action',
    target: 'party',
    range_feet: 5,
    charges_per_use: 1,
  })
  assert.equal(legacyWeapon.capabilities.equippable, true)
  assert.equal(legacyWeapon.capabilities.equip_slot, 'main_hand')
  assert.equal(torch.capabilities.equippable, false)
  assert.equal(torch.capabilities.requires_attunement, false)
  assert.equal(torch.capabilities.mechanics_status, 'partial')
  assert.equal(typeof torch.capabilities.limitation, 'string')
  assert.equal(ring.capabilities.equippable, true)
  assert.equal(ring.capabilities.equip_slot, 'ring-protection')
  assert.equal(ring.capabilities.requires_attunement, true)
  assert.equal(ring.capabilities.mechanics_status, 'partial')
  assert.match(ring.capabilities.limitation, /Short Rest/u)
  assert.doesNotMatch(ring.capabilities.limitation, /Поддельное/u)
  assert.equal(homebrew.capabilities.requires_attunement, true)
  assert.equal(homebrew.capabilities.equippable, false)
  assert.equal(Object.hasOwn(homebrew.capabilities, 'mechanics_status'), false)
  assert.equal(Object.hasOwn(legacyWeapon.capabilities, 'mechanics_status'), false)
  assert.equal(Object.hasOwn(legacyWeapon.capabilities, 'limitation'), false)
  assert.equal(raw.players[0].inventory.some((item) => Object.hasOwn(item, 'capabilities')), false)
  assert.equal(raw.players[0].inventory[0].charges, undefined)
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

test('профиль закрытого NPC не доезжает столу даже party-видимым событием', () => {
  // Сторож ветки `NpcSocialProfileUpserted` в `eventForViewer` — это
  // `&& payload.npc`, и держится он не на «живых производителей с закрытым NPC
  // нет»: узел `payload.npc` выбрасывает целиком слой ниже,
  // `projectVisibleState`, по собственной `visibility` самого NPC, и игроку
  // приезжает пустой payload. Своей проверки `viewerMaySee` в ветке поэтому
  // нет — дублировать нижний слой нечем. Но и снять `&& payload.npc` нельзя:
  // без него белый список получит `undefined` ровно на этом событии.
  const state = privateState()
  const raw = [{
    event_type: 'NpcSocialProfileUpserted',
    actor_id: 'gm',
    target_ids: [],
    visibility: 'party',
    payload: {
      npc: {
        id: 'npc-traitor',
        name: 'Тайный связной',
        role: 'предатель',
        visibility: 'gm_only',
        goals: ['предать отряд'],
        social_dcs: { persuasion: 22 },
      },
    },
  }]
  const projected = mechanicsForViewer(raw, user, 'hero', state)
  assert.equal(projected.length, 1, 'само событие из ленты не пропадает — режется его начинка')
  assert.deepEqual(projected[0].payload, {}, 'закрытый NPC выбрасывается целиком слоем ниже ветки')
  assert.equal(JSON.stringify(projected).includes('предать отряд'), false)
  assert.equal(mechanicsForViewer(raw, { role: 'admin' }, 'hero', state)[0].payload.npc.goals[0], 'предать отряд')
})

test('magic-item combat outcomes do not disclose an enemy inventory', () => {
  const state = privateState()
  const hiddenSource = {
    effect_id: 'hidden-effect', item_id: 'hidden-instance', item_name: 'Секретный предмет',
    catalog_id: 'srd_5_2_1:hidden-magic-item',
  }
  const raw = [
    {
      event_type: 'DamageApplied', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public',
      payload: { target_id: 'goblin-secret', resistant: true, applied_amount: 3, item_resistance_sources: [hiddenSource] },
    },
    {
      event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public',
      payload: { target_id: 'goblin-secret', hit: true, critical_prevented: true, critical_protection_sources: [hiddenSource] },
    },
    {
      event_type: 'SpellImmunityResolved', actor_id: 'hero', target_ids: ['goblin-secret'], visibility: 'public',
      payload: { target_id: 'goblin-secret', spell_id: 'magic-missile', item_immunity_sources: [hiddenSource] },
    },
    {
      event_type: 'DamageApplied', actor_id: 'goblin-secret', target_ids: ['hero'], visibility: 'public',
      payload: { target_id: 'hero', applied_amount: 7, item_damage_rider: true, ...hiddenSource },
    },
  ]
  const projected = mechanicsForViewer(raw, user, 'hero', state)

  assert.equal(projected[0].payload.resistant, true)
  assert.equal(projected[0].payload.item_resistance_sources, undefined)
  assert.equal(projected[1].payload.critical_prevented, true)
  assert.equal(projected[1].payload.critical_protection_sources, undefined)
  assert.equal(projected[2].payload.spell_id, 'magic-missile')
  assert.equal(projected[2].payload.item_immunity_sources, undefined)
  assert.equal(projected[3].payload.item_damage_rider, true)
  assert.equal(projected[3].payload.catalog_id, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /hidden-instance|hidden-effect|hidden-magic-item|Секретный предмет/u)
  assert.match(JSON.stringify(mechanicsForViewer(raw, { role: 'admin' }, 'hero', state)), /hidden-magic-item/u)
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

test('reward projection keeps coin transcript but hides frozen stat blocks and per-enemy XP', () => {
  const state = privateState()
  const raw = [
    {
      event_type: 'EncounterOutcomeRecorded',
      visibility: 'party',
      payload: {
        encounter_id: 'encounter-secret',
        outcome: 'enemies_defeated',
        plan: { enemies: [{ enemy_id: 'goblin-secret', stat_block_id: 'srd:secret-goblin', xp: 9_999 }] },
        prepared_reward: { secret_seed: 'never-project' },
      },
    },
    {
      event_type: 'EncounterCoinsRolled',
      visibility: 'party',
      payload: {
        encounter_id: 'encounter-secret',
        total_cp: 12,
        rolls: [{
          roll_id: 'coin-roll', expression: '1d6', dice: [3], total: 3, amount_cp: 12,
          enemy_id: 'goblin-secret', stat_block_id: 'srd:secret-goblin', xp: 100, xp_units: 4,
        }],
      },
    },
  ]
  const projected = mechanicsForViewer(raw, user, 'hero', state)
  assert.equal(projected[0].payload.plan, undefined)
  assert.equal(projected[0].payload.prepared_reward, undefined)
  assert.deepEqual(projected[1].payload.rolls, [{
    roll_id: 'coin-roll', expression: '1d6', dice: [3], total: 3, amount_cp: 12,
  }])
  assert.doesNotMatch(JSON.stringify(projected), /secret-goblin|9_999|never-project/u)
  assert.equal(mechanicsForViewer(raw, { role: 'admin' }, 'hero', state)[0].payload.plan.enemies[0].xp, 9_999)
})

test('Hit Dice pools stay private to their hero in event and explanation projections', () => {
  const state = privateState()
  const raw = [
    {
      event_type: 'HitPointDieSpent', actor_id: 'fighter', target_ids: ['fighter'], visibility: 'public',
      payload: {
        applied_healing: 7,
        pool_before: { schema_version: 1, maximum: 4, spent: 1, die_size: 10 },
        pool_after: { schema_version: 1, maximum: 4, spent: 2, die_size: 10 },
      },
    },
    {
      event_type: 'HitPointDiceRestored', actor_id: 'fighter', target_ids: ['fighter'], visibility: 'public',
      payload: {
        restored: 2,
        pool_before: { schema_version: 1, maximum: 4, spent: 2, die_size: 10 },
        pool_after: { schema_version: 1, maximum: 4, spent: 0, die_size: 10 },
      },
    },
  ]

  const otherHero = mechanicsForViewer(raw, user, 'hero', state)
  assert.equal(otherHero[0].payload.applied_healing, 7)
  for (const event of otherHero) {
    assert.equal(event.payload.pool_before, undefined)
    assert.equal(event.payload.pool_after, undefined)
    assert.equal(event.payload.restored, undefined)
  }
  assert.doesNotMatch(JSON.stringify(turnExplanationForViewer({ events: raw }, user, 'hero', state)), /pool_before|pool_after|restored/u)

  const owner = mechanicsForViewer(raw, { role: 'player', heroIds: ['fighter'] }, 'fighter', state)
  assert.equal(owner[0].payload.pool_after.spent, 2)
  assert.equal(owner[1].payload.restored, 2)
  assert.equal(mechanicsForViewer(raw, { role: 'admin' }, 'hero', state)[0].payload.pool_after.spent, 2)
})

test('admin projection retains trusted state and also receives item capabilities', () => {
  const state = privateState()
  state.players[0].inventory = [{
    id: 'ring',
    catalog_id: 'srd_5_2_1:ring-of-protection',
    name: 'Кольцо защиты',
    type: 'other',
    quantity: 1,
  }]
  const projected = campaignStateForViewer(state, { role: 'admin' }, 'hero')
  assert.notEqual(projected, state)
  assert.equal(projected.adventure, state.adventure)
  assert.equal(projected.players[0].inventory[0].capabilities.requires_attunement, true)
  assert.equal(state.players[0].inventory[0].capabilities, undefined)
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
