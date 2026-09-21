import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))

test('все 439 ID имеют версионированную строку компонентов без потери специальных требований', () => {
  assert.equal(catalog.componentsSchemaVersion, 1)
  assert.equal(catalog.spells.length, 439)
  assert.equal(new Set(catalog.spells.map(spell => spell.id)).size, 439)
  for (const spell of catalog.spells) {
    assert.equal(typeof spell.components?.verbal, 'boolean', `${spell.id}: V`)
    assert.equal(typeof spell.components?.somatic, 'boolean', `${spell.id}: S`)
    const material = spell.components.material
    if (material) {
      assert.ok(material.description.trim(), `${spell.id}: M`)
      assert.ok(material.costGp === null || Number.isFinite(material.costGp) && material.costGp >= 0, `${spell.id}: цена`)
      assert.equal(typeof material.consumed, 'boolean', `${spell.id}: расход`)
      if (material.costGp !== null || material.consumed || material.unresolved) assert.equal(material.focusSubstitutable, false, spell.id)
    } else assert.equal(material, null, spell.id)
    assert.deepEqual(canonicalCombatSpellFor(spell.id, { rulesetId: 'dnd_5e_2014' }).components, spell.components, spell.id)
    assert.equal(canonicalCombatSpellFor(spell.id, { rulesetId: 'srd_5_2_1' }).components, undefined, `${spell.id}: другая редакция`)
  }
})

test('различающиеся source-backed требования не сводятся к одной материальной цене', () => {
  const spell = id => catalog.spells.find(entry => entry.id === id).components
  assert.deepEqual(spell('absorb-elements'), { verbal: false, somatic: true, material: null })
  assert.deepEqual(spell('silvery-barbs'), { verbal: true, somatic: false, material: null })
  assert.equal(spell('chromatic-orb').material.costGp, 50)
  assert.equal(spell('chromatic-orb').material.consumed, false)
  assert.equal(spell('greater-restoration').material.costGp, 100)
  assert.equal(spell('greater-restoration').material.consumed, true)
  assert.equal(spell('booming-blade').material.costGp, 0.1)
  assert.equal(spell('summon-fiend').material.costGp, 600)
  assert.equal(spell('create-homunculus').material.unresolved, true)
  assert.equal(spell('warding-bond').material.unresolved, true)
  assert.equal(spell('jims-magic-missile').special[0].kind, 'royalty')
})
