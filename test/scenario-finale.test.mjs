// Развязки финала как механика (`docs/astohan-scenario.md`, раздел 9):
// «Изгнать» — мораль Саргата на трети хитов, сломленный он улетает; «Договор» —
// только при раскрытой правде, Убеждение СЛ 20, до боя или когда дракон ранен.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId, scenarioEncounterEndReason, scenarioEnding, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { freezeEncounterOutcomePlan } from '../server/encounter-rewards.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { NpcMoraleAgent, commandsForMoraleDecision, isMoraleMoment } from '../server/npc-controller.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { fixedDice, maxDice, minDice } from './kit/dice.mjs'

const SARGAT = 'astohan-sargat'
const hero = {
  id: 'finale-hero', character: 'Рейна', name: 'Игрок', role: 'Бард · ур. 9', species: 'Человек', background: 'Странница',
  level: 9, hp: 70, maxHp: 70, armor: 16, speed: 30,
}

async function campaign() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'FINALE', worldTemplateId: 'astohan-plains', players: [hero] }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = { isAdmin: true }, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `finale-${run.step}-${index}`, ...command }))
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
  /** Тайна сценария найдена тем же фактом `discovery`, что и удачный поиск. */
  run.discover = (clueId) => {
    const secretId = scenarioClueFactId(campaignScenario(run.state), clueId)
    const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
    assert.ok(secret, `тайна ${clueId} записана`)
    run.apply({ command_type: 'RecordWorldFact', fact: {
      id: `fact-found-${clueId}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
      summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
    } })
  }
  run.toLair = async () => {
    await run.travel('astohan-obsidian-pass')
    await run.travel('astohan-vulkanis-brazier')
  }
  run.fight = () => {
    run.apply({ command_type: 'CreateEncounter', npc_id: SARGAT, difficulty: 'deadly', seed: 'finale-fight' }, { isDirector: true })
    run.apply({ command_type: 'StartCombat', server_authoritative: true }, { isDirector: true })
  }
  /** Ранить дракона до доли хитов: подготовка сцены, а не проверяемое правило. */
  run.woundSargat = (ratio) => {
    const state = structuredClone(run.state)
    const sargat = state.enemies.find((enemy) => enemy.id === SARGAT)
    sargat.hp = Math.floor(Number(sargat.maxHp) * ratio)
    run.state = normalizeCampaignState(state)
  }
  /** Ход героя в бою: подготовка сцены. */
  run.heroTurn = () => {
    const state = structuredClone(run.state)
    state.mechanics.combat.active_index = state.mechanics.combat.initiative.findIndex((entry) => String(entry.actor_id) === hero.id)
    run.state = normalizeCampaignState(state)
  }
  return run
}

const player = { allowedActorIds: [hero.id] }

test('тайны стартового Штормберга есть с первой минуты: страница журнала и признание Ареса', async () => {
  const run = await campaign()
  const scenario = campaignScenario(run.state)
  for (const clue of ['stormberg-journal-page', 'ares-confession']) {
    assert.ok(run.state.worldMemory.facts.some((fact) => fact.id === scenarioClueFactId(scenario, clue)), clue)
  }
  assert.ok(run.state.social.npcs.find((npc) => npc.id === 'astohan-ares').known_fact_ids.includes(scenarioClueFactId(scenario, 'ares-confession')))
})

test('«Изгнать»: мораль Саргата на трети хитов, сломленный он улетает, а не сдаётся; бой кончается бегством с наградой', async () => {
  const run = await campaign()
  await run.toLair()
  run.fight()
  run.woundSargat(0.4)
  assert.equal(isMoraleMoment(run.state, SARGAT), false, 'на 40% дракон ещё не дрогнул')
  run.woundSargat(0.33)
  assert.equal(isMoraleMoment(run.state, SARGAT), true)

  const agent = new NpcMoraleAgent()
  const dispositions = new Set()
  for (let round = 1; round <= 12; round += 1) {
    const state = structuredClone(run.state)
    state.mechanics.combat.round = round
    dispositions.add((await agent.decide({ state, enemyId: SARGAT })).disposition)
  }
  assert.ok(!dispositions.has('surrender'), 'главный противник не сдаётся в плен')
  assert.ok(dispositions.has('flee'))

  const commands = commandsForMoraleDecision(run.state, SARGAT, { disposition: 'flee' })
  assert.deepEqual(commands.map((command) => command.command_type), ['AddCondition'], 'дракон улетает без пути по клеткам')
  run.apply(commands, { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true })
  assert.equal(scenarioEncounterEndReason(run.state), 'fled')
  const combat = run.state.mechanics.combat
  const active = String(combat.initiative[combat.active_index].actor_id)
  run.apply({ command_type: 'EndCombat', actor_id: active, reason: scenarioEncounterEndReason(run.state) }, { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true })
  assert.equal(run.state.mechanics.encounter.outcome, 'fled')
  const plan = freezeEncounterOutcomePlan(run.state, 'fled')
  assert.equal(plan.rewards_eligible, true, 'брошенные сокровища и опыт за разгром')
})

test('«Договор»: без правды дракон не слушает; при правде — Убеждение СЛ 20, одна попытка на героя', async () => {
  const run = await campaign()
  await run.toLair()
  assert.throws(() => run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player), { code: 'SCENARIO_TREATY_TRUTH_MISSING' })

  const truthful = await campaign()
  truthful.discover('stormberg-journal-page')
  truthful.discover('ares-confession')
  await truthful.toLair()
  const refused = truthful.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player, minDice())
  const check = refused.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.skill, 'persuasion')
  assert.equal(check.payload.success, false)
  assert.ok(refused.events.some((event) => event.event_type === 'ScenarioTreatyRefused'))
  assert.throws(() => truthful.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player, maxDice()), { code: 'SCENARIO_TREATY_ATTEMPT_SPENT' })
})

test('«Договор» до боя: дракон уходит с равнин, кампания получает развязку «договор»', async () => {
  const run = await campaign()
  run.discover('stormberg-journal-page')
  run.discover('ares-confession')
  await run.toLair()
  const concluded = run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player, maxDice())
  assert.ok(concluded.events.some((event) => event.event_type === 'ScenarioTreatyConcluded'))
  assert.equal(run.state.social.npcs.find((npc) => npc.id === SARGAT).available, false, 'дракона в логове больше нет')
  assert.equal(scenarioEnding(run.state)?.id, 'treaty')
})

test('«Договор» в бою — только когда дракон ранен; враги уходят, бой кончается договором', async () => {
  const run = await campaign()
  run.discover('stormberg-journal-page')
  run.discover('ares-confession')
  await run.toLair()
  run.fight()
  run.heroTurn()
  assert.throws(() => run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player, maxDice()), { code: 'SCENARIO_TREATY_BOSS_UNHURT' })
  run.woundSargat(0.45)
  run.heroTurn()
  const concluded = run.apply({ command_type: 'NegotiateScenarioTreaty', actor_id: hero.id }, player, maxDice())
  assert.ok(concluded.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'fled' && event.target_ids.includes(SARGAT)))
  assert.equal(scenarioEncounterEndReason(run.state), 'parley')
})

test('фраза «предлагаю Саргату договор» — переговоры только в логове; в деревне это вопрос жителю', async () => {
  const run = await campaign()
  const village = await new IntentParser().parse({ message: 'Будет ли мир с драконом?', playerId: hero.id, visibleState: run.state })
  assert.notEqual(village.intent, 'scenario_treaty')
  await run.toLair()
  const lair = await new IntentParser().parse({ message: 'Предлагаю Саргату договор', playerId: hero.id, visibleState: run.state })
  assert.equal(lair.intent, 'scenario_treaty')
})
