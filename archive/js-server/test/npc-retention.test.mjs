import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyNpcSocialEvent,
  normalizeNpcSocialState,
  normalizeNpcSocialStateLegacy,
  npcSocialForViewer,
} from '../server/npc-social.mjs'
import {
  applyNpcWorldEvent,
  normalizeNpcWorldState,
  normalizeNpcWorldStateLegacy,
} from '../server/npc-positioning.mjs'
import { withRetentionMode } from '../server/retention-context.mjs'

function socialConversation(index, npcId = 'npc:0') {
  return {
    id: `conversation:${index}`,
    npc_id: npcId,
    hero_id: 'hero:1',
    player_message: `Вопрос ${index}`,
    npc_reply: `Ответ ${index}`,
    stance: 'neutral',
    disclosed_fact_ids: [],
    disclosed_claim_ids: [],
    visibility: 'party',
  }
}

function socialPromise(id, sourceConversationId) {
  return {
    id,
    npc_id: 'npc:0',
    hero_id: 'hero:1',
    direction: 'npc_to_party',
    text: `Обещание ${id}`,
    due_hint: '',
    status: 'open',
    visibility: 'party',
    source_conversation_id: sourceConversationId,
  }
}

function dossierEntry(index) {
  return {
    id: `dossier:${index}`,
    hero_id: 'hero:1',
    summary: `Запись ${index}`,
    stance: 'neutral',
    visibility: 'party',
    disclosed_fact_ids: [],
    disclosed_claims: [],
    provenance: {
      source_kind: 'NpcConversationRecorded',
      source_conversation_id: `conversation:dossier:${index}`,
      source_event_ids: [`event:dossier:${index}`],
    },
  }
}

function mechanicsProfile(id) {
  return {
    profile_id: `profile:${id}`,
    status: 'partial',
    level: 1,
    challenge_rating: '1',
    xp: 25,
    encounter_difficulty: 'easy',
    hp: 4,
    armor: 10,
    speed: 30,
    initiative_bonus: 0,
    proficiency_bonus: 2,
    size: 'medium',
    creature_type: 'humanoid',
    abilities: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 },
    skills: {},
    saving_throws: {},
    traits: [],
    action_profiles: [{
      id: 'strike', name: 'Удар', kind: 'melee', attack_modifier: 2,
      damage_expression: '1d4', damage_type: 'bludgeoning', range_feet: 5,
    }],
    features: [{ id: 'feature', name: 'Черта', status: 'partial', description: 'Описание.' }],
    tactics: ['Держится рядом.'],
  }
}

function worldItem(index) {
  return {
    id: `item:${index}`,
    name: `Предмет ${index}`,
    type: 'other',
    quantity: 1,
  }
}

test('current social normalization retains accepted NPC, history, promise references and known facts', () => {
  const npcs = Array.from({ length: 501 }, (_, index) => ({
    id: `npc:${index}`,
    name: `NPC ${index}`,
    role: 'witness',
    location: 'Market',
    known_fact_ids: index === 500
      ? Array.from({ length: 101 }, (_, factIndex) => `fact:${factIndex}`)
      : [],
    dossier: index === 500 ? Array.from({ length: 13 }, (_, dossierIndex) => dossierEntry(dossierIndex)) : [],
    visibility: 'party',
  }))
  const conversations = Array.from({ length: 501 }, (_, index) => socialConversation(index))
  const input = {
    npcs,
    relationships: Object.fromEntries(npcs.map((npc) => [npc.id, { 'hero:1': 1 }])),
    conversations,
    promises: [
      socialPromise('promise:first', 'conversation:0'),
      socialPromise('promise:last', 'conversation:500'),
    ],
  }

  const normalized = normalizeNpcSocialState(input)
  assert.equal(normalized.npcs.length, 501)
  assert.equal(normalized.npcs.at(-1).id, 'npc:500')
  assert.equal(normalized.npcs.at(-1).known_fact_ids.length, 101)
  assert.equal(normalized.npcs.at(-1).dossier.length, 13)
  assert.equal(normalized.conversations.length, 501)
  assert.deepEqual(normalized.promises.map((promise) => promise.id), ['promise:first', 'promise:last'])
  assert.equal(npcSocialForViewer(normalized, { playerId: 'hero:1', isPartyMember: true }).npcs.at(-1).dossier.length, 12)
  assert.deepEqual(normalizeNpcSocialState(normalized), normalized)
})

test('adding social events does not evict accepted conversations, dossiers or known facts', () => {
  let social = normalizeNpcSocialState({ npcs: [{ id: 'npc:0', name: 'NPC', location: 'Market' }] })
  for (let index = 0; index < 13; index += 1) {
    social = applyNpcSocialEvent(social, {
      event_type: 'NpcConversationRecorded',
      event_id: `event:conversation:${index}`,
      payload: { conversation: socialConversation(`added:${index}`) },
    })
  }
  social = applyNpcSocialEvent(social, {
    event_type: 'NpcSocialProfileUpserted',
    payload: {
      npc: {
        id: 'npc:0',
        name: 'NPC',
        location: 'Market',
        known_fact_ids: Array.from({ length: 101 }, (_, index) => `fact:${index}`),
      },
    },
  })
  assert.equal(social.conversations.length, 13)
  assert.equal(social.npcs[0].dossier.length, 13)
  assert.equal(social.npcs[0].known_fact_ids.length, 101)
})

test('current world normalization retains the 501st NPC and accepted inventory beyond the transfer capacity', () => {
  const npcIds = Array.from({ length: 501 }, (_, index) => `npc:${index}`)
  const world = normalizeNpcWorldState({
    placements: Array.from({ length: 5_001 }, (_, index) => ({
      npc_id: `placement-npc:${index}`,
      location_id: `location:${index}`,
      x: 0,
      y: 0,
    })),
    vitals: Object.fromEntries(npcIds.map((id, index) => [id, { hp: index === 500 ? 0 : 4, max_hp: 4, alive: index !== 500 }])),
    stances: Object.fromEntries(npcIds.map((id, index) => [id, { stance: index === 500 ? 'dead' : 'neutral' }])),
    inventories: Object.fromEntries(npcIds.map((id, index) => [id, index === 500 ? Array.from({ length: 101 }, (_, itemIndex) => worldItem(itemIndex)) : [worldItem(index)]])),
    profiles: Object.fromEntries(npcIds.map((id, index) => [id, mechanicsProfile(index)])),
  })

  assert.equal(Object.keys(world.vitals).length, 501)
  assert.equal(world.vitals['npc:500'].alive, false)
  assert.equal(world.stances['npc:500'].stance, 'dead')
  assert.equal(Object.keys(world.inventories).length, 501)
  assert.equal(world.inventories['npc:500'].length, 101)
  assert.equal(Object.keys(world.profiles).length, 501)
  assert.equal(world.placements.length, 5_001)
  assert.deepEqual(normalizeNpcWorldState(world), world)
})

test('adding world events retains accepted state after the old owner and placement limits', () => {
  let world = normalizeNpcWorldState({})
  for (let index = 0; index < 501; index += 1) {
    world = applyNpcWorldEvent(world, {
      event_type: 'NpcPlaced',
      event_id: `event:place:${index}`,
      payload: {
        npc_id: `npc:${index}`,
        location_id: 'market',
        x: index,
        y: 0,
        vitality: { hp: 4, max_hp: 4, alive: true },
      },
    })
  }
  assert.equal(world.placements.length, 501)
  assert.equal(Object.keys(world.vitals).length, 501)
  assert.equal(world.vitals['npc:500'].hp, 4)
})

test('legacy retention hooks preserve the previous bounded reducer semantics', () => {
  const npcs = Array.from({ length: 501 }, (_, index) => ({
    id: `npc:${index}`,
    name: `NPC ${index}`,
    known_fact_ids: index === 0 ? Array.from({ length: 101 }, (_, factIndex) => `fact:${factIndex}`) : [],
    dossier: index === 0 ? Array.from({ length: 13 }, (_, dossierIndex) => dossierEntry(dossierIndex)) : [],
  }))
  const source = {
    npcs,
    conversations: Array.from({ length: 501 }, (_, index) => socialConversation(index)),
    promises: [socialPromise('promise:first', 'conversation:0'), socialPromise('promise:last', 'conversation:500')],
  }
  const legacySocial = normalizeNpcSocialStateLegacy(source)
  assert.deepEqual(withRetentionMode('legacy', () => normalizeNpcSocialState(source)), legacySocial)
  assert.equal(legacySocial.npcs.length, 500)
  assert.equal(legacySocial.npcs[0].known_fact_ids.length, 100)
  assert.equal(legacySocial.npcs[0].dossier.length, 12)
  assert.equal(legacySocial.conversations.length, 500)
  assert.deepEqual(legacySocial.promises.map((promise) => promise.id), ['promise:last'])
  assert.deepEqual(normalizeNpcSocialStateLegacy(legacySocial), legacySocial)

  const worldSource = {
    placements: Array.from({ length: 5_001 }, (_, index) => ({ npc_id: `npc:${index}`, location_id: `location:${index}`, x: 0, y: 0 })),
    vitals: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`npc:${index}`, { hp: 4, max_hp: 4, alive: true }])),
    inventories: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`npc:${index}`, [worldItem(index)]])),
  }
  const legacyWorld = normalizeNpcWorldStateLegacy(worldSource)
  assert.deepEqual(withRetentionMode('legacy', () => normalizeNpcWorldState(worldSource)), legacyWorld)
  assert.equal(legacyWorld.placements.length, 5_000)
  assert.equal(Object.keys(legacyWorld.vitals).length, 500)
  assert.equal(Object.keys(legacyWorld.inventories).length, 500)
  assert.deepEqual(normalizeNpcWorldStateLegacy(legacyWorld), legacyWorld)
})
