import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCombatLabState } from '../server/combat-lab-setup.mjs'
import { addPlayer, createCampaign, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'REACTION-MODES-HTTP'

function expect(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify({ code: result.body.code, error: result.body.error }))
  return result.body
}

test('HTTP: игрок задаёт режим реакции только своему герою, повтор и restart не меняют результат', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-reaction-modes-api-', env: { DND_COMBAT_TURN_TIMEOUT_MS: '3600000' } })
  const { client: gm } = await setupAdmin(server, { email: 'gm@reaction-modes.test', password: 'reaction-modes-admin-password' })
  const state = await buildCombatLabState({
    mapId: 'forest-clearing',
    party: [
      { source: 'class', classId: 'wizard', level: 5, x: 1, y: 4 },
      { source: 'class', classId: 'rogue', level: 5, x: 1, y: 5 },
    ],
    enemies: [{ monsterId: 'dnd_5e_2014:monster:orc', x: 7, y: 8 }],
  })
  state.sessionCode = CAMPAIGN
  await createCampaign(gm, { code: CAMPAIGN, name: 'Режимы реакций', state })
  const { client: rogue } = await addPlayer(server, gm, CAMPAIGN, {
    heroIds: ['hero-2'], name: 'Плут', email: 'rogue@reaction-modes.test', password: 'reaction-modes-player-password',
  })

  const command = (client, key, body) => sendCommand(client, CAMPAIGN, key, body)
  const room = async (client) => expect(await client.get(`/api/rooms/${CAMPAIGN}`)).state

  // Свой герой видит свои реакции списком с режимами; «Невероятное уклонение»
  // плута 5-го уровня — из того же серверного перечня, что сверяет команда.
  const before = await room(rogue)
  const ownHero = before.players.find((hero) => hero.id === 'hero-2')
  assert.deepEqual(ownHero.reactionModes.map((entry) => `${entry.id}:${entry.mode}`), ['opportunity-attack:ask', 'uncanny-dodge:ask'])
  assert.equal(before.players.find((hero) => hero.id === 'hero-1').reactionModes, undefined)

  const foreign = await command(rogue, 'foreign-mode', { command_type: 'SetReactionPreference', actor_id: 'hero-1', reaction_id: 'opportunity-attack', mode: 'never' })
  expect(foreign, 403)
  const invalid = await command(rogue, 'invalid-mode', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'cast:shield', mode: 'auto' })
  expect(invalid, 400)
  assert.equal(invalid.body.code, 'REACTION_PREFERENCE_INVALID')

  const set = expect(await command(rogue, 'rogue-dodge-auto', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'uncanny-dodge', mode: 'auto' }))
  const repeated = expect(await command(rogue, 'rogue-dodge-auto', { command_type: 'SetReactionPreference', actor_id: 'hero-2', reaction_id: 'uncanny-dodge', mode: 'auto' }))
  assert.equal(repeated.idempotent_replay, true, 'повтор с тем же ключом возвращает прежний commit')
  assert.deepEqual(repeated.mechanics.map((event) => event.event_type), set.mechanics.map((event) => event.event_type))
  assert.equal(set.mechanics.filter((event) => event.event_type === 'ReactionPreferenceChanged').length, 1)

  const after = await room(rogue)
  assert.equal(after.players.find((hero) => hero.id === 'hero-2').reactionModes.find((entry) => entry.id === 'uncanny-dodge').mode, 'auto')
  assert.deepEqual(after.mechanics.reaction_preferences, { 'hero-2': { 'uncanny-dodge': 'auto' } })

  await server.restart()
  const restarted = await room(rogue)
  assert.equal(restarted.players.find((hero) => hero.id === 'hero-2').reactionModes.find((entry) => entry.id === 'uncanny-dodge').mode, 'auto', 'режим пережил перезапуск сервера')
})
