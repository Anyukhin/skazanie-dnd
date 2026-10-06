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

test('мастер создания кампании ставит Асстохану старт с 7-го уровня — нижнюю границу рекомендованных уровней мира', async () => {
  const { readFileSync } = await import('node:fs')
  const { listWorldTemplates } = await import('../server/world-template-catalog.mjs')
  const astohan = listWorldTemplates().find((template) => template.id === 'astohan-plains')
  assert.equal(String(astohan.recommendedLevels).match(/\d+/u)?.[0], String(campaignScenario({ campaignConcept: { world_template_id: 'astohan-plains' } })?.progression?.start_level ?? 7))
  const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
  assert.ok(views.includes("String(selectedWorldTemplate?.recommendedLevels ?? '').match(/\\d+/u)?.[0]"), 'мастер берёт нижнюю границу рекомендованных уровней')
})

test('королевская оружейная: «беру плащ защиты из оружейной» — одна вещь на героя, только в Штормберге и вне боя', async () => {
  const run = await campaign()
  const intent = await new IntentParser().parse({ message: 'Беру плащ защиты из королевской оружейной', playerId: heroes[0].id, visibleState: run.state })
  assert.equal(intent.intent, 'scenario_armory')
  assert.equal(intent.scenario_armory.catalog_id, 'srd_5_2_1:cloak-of-protection')
  const plan = await new Adjudicator().createPlan({ intent, state: run.state, retrievedRules: { results: [], confidence: 1 } })
  assert.deepEqual(plan.proposed_commands.map((command) => command.command_type), ['ChooseScenarioArmoryItem'])

  const taken = run.apply(plan.proposed_commands, { allowedActorIds: [heroes[0].id] })
  assert.deepEqual(taken.events.map((event) => event.event_type).filter((type) => type !== 'DieRolled'), ['ItemGranted', 'ScenarioArmoryItemChosen'])
  assert.ok(run.hero().inventory.some((item) => item.catalog_id === 'srd_5_2_1:cloak-of-protection'), 'плащ у героя')
  assert.throws(() => run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[0].id, catalog_id: 'srd_5_2_1:longsword-plus-1' }, {}), { code: 'SCENARIO_ARMORY_ALREADY_TAKEN' })
  // Только из списка сценария: редкое кольцо от огня оружейная не выдаёт.
  assert.throws(() => run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[1].id, catalog_id: 'srd_5_2_1:ring-of-fire-resistance' }, {}), { code: 'SCENARIO_ARMORY_ITEM_UNKNOWN' })
  run.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[1].id, catalog_id: 'srd_5_2_1:longsword-plus-1' }, {})
  assert.ok(run.hero(heroes[1].id).inventory.some((item) => item.catalog_id === 'srd_5_2_1:longsword-plus-1'))
  // Клиент не подменяет вещь: собранный сервером предмет из запроса отбрасывается.
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.scenario_attention.armory_taken, run.state.scenario_attention.armory_taken)
  assert.deepEqual(new Set(replayed.scenario_attention.armory_taken), new Set(heroes.map((hero) => hero.id)))

  const away = await campaign()
  await away.travel('astohan-ash-watch')
  assert.throws(() => away.apply({ command_type: 'ChooseScenarioArmoryItem', actor_id: heroes[0].id, catalog_id: 'srd_5_2_1:cloak-of-protection' }, {}), { code: 'SCENARIO_ARMORY_WRONG_PLACE' })
})

test('все вещи оружейной есть в каталоге и не редкие', async () => {
  const { catalogItem } = await import('../server/item-catalog.mjs')
  const run = await campaign()
  const ids = campaignScenario(run.state).progression.armory.catalog_ids
  assert.ok(ids.length >= 5)
  for (const id of ids) {
    const item = catalogItem(id)
    assert.ok(item, id)
    assert.equal(item.rarity, 'необычный', `${id}: стартовая вещь — необычная, огонь отряд зарабатывает по сюжету`)
  }
})
