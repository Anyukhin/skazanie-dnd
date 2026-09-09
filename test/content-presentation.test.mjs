import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { auditContentPresentation, isReadableDescription } from '../tools/audit-content-presentation.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { ITEM_CATALOG, itemViewerCapabilities } from '../server/item-catalog.mjs'

test('все существующие игровые карточки имеют русские описания и локальные изображения', async () => {
  const audit = await auditContentPresentation()
  assert.deepEqual(audit.problems, [])
  assert.equal(audit.ok, true)
  assert.equal(audit.spells.descriptions, audit.spells.entries)
  assert.equal(audit.runtime_items.descriptions, audit.runtime_items.entries)
  assert.equal(audit.starter_items.images, audit.starter_items.entries)
  assert.equal(audit.reference_2014_monsters.images, audit.reference_2014_monsters.entries)
  assert.equal(isReadableDescription('особый или внебоевой эффект'), false)
  assert.equal(isReadableDescription('область cube 30 фт. · 8d6 acid · спасбросок dex'), false)
})

test('поправки механики не затирают справочное описание заклинания', () => {
  const payload = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
  for (const spell of payload.spells) assert.equal(canonicalCombatSpellFor(spell.id).description, spell.description, spell.id)
  assert.match(canonicalCombatSpellFor('resistance').supportNote, /2014.*2024/u)
})

test('свежее описание каталога не меняет авторский текст сохранённого предмета', () => {
  const item = { catalog_id: 'srd_5_2_1:dagger', name: 'Память о доме', description: 'На рукояти инициалы отца.' }
  const before = structuredClone(item)
  const capabilities = itemViewerCapabilities(item)
  assert.equal(capabilities.catalog_description, ITEM_CATALOG[item.catalog_id].description)
  assert.deepEqual(item, before)
  assert.equal(itemViewerCapabilities({ description: 'Самодельный амулет' }), null)
})
