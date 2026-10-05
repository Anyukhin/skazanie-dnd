import assert from 'node:assert/strict'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { dice } from './kit/dice.mjs'
import { createCampaign, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { resolveCommands } from '../server/rules-engine.mjs'

const SESSION = 'NPC-CONSEQUENCE-API'

test('HTTP огненный шар обычного игрока сохраняет смерть, задачу и вакансию без LLM; повтор и restart не расходуют вторую ячейку', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-npc-consequence-api-' })
  const { client: admin } = await setupAdmin(server, { name: 'Ведущий', email: 'gm@npc-consequence.test', password: 'npc-consequence-password' })
  const { client: owner } = await registerUser(server, { name: 'Игрок', email: 'owner@npc-consequence.test', password: 'npc-consequence-password' })
  const { client: outsider } = await registerUser(server, { name: 'Чужой', email: 'foreign@npc-consequence.test', password: 'npc-consequence-password' })
  const fixture = await palaceFixture({ kingHp: 1, witnesses: false })
  // Сценарий начинается в инициативе; атака и её урон ещё не исполнялись.
  const initial = resolveCommands([{ command_type: 'AttackNpc', command_id: 'palace-initiative', actor_id: fixture.heroId, npc_id: fixture.kingId }], fixture.state, {
    diceService: dice([20, 1]), context: { allowedActorIds: [fixture.heroId] },
  }).state
  initial.sessionCode = SESSION
  const users = await admin.get('/api/admin/users')
  const ownerId = users.body.users.find((user) => user.email === 'owner@npc-consequence.test').id
  const assigned = await admin.patch(`/api/admin/users/${ownerId}`, { heroIds: [fixture.heroId] })
  assert.equal(assigned.status, 200, assigned.text)
  await createCampaign(admin, { code: SESSION, name: 'Дворец после нападения', state: initial })
  const key = 'palace-fireball'
  const command = { command_type: 'CastSpell', actor_id: fixture.heroId, spell_id: 'fireball', to: fixture.kingPoint }
  const cast = (client, idempotencyKey = key) => client.post(`/api/campaigns/${SESSION}/commands`, { idempotency_key: idempotencyKey, command }, { idempotencyKey })
  const denied = await cast(outsider, 'foreign-fireball')
  assert.equal(denied.status, 403, denied.text)
  const first = await cast(owner)
  assert.equal(first.status, 200, first.text)
  const types = first.body.mechanics.map((event) => event.event_type)
  for (const type of ['SpellCast', 'ResourceSpent', 'DamageApplied', 'NpcDied', 'QuestInvalidated', 'OfficeVacated', 'CampaignStoryCompleted']) assert.ok(types.includes(type), type)
  assert.equal(types.filter((type) => type === 'NpcDied').length, 1)
  const result = first.body.authoritative_state
  const questId = fixture.state.campaignConcept.story_quest_id
  const initialQuest = fixture.state.worldMemory.quests.find((quest) => quest.id === questId)
  const failed = result.worldMemory.quests.find((quest) => quest.id === questId)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.clock, initialQuest.clock)
  assert.equal(result.campaignConcept.story_history.length, 1)
  assert.equal(result.campaignConcept.story_history[0].outcome, 'failure')
  assert.equal(result.world_offices[0].holder_npc_id, null)
  assert.equal(result.social.npcs.find((npc) => npc.id === fixture.kingId).available, false)
  assert.equal(result.npc_world, undefined)
  assert.doesNotMatch(JSON.stringify(result.world_offices), /successor|defender_npc_ids|due_at_minutes|pending/u)
  assert.doesNotMatch(JSON.stringify(first.body.mechanics.filter((event) => event.event_type.startsWith('Office'))), /due_at_minutes|candidate_dead/u)
  const slots = result.mechanics.resources[fixture.heroId].spell_slots_3.current
  assert.equal(slots, initial.mechanics.resources[fixture.heroId].spell_slots_3.current - 1)
  const repeated = await cast(owner)
  assert.equal(repeated.status, 200, repeated.text)
  assert.equal(repeated.body.idempotent_replay, true)
  assert.equal(repeated.body.authoritative_state.mechanics.resources[fixture.heroId].spell_slots_3.current, slots)
  assert.equal(repeated.body.authoritative_state.campaignConcept.story_history.length, 1)
  const rejectedDialogue = await owner.post('/api/narrate', {
    campaign_id: SESSION, actor_id: fixture.heroId, npc_id: fixture.kingId, action: 'Обращаюсь к королю', request_kind: 'action', idempotency_key: 'dead-king-dialogue',
  })
  assert.ok(rejectedDialogue.status >= 400, rejectedDialogue.text)
  assert.equal(rejectedDialogue.body.code, 'NPC_UNAVAILABLE', rejectedDialogue.text)
  await server.restart()
  const restored = await owner.get(`/api/rooms/${SESSION}`)
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.body.state.social.npcs.find((npc) => npc.id === fixture.kingId).available, false)
  assert.deepEqual(restored.body.state.world_offices, result.world_offices)
  assert.deepEqual(restored.body.state.campaignConcept.story_history, result.campaignConcept.story_history)
  const retryAfterRestart = await cast(owner)
  assert.equal(retryAfterRestart.status, 200, retryAfterRestart.text)
  assert.equal(retryAfterRestart.body.idempotent_replay, true)
  assert.equal(retryAfterRestart.body.authoritative_state.mechanics.resources[fixture.heroId].spell_slots_3.current, slots)
})
