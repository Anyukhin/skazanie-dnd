import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ITEM_CATALOG,
  ITEM_SHOP_CATALOG_IDS,
  catalogItem,
  materializeCatalogItem,
} from '../server/item-catalog.mjs'
import { normalizeInventoryItem } from '../server/merchant-economy.mjs'
import { createItemInstance, normalizeItemInstance } from '../server/item-instances.mjs'
import { itemProfileFor } from '../server/item-lifecycle.mjs'
import { resolveStartingPurchases, startingPurchaseCatalog } from '../server/character-creation-wealth.mjs'
import { starterEquipmentCatalogFor, withStarterKit } from '../server/starter-kit.mjs'

const RULESET_ID = 'dnd_5e_2014'
const COMPONENT_IDS = Object.freeze([
  'srd_5_2_1:component-pouch',
  'srd_5_2_1:arcane-focus-crystal',
  'srd_5_2_1:arcane-focus-orb',
  'srd_5_2_1:arcane-focus-rod',
  'srd_5_2_1:arcane-focus-staff',
  'srd_5_2_1:arcane-focus-wand',
  'srd_5_2_1:druidic-focus-mistletoe',
  'srd_5_2_1:druidic-focus-totem',
  'srd_5_2_1:druidic-focus-wooden-staff',
  'srd_5_2_1:druidic-focus-yew-wand',
  'srd_5_2_1:holy-symbol-amulet',
  'srd_5_2_1:holy-symbol-emblem',
  'srd_5_2_1:holy-symbol-reliquary',
  'srd_5_2_1:diamond-50gp',
])
const BARD_INSTRUMENTS = Object.freeze([
  ['bagpipes', 'srd_5_2_1:bagpipes', 3_000, 6],
  ['drum', 'srd_5_2_1:drum', 600, 3],
  ['dulcimer', 'srd_5_2_1:dulcimer', 2_500, 10],
  ['flute', 'srd_5_2_1:flute', 200, 1],
  ['lute', 'srd_5_2_1:lute', 3_500, 2],
  ['lyre', 'srd_5_2_1:lyre', 3_000, 2],
  ['horn', 'srd_5_2_1:horn', 300, 2],
  ['pan_flute', 'srd_5_2_1:pan-flute', 1_200, 2],
  ['shawm', 'srd_5_2_1:shawm', 200, 1],
  ['viol', 'srd_5_2_1:viol', 3_000, 1],
])
const MATERIAL_IDS = Object.freeze([
  'srd_5_2_1:material-summon-beast-200gp',
  'srd_5_2_1:material-summon-undead-300gp',
  'srd_5_2_1:material-summon-shadowspawn-300gp',
  'srd_5_2_1:material-summon-fey-300gp',
  'srd_5_2_1:material-shadow-of-moil-150gp',
  'srd_5_2_1:material-summon-aberration-400gp',
  'srd_5_2_1:material-summon-construct-400gp',
  'srd_5_2_1:material-summon-elemental-400gp',
  'srd_5_2_1:material-summon-draconic-spirit-500gp',
  'srd_5_2_1:material-summon-celestial-500gp',
  'srd_5_2_1:material-dawn-100gp',
  'srd_5_2_1:material-circle-of-death-500gp',
  'srd_5_2_1:material-summon-fiend-600gp',
  'srd_5_2_1:material-diamond-dust-100gp',
])
const MATERIAL_BY_SPELL = Object.freeze({
  'summon-beast': 'srd_5_2_1:material-summon-beast-200gp',
  'summon-undead': 'srd_5_2_1:material-summon-undead-300gp',
  'summon-shadowspawn': 'srd_5_2_1:material-summon-shadowspawn-300gp',
  'summon-fey': 'srd_5_2_1:material-summon-fey-300gp',
  'shadow-of-moil': 'srd_5_2_1:material-shadow-of-moil-150gp',
  'summon-aberration': 'srd_5_2_1:material-summon-aberration-400gp',
  'summon-construct': 'srd_5_2_1:material-summon-construct-400gp',
  'summon-elemental': 'srd_5_2_1:material-summon-elemental-400gp',
  'summon-draconic-spirit': 'srd_5_2_1:material-summon-draconic-spirit-500gp',
  'summon-celestial': 'srd_5_2_1:material-summon-celestial-500gp',
  dawn: 'srd_5_2_1:material-dawn-100gp',
  'circle-of-death': 'srd_5_2_1:material-circle-of-death-500gp',
  'summon-fiend': 'srd_5_2_1:material-summon-fiend-600gp',
  'greater-restoration': 'srd_5_2_1:material-diamond-dust-100gp',
  stoneskin: 'srd_5_2_1:material-diamond-dust-100gp',
})

test('каталог содержит компонентную сумку, фокусы и настоящий алмаз с серверными метаданными', () => {
  for (const id of COMPONENT_IDS) {
    const entry = catalogItem(id)
    assert.ok(entry, id)
    assert.equal(ITEM_CATALOG[id], entry)
    assert.equal(entry.availability.shop, true, id)
    assert.equal(entry.availability.loot, false, id)
    assert.equal(entry.availability.magic_loot, false, id)
    assert.equal(entry.availability.crafting, false, id)
  }
  assert.equal(catalogItem('srd_5_2_1:component-pouch').component_pouch, true)
  assert.deepEqual(catalogItem('srd_5_2_1:arcane-focus-crystal').spellcasting_focus, ['sorcerer', 'warlock', 'wizard'])
  assert.deepEqual(catalogItem('srd_5_2_1:druidic-focus-totem').spellcasting_focus, ['druid'])
  assert.deepEqual(catalogItem('srd_5_2_1:holy-symbol-amulet').spellcasting_focus, ['cleric', 'paladin'])
  assert.deepEqual(catalogItem('srd_5_2_1:diamond-50gp').material_component, { kind: 'diamond', value_cp: 5_000 })
  assert.ok(COMPONENT_IDS.every((id) => ITEM_SHOP_CATALOG_IDS.includes(id)))
})

test('дорогие материалы имеют spell_ids, точную цену и торговую доступность', () => {
  assert.ok(MATERIAL_IDS.every((id) => ITEM_SHOP_CATALOG_IDS.includes(id)))
  for (const id of MATERIAL_IDS) {
    const entry = catalogItem(id)
    assert.equal(entry.lifecycle.equippable, false, id)
    assert.equal(entry.equip, null, id)
    assert.equal(entry.material_component.spell_ids.length > 0, true, id)
    assert.equal(entry.material_component.value_cp, entry.price_cp, id)
    assert.match(entry.provenance.source_url, /www\.dnd\.su\/spells/u, id)
  }
  assert.deepEqual(catalogItem('srd_5_2_1:material-summon-fiend-600gp').material_component, {
    kind: 'summon-fiend-600gp', value_cp: 60_000, spell_ids: ['summon-fiend'],
  })
  assert.deepEqual(catalogItem('srd_5_2_1:material-diamond-dust-100gp').material_component, {
    kind: 'diamond-dust', value_cp: 10_000, spell_ids: ['greater-restoration', 'stoneskin'],
  })
  assert.equal(itemProfileFor(materializeCatalogItem('srd_5_2_1:material-summon-beast-200gp')).stackable, false)
  assert.equal(itemProfileFor(materializeCatalogItem('srd_5_2_1:material-diamond-dust-100gp')).stackable, true)
})

test('описания, цены и URL материалов совпадают с локальными source rows dnd.su', () => {
  const source = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
  const rows = new Map(source.spells.map((spell) => [spell.id, spell]))
  const expandedDescriptions = new Map([
    ['summon-undead', 'Позолоченный череп стоимостью не менее 300 зм — материальный компонент заклинания «Призыв духа нежити».'],
    ['summon-fey', 'Позолоченный цветок стоимостью не менее 300 зм — материальный компонент заклинания «Призыв духа феи».'],
    ['summon-celestial', 'Золотой реликварий стоимостью не менее 500 зм — материальный компонент заклинания «Призыв небожителя».'],
    ['dawn', 'Кулон солнечных лучей стоимостью не менее 100 зм — материальный компонент заклинания «Рассвет».'],
  ])
  for (const [spellId, catalogId] of Object.entries(MATERIAL_BY_SPELL)) {
    const row = rows.get(spellId)
    const entry = catalogItem(catalogId)
    assert.equal(entry.description, expandedDescriptions.get(spellId) ?? row.components.material.description, spellId)
    if (expandedDescriptions.has(spellId)) {
      const normalize = (value) => value.toLocaleLowerCase('ru').replaceAll(',', '')
      assert.ok(normalize(entry.description).startsWith(normalize(row.components.material.description)), spellId)
    }
    assert.equal(entry.material_component.value_cp, row.components.material.costGp * 100, spellId)
    assert.ok(entry.provenance.source_urls.includes(row.sourceUrl), spellId)
  }
})

test('десять инструментов барда — реальные held-фокусы в стартовом наборе и покупке за богатство', () => {
  for (const [toolId, catalogId, price, weight] of BARD_INSTRUMENTS) {
    const entry = catalogItem(catalogId)
    assert.ok(entry, toolId)
    assert.equal(entry.price_cp, price, toolId)
    assert.equal(entry.weight, weight, toolId)
    assert.equal(entry.type, 'tool', toolId)
    assert.deepEqual(entry.spellcasting_focus, ['bard'], toolId)
    assert.equal(entry.lifecycle.equip_slot, 'main_hand', toolId)
    assert.equal(entry.focus_mode, 'held', toolId)
    assert.equal(entry.equip.focus_mode, 'held', toolId)
    assert.equal(entry.availability.shop, true, toolId)
  }

  const purchaseCatalog = startingPurchaseCatalog()
  for (const [toolId, catalogId, price, weight] of BARD_INSTRUMENTS) {
    const purchase = purchaseCatalog.find((entry) => entry.catalog_id === catalogId)
    assert.equal(purchase?.price_cp, price, toolId)
    assert.equal(purchase?.weight, weight, toolId)
  }
  const wealth = resolveStartingPurchases('bard', { id: 'bard-instruments', class_id: 'bard', total_gp: 200 },
    BARD_INSTRUMENTS.map(([id]) => ({ id, quantity: 1 })))
  assert.equal(wealth.ok, true)
  assert.deepEqual(wealth.inventory.map((item) => item.catalog_id), BARD_INSTRUMENTS.map(([, catalogId]) => catalogId))
  assert.ok(wealth.inventory.every((item) => item.spellcasting_focus?.includes('bard') && item.focus_mode === 'held'))

  const catalog = starterEquipmentCatalogFor(RULESET_ID, { complete: true })
  const options = catalog.classes.find((entry) => entry.class_id === 'bard').choice_groups.find((group) => group.id === 'instrument').options
  assert.deepEqual(options.map((option) => option.id).sort(), BARD_INSTRUMENTS.map(([id]) => id).sort())
  for (const [toolId, catalogId] of BARD_INSTRUMENTS) {
    assert.deepEqual(options.find((option) => option.id === toolId).items, [{ catalog_id: catalogId, quantity: 1, name: catalogItem(catalogId).name }])
  }

  const bard = withStarterKit({
    id: 'component-bard', characterClass: 'bard', inventory: [], currency: {}, phbCreation: { schema_version: 1 },
    starterEquipmentChoices: { weapon: ['rapier'], pack: ['entertainers-pack'], instrument: ['lute'] },
  }, { rulesetId: RULESET_ID })
  const lute = bard.inventory.find((item) => item.catalog_id === 'srd_5_2_1:lute')
  assert.deepEqual(lute?.spellcasting_focus, ['bard'])
  assert.equal(lute?.focus_mode, 'held')
  assert.equal(lute?.image, '/assets/ui/action-icons/bardic-inspiration.png')
})

test('материализация и нормализация берут компонентные свойства из catalog_id, а не из имени или payload', () => {
  const diamond = materializeCatalogItem('srd_5_2_1:diamond-50gp', {
    id: 'diamond-instance',
    name: 'Монеты на 50 зм',
    component_pouch: true,
    material_component: { kind: 'diamond', value_cp: 1 },
  })
  assert.equal(diamond.name, 'Монеты на 50 зм', 'имя экземпляра остаётся презентационным')
  assert.equal(diamond.component_pouch, undefined)
  assert.deepEqual(diamond.material_component, { kind: 'diamond', value_cp: 5_000 })

  const normalizedFocus = normalizeInventoryItem({
    ...materializeCatalogItem('srd_5_2_1:arcane-focus-wand', { id: 'focus-instance' }),
    spellcasting_focus: ['cleric'],
    material_component: { kind: 'diamond', value_cp: 99 },
  }, { preserveUnknown: true })
  assert.deepEqual(normalizedFocus.spellcasting_focus, ['sorcerer', 'warlock', 'wizard'])
  assert.equal(normalizedFocus.material_component, undefined)

  const forgedMetadata = normalizeInventoryItem({
    id: 'forged',
    catalog_id: 'srd_5_2_1:longsword',
    component_pouch: true,
    material_component: { kind: 'diamond', value_cp: 50_000 },
  }, { preserveUnknown: true })
  assert.equal(forgedMetadata.component_pouch, undefined)
  assert.equal(forgedMetadata.material_component, undefined)
})

test('снимок экземпляра переносит компонентные метаданные через replay-форму', () => {
  const instance = createItemInstance({
    catalogId: 'srd_5_2_1:diamond-50gp',
    instanceId: 'diamond-instance',
    owner: { kind: 'enemy', actor_id: 'mage' },
    origin: { kind: 'enemy_loadout', template_id: 'mage', source_id: 'test' },
  })
  assert.deepEqual(instance.snapshot.material_component, { kind: 'diamond', value_cp: 5_000 })
  const restored = normalizeItemInstance(instance)
  assert.deepEqual(restored.snapshot.material_component, { kind: 'diamond', value_cp: 5_000 })
})

test('снимок алмазной пыли сохраняет связь с обоими расходующими заклинаниями', () => {
  const instance = createItemInstance({
    catalogId: 'srd_5_2_1:material-diamond-dust-100gp',
    instanceId: 'diamond-dust-portion',
    quantity: 2,
    owner: { kind: 'container', actor_id: 'vault' },
    origin: { kind: 'found', template_id: 'vault', source_id: 'test' },
  })
  assert.deepEqual(instance.snapshot.material_component, {
    kind: 'diamond-dust', value_cp: 10_000, spell_ids: ['greater-restoration', 'stoneskin'],
  })
  assert.equal(instance.quantity, 2)
  assert.deepEqual(normalizeItemInstance(instance).snapshot.material_component, instance.snapshot.material_component)
})

test('торговля и создание героя создают реальные component instances без выдачи старым героям', () => {
  const purchaseCatalog = startingPurchaseCatalog()
  assert.ok([...COMPONENT_IDS, ...MATERIAL_IDS].every((id) => purchaseCatalog.some((entry) => entry.catalog_id === id)))
  assert.equal(purchaseCatalog.some((entry) => entry.catalog_id === 'phb_2014:equipment:component-pouch'), false)

  const wealth = resolveStartingPurchases('wizard', { id: 'component-roll', class_id: 'wizard', total_gp: 100 }, [
    { id: 'component-pouch', quantity: 1 },
    { id: 'diamond', quantity: 1 },
  ])
  assert.equal(wealth.ok, true)
  assert.deepEqual(wealth.inventory.map((item) => item.catalog_id), [
    'srd_5_2_1:component-pouch',
    'srd_5_2_1:diamond-50gp',
  ])
  assert.equal(wealth.inventory[0].component_pouch, true)
  assert.deepEqual(wealth.inventory[1].material_component, { kind: 'diamond', value_cp: 5_000 })

  const materialPurchase = resolveStartingPurchases('wizard', { id: 'material-roll', class_id: 'wizard', total_gp: 1000 }, [
    { id: 'srd_5_2_1:material-diamond-dust-100gp', quantity: 2 },
  ])
  assert.equal(materialPurchase.ok, true)
  assert.equal(materialPurchase.inventory[0].quantity, 2)
  assert.deepEqual(materialPurchase.inventory[0].material_component, {
    kind: 'diamond-dust', value_cp: 10_000, spell_ids: ['greater-restoration', 'stoneskin'],
  })

  const catalog = starterEquipmentCatalogFor(RULESET_ID, { complete: true })
  const wizardFocus = catalog.classes.find((entry) => entry.class_id === 'wizard').choice_groups.find((group) => group.id === 'focus')
  assert.deepEqual(wizardFocus.options.find((option) => option.id === 'component-pouch').items.map(({ catalog_id, quantity }) => ({ catalog_id, quantity })), [{ catalog_id: 'srd_5_2_1:component-pouch', quantity: 1 }])
  assert.deepEqual(wizardFocus.options.find((option) => option.id === 'arcane-focus').items.map(({ catalog_id, quantity }) => ({ catalog_id, quantity })), [{ catalog_id: 'srd_5_2_1:arcane-focus-crystal', quantity: 1 }])

  const wizard = withStarterKit({
    id: 'component-wizard',
    characterClass: 'wizard',
    inventory: [],
    currency: {},
    phbCreation: { schema_version: 1 },
    starterEquipmentChoices: { weapon: ['quarterstaff'], focus: ['component-pouch'], pack: ['explorers-pack'] },
  }, { rulesetId: RULESET_ID })
  assert.equal(wizard.inventory.find((item) => item.catalog_id === 'srd_5_2_1:component-pouch')?.component_pouch, true)

  const druid = withStarterKit({ id: 'component-druid', characterClass: 'druid', inventory: [], currency: {}, phbCreation: { schema_version: 1 } }, { rulesetId: RULESET_ID })
  assert.equal(druid.inventory.find((item) => item.catalog_id === 'srd_5_2_1:druidic-focus-mistletoe')?.spellcasting_focus?.includes('druid'), true)
  const cleric = withStarterKit({ id: 'component-cleric', characterClass: 'cleric', inventory: [], currency: {}, phbCreation: { schema_version: 1 } }, { rulesetId: RULESET_ID })
  const holySymbol = cleric.inventory.find((item) => item.catalog_id === 'srd_5_2_1:holy-symbol-amulet')
  assert.equal(holySymbol?.spellcasting_focus?.includes('cleric'), true)
  assert.equal(holySymbol?.equipped, true)
  assert.equal(holySymbol?.focus_mode, 'worn')
})
