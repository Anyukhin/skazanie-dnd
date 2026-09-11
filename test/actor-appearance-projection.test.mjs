import assert from 'node:assert/strict'
import test from 'node:test'
import { actorAppearancesForViewer, campaignStateForViewer } from '../server/viewer-projection.mjs'

const sword = { id: 'sword', type: 'weapon', name: 'Длинный меч', equipped: true }
const shield = { id: 'shield', type: 'armor', name: 'Щит', equipped: true }

function state() {
  return {
    sessionCode: 'APPEARANCE', partyMemberIds: ['hero-a', 'hero-b'], activePlayerId: 'hero-a',
    players: [
      { id: 'hero-a', character: 'Гоблинус', characterClass: 'fighter', hp: 10, maxHp: 10, x: 0, y: 0, inventory: [sword, shield] },
      { id: 'hero-b', character: 'Лира', characterClass: 'wizard', hp: 10, maxHp: 10, x: 1, y: 0, inventory: [] },
    ],
    enemies: [
      { id: 'seen', name: 'Скелет', creature_type: 'undead', x: 2, y: 0, hp: 10, inventory: [{ name: 'Тайный посох', equipped: true, type: 'weapon' }] },
      { id: 'hidden', name: 'Гоблин', visibility: 'gm_only', x: 3, y: 0, hp: 20 },
    ],
    actors: [], scene: { title: 'Зал', cells: [], scene_kind: 'exploration' },
    mechanics: {}, messages: [], battleLog: [],
  }
}

test('два игрока получают одинаковое публичное оформление без копии инвентаря', () => {
  const source = state()
  const before = JSON.stringify(source)
  const a = campaignStateForViewer(source, { id: 'a', role: 'player' }, 'hero-a')
  const b = campaignStateForViewer(source, { id: 'b', role: 'player' }, 'hero-b')
  assert.deepEqual(a.actor_appearances, b.actor_appearances)
  assert.deepEqual(a.actor_appearances['hero-a'], { version: 1, profile: 'warrior', equipment: 'sword-shield' })
  assert.deepEqual(a.actor_appearances['hero-b'], { version: 1, profile: 'mage', equipment: 'unarmed' })
  assert.deepEqual(a.actor_appearances.seen, { version: 1, profile: 'skeleton', equipment: 'unknown' })
  assert.equal(a.actor_appearances.hidden, undefined)
  assert.doesNotMatch(JSON.stringify(a.actor_appearances), /Тайный|inventory|item_id|armor|hp/u)
  assert.equal(JSON.stringify(source), before)
})

test('закрытая вещь и произвольная внешность из состояния не обходят проекцию', () => {
  const source = state()
  source.players[0].inventory = [{ ...sword, name: 'Тайный меч', visibility: 'gm_only' }]
  source.actor_appearances = { hidden: { profile: 'goblin', url: 'https://private.invalid/model.glb' } }
  const projected = campaignStateForViewer(source, { id: 'b', role: 'player' }, 'hero-b')
  assert.equal(projected.actor_appearances['hero-a'].equipment, 'unarmed')
  assert.equal(projected.actor_appearances.hidden, undefined)
  assert.doesNotMatch(JSON.stringify(projected.actor_appearances), /private|Тайный/u)
})

test('лук, посох и неоднозначный набор дают отдельные безопасные варианты', () => {
  const equipment = (inventory) => actorAppearancesForViewer({ players: [{ id: 'hero', characterClass: 'ranger', inventory }] }).hero.equipment
  assert.equal(equipment([{ ...sword, name: 'Длинный лук' }]), 'bow')
  assert.equal(equipment([{ ...sword, name: 'Посох' }]), 'staff')
  assert.equal(equipment([{ ...sword, name: 'Кинжал' }]), 'dagger')
  assert.equal(equipment([{ ...sword, name: 'Арбалет' }]), 'unknown')
  assert.equal(equipment([sword, { ...sword, id: 'bow', name: 'Длинный лук' }]), 'unknown')
  assert.equal(equipment([{ ...sword, equipped: false }]), 'unarmed')
  const unusual = actorAppearancesForViewer({ players: [{ id: '__proto__', characterClass: 'fighter' }] })
  assert.equal(Object.hasOwn(unusual, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(unusual), null)
})

test('замаскированная личность не восстанавливается по creature_type', () => {
  const appearances = actorAppearancesForViewer({
    enemies: [{
      id: 'masked', name: 'Неизвестное существо', creature_type: 'goblin',
      inventory: [{ id: 'secret-bow', name: 'Лук', type: 'weapon', equipped: true, visibility: 'gm_only' }],
    }, { id: 'hidden', name: 'Гоблин', visibility: 'gm_only' }],
  })
  assert.deepEqual(appearances.masked, { version: 1, profile: 'warrior', equipment: 'unknown' })
  assert.equal(appearances.hidden, undefined)
})
