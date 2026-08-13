import assert from 'node:assert/strict'
import test from 'node:test'

import { ENCOUNTER_THEMES, assembleEncounter, SRD_5_2_1_MONSTER_ALLOWLIST } from '../server/encounter-assembler.mjs'
import {
  ENEMY_LOADOUT_POLICY_ID,
  ENEMY_LOADOUT_SCHEMA_VERSION,
  ENEMY_LOADOUT_TEMPLATE_IDS,
  EnemyLoadoutError,
  assertEnemyLoadoutItem,
  enemyLoadoutFor,
  normalizeEnemyLoadout,
} from '../server/enemy-loadouts.mjs'
import {
  ITEM_CATALOG,
  ITEM_CORPSE_LOOT_CATALOG_IDS,
  ITEM_ENCOUNTER_THEMES,
  ITEM_ENEMY_LOADOUT_CATALOG_IDS,
  catalogItem,
  itemLootMetadata,
  materializeCatalogItem,
} from '../server/item-catalog.mjs'
import {
  ITEM_INSTANCE_SCHEMA_VERSION,
  ItemInstanceError,
  createItemInstance,
  normalizeItemInstance,
} from '../server/item-instances.mjs'
import { LOOT_BY_THEME } from '../server/loot-tables.mjs'
import { campaignStateForViewer, mechanicsForViewer, publicEnemyFor } from '../server/viewer-projection.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

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

test('каталог честно объявляет три метаданных добычи, и ruling-only не проходит ни в один канал', () => {
  for (const entry of Object.values(ITEM_CATALOG)) {
    assert.equal(typeof entry.enemy_loadout_eligible, 'boolean', entry.catalog_id)
    assert.equal(typeof entry.corpse_loot_eligible, 'boolean', entry.catalog_id)
    assert.ok(Array.isArray(entry.themes), entry.catalog_id)
    for (const theme of entry.themes) assert.ok(ITEM_ENCOUNTER_THEMES.includes(theme), `${entry.catalog_id}: ${theme}`)
    if (entry.mechanics_status === 'ruling-only') {
      assert.equal(entry.enemy_loadout_eligible, false, entry.catalog_id)
      assert.equal(entry.corpse_loot_eligible, false, entry.catalog_id)
    }
    // Инвентарь противника — узкий канал: магия в него не входит и остаётся за
    // отдельной политикой редкости `magic_loot`. Снять её с тела можно.
    if (entry.magic_item) assert.equal(entry.enemy_loadout_eligible, false, entry.catalog_id)
  }
  assert.ok(ITEM_ENEMY_LOADOUT_CATALOG_IDS.length > 0)
  assert.ok(ITEM_CORPSE_LOOT_CATALOG_IDS.length > ITEM_ENEMY_LOADOUT_CATALOG_IDS.length)
  for (const catalogId of ITEM_ENEMY_LOADOUT_CATALOG_IDS) {
    assert.ok(ITEM_CORPSE_LOOT_CATALOG_IDS.includes(catalogId), catalogId)
  }
  assert.deepEqual(itemLootMetadata('srd_5_2_1:carpenters-tools'), {
    enemy_loadout_eligible: false, corpse_loot_eligible: false, themes: [],
  })
  assert.equal(itemLootMetadata('srd_5_2_1:not-a-thing'), null)
})

// Классификация вещи живёт в каталоге, очерёдность выдачи — в таблицах наград.
// Сторож держит их вместе: предмет, который таблица выдаёт за тему, обязан эту
// тему нести. Обратное не требуется — в каталоге список шире.
test('таблицы наград не расходятся с тематической классификацией каталога', () => {
  // Темы каталога — те же, что у сборщика встреч. Утверждение в комментарии
  // модуля стоит ровно столько, сколько эта строка.
  assert.deepEqual([...ITEM_ENCOUNTER_THEMES].sort(), [...ENCOUNTER_THEMES].sort())
  for (const [theme, catalogIds] of Object.entries(LOOT_BY_THEME)) {
    assert.ok(ITEM_ENCOUNTER_THEMES.includes(theme), theme)
    for (const catalogId of catalogIds) {
      const entry = catalogItem(catalogId)
      assert.ok(entry, catalogId)
      assert.ok(entry.themes.includes(theme), `${catalogId} не объявляет тему ${theme}`)
    }
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
