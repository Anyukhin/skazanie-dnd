import assert from 'node:assert/strict'
import test from 'node:test'
import { addProp, createTacticalMap, legacyCellsFromTacticalMap, serializeTacticalMap, setDoor } from '../server/tactical-map.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('кнопки взлома двери и сундука передают отмычки в Rules Engine', { timeout: runnerTimeout(60_000) }, async t => {
  const server = await startTestServer(t, { dice: { rules: [{ sides: 20, value: 'max' }] } })
  const { client: gm } = await setupAdmin(server)
  const code = 'LOCKPICK-HTTP'
  const hero = {
    id: 'rogue', name: 'Игрок', character: 'Лиса', role: 'Плут', level: 7, hp: 35, maxHp: 35, x: 1, y: 1,
    abilities: { dex: 17 }, proficiency: 3, toolProficiencies: ['thieves_tools'], skillExpertiseIds: ['thieves_tools'],
  }
  const map = createTacticalMap({ width: 5, height: 4, locationId: 'vault', seed: 'lockpick-6', fill: { passable: true, revealed: true } })
  setDoor(map, { id: 'door', x: 1, y: 1, dir: 'e', state: 'locked', lockDc: 15, blocksMove: true, blocksSight: true })
  addProp(map, { id: 'prop-chest', assetId: 'chest', x: 1.5, y: 2.5, footprint: [{ x: 1, y: 2 }] })
  await createCampaign(gm, { code, state: {
    sessionCode: code, campaign: 'Хранилище', ruleset_id: 'dnd_5e_2014', enabled_rule_packs: ['dnd_5e_2014'],
    players: [hero], activePlayerId: hero.id, partyMemberIds: [hero.id],
    scene: { location: 'Хранилище', map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map) },
    mechanics: { positions: { [hero.id]: { x: 1, y: 1 } } }, enemies: [], entities: [], messages: [], battleLog: [], state_version: 0,
  } })
  const { client: player } = await addPlayer(server, gm, code, { heroIds: [hero.id] })
  const open = (key, command) => sendCommand(player, code, key, { actor_id: hero.id, intent: 'lockpick', ...command })
  const door = expectStatus(await open('door-key', { command_type: 'OperateDoor', door_id: 'door' }))
  assert.equal(door.mechanics.find(e => e.event_type === 'DoorLockpicked')?.payload.check_total, 29)
  const chest = expectStatus(await open('chest-key', { command_type: 'OperateSceneObject', prop_id: 'prop-chest' }))
  const check = chest.mechanics.find(e => e.event_type === 'SceneObjectCheckResolved')
  assert.equal(check?.payload.modifier, 9)
  assert.ok(chest.mechanics.some(e => e.event_type === 'SceneObjectLootRevealed'))
})
