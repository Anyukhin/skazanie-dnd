// Внимание Саргата (`server/scenario-attention.mjs`): счёт выводится из
// журнала, расспросы в поселениях с осведомителями его поднимают, тихие — нет;
// на пороге приходит незнакомец, на втором шаге превращается и выдыхает пламя.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { authorizeDirectorIntent } from '../server/campaign-loop-policy.mjs'
import { scenarioEnding, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import {
  scenarioAttention,
  scenarioStrangerNarration,
  scenarioStrangerNpcId,
  scenarioStrangerStage,
} from '../server/scenario-attention.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { RulesEngine } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { dice, fixedDice } from './kit/dice.mjs'
import { assertReplayMatches, createTestStore } from './kit/engine.mjs'

const hero = {
  id: 'attention-hero',
  character: 'Ирма',
  name: 'Игрок',
  role: 'Воин · ур. 7',
  species: 'Человек',
  background: 'Странник',
  level: 7,
  hp: 64,
  maxHp: 64,
  armor: 18,
  speed: 30,
}

const admin = { isAdmin: true }
const director = { isDirector: true }

/** Кампания и журнал: каждое изменение идёт командами, а журнал проверяет replay. */
async function campaign() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({
    code: 'ATTENTION', worldTemplateId: 'astohan-plains', players: [hero],
  }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = admin, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({
      command_id: `attention-${run.step}-${index}`, ...command,
    }))
    const result = resolveCommands(list, run.state, { diceService, context })
    run.state = normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  // Архитектор ведёт по дорогам карты мира: за один переход — до соседнего места.
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({
        state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId,
      })
      run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
    }
    assert.equal(scenarioLocationId(run.state), locationId, `отряд дошёл до ${locationId}`)
  }
  /** Собеседник в текущем месте и реплика героя ему — тем же путём, что социальный контроллер. */
  run.ask = (message, npcId = 'attention-villager') => {
    if (!run.state.social.npcs.some((npc) => npc.id === npcId && npc.location === run.state.scene.location)) {
      run.apply({ command_type: 'UpsertNpcSocialProfile', npc: {
        id: npcId, name: 'Старый Хельм', role: 'житель', location: run.state.scene.location,
        public_summary: 'Местный житель.', visibility: 'party', available: true,
      } })
    }
    return run.apply({ command_type: 'RecordNpcSocialTurn', actor_id: hero.id, conversation: {
      id: `conversation:${run.step}`, npc_id: npcId, hero_id: hero.id, player_message: message,
      npc_reply: 'Житель пожимает плечами.', stance: 'neutral', disclosed_fact_ids: [], relationship_delta: 0, visibility: 'party',
    } }, { isSocialController: true })
  }
  run.value = () => scenarioAttention(run.state).value
  return run
}

function assertReplay(run) {
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.scenario_attention, run.state.scenario_attention, 'счёт внимания сходится при replay')
}

test('расспросы о драконе в Редстоуновке поднимают счёт раз за визит; чужая тема и другие места — нет', async () => {
  const run = await campaign()
  assert.equal(run.value(), 0)
  await run.travel('astohan-ash-watch')
  run.ask('Что вы знаете о драконе?')
  assert.equal(run.value(), 0, 'на заставе осведомителей нет')

  await run.travel('astohan-redstone')
  run.ask('Где здесь можно купить хлеба?')
  assert.equal(run.value(), 0, 'вопрос не о драконе')
  run.ask('Расскажите про Саргата, куда он летает?')
  assert.equal(run.value(), 1)
  run.ask('А драконье логово далеко?')
  assert.equal(run.value(), 1, 'одна деревня за визит — один слух')

  await run.travel('astohan-lomar-tower')
  await run.travel('astohan-redstone')
  run.ask('Видели дракона в последние дни?')
  assert.equal(run.value(), 2, 'новый визит — новый слух')
  assert.deepEqual(scenarioAttention(run.state).history.map((entry) => entry.reason), ['questions', 'questions'])
  assertReplay(run)
})

test('бой в поселении с осведомителями — громкое дело: +2', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight' }, director)
  assert.equal(run.value(), 2)
  assert.equal(scenarioAttention(run.state).history.at(-1).reason, 'fight')
  assertReplay(run)
})

test('на третьем пункте Режиссёр приводит незнакомца; игрок не может ни вызвать, ни раскрыть его', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.ask('Где дракон?')
  run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight' }, director)
  assert.equal(run.value(), 3)
  assert.equal(scenarioStrangerStage(run.state), 'arrive')

  const authorization = authorizeDirectorIntent(run.state, { type: 'continue_exploration' })
  assert.equal(authorization.intent.type, 'open_social_scene')
  assert.equal(authorization.intent.npc_id, scenarioStrangerNpcId(run.state))
  assert.equal(authorization.reason, 'scenario_stranger')

  assert.throws(() => run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, {}), { code: 'SCENARIO_STAGE_FORBIDDEN' })
  assert.throws(() => run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director), { code: 'SCENARIO_STAGE_NOT_DUE' })

  const arrived = run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director)
  const strangerId = scenarioStrangerNpcId(run.state)
  const profile = run.state.social.npcs.find((npc) => npc.id === strangerId)
  assert.equal(profile.available, true)
  assert.equal(profile.name, 'Незнакомец в пепельном плаще', 'имени дракона у незнакомца нет')
  assert.equal(profile.location, run.state.scene.location)
  assert.ok(arrived.events.some((event) => event.event_type === 'NpcPlaced' && event.payload.npc_id === strangerId), 'незнакомец встаёт на поле')
  assert.equal(scenarioAttention(run.state).stranger_stage, 'arrived')
  assert.match(scenarioStrangerNarration(arrived.events, run.state), /пепельном плаще/u)
  assert.equal(scenarioStrangerStage(run.state), null, 'пока отряд при нём ничего не сделал, он не раскрывается')
  assert.throws(() => run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director), { code: 'SCENARIO_STAGE_NOT_DUE' })
  assertReplay(run)
})

test('раскрытие: один бросок 8к6 на всех, спасбросок Ловкости СЛ 17 — половина; незнакомец улетает', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.ask('Где дракон?')
  run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight' }, director)
  run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director)
  run.ask('Мы ищем дракона, который сжёг заставу.', scenarioStrangerNpcId(run.state))
  assert.equal(scenarioAttention(run.state).value, 3, 'разговор с самим незнакомцем счёт не поднимает')
  assert.equal(scenarioStrangerStage(run.state), 'reveal')

  const hpBefore = run.state.players.find((player) => player.id === hero.id).hp
  // 8к6 = 4×8 = 32; спасбросок d20 = 2 — провал при любом бонусе героя седьмого уровня.
  const revealed = run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director, dice([4, 4, 4, 4, 4, 4, 4, 4, 2]))
  const save = revealed.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.difficulty, 17)
  assert.equal(save.payload.ability, 'dex')
  assert.equal(save.payload.saved, false)
  const damage = revealed.events.find((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.damage_type, 'fire')
  assert.equal(damage.payload.applied_amount, 32)
  assert.equal(run.state.players.find((player) => player.id === hero.id).hp, hpBefore - 32)
  const profile = run.state.social.npcs.find((npc) => npc.id === scenarioStrangerNpcId(run.state))
  assert.equal(profile.available, false, 'после выдоха собеседника больше нет')
  assert.equal(scenarioAttention(run.state).stranger_stage, 'revealed')
  assert.equal(scenarioStrangerStage(run.state), null, 'второй раз он не приходит')
  const text = scenarioStrangerNarration(revealed.events, run.state)
  assert.match(text, /Саргат/u)
  assert.match(text, /Ирма: спасбросок Ловкости \d+ против СЛ 17 — провал, 32 урона огнём\./u)
  assertReplay(run)
})

test('успешный спасбросок — половина урона', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.ask('Где дракон?')
  run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight' }, director)
  run.apply({ command_type: 'StageScenarioStranger', stage: 'arrive' }, director)
  run.ask('Кто вы такой?', scenarioStrangerNpcId(run.state))
  const revealed = run.apply({ command_type: 'StageScenarioStranger', stage: 'reveal' }, director, dice([6, 6, 6, 6, 6, 6, 6, 5, 20]))
  assert.equal(revealed.events.find((event) => event.event_type === 'SavingThrowResolved').payload.saved, true)
  assert.equal(revealed.events.find((event) => event.event_type === 'DamageApplied').payload.applied_amount, 23)
})

test('счёт внимания — знание ведущего: в проекции игрока его нет', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.ask('Где дракон?')
  assert.equal(run.value(), 1)
  const projected = campaignStateForViewer(run.state, { role: 'player', heroIds: [hero.id] }, hero.id)
  assert.equal(projected.scenario_attention, undefined)
})

test('стычка с Саргатом вне логова развязкой кампании не считается', async () => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  const state = structuredClone(run.state)
  state.mechanics.encounter = {
    id: 'encounter-sargat-in-village', status: 'ended', outcome: 'enemies_defeated',
    enemy_ids: ['astohan-sargat'], location: state.scene.location,
  }
  state.autonomy.encounter_outcomes = [{ encounter_id: 'encounter-sargat-in-village', outcome: 'enemies_defeated' }]
  assert.equal(scenarioEnding(state), null)
})

test('Режиссёр ведёт сцену незнакомца сам: шаг прихода, реплика отряда, шаг выдоха; журнал переигрывается', async (t) => {
  const run = await campaign()
  await run.travel('astohan-redstone')
  run.ask('Где дракон?')
  run.apply({ command_type: 'CreateEncounter', theme: 'raiders', difficulty: 'easy', seed: 'attention-fight' }, director)
  assert.equal(run.value(), 3)
  const store = createTestStore(t, { snapshotEvery: 3 })
  await store.initializeCampaign({ campaign_id: 'ATTENTION', initial_state: run.state })
  const autonomy = new AutonomousCampaignOrchestrator({
    eventStore: store, rulesEngine: new RulesEngine({ diceService: fixedDice(3) }), now: () => 1_784_466_000_000,
  })
  const eventsOf = (result) => (result.results ?? []).flatMap((stage) => stage.events ?? [])

  // Модель просит осмотреться, но порог внимания — правило сценария.
  const arrival = await autonomy.runIntent({ campaignId: 'ATTENTION', intent: { type: 'continue_exploration' }, idempotencyKey: 'stranger-1' })
  assert.equal(arrival.intent.type, 'open_social_scene')
  assert.ok(eventsOf(arrival).some((event) => event.event_type === 'ScenarioStrangerStaged' && event.payload.stage === 'arrived'))
  let state = (await store.load('ATTENTION')).state
  assert.equal(state.scene.objective, 'Понять, чего хочет незнакомец в пепельном плаще')

  // Пока отряд молчит, следующий шаг Режиссёра незнакомца не раскрывает.
  const idle = await autonomy.runIntent({ campaignId: 'ATTENTION', intent: { type: 'offer_next_hook' }, idempotencyKey: 'stranger-2' })
  assert.equal(eventsOf(idle).some((event) => event.event_type === 'ScenarioStrangerStaged'), false)

  const head = await store.load('ATTENTION')
  run.state = state
  const reply = run.ask('Мы ищем того, кто сжёг заставу.', scenarioStrangerNpcId(state))
  await store.commit({
    campaign_id: 'ATTENTION', idempotency_key: 'stranger-reply', expected_state_version: head.current_state_version, events: reply.events,
  })
  const reveal = await autonomy.runIntent({ campaignId: 'ATTENTION', intent: { type: 'continue_exploration' }, idempotencyKey: 'stranger-3' })
  const revealEvents = eventsOf(reveal)
  assert.ok(revealEvents.some((event) => event.event_type === 'ScenarioStrangerStaged' && event.payload.stage === 'revealed'))
  assert.ok(revealEvents.some((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'fire'))
  state = (await store.load('ATTENTION')).state
  assert.equal(scenarioAttention(state).stranger_stage, 'revealed')
  assert.match(scenarioStrangerNarration(revealEvents, state), /Не ищите меня/u)
  await assertReplayMatches(store, 'ATTENTION')
})

test('свободный расспрос толпы поднимает счёт, а выспрашивание обманом — нет', async () => {
  const run = await campaign()
  await run.travel('astohan-mittlayd')
  const ruling = (id, skill) => ({ command_type: 'RecordRuling', ruling_id: id, ruling: {
    id, status: 'applied', scope: 'single-action', question: 'Выспрашиваю у перевозчиков, где видели дракона',
    interpretation: { activity_kind: 'social', skill }, outcome: 'applied',
  } })
  run.apply(ruling('ruling-quiet', 'deception'))
  assert.equal(run.value(), 0, 'под видом торговца — тихое расследование')
  run.apply(ruling('ruling-open', 'persuasion'))
  assert.equal(run.value(), 1)
  assertReplay(run)
})
