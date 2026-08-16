import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { assembleEncounter, SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import {
  ENEMY_LOADOUT_POLICY_ID,
  ENEMY_LOADOUT_SCHEMA_VERSION,
  ENEMY_LOADOUT_TEMPLATE_IDS,
  EnemyLoadoutError,
  assertEnemyLoadoutItem,
  enemyLoadoutFor,
  normalizeEnemyLoadout,
  optionalEnemyLoadoutItem,
} from '../server/enemy-loadouts.mjs'
import {
  ITEM_CATALOG,
  catalogItem,
  materializeCatalogItem,
} from '../server/item-catalog.mjs'
import {
  ITEM_INSTANCE_SCHEMA_VERSION,
  MAX_ITEM_INSTANCE_CHARGES,
  MAX_ITEM_SNAPSHOT_NUMBER,
  ItemInstanceError,
  createItemInstance,
  normalizeItemInstance,
} from '../server/item-instances.mjs'
import { activeItemEffectTotals, derivedEquipmentArmorClass } from '../server/item-lifecycle.mjs'
import { campaignStateForViewer, mechanicsForViewer, publicEnemyFor } from '../server/viewer-projection.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function cells(width = 12, height = 5) {
  return Array.from({ length: height }, (_, y) => (
    Array.from({ length: width }, (_, x) => ({ x, y, type: 'floor', revealed: true }))
  )).flat()
}

function encounter({ theme = 'raiders', difficulty = 'hard', seed = 'campaign-1:chapter-1:encounter-1', level = 3 } = {}) {
  return assembleEncounter({
    scene: { cells: cells() },
    party: [
      { id: 'hero-1', level, x: 0, y: 0 },
      { id: 'hero-2', level, x: 1, y: 0 },
      { id: 'hero-3', level, x: 2, y: 0 },
      { id: 'hero-4', level, x: 3, y: 0 },
    ],
    difficulty,
    theme,
    seed,
  })
}

function allEnemies(themes = ['goblinoids', 'raiders', 'warband', 'law', 'ambush', 'undead', 'beasts', 'vermin', 'crypt', 'cave', 'wilderness', 'generic']) {
  return themes.flatMap((theme) => [
    ...encounter({ theme, difficulty: 'easy', level: 1, seed: `sweep:${theme}:easy` }).enemies,
    ...encounter({ theme, difficulty: 'hard', level: 5, seed: `sweep:${theme}:hard` }).enemies,
    ...encounter({ theme, difficulty: 'deadly', level: 8, seed: `sweep:${theme}:deadly` }).enemies,
  ])
}

test('каталог честно объявляет два метаданных добычи, и ruling-only не проходит ни в один канал', () => {
  for (const entry of Object.values(ITEM_CATALOG)) {
    assert.equal(typeof entry.enemy_loadout_eligible, 'boolean', entry.catalog_id)
    assert.equal(typeof entry.corpse_loot_eligible, 'boolean', entry.catalog_id)
    if (entry.mechanics_status === 'ruling-only') {
      assert.equal(entry.enemy_loadout_eligible, false, entry.catalog_id)
      assert.equal(entry.corpse_loot_eligible, false, entry.catalog_id)
    }
    // Инвентарь противника — узкий канал: магия в него не входит и остаётся за
    // отдельной политикой редкости `magic_loot`. Снять её с тела можно.
    if (entry.magic_item) assert.equal(entry.enemy_loadout_eligible, false, entry.catalog_id)
    // То же и с доспехом, но по другой причине: КД стат-блока объявлено числом.
    if (entry.category === 'armor') {
      assert.equal(entry.enemy_loadout_eligible, false, entry.catalog_id)
      assert.equal(entry.corpse_loot_eligible, true, entry.catalog_id)
    }
    if (entry.enemy_loadout_eligible) assert.equal(entry.corpse_loot_eligible, true, entry.catalog_id)
  }
  // Доспех отклоняется границей, а не отсутствием строки в шаблоне: попытка
  // положить его в инвентарь падает у самого входа.
  for (const catalogId of ['srd_5_2_1:chain-mail', 'srd_5_2_1:ring-mail', 'srd_5_2_1:shield', 'srd_5_2_1:leather-armor']) {
    assert.equal(catalogItem(catalogId).category, 'armor', catalogId)
    assert.throws(
      () => assertEnemyLoadoutItem(catalogId),
      (error) => error instanceof EnemyLoadoutError && error.code === 'ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE',
      catalogId,
    )
  }
})

test('экземпляр предмета несёт снимок каталога, владельца, происхождение и признак добычи', () => {
  const instance = createItemInstance({
    catalogId: 'srd_5_2_1:scimitar',
    instanceId: 'enemy-1-item-1',
    equipped: true,
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit', source_id: 'encounter-proposal-1' },
  })
  assert.equal(instance.schema_version, ITEM_INSTANCE_SCHEMA_VERSION)
  assert.equal(instance.item_instance_id, 'enemy-1-item-1')
  assert.equal(instance.catalog_id, 'srd_5_2_1:scimitar')
  assert.equal(instance.quantity, 1)
  assert.equal(instance.equipped, true)
  assert.deepEqual(instance.owner, { kind: 'enemy', actor_id: 'enemy-1' })
  assert.deepEqual(instance.origin, { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit', source_id: 'encounter-proposal-1' })
  assert.equal(instance.lootable, true)
  assert.equal(instance.snapshot.name, 'Скимитар')
  assert.equal(instance.snapshot.mechanics_status, 'partial')
  assert.equal(instance.snapshot.combat.damage, '1d6')

  assert.throws(() => createItemInstance({
    catalogId: 'srd_5_2_1:not-a-thing',
    instanceId: 'x',
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'enemy_loadout' },
  }), (error) => error instanceof ItemInstanceError && error.code === 'ITEM_INSTANCE_CATALOG_UNKNOWN')
  assert.throws(() => createItemInstance({
    catalogId: 'srd_5_2_1:scimitar',
    instanceId: 'x',
    owner: { kind: 'hero', actor_id: 'hero-1' },
    origin: { kind: 'enemy_loadout' },
  }), (error) => error instanceof ItemInstanceError && error.code === 'ITEM_INSTANCE_OWNER_REQUIRED')
  assert.throws(() => createItemInstance({
    catalogId: 'srd_5_2_1:scimitar',
    instanceId: 'x',
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'made-up' },
  }), (error) => error instanceof ItemInstanceError && error.code === 'ITEM_INSTANCE_ORIGIN_REQUIRED')
})

// Снимок нужен ради replay: пересобранный каталог не переписывает прошлый бой.
// Проверка бьёт по обеим сторонам — снимок совпадает с каталогом на момент
// создания, а нормализация сохранённой записи в каталог уже не ходит.
test('снимок экземпляра совпадает с каталогом при создании и переживает подмену каталога', () => {
  const enemy = encounter({ theme: 'goblinoids', difficulty: 'medium', level: 2, seed: 'snapshot-check' })
    .enemies.find((candidate) => candidate.loadout.items.length > 0)
  assert.ok(enemy, 'в теме гоблиноидов обязан быть хотя бы один вооружённый противник')
  const weapon = enemy.loadout.items.find((item) => item.snapshot.type === 'weapon')
  assert.ok(weapon)
  const materialized = materializeCatalogItem(weapon.catalog_id, {})
  for (const [key, value] of Object.entries(weapon.snapshot)) {
    assert.deepEqual(value, materialized[key], `${weapon.catalog_id}.${key}`)
  }

  const rebalanced = normalizeItemInstance({
    ...weapon,
    snapshot: { ...weapon.snapshot, name: 'Старое имя', combat: { ...weapon.snapshot.combat, damage: '1d99' } },
  })
  assert.equal(rebalanced.snapshot.name, 'Старое имя')
  assert.equal(rebalanced.snapshot.combat.damage, '1d99')
  assert.equal(rebalanced.catalog_id, weapon.catalog_id)
})

test('один сид даёт один и тот же инвентарь, разные противники — разные карманы', () => {
  const first = encounter({ seed: 'stable:seed' })
  const second = encounter({ seed: 'stable:seed' })
  assert.deepEqual(
    first.enemies.map((enemy) => enemy.loadout),
    second.enemies.map((enemy) => enemy.loadout),
  )
  const other = encounter({ seed: 'another:seed' })
  assert.notDeepEqual(
    first.enemies.map((enemy) => enemy.loadout),
    other.enemies.map((enemy) => enemy.loadout),
  )

  // Одинаковые существа в одном бою не должны быть копиями друг друга.
  const twins = allEnemies(['warband', 'raiders', 'law'])
    .filter((enemy) => enemy.loadout.template_id)
  const purses = new Map()
  for (const enemy of twins) {
    const bucket = purses.get(enemy.stat_block_id) ?? new Set()
    bucket.add(enemy.loadout.purse_cp)
    purses.set(enemy.stat_block_id, bucket)
  }
  assert.ok([...purses.values()].some((bucket) => bucket.size > 1), 'карманы обязаны различаться хотя бы у одного вида')
})

test('гарантированная экипировка гуманоида — это оружие его стат-блока, и ничего сверх каталога', () => {
  const humanoids = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)
    .filter(([, block]) => block.creature_type === 'humanoid')
    .map(([statBlockId]) => statBlockId)
  assert.equal(humanoids.length, 16)
  assert.deepEqual([...ENEMY_LOADOUT_TEMPLATE_IDS].sort(), [...humanoids].sort())

  for (const statBlockId of humanoids) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    const loadout = enemyLoadoutFor({ statBlockId, block, ownerId: `${statBlockId}-1`, seed: 'loadout-sweep' })
    assert.equal(loadout.schema_version, ENEMY_LOADOUT_SCHEMA_VERSION)
    assert.equal(loadout.policy_id, ENEMY_LOADOUT_POLICY_ID)
    assert.equal(loadout.template_id, statBlockId)
    const weapons = loadout.items.filter((item) => item.snapshot.type === 'weapon')
    assert.ok(weapons.length >= 1, statBlockId)
    assert.equal(weapons.filter((item) => item.equipped).length, 1, `${statBlockId}: надето ровно одно оружие`)
    // Инвентарь выведен из `action_profiles`, а не назначен рядом: у надетого
    // оружия тот же вид и тот же тип урона, что у основной атаки стат-блока.
    //
    // Числа при этом не сверяются, и это принципиально: у гоблина-налётчика
    // скимитар бьёт 1к4+2, а не каталожные 1к6 — стат-блок остаётся
    // единственным источником боевых формул, каталог описывает вещь.
    const equipped = weapons.find((item) => item.equipped)
    const primary = block.action_profiles[0]
    const slug = equipped.catalog_id.split(':').at(-1)
    assert.equal(String(primary.id).replace(/-(melee|ranged)$/u, ''), slug, `${statBlockId}: ${primary.id} vs ${slug}`)
    assert.equal(equipped.snapshot.combat.damageType, primary.damage_type, `${statBlockId}: тип урона`)
    for (const profile of block.action_profiles) {
      const profileSlug = String(profile.id).replace(/-(melee|ranged)$/u, '')
      const matched = weapons.find((item) => item.catalog_id.split(':').at(-1) === profileSlug)
      assert.ok(matched, `${statBlockId}: у действия ${profile.id} нет вещи в инвентаре`)
      assert.equal(matched.snapshot.combat.damageType, profile.damage_type, `${statBlockId}.${profile.id}: тип урона`)
    }
    for (const item of loadout.items) {
      const entry = catalogItem(item.catalog_id)
      assert.ok(entry, item.catalog_id)
      assert.equal(entry.enemy_loadout_eligible, true, item.catalog_id)
      assert.notEqual(entry.mechanics_status, 'ruling-only', item.catalog_id)
      assert.equal(item.owner.actor_id, `${statBlockId}-1`)
      assert.equal(item.origin.template_id, statBlockId)
      assert.equal(item.lootable, entry.corpse_loot_eligible)
    }
  }
})

test('лучник несёт боеприпасы диапазоном, а карман — только медяки в границах шаблона', () => {
  const seen = new Set()
  for (let index = 0; index < 40; index += 1) {
    const loadout = enemyLoadoutFor({
      statBlockId: 'srd_5_2_1:scout',
      block: SRD_5_2_1_MONSTER_ALLOWLIST['srd_5_2_1:scout'],
      ownerId: `scout-${index}`,
      seed: 'ammunition-range',
    })
    const arrows = loadout.items.find((item) => item.catalog_id === 'srd_5_2_1:arrows-20')
    assert.ok(arrows, 'у разведчика с длинным луком обязаны быть стрелы')
    assert.ok(arrows.quantity >= 1 && arrows.quantity <= 2, String(arrows.quantity))
    seen.add(arrows.quantity)
    assert.ok(loadout.purse_cp >= 5 && loadout.purse_cp <= 30, String(loadout.purse_cp))
  }
  assert.equal(seen.size, 2, 'диапазон обязан давать оба значения, а не одно')
})

test('звери, слизни и безмозглая нежить остаются без инвентаря и без карманов', () => {
  const emptyTypes = new Set(['beast', 'ooze', 'plant', 'construct', 'undead', 'elemental', 'monstrosity', 'dragon', 'celestial', 'giant', 'fiend'])
  for (const [statBlockId, block] of Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST)) {
    if (!emptyTypes.has(block.creature_type)) continue
    const loadout = enemyLoadoutFor({ statBlockId, block, ownerId: `${statBlockId}-1`, seed: 'empty-sweep' })
    assert.deepEqual(loadout.items, [], statBlockId)
    assert.equal(loadout.purse_cp, 0, statBlockId)
    assert.equal(loadout.template_id, null, statBlockId)
  }
})

test('опциональные расходники автошаблона исполняются движком целиком', () => {
  const optional = new Set()
  for (const statBlockId of ENEMY_LOADOUT_TEMPLATE_IDS) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    for (let index = 0; index < 60; index += 1) {
      for (const item of enemyLoadoutFor({ statBlockId, block, ownerId: `${statBlockId}-${index}`, seed: 'consumable-sweep' }).items) {
        if (['consumable', 'gear', 'tool'].includes(catalogItem(item.catalog_id).category)) optional.add(item.catalog_id)
      }
    }
  }
  assert.ok(optional.size > 0, 'шаблоны обязаны хоть иногда давать расходник')
  for (const catalogId of optional) {
    assert.equal(catalogItem(catalogId).mechanics_status, 'verified', catalogId)
  }
})

test('граница шаблона отклоняет ruling-only, магию и невериф. расходник', () => {
  assert.equal(catalogItem('srd_5_2_1:crowbar').mechanics_status, 'ruling-only')
  assert.throws(
    () => assertEnemyLoadoutItem('srd_5_2_1:crowbar'),
    (error) => error instanceof EnemyLoadoutError && error.code === 'ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE',
  )
  assert.throws(
    () => assertEnemyLoadoutItem('srd_5_2_1:ring-of-protection'),
    (error) => error instanceof EnemyLoadoutError && error.code === 'ENEMY_LOADOUT_ITEM_NOT_ELIGIBLE',
  )
  assert.throws(
    () => assertEnemyLoadoutItem('srd_5_2_1:not-a-thing'),
    (error) => error instanceof EnemyLoadoutError && error.code === 'ENEMY_LOADOUT_CATALOG_UNKNOWN',
  )
  // Скимитар — гарантированное оружие стат-блока, для него планка `partial`.
  // Как самостоятельно выбранный расходник он бы не прошёл.
  assert.equal(assertEnemyLoadoutItem('srd_5_2_1:scimitar').mechanics_status, 'partial')
  assert.throws(
    () => assertEnemyLoadoutItem('srd_5_2_1:scimitar', { verifiedOnly: true }),
    (error) => error instanceof EnemyLoadoutError && error.code === 'ENEMY_LOADOUT_CONSUMABLE_NOT_VERIFIED',
  )
  // Даже созданный вручную экземпляр неисполнимой вещи не становится добычей.
  assert.equal(createItemInstance({
    catalogId: 'srd_5_2_1:crowbar',
    instanceId: 'manual-1',
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'enemy_loadout' },
  }).lootable, false)
})

test('старые сохранения нормализуются в пустой инвентарь, мусор в поле отбрасывается', () => {
  const state = normalizeCampaignState({
    players: [],
    enemies: [
      { id: 'legacy-goblin', hp: 7, maxHp: 7 },
      { id: 'garbage', hp: 5, maxHp: 5, loadout: 'нет' },
      {
        id: 'partial',
        hp: 5,
        maxHp: 5,
        loadout: {
          template_id: 'srd_5_2_1:bandit',
          purse_cp: -50,
          items: [
            { catalog_id: 'srd_5_2_1:scimitar' },
            {
              schema_version: 1,
              item_instance_id: 'partial-item-1',
              catalog_id: 'srd_5_2_1:dagger',
              snapshot: { name: 'Кинжал', type: 'weapon', secret: 'не должно проехать' },
              quantity: 3,
              owner: { kind: 'enemy', actor_id: 'partial' },
              origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit' },
              lootable: true,
            },
          ],
        },
      },
    ],
  })
  assert.deepEqual(state.enemies[0].loadout, {
    schema_version: 1, policy_id: ENEMY_LOADOUT_POLICY_ID, template_id: null, items: [], purse_cp: 0,
  })
  assert.deepEqual(state.enemies[1].loadout.items, [])
  assert.equal(state.enemies[2].loadout.purse_cp, 0)
  assert.equal(state.enemies[2].loadout.items.length, 1, 'запись без владельца и происхождения экземпляром не является')
  assert.equal(state.enemies[2].loadout.items[0].item_instance_id, 'partial-item-1')
  assert.equal(state.enemies[2].loadout.items[0].quantity, 3)
  assert.equal(state.enemies[2].loadout.items[0].snapshot.secret, undefined)
  assert.deepEqual(normalizeEnemyLoadout(undefined), {
    schema_version: 1, policy_id: ENEMY_LOADOUT_POLICY_ID, template_id: null, items: [], purse_cp: 0,
  })
})

// Инвентарь живого противника — закрытая информация: отряд узнаёт о кошельке
// бандита, когда обыщет тело, а не когда увидит его на карте.
test('инвентарь живого противника не виден игроку ни в состоянии, ни в канале событий', () => {
  const proposal = encounter({ theme: 'raiders', seed: 'projection-check' })
  const enemy = proposal.enemies.find((candidate) => candidate.loadout.items.length > 0)
  assert.ok(enemy)
  const state = {
    sessionCode: 'LOOT',
    partyMemberIds: ['hero-1'],
    players: [{ id: 'hero-1', character: 'Лира', inventory: [] }],
    scene: { title: 'Тракт', location: 'Тракт', cells: [] },
    enemies: proposal.enemies,
    mechanics: { encounter: { id: 'encounter-1', status: 'staged', enemies: proposal.enemies } },
  }

  const room = campaignStateForViewer(state, { role: 'player', heroIds: ['hero-1'] }, 'hero-1')
  const roomJson = JSON.stringify(room)
  assert.equal(roomJson.includes('item_instance_id'), false, 'экземпляры не уезжают игроку состоянием')
  assert.equal(roomJson.includes('purse_cp'), false)
  assert.equal(roomJson.includes('"loadout"'), false)

  const projected = publicEnemyFor(enemy, state, 'hero-1')
  assert.equal(projected.loadout, undefined)
  assert.equal(projected.purse_cp, undefined)
  assert.equal(JSON.stringify(projected).includes('item_instance_id'), false)

  const events = mechanicsForViewer(
    [{
      event_id: 'e1',
      event_type: 'EncounterCreated',
      visibility: 'party',
      payload: { encounter: { id: 'encounter-1', status: 'staged', difficulty: 'hard', theme: 'raiders', enemies: proposal.enemies } },
    }],
    { role: 'player', heroIds: ['hero-1'] },
    'hero-1',
    state,
  )
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('item_instance_id'), false, 'экземпляры предметов не уезжают игроку событием')
  assert.equal(serialized.includes('purse_cp'), false, 'карман противника не уезжает игроку событием')
  assert.equal(serialized.includes('"loadout"'), false)
  for (const projectedEnemy of events[0].payload.encounter.enemies) {
    assert.equal(projectedEnemy.loadout, undefined)
  }
})

// Главный инвариант шага, и до этой проверки он держался только на том, что
// никто не написал строку: каталог отдавал `enemy_loadout_eligible` всей
// категории `armor` целиком, поэтому кольчуга прошла бы в инвентарь молча.
test('доспеха нет ни в одном собранном инвентаре, и граница отклоняет его на входе', () => {
  const seen = new Set()
  for (const enemy of allEnemies()) {
    for (const item of enemy.loadout.items) {
      const entry = catalogItem(item.catalog_id)
      assert.ok(entry, item.catalog_id)
      assert.notEqual(entry.category, 'armor', `${enemy.stat_block_id}: ${item.catalog_id}`)
      assert.equal(item.snapshot.type === 'armor', false, `${enemy.stat_block_id}: ${item.catalog_id}`)
      seen.add(item.catalog_id)
    }
  }
  assert.ok(seen.size > 5, 'выборка обязана быть содержательной, иначе проверка ничего не значит')

  // Тот же прогон по шаблонам напрямую: сборка встречи выбирает не всех.
  for (const statBlockId of ENEMY_LOADOUT_TEMPLATE_IDS) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    for (let index = 0; index < 20; index += 1) {
      const loadout = enemyLoadoutFor({ statBlockId, block, ownerId: `${statBlockId}-${index}`, seed: 'armor-sweep' })
      for (const item of loadout.items) {
        assert.notEqual(catalogItem(item.catalog_id).category, 'armor', `${statBlockId}: ${item.catalog_id}`)
      }
    }
  }
})

const DUEL_SWORD = {
  id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
  combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 },
}

function duelState(enemy) {
  return normalizeCampaignState({
    sessionCode: 'LOOT-AC',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40,
      armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [DUEL_SWORD], x: 0, y: 0,
    }],
    enemies: [enemy],
    scene: { turn: 1, cells: cells(6, 2) },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: enemy.id, total: 5 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          [enemy.id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

// Вторая половина того же инварианта, и она про границу `enemy.loadout` против
// `actor.inventory`: инвентарь противника обязан оставаться невидимым для
// боевых формул. Проверка идёт настоящим ударом через Rules Engine, а не
// сравнением полей, — в событии лежит то самое КД, по которому считается
// попадание.
test('КД противника с полным инвентарём равно числу стат-блока', () => {
  let rollId = 0
  for (const statBlockId of ENEMY_LOADOUT_TEMPLATE_IDS) {
    const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
    const enemy = {
      id: 'foe', name: block.name, creature_type: block.creature_type,
      hp: block.hp, maxHp: block.hp, armor: block.armor, speed: block.speed,
      abilities: { ...block.abilities }, x: 1, y: 0, alive: true, stat_block_id: statBlockId,
      loadout: enemyLoadoutFor({ statBlockId, block, ownerId: 'foe', seed: 'armor-class-check' }),
    }
    assert.ok(enemy.loadout.items.length > 0, statBlockId)
    const state = duelState(enemy)
    const stored = state.enemies[0]
    // Инвентарь есть, но он лежит не в том поле, которое читают формулы.
    assert.ok(stored.loadout.items.length > 0, statBlockId)
    assert.equal(stored.inventory, undefined, statBlockId)
    assert.equal(derivedEquipmentArmorClass(stored), null, statBlockId)
    assert.equal(activeItemEffectTotals(stored).armor_class_bonus, 0, statBlockId)

    const result = resolveCommand(
      { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true },
      state,
      {
        diceService: new DiceService({
          rng: new SequenceDiceRng([10, 4]),
          idFactory: () => `armor-class-roll-${++rollId}`,
          now: () => '2026-08-13T12:00:00.000Z',
        }),
        context: { serverAuthoritativeCombat: true, isAdmin: true },
      },
    )
    const resolved = result.events.find((event) => event.event_type === 'AttackResolved')
    assert.ok(resolved, statBlockId)
    assert.equal(resolved.payload.armor_class, block.armor, `${statBlockId}: КД взято не из стат-блока`)
  }
})

// Снимок приезжает из сохранения и из payload события, то есть и из админского
// импорта состояния. Прежняя проверка ловила только выброс неизвестного ключа и
// создавала ложное чувство закрытой границы.
test('снимок экземпляра — недоверенные данные: числа, тип и картинка приводятся к границам', () => {
  const instance = normalizeItemInstance({
    schema_version: 1,
    item_instance_id: 'hostile-1',
    catalog_id: 'srd_5_2_1:dagger',
    quantity: 1,
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit' },
    lootable: true,
    snapshot: {
      name: 'Кинжал',
      type: 'armor-of-my-choosing',
      weight: -1e9,
      base_price_cp: 1e15,
      image: 'https://evil.example/steal.png',
      mechanics_status: 'totally-verified',
      rarity: 'божественный',
      catalog_schema_version: 999,
      combat: { kind: 'melee', armor: { base: 1e15 } },
      passive_effects: [
        { armor_class_bonus: 50 },
        { schema_version: 1, effect_id: 'forged', group: 'forged', armor_class_bonus: 5_000 },
      ],
      charges: { current: 1e9, max: 1e9 },
      recharge: { schema_version: 1, trigger: 'always', formula: '99d99' },
      secret: 'не должно проехать',
    },
  })
  const snapshot = instance.snapshot
  assert.equal(snapshot.secret, undefined)
  assert.equal(snapshot.type, 'other', 'тип сводится к известному множеству инвентаря')
  assert.equal(snapshot.weight, 0, 'отрицательный вес не уменьшает переносимый груз')
  assert.equal(snapshot.base_price_cp, MAX_ITEM_SNAPSHOT_NUMBER, 'цена ограничена — её заплатит торговец')
  assert.equal(snapshot.image, undefined, 'внешний адрес в разметку карточки не попадает')
  assert.equal(snapshot.mechanics_status, undefined)
  assert.equal(snapshot.rarity, 'обычный')
  assert.equal(snapshot.catalog_schema_version, '999')
  assert.equal(snapshot.recharge, undefined, 'выдуманный профиль перезарядки отбрасывается')
  assert.equal(snapshot.charges.max, MAX_ITEM_INSTANCE_CHARGES)
  assert.equal(snapshot.charges.current, MAX_ITEM_INSTANCE_CHARGES)
  // Числа ограничены на любой глубине, а не только в названных полях.
  assert.equal(snapshot.combat.armor.base, MAX_ITEM_SNAPSHOT_NUMBER)
  // Запись без effect_id и group эффектом не является; у оформленной надбавка
  // подрезана общим авторитетным контрактом пассивных эффектов.
  assert.equal(snapshot.passive_effects.length, 1)
  assert.equal(snapshot.passive_effects[0].armor_class_bonus, 100)

  // Картинка, которую сервер отдаёт сам, границу проходит.
  const local = normalizeItemInstance({
    item_instance_id: 'local-1',
    catalog_id: 'srd_5_2_1:dagger',
    owner: { kind: 'enemy', actor_id: 'enemy-1' },
    origin: { kind: 'enemy_loadout' },
    snapshot: { image: '/assets/items/item-srd-5-2-1-dagger.png' },
  })
  assert.equal(local.snapshot.image, '/assets/items/item-srd-5-2-1-dagger.png')
  for (const image of ['/assets/items/../../etc/passwd.png', '/generated/items/x.svg', 'javascript:alert(1)', '//evil.example/x.png']) {
    const rejected = normalizeItemInstance({
      item_instance_id: 'rejected-1',
      catalog_id: 'srd_5_2_1:dagger',
      owner: { kind: 'enemy', actor_id: 'enemy-1' },
      origin: { kind: 'enemy_loadout' },
      snapshot: { image },
    })
    assert.equal(rejected.snapshot.image, undefined, image)
  }
})

// Снимок в момент создания и снимок после чтения сохранения обязаны совпадать:
// иначе состояние после replay разошлось бы с состоянием в момент боя.
test('приведение экземпляра — неподвижная точка: replay не меняет ни одного поля', () => {
  for (const catalogId of ['srd_5_2_1:scimitar', 'srd_5_2_1:arrows-20', 'srd_5_2_1:healers-kit', 'srd_5_2_1:potion-of-healing', 'srd_5_2_1:ring-of-protection']) {
    const created = createItemInstance({
      catalogId,
      instanceId: `fixed-point-${catalogId}`,
      quantity: 2,
      owner: { kind: 'enemy', actor_id: 'enemy-1' },
      origin: { kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit', source_id: 'encounter-proposal-1' },
    })
    assert.deepEqual(normalizeItemInstance(created), created, catalogId)
    assert.deepEqual(normalizeItemInstance(normalizeItemInstance(created)), created, catalogId)
    assert.equal(created.snapshot.properties, undefined, 'дубль описания в снимке не хранится')
    assert.ok(created.snapshot.description, catalogId)
  }
})

// Инвентарь обязан лежать в состоянии ровно один раз. Вторая копия в
// `mechanics.encounter` не проходила нормализатор никогда: мусор из сохранения
// вычистился бы в одной копии и остался в другой.
test('замороженный состав встречи не хранит второй копии инвентарей', () => {
  const proposal = encounter({ theme: 'law', seed: 'single-copy' })
  assert.ok(proposal.enemies.some((enemy) => enemy.loadout.items.length > 0))

  const before = normalizeCampaignState({
    sessionCode: 'LOOT-COPY',
    partyMemberIds: ['hero-1'],
    players: [{ id: 'hero-1', character: 'Лира', inventory: [] }],
    scene: { title: 'Ворота', location: 'Ворота', cells: cells() },
    enemies: [],
  })
  const state = applyGameEvent(before, {
    event_id: 'e1',
    event_type: 'EncounterCreated',
    payload: { encounter: { ...proposal, id: 'encounter-1', encounter_id: 'encounter-1' } },
  })

  assert.ok(state.enemies.every((enemy) => enemy.loadout), 'боевая запись врага инвентарь несёт')
  assert.ok(state.enemies.some((enemy) => enemy.loadout.items.length > 0))
  for (const descriptor of state.mechanics.encounter.enemies) {
    assert.equal(descriptor.loadout, undefined, descriptor.id)
    // Состав встречи по-прежнему опознаётся: награду замораживают по этим полям.
    assert.ok(descriptor.id && descriptor.stat_block_id, descriptor.id)
  }
  assert.deepEqual(state.mechanics.encounter.enemy_ids, state.enemies.map((enemy) => enemy.id))
  assert.equal(JSON.stringify(state.mechanics.encounter).includes('item_instance_id'), false)

  // Старое сохранение со второй копией чистится тем же правилом при загрузке.
  const legacy = normalizeCampaignState({
    ...before,
    mechanics: { ...before.mechanics, encounter: { id: 'encounter-1', status: 'staged', enemies: proposal.enemies } },
  })
  for (const descriptor of legacy.mechanics.encounter.enemies) {
    assert.equal(descriptor.loadout, undefined, descriptor.id)
  }
})

// Необязательный расходник выбирает сервер сам, и его eligibility выводится из
// живого каталога. Перебалансировка не должна превращать сборку встречи,
// которую Директор дёргает через `/autonomy/advance`, в необработанную ошибку.
test('неисполнимый расходник пропускается, а гарантированное снаряжение падает громко', () => {
  assert.equal(catalogItem('srd_5_2_1:crowbar').mechanics_status, 'ruling-only')
  assert.equal(optionalEnemyLoadoutItem('srd_5_2_1:crowbar'), null)
  assert.equal(optionalEnemyLoadoutItem('srd_5_2_1:chain-mail'), null)
  assert.equal(optionalEnemyLoadoutItem('srd_5_2_1:scimitar'), null, 'оружие со статусом partial расходником не выдаётся')
  assert.equal(optionalEnemyLoadoutItem('srd_5_2_1:not-a-thing'), null)
  assert.equal(optionalEnemyLoadoutItem('srd_5_2_1:potion-of-healing').catalog_id, 'srd_5_2_1:potion-of-healing')

  // Гарантированное снаряжение так пропускать нельзя: отсутствие вещи означает
  // неверную сборку, и она обязана падать.
  assert.throws(
    () => assertEnemyLoadoutItem('srd_5_2_1:chain-mail'),
    (error) => error instanceof EnemyLoadoutError,
  )

  // И ни одна тема при этом не роняет сборку встречи целиком.
  for (const theme of ['goblinoids', 'raiders', 'warband', 'law', 'ambush', 'undead', 'beasts', 'vermin', 'crypt', 'cave', 'wilderness', 'generic']) {
    for (const difficulty of ['easy', 'medium', 'hard', 'deadly']) {
      assert.doesNotThrow(() => encounter({ theme, difficulty, level: 5, seed: `no-throw:${theme}:${difficulty}` }))
    }
  }
})
