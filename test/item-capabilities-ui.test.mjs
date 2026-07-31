import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const inventorySource = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')

test('inventory item actions are wired to projected capabilities instead of catalog ids', () => {
  assert.match(inventorySource, /item\.capabilities\?\.equippable/u)
  assert.match(inventorySource, /item\.capabilities\?\.usable/u)
  assert.match(inventorySource, /item\.capabilities\.use\?\.target === 'party'/u)
  assert.match(inventorySource, /useTargetOptions = \[player, \.\.\.party\.filter/u)
  assert.match(inventorySource, /item\.capabilities\.charges\.current/u)
  assert.doesNotMatch(inventorySource, /potion-of-healing|healers-kit|longsword-plus-1/u)
})
