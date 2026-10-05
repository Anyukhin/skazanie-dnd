import assert from 'node:assert/strict'
import test from 'node:test'
import { createCampaign, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'

function cells() {
  return Array.from({ length: 25 }, (_, index) => ({
    x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true,
  }))
}

test('обычный HTTP путь позволяет владельцу героя наложить Protection from Energy на себя', { timeout: 30_000 }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-pfe-http-' })
  const log = () => server.output()
  const { client: admin } = await setupAdmin(server, { name: 'PFE admin', email: 'pfe-admin@test.invalid', password: 'pfe-admin-password' })
  const { client: player } = await registerUser(server, { name: 'PFE player', email: 'pfe-player@test.invalid', password: 'pfe-player-password' })
  const state = {
    sessionCode: 'PFE-HTTP', campaign: 'Protection from energy HTTP', partyMemberIds: ['caster', 'ally'], activePlayerId: 'caster',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [
      { id: 'caster', name: 'Мира', character: 'Мира', characterClass: 'wizard', level: 5, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 3, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], knownSpellIds: ['protection-from-energy'], preparedSpellIds: ['protection-from-energy'], x: 1, y: 1 },
      { id: 'ally', name: 'Бор', character: 'Бор', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [], scene: { title: 'PFE HTTP', location: 'test', turn: 1, cells: cells() },
    mechanics: { resources: { caster: { spell_slots_3: { current: 2, max: 2 } } }, combat: { active: false } }, engine_mode: 'enforce',
  }
  await createCampaign(admin, { code: 'PFE-HTTP', name: state.campaign, state })
  const users = await admin.get('/api/admin/users')
  const playerUser = users.body.users.find((candidate) => candidate.email === 'pfe-player@test.invalid')
  const assigned = await admin.patch(`/api/admin/users/${playerUser.id}`, { heroIds: ['caster'] })
  assert.equal(assigned.status, 200, `${assigned.text}\n${log()}`)

  const command = { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'protection-from-energy', target_id: 'caster', spell_option: 'fire' }
  const first = await player.post('/api/campaigns/PFE-HTTP/commands', { idempotency_key: 'pfe-http-cast', message: 'Защищаюсь от огня', command })
  assert.equal(first.status, 200, `${first.text}\n${log()}`)
  const condition = first.body.mechanics.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(condition.payload.condition, 'protected-from-energy:fire')
  assert.equal(condition.payload.expiry_policy, 'protection-from-energy/v1')
  assert.equal(first.body.authoritative_state.mechanics.resources.caster.spell_slots_3.current, 1)

  const duplicate = await player.post('/api/campaigns/PFE-HTTP/commands', { idempotency_key: 'pfe-http-cast', message: 'Защищаюсь от огня', command })
  assert.equal(duplicate.status, 200, `${duplicate.text}\n${log()}`)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.state_version, first.body.authoritative_state.state_version)
})
