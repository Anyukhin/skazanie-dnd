import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, registerUser, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { normalizeCampaignState } from './kit/fixtures.mjs'

const CAMPAIGN = 'ASTOHAN-DEFEAT-PLAYER'
const DICE = {
  format: 'skazanie.test-dice/1',
  rules: [
    { actor: '^wolf$', purpose: '^attack$', sides: 20, value: 19 },
    { actor: '^wolf$', purpose: '^damage$', value: 'max' },
    { actor: '^hero$', purpose: '^death_saving_throw$', sides: 20, value: 10 },
    { value: 'min' },
  ],
}

async function state() {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN,
    campaign: 'Асстохан · восстановление после заставы',
    partyMemberIds: ['hero', 'ally'],
    players: [
      { id: 'hero', character: 'Испытатель', hp: 1, maxHp: 30, armor: 10, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 1, alive: true, inventory: [] },
      { id: 'ally', character: 'Союзник', hp: 0, maxHp: 30, armor: 10, speed: 30, proficiency: 2, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, alive: true, inventory: [] },
    ],
    enemies: [{
      id: 'wolf', name: 'Волк заставы', hp: 10, maxHp: 10, armor: 10, speed: 30,
      attackBonus: 8, damageDice: 1, damageBonus: 4, x: 1, y: 1, alive: true,
      action_profiles: [{ id: 'bite', kind: 'melee', range_feet: 5, damage: '1d6+4', damage_type: 'piercing', attack_bonus: 8 }],
      attack_profile: { id: 'bite', kind: 'melee', range_feet: 5, damage: '1d6+4', damage_type: 'piercing', attack_bonus: 8 },
    }],
    scene: { title: 'Глава 1 · Пепельная застава', location: 'Пепельная застава', location_id: 'astohan-ash-watch', cells: [] },
    mechanics: {
      positions: { hero: { x: 0, y: 1 }, ally: { x: 0, y: 0 }, wolf: { x: 1, y: 1 } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
        turn_completed: [],
      },
      encounter: { id: 'ash-watch-defeat', status: 'active', enemy_ids: ['wolf'] },
      death: { campaign_status: 'active', heroes: {}, saving_throws: { ally: { successes: 3, failures: 0, stable: true, recovery_minutes_remaining: 60 } } },
    },
  })
}

test('публичный EndTurn закрывает поражение отряда и восстанавливает его после restart', { timeout: 35_000 }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-astohan-defeat-player-', setupToken: 'astohan-defeat-player-setup', dice: DICE })
  const admin = await setupAdmin(server, { email: 'astohan-defeat-admin@example.test', password: 'astohan-defeat-admin-password' })
  const player = await registerUser(server, { email: 'astohan-defeat-player@example.test', password: 'astohan-defeat-player-password' })
  await createCampaign(admin.client, { code: CAMPAIGN, name: 'Пепельная застава · recovery', state: await state() })
  const users = await admin.client.get('/api/admin/users')
  const user = users.body.users.find((entry) => entry.email === player.email)
  assert.ok(user)
  await admin.client.patch('/api/admin/users/' + user.id, { heroIds: ['hero'] })

  const first = await sendCommand(player.client, CAMPAIGN, 'player-defeat-end-turn', { command_type: 'EndTurn', actor_id: 'hero' })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.body.mechanics.find((event) => event.event_type === 'CombatEnded')?.payload?.reason, 'party_incapacitated', JSON.stringify(first.body))
  assert.ok(first.body.mechanics.some((event) => event.event_type === 'EncounterOutcomeRecorded'
    && event.payload?.outcome === 'party_incapacitated'))
  assert.equal(first.body.authoritative_state.mechanics.combat.active, false)
  assert.ok(first.body.mechanics.some((event) => event.event_type === 'DowntimeResolved' && event.payload?.reason === 'post_defeat_recovery'))
  assert.ok(first.body.authoritative_state.players.every((hero) => hero.hp > 0), JSON.stringify({
    players: first.body.authoritative_state.players,
    events: first.body.mechanics.map((event) => event.event_type),
  }))

  const room = await player.client.get('/api/rooms/' + CAMPAIGN)
  assert.equal(room.status, 200, room.text)
  assert.equal(room.body.state.mechanics.combat.active, false)
  assert.equal(room.body.state.mechanics.death.campaign_status, 'active')
  assert.ok(room.body.state.players.every((hero) => hero.hp > 0))
  assert.ok(room.body.state.battleLog?.length > 0)

  await server.restart()
  const afterRestart = await player.client.get('/api/rooms/' + CAMPAIGN)
  assert.equal(afterRestart.status, 200, afterRestart.text)
  assert.equal(afterRestart.body.state.mechanics.combat.active, false)
  assert.ok(afterRestart.body.state.players.every((hero) => hero.hp > 0))
})
