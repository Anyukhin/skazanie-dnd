import assert from 'node:assert/strict'
import test from 'node:test'
import { compileClientModules } from './kit/client-ts.mjs'

const { modules: [figures, summons] } = await compileClientModules([
  'src/astohan-actor-figures.ts',
  'src/astohan-summon-figures.ts',
])

const keys = [
  'astohan-summon-spiritual-weapon', 'astohan-summon-beast', 'astohan-summon-animal',
  'astohan-summon-fey', 'astohan-summon-lesser-demon', 'astohan-summon-shadowspawn',
  'astohan-summon-undead', 'astohan-summon-woodland', 'astohan-summon-faithful-hound',
  'astohan-summon-aberration', 'astohan-summon-construct', 'astohan-summon-elemental',
  'astohan-summon-greater-demon',
]

test('все 13 исполняемых призывов получают отдельный публичный силуэт', () => {
  for (const key of keys) {
    const figure = summons.buildCampaignSummon(key)
    assert.ok(figure, key)
    assert.equal(figure.userData.board3dPickable, false, key)
    assert.ok(figure.children.length > 0, key)
  }
})
