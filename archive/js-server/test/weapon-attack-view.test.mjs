import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCombatLabState } from '../server/combat-lab-setup.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { weaponAttackSummary } from '../server/rules-engine.mjs'
import { withWeaponAttackSummaries } from '../server/weapon-attack-view.mjs'

const modifierOf = (score) => Math.floor((Number(score) - 10) / 2)
const item = (id, catalogId, extra = {}) => ({ ...materializeCatalogItem(`srd_5_2_1:${catalogId}`, {}), id, quantity: 1, equipped: false, rarity: 'обычный', ...extra })

async function party() {
  const state = await buildCombatLabState({
    mapId: 'forest-clearing',
    party: [
      { source: 'class', classId: 'fighter', level: 5, x: 1, y: 4 },
      { source: 'class', classId: 'rogue', level: 5, x: 1, y: 3 },
    ],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:orc', x: 9, y: 9 }],
  })
  state.players[0].inventory = [item('sword', 'longsword', { equipped: true }), item('bow', 'shortbow')]
  state.players[1].inventory = [item('rapier', 'rapier', { equipped: true })]
  return state
}

test('сводка удара считается движком: модификатор и урон те же, что у настоящей атаки', async () => {
  const state = await party()
  const fighter = state.players[0]
  const sword = weaponAttackSummary(state, fighter.id, 'sword')
  assert.equal(sword.ability, 'str')
  assert.equal(sword.kind, 'melee')
  assert.equal(sword.attack_modifier, modifierOf(fighter.abilities.str) + fighter.proficiency)
  assert.equal(sword.damage_expression, `1d8+${modifierOf(fighter.abilities.str)}`)
  const rogue = state.players[1]
  const rapier = weaponAttackSummary(state, rogue.id, 'rapier')
  // Фехтовальное оружие бьёт лучшей из Силы и Ловкости — у плута Ловкость.
  assert.equal(rapier.ability, 'dex')
  assert.equal(rapier.attack_modifier, modifierOf(rogue.abilities.dex) + rogue.proficiency)
  // Постоянные бонусы состояний входят, как в прогнозе и в самом ударе.
  state.mechanics.conditions = { ...(state.mechanics.conditions ?? {}), [fighter.id]: ['magic-weapon'] }
  assert.equal(weaponAttackSummary(state, fighter.id, 'sword').attack_modifier, sword.attack_modifier + 1)
  assert.equal(weaponAttackSummary(state, fighter.id, 'missing'), null)
})

test('сводка ложится только на надетое оружие своего героя, ведущему — на всех', async () => {
  const state = await party()
  const projected = { players: state.players.map((player) => ({ ...player, inventory: player.inventory.map((entry) => ({ ...entry })) })) }
  const own = withWeaponAttackSummaries(projected, state, state.players[0].id)
  const [fighter, rogue] = own.players
  assert.ok(fighter.inventory.find((entry) => entry.id === 'sword').attack_summary, 'надетый меч получает сводку')
  assert.equal(fighter.inventory.find((entry) => entry.id === 'bow').attack_summary, undefined, 'лук в сумке сводку не получает')
  assert.equal(rogue.inventory.find((entry) => entry.id === 'rapier').attack_summary, undefined, 'модификатор соседа по столу не раскрывается')
  assert.equal(projected.players[0].inventory[0].attack_summary, undefined, 'исходная проекция не мутируется')
  const gm = withWeaponAttackSummaries(projected, state, '')
  assert.ok(gm.players[1].inventory[0].attack_summary, 'ведущий видит сводку всех героев')
  const noInventory = { players: [{ id: state.players[0].id }] }
  assert.equal(withWeaponAttackSummaries(noInventory, state, state.players[0].id), noInventory)
})
