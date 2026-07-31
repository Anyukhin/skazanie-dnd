import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const inventorySource = readFileSync(new URL('../src/InventoryViews.tsx', import.meta.url), 'utf8')

test('inventory item actions are wired to projected capabilities instead of catalog ids', () => {
  assert.match(inventorySource, /item\.capabilities\?\.equippable/u)
  assert.match(inventorySource, /item\.capabilities\?\.usable/u)
  assert.match(inventorySource, /item\.capabilities\?\.requires_attunement/u)
  assert.match(inventorySource, /item\.capabilities\?\.use\?\.target === 'party'/u)
  assert.match(inventorySource, /item\.capabilities\.use\?\.target === 'enemy'/u)
  assert.match(inventorySource, /useTargetOptions = \[player, \.\.\.party\.filter/u)
  assert.match(inventorySource, /item\.capabilities\.charges\.current/u)
  assert.match(inventorySource, /item\.capabilities\.use\?\.min_charges_to_spend/u)
  assert.match(inventorySource, /item\.capabilities\.use\.max_charges_to_spend/u)
  assert.match(inventorySource, /combatItemTurnAvailable/u)
  assert.match(inventorySource, /item\.capabilities\.use\?\.combat_only/u)
  assert.match(inventorySource, /item\.capabilities\.use\?\.requires_equipped/u)
  assert.match(inventorySource, /!item\.equipped/u)
  assert.match(inventorySource, /enemyTargets\.some\(\(candidate\) => candidate\.id === selected\)/u)
  assert.match(inventorySource, /Math\.min\(availableMaximum, preferred\)/u)
  assert.match(inventorySource, /item\.capabilities\?\.mechanics_status/u)
  assert.match(inventorySource, /item\.capabilities\.mechanics_status !== 'verified'/u)
  assert.match(inventorySource, /item\.capabilities\.limitation/u)
  assert.match(inventorySource, /item-mechanics-limitation/u)
  assert.doesNotMatch(inventorySource, /potion-of-healing|healers-kit|longsword-plus-1|ring-of-protection/u)
})
