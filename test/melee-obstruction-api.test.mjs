import assert from 'node:assert/strict'
import test from 'node:test'

import { createTacticalMap, serializeTacticalMap, setDoor, setEdge } from '../server/tactical-map.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('открытый проход, тонкая стена и закрытая дверь одинаково действуют в прогнозе и атаке', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { dice: { format: 'skazanie.test-dice/1', rules: [{ sides: 20, value: 14 }, { value: 'min' }] } })
  const { client: admin } = await setupAdmin(server)
  for (const passage of ['open', 'wall', 'closed']) {
    const code = `MELEE-${passage.toUpperCase()}`
    const map = createTacticalMap({ width: 2, height: 1, fill: { material: 'stone', passable: true, revealed: true } })
    if (passage === 'wall') setEdge(map, 0, 0, 1, 0, { kind: 'wall' })
    else setDoor(map, { id: 'door', x: 0, y: 0, dir: 'e', state: passage })
    await createCampaign(admin, { code, state: {
      partyMemberIds: ['hero'], activePlayerId: 'hero',
      players: [{ id: 'hero', character: 'Герой', x: 0, y: 0, hp: 12, maxHp: 12, armor: 14, proficiency: 2, abilities: { str: 16 }, inventory: [
        { id: 'sword', name: 'Меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } },
      ] }],
      enemies: [{ id: 'enemy', name: 'Противник', x: 1, y: 0, hp: 12, maxHp: 12, armor: 12, alive: true }],
      scene: { turn: 1, map: serializeTacticalMap(map), cells: [] },
      mechanics: { combat: { active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'enemy' }], action_economy: { hero: { action: true } },
      } },
    } })
    const { client: player } = await addPlayer(server, admin, code, { heroIds: ['hero'] })
    const getState = async () => expectStatus(await player.get(`/api/rooms/${code}`)).state
    const before = await getState()
    const shot = before.combatForecast?.targets.enemy?.find((entry) => entry.item_id === 'sword')
    assert.ok(shot, passage)
    assert.equal(shot.distance_feet, 5, passage)
    const attack = { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy', item_id: 'sword' }
    const response = await sendCommand(player, code, 'melee', attack)
    if (passage === 'open') {
      const result = expectStatus(response)
      assert.ok(result.mechanics.some((event) => event.event_type === 'AttackResolved' && event.payload.hit))
      await server.restart()
      const retry = expectStatus(await sendCommand(player, code, 'melee', attack))
      assert.equal(retry.idempotent_replay, true)
      assert.deepEqual(retry.mechanics, result.mechanics)
    } else {
      assert.equal(response.body?.code, 'TRAJECTORY_BLOCKED', `${passage}: HTTP ${response.status}`)
      assert.equal((await getState()).state_version, before.state_version)
    }
    assert.equal(shot.in_range, passage === 'open', passage)
    assert.equal(shot.unreachable_reason, passage === 'open' ? null : 'линия удара перекрыта', passage)
    assert.equal(shot.critical_chance, passage === 'open' ? 5 : null, passage)
  }
})
