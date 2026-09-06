import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { IntentParser, buildRuleQueries, resolvePresentSocialActors } from '../server/intent-parser.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

const state = normalizeCampaignState({ players: [
  { id: 'hero', character: 'Ада', hp: 10, maxHp: 10, proficiency: 2, abilities: { str: 16 }, inventory: [] },
  { id: 'goblin', character: 'Гоблин', hp: 7, maxHp: 7, armor: 13, abilities: { dex: 14 }, inventory: [] },
] })

test('Intent Parser возвращает только структурированное намерение и находит видимую цель', async () => {
  const intent = await new IntentParser().parse({ message: 'Атакую гоблина мечом', playerId: 'hero', visibleState: state })
  assert.equal(intent.intent, 'attack')
  assert.deepEqual(intent.targets, ['goblin'])
  assert.equal(intent.requires_clarification, false)
  assert.ok(buildRuleQueries(intent, state).some((query) => query.includes('armor class')))
})

test('Intent Parser узнаёт русское имя NPC в естественном падеже', async () => {
  const visibleState = {
    players: [{ id: 'hero', character: 'Ада' }],
    social: { npcs: [{ id: 'mira-guide', name: 'Мира Ветрокрыл', role: 'проводница' }] },
  }
  const intent = await new IntentParser().parse({
    message: 'Я убеждаю Миру Ветрокрыл рассказать всё, что она знает.',
    playerId: 'hero',
    visibleState,
  })
  assert.equal(intent.intent, 'social')
  assert.equal(intent.approach, 'persuasion')
  assert.deepEqual(intent.targets, ['mira-guide'])
  assert.equal(intent.requires_clarification, false)
})

test('Intent Parser узнаёт составное имя короля и его короткое имя в падеже', async () => {
  const visibleState = {
    players: [{ id: 'hero', character: 'Ада' }],
    scene: { location: 'Астраханские равнины' },
    social: { npcs: [{ id: 'ares', name: 'Король Арес', role: 'king', location: 'Астраханские равнины', available: true }] },
  }
  assert.deepEqual(
    resolvePresentSocialActors('Спрашиваю короля Ареса: что известно о молодом драконе?', visibleState).map((npc) => npc.id),
    ['ares'],
  )
  const parser = new IntentParser()
  for (const message of [
    'Спрашиваю короля Ареса: что известно о молодом драконе и куда нам идти сначала?',
    'Спрашиваю Аресу, куда идти?',
  ]) {
    const intent = await parser.parse({ message, playerId: 'hero', visibleState })
    assert.equal(intent.intent, 'social')
    assert.deepEqual(intent.targets, ['ares'])
    assert.equal(intent.requires_clarification, false)
  }
})

test('Adjudicator предлагает команду, но не меняет состояние', async () => {
  const intent = await new IntentParser().parse({ message: 'Атакую гоблина мечом', playerId: 'hero', visibleState: state })
  const before = structuredClone(state)
  const plan = await new Adjudicator().createPlan({ intent, state, retrievedRules: { results: [], confidence: 0.8 } })
  assert.equal(plan.proposed_commands[0].command_type, 'MakeAttack')
  assert.equal(plan.proposed_commands[0].target_id, 'goblin')
  assert.deepEqual(state, before)
})

test('неформализованное действие становится явным ruling, а не выдуманным правилом', async () => {
  const intent = await new IntentParser().parse({ message: 'Рассказываю статуе старую шутку', playerId: 'hero', visibleState: state })
  const plan = await new Adjudicator().createPlan({ intent, state, retrievedRules: { results: [], confidence: 0.1 } })
  assert.equal(plan.ruling_required, true)
  assert.equal(plan.proposed_commands.length, 0)
  assert.equal(plan.ruling_draft.scope, 'single_event')
})

test('завершение боя распознаётся отдельно от завершения хода', async () => {
  const intent = await new IntentParser().parse({ message: 'Завершаю бой: противник сдался', playerId: 'hero', visibleState: state })
  const plan = await new Adjudicator().createPlan({ intent, state, retrievedRules: { results: [], confidence: 0.8 } })
  assert.equal(intent.intent, 'end_combat')
  assert.equal(plan.proposed_commands[0].command_type, 'EndCombat')
})
