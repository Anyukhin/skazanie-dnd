import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCombatLabState, resolveCommands, tacticalMapFromLegacyCells } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const fixedDice = { format: 'skazanie.test-dice/1', rules: [{ actor: '^ogre$', sides: 20, value: 15 }] }
const currentActor = ({ mechanics }) => mechanics.combat.initiative[mechanics.combat.active_index]?.actor_id

async function battleState(code, { wallBetweenActors = false } = {}) {
  const lab = await buildCombatLabState({
    mapId: 'open-courtyard',
    party: [{ source: 'class', classId: 'fighter', level: 3, x: 1, y: 1 }],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:ogre', x: 5, y: 2 }],
  })
  const positions = { first: { x: 4, y: 12 }, second: { x: 5, y: 12 }, ogre: wallBetweenActors ? { x: 6, y: 12 } : { x: 8, y: 14 } }
  const ogre = { ...lab.enemies[0], id: 'ogre', ...positions.ogre }
  if (wallBetweenActors) {
    ogre.footprint = { version: 1, size: 1 }
    ogre.action_profiles = ogre.action_profiles.filter((profile) => profile.id === 'greatclub')
  }
  const players = ['first', 'second'].map((id) => ({
    id, character: id, characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 12, speed: 30, inventory: [],
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, ...positions[id],
  }))
  const cells = Array.from({ length: 24 * 16 }, (_, index) => {
    const x = index % 24
    const y = Math.floor(index / 24)
    let type = 'floor'
    if (!wallBetweenActors && x === 12 && y >= 10 && y <= 12) type = 'wall'
    if (!wallBetweenActors && (x === 6 || x === 7) && y >= 12) type = 'water'
    return { x, y, type, revealed: true }
  })
  const board = wallBetweenActors
    ? await tacticalMapFromLegacyCells(cells, { locationId: 'pier' }, [{ edge: [5, 12, 6, 12, { kind: 'wall' }] }])
    : { cells }
  const initiative = ['first', 'ogre', 'second'].map((actor_id, index) => ({ actor_id, total: 20 - index * 5 }))
  const action_economy = Object.fromEntries(initiative.map(({ actor_id }) => [
    actor_id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
  ]))
  return {
    sessionCode: code, partyMemberIds: ['first', 'second'], activePlayerId: 'first',
    players, enemies: [ogre], scene: { title: 'Причал', location: 'Причал', turn: 1, ...board },
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', engine_mode: 'enforce',
    mechanics: {
      positions, combat: { active: true, active_index: 0, round: 1, initiative, action_economy },
      ...(wallBetweenActors ? { conditions: { ogre: [{ id: 'speed-zero', duration: 'concentration' }] } } : {}),
    },
  }
}

async function assertBlockedAttack(state, actionId) {
  const attackerTurn = structuredClone(state)
  attackerTurn.mechanics.combat.active_index = 1
  await assert.rejects(resolveCommands([{
    command_type: 'MakeAttack', campaign_id: state.sessionCode, command_id: 'probe-attack',
    actor_id: 'ogre', action_id: actionId, target_id: 'second', server_authoritative: true,
  }], attackerTurn, { context: { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true }, fixed: 15 }), {
    code: 'TRAJECTORY_BLOCKED',
  })
}

async function setupCombat(t, code, state) {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-npc-turn-fallback-', dice: fixedDice })
  const { client: admin } = await setupAdmin(server)
  await createCampaign(admin, { code, state })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: ['first', 'second'] })
  const room = async () => expectStatus(await player.get('/api/rooms/' + code)).state
  const endTurn = async (extra = {}) => expectStatus(await player.post('/api/campaigns/' + code + '/commands', {
    idempotency_key: 'first-ends-turn', command: { command_type: 'EndTurn', actor_id: 'first', ...extra },
  }))
  return { server, player, room, endTurn }
}

test('огр обходит воду и атакует на карте 24×16 из плейтеста', { timeout: runnerTimeout(30_000) }, async (t) => {
  const code = 'NPC-PIER-ROUTE'
  const state = await battleState(code)
  await assertBlockedAttack(state, 'javelin:thrown')
  const { room, endTurn } = await setupCombat(t, code, state)
  const response = await endTurn({ auto_skip_reason: 'npc-no-target', server_authoritative: true })
  const after = await room()
  assert.equal(currentActor(after), 'second')
  const playerEnd = response.mechanics.find((event) => event.actor_id === 'first' && event.event_type === 'TurnEnded')
  assert.ok(playerEnd)
  assert.equal(playerEnd.payload.auto_skip_reason, undefined, 'клиент не может поставить причину пропуска NPC')
  assert.ok(!after.messages.some(({ text }) => /Враг не нашёл цели/u.test(text)))
  assert.ok(response.mechanics.some((event) => event.actor_id === 'ogre' && event.event_type === 'ActorMoved'))
  assert.ok(response.mechanics.some((event) => event.actor_id === 'ogre' && event.event_type === 'AttackResolved'))
})

test('тонкая стена завершает ход врага без атаки, запись переживает повтор и рестарт', { timeout: runnerTimeout(40_000) }, async (t) => {
  const code = 'NPC-PIER-WALL'
  const state = await battleState(code, { wallBetweenActors: true })
  await assertBlockedAttack(state, 'greatclub')
  const { server, player, room, endTurn } = await setupCombat(t, code, state)
  await endTurn()
  const after = await room()
  assert.equal(currentActor(after), 'second', server.output())
  const messages = (state) => state.messages.filter(({ text }) => /Враг не нашёл цели/u.test(text))
  assert.equal(messages(after).length, 1)
  const beforeReplay = await readJournal(server, code)
  assert.ok(!beforeReplay.events.some((event) => event.actor_id === 'ogre' && event.event_type === 'AttackResolved'))
  assert.equal(beforeReplay.events.filter((event) => event.actor_id === 'ogre' && event.event_type === 'TurnEnded').length, 1)

  await endTurn()
  await server.restart()
  const resumed = expectStatus(await player.post('/api/campaigns/' + code + '/system-tick', {})).state
  assert.equal(currentActor(resumed), 'second')
  assert.deepEqual(messages(resumed), messages(after))
  const replayed = await readJournal(server, code, { useSnapshots: false })
  assert.deepEqual(replayed.state, beforeReplay.state)
  assert.equal(replayed.events.length, beforeReplay.events.length)
})
