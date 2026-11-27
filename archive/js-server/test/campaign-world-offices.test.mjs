import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'

const hero = {
  id: 'office-hero',
  character: 'Испытатель',
  name: 'Игрок',
  role: 'Воин · ур. 8',
  species: 'Человек',
  background: 'Странник',
  level: 8,
  hp: 72,
  maxHp: 72,
  armor: 18,
  speed: 30,
}

test('авторский world_rules проверяет ссылки и не попадает в публичный concept', async () => {
  const template = getWorldTemplate('astohan-plains')
  const rules = template.opening.world_rules
  const npcIds = new Set(template.opening.npcs.map((npc) => npc.id))
  const factionIds = new Set(template.factions.map((faction) => faction.id))

  assert.equal(rules.schema_version, 1)
  for (const office of rules.offices) {
    assert.ok(factionIds.has(office.faction_id), office.faction_id)
    assert.ok(npcIds.has(office.holder_npc_id), office.holder_npc_id)
    assert.ok(office.defender_npc_ids.every((npcId) => npcIds.has(npcId)))
    assert.ok(npcIds.has(office.successor.npc_id), office.successor.npc_id)
    assert.ok(Number.isSafeInteger(office.successor.delay_minutes) && office.successor.delay_minutes > 0)
  }
  assert.ok(npcIds.has(rules.starter_responsibility.npc_id))
  assert.equal(rules.offered_quests.length, 1)
  assert.equal(rules.offered_quests[0].status, 'offered')

  const state = await new CampaignBootstrapper().create({
    code: 'OFFICE-BOOTSTRAP',
    worldTemplateId: template.id,
    players: [hero],
  })
  const office = state.world_offices?.offices?.find((entry) => entry.id === 'office:astohan-crown')
  assert.ok(office)
  assert.deepEqual(office, {
    id: 'office:astohan-crown',
    title: 'Корона Валедора',
    faction_id: 'faction-astohan-plains-astohan-crown',
    holder_npc_id: 'astohan-ares',
    visibility: 'party',
    successor: {
      npc_id: 'astohan-ivara',
      delay_minutes: 1_440,
      required_tags: ['marshal'],
    },
    defender_npc_ids: ['astohan-ivara', 'astohan-oren'],
    status: 'held',
    pending: null,
    succession_history: [],
  })

  const conceptText = JSON.stringify(state.campaignConcept)
  assert.equal(Object.hasOwn(state.campaignConcept, 'world_offices'), false)
  assert.equal(Object.hasOwn(state.campaignConcept, 'world_rules'), false)
  assert.doesNotMatch(conceptText, /astohan-(?:ares|ivara|oren)/u)

  const starterQuest = state.worldMemory.quests.find((quest) => quest.responsibility?.type === 'npc')
  assert.deepEqual(starterQuest.responsibility, {
    schema_version: 1,
    type: 'npc',
    npc_id: 'astohan-ares',
    death_policy: 'impossible',
  })
  const offeredQuest = state.worldMemory.quests.find((quest) => quest.id === 'quest:astohan-crown-report')
  assert.ok(offeredQuest)
  assert.equal(offeredQuest.title, 'Вернуть донесение короне')
  assert.equal(offeredQuest.status, 'offered')
  assert.equal(offeredQuest.giver_npc_id, 'astohan-ares')
  assert.deepEqual(offeredQuest.responsibility, {
    schema_version: 1,
    type: 'office',
    office_id: 'office:astohan-crown',
    death_policy: 'transfer',
  })
  assert.equal(state.worldMemory.quests.filter((quest) => quest.status === 'active').length, 2)
})
