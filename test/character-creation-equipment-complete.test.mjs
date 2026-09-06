import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultStarterEquipmentChoices,
  resolveStarterEquipmentChoices,
  starterEquipmentCatalogFor,
  completeBackgroundChoicesForHero,
  validateCompleteBackgroundChoices,
  withStarterKit,
} from '../server/starter-kit.mjs'

const RULESET_ID = 'dnd_5e_2014'

test('полный каталог 2014 содержит все 12 классов и 13 предысторий', () => {
  const legacy = starterEquipmentCatalogFor(RULESET_ID)
  const complete = starterEquipmentCatalogFor(RULESET_ID, { complete: true })
  assert.equal(legacy.classes.length, 12)
  assert.equal(complete.classes.length, 12)
  assert.equal(complete.backgrounds.length, 13)
  assert.equal(complete.complete_schema_version, 1)
  const classIds = new Set(complete.classes.map((entry) => entry.class_id))
  assert.equal(classIds.size, 12)
  assert.ok(complete.classes.find((entry) => entry.class_id === 'bard').choice_groups.find((group) => group.id === 'instrument').options.length >= 10)
  assert.ok(complete.classes.find((entry) => entry.class_id === 'barbarian').choice_groups.find((group) => group.id === 'primary-weapon').options.some((option) => option.items?.some((item) => item.catalog_id === 'srd_5_2_1:whip')))
  assert.ok(complete.classes.find((entry) => entry.class_id === 'fighter').choice_groups.find((group) => group.id === 'melee-loadout').options.length > 100)
  assert.ok(complete.classes.find((entry) => entry.class_id === 'ranger').choice_groups.find((group) => group.id === 'melee').options.length > 50)
})

test('старый каталог и policy v2 остаются совместимыми, а complete включается явно', () => {
  const legacy = starterEquipmentCatalogFor(RULESET_ID)
  const complete = starterEquipmentCatalogFor(RULESET_ID, { complete: true })
  const legacyBarbarian = legacy.classes.find((entry) => entry.class_id === 'barbarian')
  const completeBarbarian = complete.classes.find((entry) => entry.class_id === 'barbarian')
  assert.equal(legacyBarbarian.choice_groups.find((group) => group.id === 'primary-weapon').options.length, 2)
  assert.ok(completeBarbarian.choice_groups.find((group) => group.id === 'primary-weapon').options.length > 2)
  assert.deepEqual(defaultStarterEquipmentChoices('fighter', RULESET_ID), {
    armor: ['chain-mail'], 'melee-loadout': ['longsword-shield'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'],
  })
  assert.deepEqual(defaultStarterEquipmentChoices('fighter', RULESET_ID, { complete: true }), {
    armor: ['chain-mail'], 'melee-loadout': ['longsword-shield'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'],
  })
  assert.equal(resolveStarterEquipmentChoices('fighter', {
    armor: ['chain-mail'], 'melee-loadout': ['greatsword'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'],
  }, RULESET_ID, { complete: true }).ok, false)
})

test('полный режим принимает динамические варианты оружия и материализует даже сеть', () => {
  const catalog = starterEquipmentCatalogFor(RULESET_ID, { complete: true })
  const fighter = catalog.classes.find((entry) => entry.class_id === 'fighter')
  const melee = fighter.choice_groups.find((group) => group.id === 'melee-loadout')
  const netOption = melee.options.find((option) => option.id === 'martial-and-shield-net')
  assert.ok(netOption)
  assert.ok(netOption.narrative_items.some((item) => item.name === 'Сеть' && item.weight === 3 && item.type === 'weapon'))
  const resolved = resolveStarterEquipmentChoices('fighter', {
    armor: ['chain-mail'], 'melee-loadout': ['martial-and-shield-net'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'],
  }, RULESET_ID, { complete: true })
  assert.equal(resolved.ok, true)
  assert.ok(resolved.selected_options[1].narrative_items.some((item) => item.name === 'Сеть'))
  const hero = withStarterKit({
    id: 'net-fighter', characterClass: 'fighter', backgroundId: 'criminal', inventory: [], currency: {},
    starterEquipmentChoices: { armor: ['chain-mail'], 'melee-loadout': ['martial-and-shield-net'], secondary: ['light-crossbow'], pack: ['dungeoneers-pack'] },
    phbCreation: { schema_version: 1 },
  }, { rulesetId: RULESET_ID })
  const net = hero.inventory.find((item) => item.name === 'Сеть')
  assert.equal(net.type, 'weapon')
  assert.equal(net.quantity, 1)
  assert.equal(net.weight, 3)
  assert.equal(net.equipped, true)
})

test('полный режим материализует каждый PHB класс с физическими весами и количество запасов', () => {
  const classes = starterEquipmentCatalogFor(RULESET_ID, { complete: true }).classes
  for (const entry of classes) {
    const hero = withStarterKit({
      id: `complete-${entry.class_id}`, characterClass: entry.class_id, backgroundId: 'acolyte', inventory: [], currency: {},
      phbCreation: { schema_version: 1 },
    }, { rulesetId: RULESET_ID })
    assert.ok(hero.inventory.length > 0, entry.class_id)
    for (const item of hero.inventory) {
      assert.ok(Number.isFinite(item.weight), `${entry.class_id}: ${item.name} weight`)
      assert.ok(Number.isInteger(item.quantity) && item.quantity >= 1, `${entry.class_id}: ${item.name} quantity`)
    }
  }
  const explorer = withStarterKit({
    id: 'pack-wizard', characterClass: 'wizard', backgroundId: 'sage', inventory: [], currency: {}, phbCreation: { schema_version: 1 },
    starterEquipmentChoices: { weapon: ['quarterstaff'], focus: ['component-pouch'], pack: ['explorers-pack'] },
  }, { rulesetId: RULESET_ID })
  const pack = explorer.inventory.find((item) => item.catalog_id === 'srd_5_2_1:explorers-pack')
  assert.ok(pack?.contents.some((item) => item.name === 'Сухой паёк, 1 день' && item.quantity === 10 && item.weight === 20))
})

test('полный каталог содержит физический набор каждого PHB 2014 фона и явные варианты выбора', () => {
  const backgrounds = starterEquipmentCatalogFor(RULESET_ID, { complete: true }).backgrounds
  for (const background of backgrounds) {
    assert.ok(Array.isArray(background.fixed_items) || Array.isArray(background.fixed_narrative_items), background.background_id)
    const entries = [
      ...(background.fixed_items ?? []),
      ...(background.fixed_narrative_items ?? []),
      ...(background.choice_groups ?? []).flatMap((group) => group.options.flatMap((option) => [...(option.items ?? []), ...(option.narrative_items ?? [])])),
    ]
    assert.ok(entries.length > 0, background.background_id)
    for (const item of entries) {
      if (item.catalog_id) continue
      assert.ok(Number.isFinite(item.weight), `${background.background_id}: ${item.name} weight`)
      assert.ok(Number.isInteger(item.quantity) && item.quantity >= 1, `${background.background_id}: ${item.name} quantity`)
    }
  }
  const guild = backgrounds.find((entry) => entry.background_id === 'guild-artisan')
  assert.equal(guild.choice_groups[0].options.length, 18)
  assert.equal(guild.choice_groups[0].options.find((option) => option.id === 'guild-merchant-mule-cart').owned_assets.length, 2)
  const entertainer = backgrounds.find((entry) => entry.background_id === 'entertainer')
  assert.equal(entertainer.choice_groups[0].options.length, 12)
  assert.ok(entertainer.choice_groups[0].options.some((option) => option.id === 'gladiator-net'))
  const soldier = backgrounds.find((entry) => entry.background_id === 'soldier')
  assert.equal(soldier.choice_groups.find((group) => group.id === 'gaming-set').options.length, 4)
})

test('complete background choices are normalized and validated before materialization', () => {
  const hero = { backgroundId: 'guild-artisan', phbCreation: { schema_version: 1, backgroundEquipmentChoices: { 'artisan-tool': ['smiths_tools'] } } }
  const selected = completeBackgroundChoicesForHero(hero)
  assert.deepEqual(selected['artisan-tool'], ['smiths_tools'])
  assert.equal(validateCompleteBackgroundChoices('guild-artisan', selected).ok, true)
  assert.equal(validateCompleteBackgroundChoices('guild-artisan', { 'artisan-tool': ['not-a-tool'] }).ok, false)
})
