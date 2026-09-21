import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand, spellTargetsAt } from '../server/rules-engine.mjs'

const POINT = { x: 4, y: 4 }
// Независимый эталон: 20 футов = ровно четыре клетки по каждой оси.
const EXPECTED_20FT_CUBE = [
  { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 }, { x: 6, y: 3 },
  { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 },
  { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 },
  { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 5, y: 6 }, { x: 6, y: 6 },
]

const key = (point) => `${point.x},${point.y}`
const keys = (points) => points.map(key)
const cubeSpell = (overrides = {}) => ({
  id: 'entangle',
  kind: 'area-save',
  target: 'point',
  radius: 10,
  areaSideFeet: 20,
  areaShape: 'cube',
  saveAbility: 'str',
  ...overrides,
})

test('cube profiles carry source side lengths independently from legacy radius', () => {
  const expectedSides = {
    'create-bonfire': 5,
    grease: 10,
    entangle: 20,
    'faerie-fire': 20,
    thunderwave: 15,
    web: 20,
    'hypnotic-pattern': 30,
    'evard-s-black-tentacles': 20,
    'cloud-of-daggers': 5,
    'erupting-earth': 20,
    'healing-spirit': 5,
  }
  for (const [spellId, sideFeet] of Object.entries(expectedSides)) {
    assert.equal(canonicalCombatSpellFor(spellId)?.areaSideFeet, sideFeet, `${spellId}: source side must be explicit`)
  }
})

function floorCells(width = 12, height = 12) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function field(enemies, { mageAt = { x: 0, y: 0 }, activeEnemy = null, activeEffects = [] } = {}) {
  const initiative = [
    { actor_id: 'mage', total: 20 },
    ...enemies.map((enemy, index) => ({ actor_id: enemy.id, total: 10 - index })),
  ]
  return normalizeCampaignState({
    sessionCode: 'SPELL-CUBE-GEOMETRY',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage', character: 'Маг', characterClass: 'wizard', level: 10,
      hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 4,
      abilities: { int: 18, dex: 14, con: 14, wis: 12, str: 10 },
      inventory: [], x: mageAt.x, y: mageAt.y,
    }],
    enemies: enemies.map((enemy) => ({
      id: enemy.id, name: enemy.id, creature_type: 'humanoid', hp: 30, maxHp: 30,
      armor: 12, speed: 30, abilities: { str: 12, dex: 12, con: 12, wis: 10 },
      alive: true, x: enemy.x, y: enemy.y, ...enemy,
    })),
    scene: { cells: floorCells() },
    mechanics: {
      active_effects: activeEffects,
      combat: {
        active: true,
        round: 1,
        active_index: activeEnemy ? initiative.findIndex((entry) => entry.actor_id === activeEnemy) : 0,
        initiative,
        action_economy: Object.fromEntries(['mage', ...enemies.map((enemy) => enemy.id)].map((id) => [id, {
          action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0,
        }])),
      },
    },
  })
}

test('20-футовый point-cube поражает вручную заданные 16 клеток, включая диагональные углы', () => {
  const expectedIds = EXPECTED_20FT_CUBE.map((point) => `cube-${key(point)}`)
  const enemies = EXPECTED_20FT_CUBE.map((point) => ({ id: `cube-${key(point)}`, ...point }))
  enemies.push({ id: 'outside-north-west', x: 2, y: 2 }, { id: 'outside-south-east', x: 7, y: 7 })
  const current = field(enemies)
  const targets = spellTargetsAt(current, { actor_id: 'mage', to: POINT }, cubeSpell())

  assert.deepEqual(targets.map((actor) => actor.id), expectedIds)
  assert.equal(targets.some((actor) => actor.id === 'outside-north-west'), false)
  assert.equal(targets.some((actor) => actor.id === 'outside-south-east'), false)
})

test('self-конус, куб и линия отвергают нулевое направление до расхода ячейки', () => {
  for (const spellId of ['burning-hands', 'thunderwave', 'lightning-bolt']) {
    const current = field([{ id: 'target', x: 2, y: 1 }], { mageAt: { x: 1, y: 1 } })
    const before = structuredClone(current)
    assert.throws(() => resolveCommand({
      command_type: 'CastSpell', command_id: `zero-direction:${spellId}`,
      actor_id: 'mage', spell_id: spellId, to: { x: 1, y: 1 }, server_authoritative: true,
    }, current, { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { serverAuthoritativeCombat: true } }), { code: 'SPELL_DIRECTION_REQUIRED' })
    assert.deepEqual(current, before, `${spellId}: отказ не изменяет состояние и ресурсы`)
  }
})

test('старый point-cube без areaSideFeet сохраняет совместимый fallback radius×2', () => {
  const enemies = EXPECTED_20FT_CUBE.map((point) => ({ id: `cube-${key(point)}`, ...point }))
  enemies.push({ id: 'outside', x: 2, y: 4 }, { id: 'outside-diagonal', x: 7, y: 7 })
  const current = field(enemies)
  const legacy = cubeSpell()
  delete legacy.areaSideFeet
  assert.deepEqual(
    spellTargetsAt(current, { actor_id: 'mage', to: POINT }, legacy).map((actor) => actor.id),
    EXPECTED_20FT_CUBE.map((point) => `cube-${key(point)}`),
  )
})

test('явная сторона не превращает малый point-cube в 2×2 через глобальное удвоение radius', () => {
  const current = field([
    { id: 'bonfire-cell', x: 4, y: 4 },
    { id: 'bonfire-east', x: 5, y: 4 },
  ])
  const spell = cubeSpell({ id: 'create-bonfire', radius: 5, areaSideFeet: 5 })
  assert.deepEqual(spellTargetsAt(current, { actor_id: 'mage', to: POINT }, spell).map((actor) => actor.id), ['bonfire-cell'])
})

test('self-cube учитывает всю площадь крупного заклинателя и сохраняет край/диагональ', () => {
  const current = field([
    { id: 'self-edge', x: 4, y: 1 },
    { id: 'self-diagonal', x: 4, y: 0 },
    { id: 'self-outside', x: 5, y: 4 },
  ], { mageAt: { x: 1, y: 1 } })
  current.players[0].footprint = { version: 1, size: 2 }
  const spell = cubeSpell({ radius: 15, areaSideFeet: 15, areaOrigin: 'self' })
  const targets = spellTargetsAt(current, { actor_id: 'mage', to: { x: 4, y: 1 } }, spell).map((actor) => actor.id)
  assert.ok(targets.includes('self-edge'))
  assert.ok(targets.includes('self-diagonal'))
  assert.equal(targets.includes('self-outside'), false)
})

test('длящаяся point-cube использует ту же границу при входе, что и начальное поражение', () => {
  const effect = {
    id: 'entangle:geometry',
    effect_id: 'entangle:geometry',
    spell_id: 'entangle',
    source_actor: 'mage',
    center: POINT,
    radius_feet: 10,
    area_side_feet: 20,
    area_shape: 'cube',
    trigger_on_enter: true,
    condition: 'restrained',
    expires_round: 10,
  }
  const initial = field([{ id: 'runner', x: 1, y: 4 }], { activeEnemy: 'runner', activeEffects: [effect] })
  const options = { diceService: new DiceService({ rng: new SequenceDiceRng([20]) }), context: { serverAuthoritativeCombat: true, isAdmin: true } }
  const outside = resolveCommand({ command_type: 'MoveActor', command_id: 'cube-outside', actor_id: 'runner', to: { x: 2, y: 4 }, server_authoritative: true }, initial, options)
  assert.equal(outside.events.some((event) => event.event_type === 'ConditionAdded'), false)
  const insideState = replayEvents(initial, outside.events)
  const inside = resolveCommand({ command_type: 'MoveActor', command_id: 'cube-inside', actor_id: 'runner', to: { x: 3, y: 4 }, server_authoritative: true }, insideState, options)
  assert.ok(inside.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained'))
})
