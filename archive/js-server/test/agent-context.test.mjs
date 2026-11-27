import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignConceptForAgent } from '../server/agent-context.mjs'
import { PLAYER_REQUEST_ROLES, answerKnownLore } from '../server/player-request-router.mjs'

test('shared campaign premise is bounded for every creative role and excludes unrelated private state', () => {
  const state = {
    campaignConcept: {
      preset: 'Frontier',
      tone: 'Hopeful mystery',
      premise: 'A vanished road returns each new moon.',
      boundaries: 'No sexual violence; fade to black.',
      themes: 'memory, duty',
      private_solution: 'The road is a dragon.',
    },
    secretGmNotes: 'Never expose this.',
  }
  const premise = campaignConceptForAgent(state)
  for (const role of Object.values(PLAYER_REQUEST_ROLES)) {
    assert.equal(premise.premise, 'A vanished road returns each new moon.', role.id)
    assert.equal(premise.tone, 'Hopeful mystery', role.id)
    assert.equal(premise.boundaries, 'No sexual violence; fade to black.', role.id)
  }
  assert.equal(Object.hasOwn(premise, 'private_solution'), false)
  assert.doesNotMatch(JSON.stringify(premise), /Never expose this/u)
})

test('deterministic Worldkeeper receives the same premise contract without treating it as a canonical fact', () => {
  const result = answerKnownLore('Что я знаю об этом месте?', {
    campaignConcept: { premise: 'A lost road.', tone: 'mystery', boundaries: 'PG-13' },
    worldMemory: { entities: [], facts: [], quests: [], knowledge: {} },
    partyMemberIds: ['hero'],
    adventure: {},
    scene: {},
  }, { viewer: { playerId: 'hero', isPartyMember: true } })

  assert.equal(result.agent_context.campaign_premise.premise, 'A lost road.')
  assert.equal(result.agent_context.campaign_premise.tone, 'mystery')
  assert.equal(result.agent_context.campaign_premise.boundaries, 'PG-13')
  assert.doesNotMatch(result.narration, /A lost road/u)
})

test('shared campaign premise передаёт только три последних эпилога арок в bounded-форме', () => {
  const state = {
    adventure: { chapter: 1 },
    campaignConcept: {
      arc: { arc_number: 5 },
      arc_history: Array.from({ length: 4 }, (_, index) => ({
        arc_number: index + 1,
        title: `Арка ${index + 1}`,
        epilogue: `${'Итог '.repeat(300)}${index + 1}`,
        private_solution: 'не передавать',
      })),
    },
  }
  const premise = campaignConceptForAgent(state)
  assert.equal(premise.current_arc_number, 5)
  assert.equal(premise.current_chapter, 1)
  assert.deepEqual(premise.arc_history.map((entry) => entry.arc_number), [2, 3, 4])
  assert.ok(premise.arc_history.every((entry) => entry.epilogue.length <= 1_200))
  assert.doesNotMatch(JSON.stringify(premise), /private_solution/u)
})

test('shared campaign premise передаёт bounded-историю и публичные опоры авторского мира', () => {
  const state = {
    campaignConcept: {
      world_template_id: 'league-nine-tides',
      world_template_version: '1.0.0',
      worldSummary: 'Лига островов живёт по картам прилива.',
      worldHistory: `${'Старая дамба помнит бурю. '.repeat(200)}конец`,
      factions: [{ id: 'dam-keepers', name: 'Смотрители дамб', summary: 'Чинят берег и хранят правду.', goal: 'Не дать морю забрать города.', private_solution: 'не передавать' }],
      story_arcs: [{ title: 'Город под водой', levels: '1–4', summary: 'Экспедиция в затонувшие кварталы.', stakes: 'Будущее побережья.', private_solution: 'не передавать' }],
      private_solution: 'не передавать',
    },
  }

  const premise = campaignConceptForAgent(state)
  assert.equal(premise.world_template_id, 'league-nine-tides')
  assert.equal(premise.world_template_version, '1.0.0')
  assert.equal(premise.world_summary, 'Лига островов живёт по картам прилива.')
  assert.equal(premise.world_history.length, 3_000)
  assert.equal(premise.factions[0].name, 'Смотрители дамб')
  assert.equal(premise.story_arcs[0].title, 'Город под водой')
  assert.doesNotMatch(JSON.stringify(premise), /private_solution/u)
})
