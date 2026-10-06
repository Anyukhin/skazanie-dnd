// Прогресс по сюжету (`docs/astohan-scenario.md`, разделы 4 и 11): кошель
// короля в Штормберге и уровни за пройденные линии (7 → 10).
import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId, scenarioLocationId, scenarioMilestoneLevel } from '../server/campaign-scenario.mjs'
import { experienceForLevel } from '../server/character-lifecycle.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { currencyToCopper } from '../server/merchant-economy.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { dice, fixedDice } from './kit/dice.mjs'

const heroes = [
  { id: 'path-hero', character: 'Мирт', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Солдат', level: 7, hp: 70, maxHp: 70, armor: 18, speed: 30 },
  { id: 'path-ally', character: 'Лиса', name: 'Игрок 2', role: 'Плут · ур. 7', species: 'Полурослик', background: 'Преступник', level: 7, hp: 50, maxHp: 50, armor: 15, speed: 25 },
]

async function campaign() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'PATH', worldTemplateId: 'astohan-plains', players: heroes }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = { isAdmin: true }, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `path-${run.step}-${index}`, ...command }))
    const result = resolveCommands(list, run.state, { diceService, context })
    run.state = normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `В ${locationId}`, destinationLocationId: locationId })
      run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
    }
    assert.equal(scenarioLocationId(run.state), locationId)
  }
  run.discover = (clueId) => {
    const secretId = scenarioClueFactId(campaignScenario(run.state), clueId)
    const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
    assert.ok(secret, `тайна ${clueId} записана`)
    return run.apply({ command_type: 'RecordWorldFact', fact: {
      id: `fact-found-${clueId}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
      summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
    } })
  }
  run.hero = (id = heroes[0].id) => run.state.players.find((player) => player.id === id)
  return run
}

test('кошель короля: «берём кошель короля» в Штормберге — d20 × 100 золотых, раз на героя', async () => {
  const run = await campaign()
  const intent = await new IntentParser().parse({ message: 'Берём кошель короля', playerId: heroes[0].id, visibleState: run.state })
  assert.equal(intent.intent, 'scenario_purse')
  const plan = await new Adjudicator().createPlan({ intent, state: run.state, retrievedRules: { results: [], confidence: 1 } })
  assert.deepEqual(plan.proposed_commands.map((command) => command.command_type), ['ReceiveScenarioPurse'])

  const before = currencyToCopper(run.hero().currency)
  const paid = run.apply(plan.proposed_commands, { allowedActorIds: [heroes[0].id] }, dice([15]))
  const granted = paid.events.find((event) => event.event_type === 'ScenarioPurseGranted')
  assert.equal(granted.payload.gold, 1_500)
  assert.equal(currencyToCopper(run.hero().currency) - before, 1_500 * 100)
  assert.throws(() => run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[0].id }, {}, dice([3])), { code: 'SCENARIO_PURSE_ALREADY_PAID' })
  run.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[1].id }, {}, dice([4]))
  assert.equal(currencyToCopper(run.hero(heroes[1].id).currency) >= 400 * 100, true, 'второму герою — свой бросок')

  await run.travel('astohan-ash-watch')
  const fresh = await campaign()
  await fresh.travel('astohan-ash-watch')
  assert.throws(() => fresh.apply({ command_type: 'ReceiveScenarioPurse', actor_id: heroes[0].id }, {}, dice([10])), { code: 'SCENARIO_PURSE_WRONG_PLACE' })
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.players.find((player) => player.id === heroes[0].id).currency, run.hero().currency)
})

test('уровни за линии: закрытая линия доводит опыт каждого героя до порога следующего уровня', async () => {
  const run = await campaign()
  assert.equal(scenarioMilestoneLevel(run.state), 7)
  await run.travel('astohan-forgotten-cliffs')
  const closed = run.discover('cliffs-chapel')
  assert.equal(scenarioMilestoneLevel(run.state), 8, 'линия Рыцаря закрыта')
  const awards = closed.events.filter((event) => event.event_type === 'ExperienceAwarded' && event.payload.reason === 'scenario-line')
  assert.equal(awards.length, heroes.length)
  for (const hero of heroes) assert.ok(run.hero(hero.id).experience >= experienceForLevel(8), hero.id)

  // Второй раз та же линия опыта не даёт: прироста уровня по сюжету нет.
  const again = run.discover('cliffs-frescoes')
  assert.equal(again.events.some((event) => event.event_type === 'ExperienceAwarded'), false)

  await run.travel('astohan-quiet-watch-camp')
  run.discover('camp-gedrik')
  await run.travel('astohan-mittlayd')
  const network = run.discover('mittlayd-informant')
  assert.equal(scenarioMilestoneLevel(run.state), 9, 'вторая линия — девятый уровень')
  assert.ok(network.events.some((event) => event.event_type === 'ExperienceAwarded'))
  for (const hero of heroes) assert.ok(run.hero(hero.id).experience >= experienceForLevel(9), hero.id)
  const replayed = replayEvents(run.initial, run.events)
  assert.equal(replayed.players.find((player) => player.id === heroes[0].id).experience, run.hero().experience)
})
