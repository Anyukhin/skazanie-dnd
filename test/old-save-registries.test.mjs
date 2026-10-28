// Старые сохранения: мусор в реестрах кампании не роняет загрузку
// (docs/rust-port-js-findings.md, P1 «кампания не загружается», `law-and-order`,
// `npc-social`). Rust (sk-social, sk-memory, sk-world-*, sk-society) читает те
// же входы так же — закреплено эталонами крейтов.
import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignRulesetCanChange } from '../server/campaign-ruleset.mjs'
import { applyCaptiveEvent, normalizeCaptivesState } from '../server/captives.mjs'
import { courierLetterChronicleEntry, normalizeCourierLetterState } from '../server/courier-letters.mjs'
import { applyLawEvent } from '../server/law-and-order.mjs'
import {
  applyNpcSocialEvent, ensureNpcSocialState, normalizeNpcSocialState, promiseDueOffsetMinutes,
} from '../server/npc-social.mjs'
import { applyOffscreenWorldEvent, normalizeOffscreenWorldState } from '../server/offscreen-world.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { normalizeWorldDeedsState, rumorReputationDelta, rumorWording } from '../server/world-deeds.mjs'
import { createCampaignWorldMap, ensureCampaignWorldMap, reconcileWorldMap, worldLocationById } from '../server/world-map.mjs'
import { normalizeWorldMemory } from '../server/world-memory.mjs'

const npc = (id, name) => ({ id, name, role: 'житель', location: 'Площадь' })
const conversation = (id, npcId) => ({ id, npc_id: npcId, hero_id: 'hero-1', player_message: 'Здравствуй', npc_reply: 'И тебе.' })
const promise = (id, npcId) => ({ id, npc_id: npcId, hero_id: 'hero-1', text: 'Принесу карту', status: 'open' })

test('null в коллекциях социального состояния читается как пустая запись', () => {
  const social = normalizeNpcSocialState({
    npcs: [null, npc('npc-1', 'Марта')],
    conversations: [null, conversation('talk-1', 'npc-1')],
    promises: [null, promise('promise-1', 'npc-1')],
    relationships: { 'npc-1': { 'hero-1': 30 } },
  })
  assert.deepEqual(social.npcs.map((entry) => entry.id), ['npc-1'])
  assert.deepEqual(social.conversations.map((entry) => entry.id), ['talk-1'])
  assert.deepEqual(social.promises.map((entry) => entry.id), ['promise-1'])
  const ensured = ensureNpcSocialState({ npcs: [null] }, {
    merchants: [null, { id: 'merchant-1', name: 'Борин' }],
    worldMemory: { entities: [null, { id: 'npc-2', kind: 'npc', name: 'Орин' }] },
  })
  assert.deepEqual(ensured.npcs.map((entry) => entry.id), ['merchant-1', 'npc-2'])
  assert.doesNotThrow(() => ensureNpcSocialState({}, null))
  assert.doesNotThrow(() => ensureNpcSocialState({}, { merchants: 'shop', worldMemory: { entities: {} } }))
})

test('первая нормализация хранит память о торговце и NPC памяти мира без своего профиля', () => {
  const state = {
    merchants: [{ id: 'merchant-1', name: 'Борин', location: 'Рынок' }],
    worldMemory: { entities: [{ id: 'npc-2', kind: 'npc', name: 'Орин', visibility: 'party' }] },
  }
  const social = ensureNpcSocialState({
    npcs: [],
    conversations: [conversation('talk-1', 'merchant-1'), conversation('talk-2', 'npc-2')],
    promises: [{ ...promise('promise-1', 'merchant-1'), source_conversation_id: 'talk-1' }],
    relationships: { 'merchant-1': { 'hero-1': 25 }, 'npc-2': { 'hero-1': -30 } },
  }, state)
  assert.deepEqual(social.conversations.map((entry) => entry.id), ['talk-1', 'talk-2'])
  assert.deepEqual(social.promises.map((entry) => entry.id), ['promise-1'])
  assert.deepEqual(social.relationships, { 'merchant-1': { 'hero-1': 25 }, 'npc-2': { 'hero-1': -30 } })
  assert.deepEqual(social.relationship_tiers, { 'merchant-1': { 'hero-1': 'friendly' }, 'npc-2': { 'hero-1': 'unfriendly' } })
  // Нормализованное состояние нормализацией не меняется.
  assert.deepEqual(ensureNpcSocialState(social, state), social)
})

test('NpcRelationshipAdjusted двигает ступень вместе со счётом и не пишет отношение без NPC или героя', () => {
  const input = normalizeNpcSocialState({ npcs: [npc('npc-1', 'Марта')], relationships: { 'npc-1': { 'hero-1': 15 } } })
  const adjusted = applyNpcSocialEvent(input, { event_type: 'NpcRelationshipAdjusted', payload: { npc_id: 'npc-1', hero_id: 'hero-1', delta: 10 } })
  assert.equal(adjusted.relationships['npc-1']['hero-1'], 25)
  assert.equal(adjusted.relationship_tiers['npc-1']['hero-1'], 'friendly')
  const first = applyNpcSocialEvent(input, { event_type: 'NpcRelationshipAdjusted', payload: { npc_id: 'npc-1', hero_id: 'hero-2', delta: -25 } })
  assert.deepEqual(first.relationship_tiers['npc-1'], { 'hero-1': 'neutral', 'hero-2': 'unfriendly' })
  for (const payload of [{ npc_id: 'npc-unknown', hero_id: 'hero-1', delta: 5 }, { npc_id: 'npc-1', hero_id: '', delta: 5 }, { npc_id: '', hero_id: 'hero-1', delta: 5 }]) {
    const result = applyNpcSocialEvent(input, { event_type: 'NpcRelationshipAdjusted', payload })
    assert.deepEqual(result.relationships, { 'npc-1': { 'hero-1': 15 } }, JSON.stringify(payload))
    assert.deepEqual(result.relationship_tiers, { 'npc-1': { 'hero-1': 'neutral' } }, JSON.stringify(payload))
  }
  // Герой с id ключа прототипа начинает с нуля, а не с функции.
  const proto = applyNpcSocialEvent(input, { event_type: 'NpcRelationshipAdjusted', payload: { npc_id: 'npc-1', hero_id: 'constructor', delta: 5 } })
  assert.equal(proto.relationships['npc-1'].constructor, 5)
})

test('«нескоро» срока обещания не задаёт, «скоро» — четыре часа', () => {
  assert.equal(promiseDueOffsetMinutes('нескоро'), null)
  assert.equal(promiseDueOffsetMinutes('Нескоро, как получится'), null)
  assert.equal(promiseDueOffsetMinutes('скоро'), 240)
  assert.equal(promiseDueOffsetMinutes('очень скоро'), 240)
  assert.equal(promiseDueOffsetMinutes('soon'), 240)
})

test('null в памяти мира и clock: null у задания — пустые записи и часы по умолчанию', () => {
  const memory = normalizeWorldMemory({
    entities: [null, { id: 'npc-1', kind: 'npc', name: 'Марта' }],
    facts: [null], relationships: [null], threads: [null, { id: 'thread-1', title: 'Нить', clock: null }],
    epistemic_claims: [null], summaries: [null], knowledge_ledger: [null],
    quests: [null, { id: 'quest-1', title: 'Карта', clock: null }],
  })
  assert.equal(memory.entities.length, 2)
  assert.equal(memory.entities[0].id, '')
  const quest = memory.quests.find((entry) => entry.id === 'quest-1')
  assert.deepEqual(quest.clock, { current: 0, max: 4, label: '', triggered: false })
  assert.deepEqual(memory.threads.find((entry) => entry.id === 'thread-1').clock, { current: 0, max: 4, label: '', triggered: false })
})

test('null в шагах мира, пленных, письмах и летописи отбрасывается', () => {
  const entry = { kind: 'quest_clock', summary: 'Время идёт', quest_id: 'quest-1' }
  const offscreen = normalizeOffscreenWorldState({ steps: [null, { id: 'step-1', entries: [null, entry] }], watch: [null] })
  assert.deepEqual(offscreen.steps.map((step) => step.id), ['step-1'])
  assert.equal(offscreen.steps[0].entries.length, 1)
  const raw = { schema_version: offscreen.schema_version, steps: [null], watch: [] }
  const applied = applyOffscreenWorldEvent(raw, { event_type: 'OffscreenWorldStepResolved', payload: { step: { id: 'step-2', entries: [entry] } } })
  assert.deepEqual(applied.steps.map((step) => step.id), ['step-2'])

  assert.deepEqual(normalizeCaptivesState({ captives: [null, { id: 'captive-1', npc_id: 'npc-1' }] }).captives.map((captive) => captive.id), ['captive-1'])
  assert.doesNotThrow(() => applyCaptiveEvent({ captives: [null] }, { event_type: 'CaptiveFed', payload: { captive_id: 'captive-1' } }))

  assert.deepEqual(normalizeCourierLetterState({ letters: [null, { id: 'letter-1', hero_id: 'hero-1', addressee_id: 'npc-1' }] }).letters.map((letter) => letter.id), ['letter-1'])
  assert.equal(courierLetterChronicleEntry({ event_type: 'CourierLetterSent', payload: { letter: null, letter_id: 'letter-1' } }), null)

  const deeds = normalizeWorldDeedsState({ deeds: [null, { id: 'deed-1', kind: 'theft' }, { id: 'deed-2', kind: 'constructor' }] })
  assert.deepEqual(deeds.deeds.map((deed) => deed.id), ['deed-1'])
  assert.equal(rumorWording({ kind: 'theft', actor_names: 'Марта' }, 0).includes('чужаки'), true)
  assert.equal(rumorReputationDelta({ kind: 'theft', severity: 'constructor' }, 0), -2)
})

test('кампания старого сохранения с null во всех реестрах загружается', () => {
  const state = normalizeCampaignState({
    players: [], enemies: [],
    merchants: [null],
    social: { npcs: [null], conversations: [null], promises: [null] },
    worldMemory: { entities: [null], quests: [{ id: 'quest-1', title: 'Карта', clock: null }] },
    offscreen_world: { schema_version: 1, steps: [null] },
    captives: { schema_version: 1, captives: [null] },
    courier_letters: { schema_version: 1, letters: [null] },
    world_deeds: { schema_version: 1, deeds: [null] },
  })
  assert.equal(state.social.npcs.every((entry) => entry && entry.id && entry.name), true)
  assert.deepEqual(state.captives.captives, [])
  assert.deepEqual(state.courier_letters.letters, [])
  assert.deepEqual(state.world_deeds.deeds, [])
  assert.deepEqual(state.offscreen_world.steps, [])
  assert.equal(state.worldMemory.quests.find((quest) => quest.id === 'quest-1').clock.max, 4)
})

test('applyLawEvent нормализует сохранение и с верной версией: escape_attempts "2" после побега — 3', () => {
  const law = {
    schema_version: 1,
    crimes: [],
    encounter: { id: 'guard-1', region_id: 'region-1', escape_attempts: '2' },
  }
  const after = applyLawEvent(law, { event_type: 'GuardEncounterResolved', payload: { resolution: 'flee', success: false } })
  assert.equal(after.encounter.escape_attempts, 3)
  const dirty = { schema_version: 1, crimes: [null, { id: 'crime-1', kind: 'theft', region_id: 'region-1', points: '2' }], cleared: {}, encounter: null }
  const cleaned = applyLawEvent(dirty, { event_type: 'Unrelated' })
  assert.deepEqual(cleaned.crimes.map((crime) => [crime.id, crime.points]), [['crime-1', 2]])
  // Чистое состояние нормализация не меняет.
  assert.deepEqual(applyLawEvent(cleaned, { event_type: 'Unrelated' }), cleaned)
})

test('null в журнале не скрывает событие после него, причина без undefined', () => {
  const locked = campaignRulesetCanChange([null, { event_type: 'CharacterImported' }])
  assert.deepEqual(locked, { allowed: false, reason: 'Редакция зафиксирована событием CharacterImported', blocking_event_type: 'CharacterImported' })
  assert.equal(campaignRulesetCanChange([null]).allowed, true)
  const untyped = campaignRulesetCanChange([{ id: 'e1' }])
  assert.equal(untyped.allowed, false)
  assert.doesNotMatch(untyped.reason, /undefined/u)
})

test('карта мира старого сохранения: null вместо концепта, карты, сцены и мест', () => {
  const plain = createCampaignWorldMap({ seed: 's' })
  assert.deepEqual(createCampaignWorldMap({ seed: 's', concept: null, source: null }), plain)
  for (const knownLocations of [null, 'ab', 5]) {
    assert.doesNotThrow(() => reconcileWorldMap(null, { seed: 's', knownLocations, scene: null, concept: null, currentLocation: 'Норвин' }), String(knownLocations))
  }
  const state = { sessionCode: 'OLD', campaignConcept: null, scene: null, adventure: { history: [{ location: 'Норвин' }] } }
  assert.ok(ensureCampaignWorldMap(state).locations.some((location) => location.name === 'Норвин'))
  assert.equal(worldLocationById({ locations: [null, 5, { id: 'port', name: 'Порт' }] }, 'port')?.name, 'Порт')
})
