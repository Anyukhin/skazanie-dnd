import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveCharacterSheet } from '../server/character-lifecycle.mjs'
import { catalogItem } from '../server/item-catalog.mjs'
import { STARTER_KIT_2024_POLICY, withStarterKit } from '../server/starter-kit.mjs'

// Боевой плейтест 2026-10-03: в кампании 2024 жрец выходил с кинжалом и КД 14,
// воин — с длинным мечом и КД 15. Теперь новый герой 2024 получает вариант A
// своего класса из SRD 5.2.1; герой из прежнего события — прежний набор.

const kit = (characterClass, abilities) => withStarterKit(
  { id: 'hero', characterClass, level: 1, inventory: [], currency: {}, ...(abilities ? { abilities } : {}) },
  { rulesetId: 'srd_5_2_1', starterPolicyId: STARTER_KIT_2024_POLICY.policy_id },
)
const ids = (hero) => hero.inventory.map((item) => item.catalog_id).filter(Boolean)
const armorClass = (hero) => deriveCharacterSheet(hero, { rulesetId: 'srd_5_2_1' }).armor_class.value

test('жрец, воин и паладин выходят в доспехах и с оружием своего класса', () => {
  const cleric = kit('cleric')
  assert.deepEqual(ids(cleric).slice(0, 3), ['srd_5_2_1:chain-shirt', 'srd_5_2_1:shield', 'srd_5_2_1:mace'])
  assert.equal(armorClass(cleric), 15)
  const fighter = kit('fighter')
  assert.ok(ids(fighter).includes('srd_5_2_1:greatsword'))
  assert.equal(fighter.inventory.find((item) => item.catalog_id === 'srd_5_2_1:javelin').quantity, 8)
  assert.equal(armorClass(fighter), 16)
  assert.equal(armorClass(kit('paladin')), 18)
})

test('ловкий воин получает вариант B — без кольчуги, с луком и стрелами', () => {
  const archer = kit('fighter', { str: 10, dex: 16, con: 14, int: 10, wis: 12, cha: 8 })
  assert.ok(ids(archer).includes('srd_5_2_1:studded-leather-armor'))
  assert.ok(ids(archer).includes('srd_5_2_1:longbow'))
  assert.ok(ids(archer).includes('srd_5_2_1:arrows-20'))
  assert.ok(!ids(archer).includes('srd_5_2_1:chain-mail'))
})

test('у каждого заклинателя фокусировка своего класса', () => {
  for (const characterClass of ['bard', 'cleric', 'druid', 'paladin', 'sorcerer', 'warlock', 'wizard']) {
    const hero = kit(characterClass)
    const focus = hero.inventory.find((item) => catalogItem(item.catalog_id)?.spellcasting_focus?.includes(characterClass))
    assert.ok(focus, `${characterClass}: нет фокусировки`)
  }
  // Следопыту 2024 служит друидическая фокусировка; каталог пока помечает её
  // только друидской, поэтому проверяем сам предмет.
  assert.ok(ids(kit('ranger')).includes('srd_5_2_1:druidic-focus-mistletoe'))
})

test('у каждого класса есть надетое оружие, а у стрелка — снаряды', () => {
  for (const characterClass of ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard']) {
    const hero = kit(characterClass)
    const weapons = hero.inventory.filter((item) => item.type === 'weapon')
    assert.ok(weapons.length, `${characterClass}: без оружия`)
    if (characterClass === 'druid') continue // фокусировка-посох в руке, серп в сумке — по варианту A
    assert.ok(weapons.some((item) => item.equipped), `${characterClass}: оружие не в руках`)
  }
  assert.ok(ids(kit('ranger')).includes('srd_5_2_1:arrows-20'))
  assert.ok(ids(kit('rogue')).includes('srd_5_2_1:arrows-20'))
})

test('герой из прежнего события получает прежний набор: replay его не меняет', () => {
  const legacy = withStarterKit({ id: 'hero', characterClass: 'cleric', level: 1, inventory: [], currency: {} }, { rulesetId: 'srd_5_2_1' })
  assert.deepEqual(ids(legacy), ['srd_5_2_1:dagger', 'srd_5_2_1:leather-armor', 'srd_5_2_1:shield'])
  const classic = withStarterKit({ id: 'hero', characterClass: 'cleric', level: 1, inventory: [], currency: {} }, { rulesetId: 'dnd_5e_2014', starterPolicyId: STARTER_KIT_2024_POLICY.policy_id })
  assert.equal(classic.starterEquipmentPolicyId, 'skazanie.starter-equipment.dnd-5e-2014', 'в 2014 действует свой набор PHB, метка 2024 его не трогает')
})
