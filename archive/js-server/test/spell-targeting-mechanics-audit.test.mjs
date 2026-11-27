import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCombatSpellFor, combatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { createTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand, spellTargetsAt } from '../server/rules-engine.mjs'

function dice() {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(Array.from({ length: 120 }, () => 6)),
    idFactory: () => `area-loe-${++id}`,
    now: () => '2026-09-19T12:00:00.000Z',
  })
}

function state(map, { mageAt = { x: 1, y: 2 }, enemyAt = { x: 7, y: 2 }, enemyFootprint } = {}) {
  return normalizeCampaignState({
    sessionCode: 'AREA-LOE-AUDIT',
    partyMemberIds: ['mage'],
    players: [{
      id: 'mage', character: 'Маг', characterClass: 'wizard', level: 5,
      hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3,
      knownSpellIds: ['web', 'fireball', 'darkness', 'fog-cloud'], preparedSpellIds: ['web', 'fireball', 'darkness', 'fog-cloud'],
      abilities: { int: 18, dex: 14, con: 14, wis: 12 }, inventory: [], ...mageAt,
    }],
    enemies: [{
      id: 'behind-wall', name: 'За стеной', creature_type: 'humanoid', hp: 20, maxHp: 20,
      armor: 12, speed: 30, abilities: { dex: 10, con: 10, wis: 10 }, alive: true, ...enemyAt,
      ...(enemyFootprint ? { footprint: enemyFootprint } : {}),
    }],
    scene: { map: JSON.parse(JSON.stringify(serializeTacticalMap(map))) },
    mechanics: {
      resources: { mage: { spell_slots_2: { current: 2, max: 2 }, spell_slots_3: { current: 2, max: 2 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'behind-wall', total: 10 }],
        action_economy: { mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

function mapWithWall() {
  const map = createTacticalMap({ width: 10, height: 5, locationId: 'area-loe', fill: { passable: true, revealed: true, material: 'stone' } })
  setCell(map, 6, 2, { type: 'wall', passable: false })
  return map
}

function mapWithClosedDoor() {
  const map = createTacticalMap({ width: 10, height: 5, locationId: 'area-door', fill: { passable: true, revealed: true, material: 'stone' } })
  setDoor(map, { id: 'vault-door', x: 6, y: 2, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  return map
}

const areaCommand = (spellId) => ({
  command_type: 'CastSpell', command_id: `audit-${spellId}`, actor_id: 'mage', spell_id: spellId,
  to: { x: 5, y: 2 }, server_authoritative: true,
})

test('generic AoE obeys total cover while Fireball wraps a corner inside its radius', () => {
  const current = state(mapWithWall())
  const web = combatSpellFor(current.players[0], 'web')
  const fireball = combatSpellFor(current.players[0], 'fireball')
  const webTargets = spellTargetsAt(current, areaCommand('web'), web).map((actor) => actor.id)
  const fireballTargets = spellTargetsAt(current, areaCommand('fireball'), fireball).map((actor) => actor.id)

  assert.deepEqual(webTargets, [], 'обычная область не должна проникать через стену')
  assert.ok(fireballTargets.includes('behind-wall'), 'Fireball может обогнуть угол в пределах радиуса')
})

test('corner-wrapping is canonical profile metadata and explicit false is respected', () => {
  const current = state(mapWithWall())
  for (const id of ['fireball', 'darkness', 'fog-cloud', 'stinking-cloud', 'cloudkill']) {
    assert.equal(canonicalCombatSpellFor(id)?.spreadsAroundCorners, true, `${id} должен нести флаг в canonical-профиле`)
  }
  assert.equal(combatSpellFor(current.players[0], 'fog-cloud')?.mechanicsSupport, 'heuristic', 'metadata не должна разблокировать Fog Cloud')

  const fireball = combatSpellFor(current.players[0], 'fireball')
  const explicitFalse = { ...fireball, spreadsAroundCorners: false }
  assert.equal(spellTargetsAt(current, areaCommand('fireball'), explicitFalse).some((actor) => actor.id === 'behind-wall'), false, 'сохранённый явный false должен блокировать обход угла')
})

test('canonical Darkness wraps a corner but cannot enter a sealed room', () => {
  const aroundCorner = state(mapWithWall())
  const darkness = combatSpellFor(aroundCorner.players[0], 'darkness')
  assert.ok(spellTargetsAt(aroundCorner, areaCommand('darkness'), darkness).some((actor) => actor.id === 'behind-wall'))

  const sealed = createTacticalMap({ width: 10, height: 6, locationId: 'area-sealed', fill: { passable: true, revealed: true, material: 'stone' } })
  for (const [x, y] of [[6, 2], [7, 1], [7, 3], [8, 2]]) setCell(sealed, x, y, { type: 'wall', passable: false })
  const sealedState = state(sealed)
  const sealedDarkness = combatSpellFor(sealedState.players[0], 'darkness')
  assert.equal(spellTargetsAt(sealedState, areaCommand('darkness'), sealedDarkness).some((actor) => actor.id === 'behind-wall'), false)
})

test('закрытая дверь блокирует generic AoE до цели за дверью', () => {
  const current = state(mapWithClosedDoor())
  const web = combatSpellFor(current.players[0], 'web')
  assert.deepEqual(spellTargetsAt(current, areaCommand('web'), web), [])
})

test('diagonal LoE does not slip through a closed corner', () => {
  const map = createTacticalMap({ width: 10, height: 8, locationId: 'area-corner', fill: { passable: true, revealed: true, material: 'stone' } })
  setDoor(map, { id: 'corner-east', x: 4, y: 4, dir: 'e', state: 'closed', blocksMove: true, blocksSight: true })
  setDoor(map, { id: 'corner-south', x: 4, y: 4, dir: 's', state: 'closed', blocksMove: true, blocksSight: true })
  const current = state(map, { mageAt: { x: 1, y: 4 }, enemyAt: { x: 6, y: 6 } })
  const web = combatSpellFor(current.players[0], 'web')
  assert.deepEqual(spellTargetsAt(current, { ...areaCommand('web'), to: { x: 4, y: 4 } }, web), [], 'диагональ через закрытый угол не должна считаться прямой LoE')
})

test('hidden geometry still blocks LoE without becoming visible target data', () => {
  const map = mapWithWall()
  setCell(map, 6, 2, { revealed: false })
  const current = state(map)
  const web = combatSpellFor(current.players[0], 'web')
  assert.deepEqual(spellTargetsAt(current, areaCommand('web'), web), [], 'fog does not turn a solid wall into line of effect')
})

test('large footprint requires the same cell to be inside the area and visible by LoE', () => {
  const map = createTacticalMap({ width: 8, height: 6, locationId: 'area-large', fill: { passable: true, revealed: true, material: 'stone' } })
  setCell(map, 1, 1, { type: 'wall', passable: false })
  const current = state(map, { mageAt: { x: 0, y: 0 }, enemyAt: { x: 1, y: 2 }, enemyFootprint: { version: 1, size: 2 } })
  const web = combatSpellFor(current.players[0], 'web')
  assert.equal(spellTargetsAt(current, { ...areaCommand('web'), to: { x: 0, y: 0 } }, web).some((actor) => actor.id === 'behind-wall'), false, 'outside-footprint LoE must not rescue an inside footprint cell blocked by a wall')
})

test('LoE отказ/успех сохраняет экономику, replay и persisted area cells', () => {
  const blocked = state(mapWithWall())
  assert.throws(
    () => resolveCommand({ ...areaCommand('web'), command_id: 'audit-blocked-center', to: { x: 8, y: 2 } }, blocked, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } }),
    (error) => error.code === 'TRAJECTORY_BLOCKED',
    'центр за сплошной стеной должен отказать до ResourceSpent',
  )
  const command = areaCommand('web')
  const cast = resolveCommand(command, blocked, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.equal(cast.events.filter((event) => event.event_type === 'SpellSavingThrowResolved').length, 0)
  assert.equal(cast.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  const replayed = replayEvents(blocked, cast.events)
  const area = replayed.mechanics.active_effects.find((effect) => effect.spell_id === 'web')
  assert.ok(area, 'валидный cast сохраняет область для replay')
  assert.deepEqual(replayEvents(blocked, cast.events), replayed)
  const mageEnd = resolveCommand({ command_type: 'EndTurn', command_id: 'audit-mage-end', actor_id: 'mage', server_authoritative: true }, replayed, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  const enemyTurn = replayEvents(replayed, mageEnd.events)
  const enemyEnd = resolveCommand({ command_type: 'EndTurn', command_id: 'audit-enemy-end', actor_id: 'behind-wall', server_authoritative: true }, enemyTurn, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.equal(enemyEnd.events.filter((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('behind-wall')).length, 0, 'persisted area must keep LoE after replay')
  const fireball = resolveCommand({ ...areaCommand('fireball'), command_id: 'audit-fireball' }, blocked, { diceService: dice(), context: { serverAuthoritativeCombat: true, isAdmin: true } })
  assert.equal(fireball.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.ok(fireball.events.some((event) => event.event_type === 'SpellSavingThrowResolved' && event.target_ids.includes('behind-wall')))
})
