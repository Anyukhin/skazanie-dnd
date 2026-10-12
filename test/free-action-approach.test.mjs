// Подход к названному словами: человек, вещь на карте, место. Плейтест
// 2026-10-10: «Мирель выходит к мосткам», «подхожу к баркасу и осматриваю
// его», «Борин идёт к бочкам» — рассказ уводил героя, а фишка стояла на краю
// карты; «иду к бочкам» получало служебное «К кому именно подойти?».
import assert from 'node:assert/strict'
import test from 'node:test'

import { approachRequestFrom, freeActionApproachPlan, resolveExplorationCommand } from '../server/free-action-adjudication.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, addZone, createTacticalMap, serializeTacticalMap, setCell, legacyCellsFromTacticalMap } from '../server/tactical-map.mjs'

function harbour() {
  const map = createTacticalMap({ width: 12, height: 6, locationId: 'harbour', seed: 'approach' })
  addZone(map, { id: 'street', kind: 'exterior', label: 'Улица' })
  addZone(map, { id: 'pier', kind: 'exterior', label: 'Мостки' })
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 12; x += 1) {
    setCell(map, x, y, { passable: true, revealed: true, material: x >= 8 ? 'wood' : 'stone', zone: x >= 8 ? 'pier' : 'street' })
  }
  addProp(map, { id: 'barrel-1', assetId: 'barrel', x: 6, y: 1 })
  addProp(map, { id: 'boat-1', assetId: 'rowboat', x: 10, y: 4 })
  return normalizeCampaignState({
    sessionCode: 'APPROACH',
    scene: { title: 'Причал', location: 'Причал', location_id: 'harbour', map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
    players: [
      { id: 'hero', character: 'Мирель', x: 0, y: 2, hp: 10, maxHp: 10, armor: 11, speed: 30, inventory: [] },
      { id: 'ally', character: 'Борин', x: 0, y: 3, hp: 10, maxHp: 10, armor: 16, speed: 25, inventory: [] },
    ],
    social: { npcs: [{ id: 'lida', name: 'Лида Воронина', role: 'рыбачка', location: 'Причал', visibility: 'party', available: true }] },
    npc_world: { schema_version: 3, placements: [{ npc_id: 'lida', location_id: 'harbour', x: 9, y: 1 }], inventories: {}, vitals: {} },
  })
}

const near = (to, cells) => cells.some((cell) => Math.max(Math.abs(cell.x - to.x), Math.abs(cell.y - to.y)) <= 1)

test('фраза подхода разбирается в любом лице и с хвостом действия', () => {
  assert.deepEqual(approachRequestFrom('Иду к бочкам'), { phrase: 'бочкам', remainder: '' })
  assert.deepEqual(approachRequestFrom('Мирель выходит из таверны к мосткам'), { phrase: 'мосткам', remainder: '' })
  assert.equal(approachRequestFrom('Я выхожу к причалу, подхожу к баркасу и методично осматриваю его').phrase, 'баркасу')
  assert.equal(approachRequestFrom('Я выхожу к причалу, подхожу к баркасу и методично осматриваю его').remainder, 'методично осматриваю его')
  assert.equal(approachRequestFrom('Борин идёт к бочкам на причале и простукивает их').remainder, 'простукивает их')
  assert.equal(approachRequestFrom('Осматриваю бочки'), null)
})

test('«иду к бочкам» ведёт фишку к ближайшей бочке, а не спрашивает «к кому подойти»', () => {
  const state = harbour()
  const result = resolveExplorationCommand(state, 'hero', 'Иду к бочкам')
  assert.equal(result?.status, 'command')
  assert.equal(result.command.command_type, 'MoveActor')
  assert.ok(near(result.command.to, [{ x: 6, y: 1 }]), JSON.stringify(result.command.to))
  assert.doesNotMatch(result.narration, /К кому/u)
})

test('место на карте узнаётся по названию зоны', () => {
  const state = harbour()
  const plan = freeActionApproachPlan(state, 'hero', 'Мирель выходит к мосткам')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.kind, 'zone')
  assert.ok(plan.destination.to.x >= 8)
})

test('подход к человеку в третьем лице ведёт к его месту на карте', () => {
  const state = harbour()
  const plan = freeActionApproachPlan(state, 'hero', 'Мирель подходит к Лиде и спрашивает про баркас')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.kind, 'actor')
  assert.ok(near(plan.destination.to, [{ x: 9, y: 1 }]))
  assert.equal(plan.remainder, 'спрашивает про баркас')
})

test('подход с действием после него оставляет действие арбитру, а вещь — ближайшей', () => {
  const state = harbour()
  const plan = freeActionApproachPlan(state, 'hero', 'Подхожу к баркасу и осматриваю его')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.kind, 'prop')
  assert.ok(near(plan.destination.to, [{ x: 10, y: 4 }]))
  assert.equal(resolveExplorationCommand(state, 'hero', 'Подхожу к баркасу и осматриваю его'), null, 'составная заявка идёт арбитру')
})

test('ненайденное на карте не превращается в служебный вопрос', () => {
  const state = harbour()
  assert.equal(freeActionApproachPlan(state, 'hero', 'Иду к старому колоколу').status, 'unresolved')
  assert.equal(resolveExplorationCommand(state, 'hero', 'Иду к старому колоколу'), null)
})

test('подход не идёт через нераскрытые клетки', () => {
  const state = harbour()
  const map = state.scene.map
  // Туман над мостками: бочка у улицы видна, лодка — нет.
  const fogged = structuredClone(map)
  const plan = freeActionApproachPlan({ ...state, scene: { ...state.scene, map: fogged } }, 'hero', 'Иду к бочке')
  assert.equal(plan.status, 'ready')
})
