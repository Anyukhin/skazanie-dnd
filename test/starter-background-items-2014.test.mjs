import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundCatalogFor, defaultBackgroundChoices } from '../server/backgrounds.mjs'
import { starterEquipmentCatalogFor, withStarterKit } from '../server/starter-kit.mjs'

const rulesetId = 'dnd_5e_2014'
for (const background of backgroundCatalogFor(rulesetId).options) {
  for (const profile of starterEquipmentCatalogFor(rulesetId).classes) {
    test(profile.class_id + ' / ' + background.id + ': стартовый набор сохраняет предметы предыстории', () => {
      const hero = withStarterKit({
        id: 'hero-regression', characterClass: profile.class_id,
        backgroundId: background.id,
        backgroundChoices: defaultBackgroundChoices(background.id, rulesetId),
      }, { rulesetId })
      const items = hero.inventory.filter((item) => /^hero-regression-starter-background-\d+$/.test(item.id))
      assert.deepEqual(items.map((item) => ({ catalogId: item.catalog_id, quantity: item.quantity })),
        (background.equipment?.catalogItems ?? []).map((item) => ({ catalogId: item.catalogId, quantity: item.quantity ?? 1 })))
      assert.equal(new Set(hero.inventory.map((item) => item.id)).size, hero.inventory.length)
    })
  }
}
