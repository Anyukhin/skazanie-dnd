import assert from 'node:assert/strict'
import test from 'node:test'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { validateWorldMemoryCommand, worldMemoryEvent, applyWorldMemoryEvent } from '../server/world-memory.mjs'
import { campaignStateForViewer, mechanicsForViewer, turnResultForViewer, turnExplanationForViewer } from '../server/viewer-projection.mjs'
import { normalizeQuestResponsibility } from '../server/quest-consequences.mjs'

test('невозможность поручения требует системных прав и сохранённой причины, часы не заполняются', async () => {
  const { state, kingId } = await palaceFixture()
  const quest = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'npc')
  const command = { command_type: 'InvalidateQuest', quest_id: quest.id, command_id: 'invalid-personal-quest' }
  assert.throws(() => validateWorldMemoryCommand(command, state), { code: 'WORLD_MEMORY_FORBIDDEN' })
  assert.throws(() => validateWorldMemoryCommand(command, state, { isDirector: true }), { code: 'WORLD_QUEST_INVALIDATION_UNPROVEN' })
  state.npc_world.vitals[kingId] = { hp: 0, max_hp: 150, alive: false }
  assert.throws(() => validateWorldMemoryCommand(command, state, { isDirector: true }), { code: 'WORLD_QUEST_INVALIDATION_UNPROVEN' })
  state.worldMemory.facts.push({ id: 'death-fact', subject_id: kingId, predicate: 'died', status: 'active', source_event_ids: ['confirmed-death'], visibility: 'party' })
  const event = worldMemoryEvent(validateWorldMemoryCommand(command, state, { isDirector: true }))
  assert.equal(event.event_type, 'QuestInvalidated')
  assert.deepEqual(event.payload.source_event_ids, ['confirmed-death'])
  const memory = applyWorldMemoryEvent(state.worldMemory, event)
  const closed = memory.quests.find((entry) => entry.id === quest.id)
  assert.equal(closed.status, 'failed')
  assert.deepEqual(closed.clock, quest.clock)
  assert.deepEqual(applyWorldMemoryEvent(memory, event), memory)
  assert.throws(() => validateWorldMemoryCommand(command, { ...state, worldMemory: memory }, { isDirector: true }), { code: 'WORLD_QUEST_INVALIDATION_UNPROVEN' })
})

test('техническое обновление не снимает зависимость, мёртвому NPC нельзя вернуть открытое поручение', async () => {
  const { state, kingId } = await palaceFixture()
  const source = state.worldMemory.quests.find((entry) => entry.responsibility?.type === 'npc')
  const quest = { id: source.id, title: 'Уточнённое поручение', summary: 'Тот же обязательный получатель', status: 'active' }
  const validated = validateWorldMemoryCommand({ command_type: 'UpsertQuest', quest }, state, { isDirector: true })
  assert.deepEqual(validated.quest.responsibility, source.responsibility)
  assert.equal(validated.quest.giver_npc_id, kingId)
  state.npc_world.vitals[kingId].alive = false
  for (const status of ['active', 'offered']) {
    assert.throws(() => validateWorldMemoryCommand({ command_type: 'UpsertQuest', quest: { ...quest, status } }, state, { isDirector: true }), { code: 'WORLD_QUEST_IMPOSSIBLE' })
  }
  assert.equal(normalizeQuestResponsibility({ type: 'npc', npc_id: kingId, death_policy: 'transfer' }), null)
  assert.throws(() => validateWorldMemoryCommand({ command_type: 'UpsertQuest', quest: { ...quest,
    responsibility: { type: 'office', office_id: 'unknown-office', death_policy: 'transfer' },
  } }, state, { isDirector: true }), { code: 'WORLD_QUEST_RESPONSIBILITY_INVALID' })
})

test('проекция должности и её события не раскрывает план преемства', async () => {
  const { state, heroId } = await palaceFixture()
  state.world_offices.offices.push({ ...structuredClone(state.world_offices.offices[0]), id: 'secret-office', visibility: 'gm_only' })
  const visible = campaignStateForViewer(state, { role: 'player' }, heroId)
  assert.equal(visible.world_offices.length, 1)
  assert.doesNotMatch(JSON.stringify(visible.world_offices), /successor|defender|pending|delay|secret-office/u)
  const events = mechanicsForViewer([{ event_type: 'OfficeVacated', visibility: 'party', payload: {
    schema_version: 1, office_id: state.world_offices.offices[0].id, title: 'Корона', holder_npc_id: null,
    due_at_minutes: 1440, succession_id: 'secret-plan', source_event_id: 'internal-death',
  } }], { role: 'player' }, heroId, state)
  assert.equal(events.length, 1)
  assert.doesNotMatch(JSON.stringify(events), /due_at_minutes|secret-plan|internal-death/u)
})

test('спасбросок социального NPC показывает исход, но не его приватный модификатор через события или броски', async () => {
  const { state, heroId, kingId } = await palaceFixture()
  const roll = { actor_id: kingId, purpose: 'npc_spell_save:fireball:dex', roll_id: 'private-npc-die',
    modifier: 5, kept: 8, dice: [8], expression: '1d20+5', total: 13, visibility: 'public' }
  const event = { event_type: 'NpcSavingThrowResolved', actor_id: heroId, target_ids: [kingId], visibility: 'party',
    payload: { ...roll, npc_id: kingId, saved: false, difficulty: 15 } }
  const result = turnResultForViewer({ mechanics: [event], rolls: [roll], authoritative_state: state }, { role: 'player' }, heroId)
  assert.deepEqual(result.rolls, [])
  assert.equal(result.mechanics[0].payload.saved, false)
  assert.equal(result.mechanics[0].payload.total, 13)
  assert.doesNotMatch(JSON.stringify(result.mechanics), /modifier|kept|dice|expression|private-npc-die/u)
  assert.deepEqual(turnExplanationForViewer({ rolls: [roll], events: [event] }, { role: 'player' }, heroId, state).rolls, [])
  assert.equal(turnResultForViewer({ rolls: [roll] }, { role: 'admin' }, heroId).rolls[0].modifier, 5)
})
