// Проклятый рыцарь (`server/scenario-knight.mjs`): Каэлан приходит в Замок
// Забытых Скал только с 23:00 до 01:00 по часам мира и только при отряде;
// отряд может дождаться полуночи словами «ждём до полуночи».
import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { normalizeAuthoredNpcMechanics } from '../server/authored-npc.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { scenarioLocationId } from '../server/campaign-scenario.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { scenarioKnightPresencePlan } from '../server/scenario-knight.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { clockMinuteOf, minutesUntilClock } from '../server/weather.mjs'
import { fixedDice } from './kit/dice.mjs'

const KAELAN = 'astohan-kaelan'
const CLIFFS = 'astohan-forgotten-cliffs'
const hero = {
  id: 'knight-hero', character: 'Ярра', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник',
  level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30,
}

async function campaign() {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({
    code: 'KNIGHT', worldTemplateId: 'astohan-plains', players: [hero],
  }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = (commands, context = { isAdmin: true }) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `knight-${run.step}-${index}`, ...command }))
    const result = resolveCommands(list, run.state, { diceService: fixedDice(10), context })
    run.state = normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
      run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
    }
    assert.equal(scenarioLocationId(run.state), locationId)
  }
  /** Ждать до минуты суток — тем же путём, что «ждём до …» игрока. */
  run.waitUntil = (minuteOfDay) => run.apply({
    command_type: 'AdvanceTime', unit: 'minute', amount: minutesUntilClock(run.state.mechanics.world_time.elapsed_minutes, minuteOfDay),
  })
  run.kaelan = () => run.state.social.npcs.find((npc) => npc.id === KAELAN)
  run.present = () => run.kaelan().available !== false
  return run
}

const presenceEvents = (result) => result.events.filter((event) => event.event_type === 'ScenarioKnightPresenceChanged')

test('днём рыцаря в замке нет; в полночь он въезжает во двор, в час ночи уходит', async () => {
  const run = await campaign()
  assert.equal(run.present(), false, 'при создании кампании рыцарь недоступен')
  await run.travel(CLIFFS)
  assert.equal(run.present(), false, 'днём замок пуст')

  const midnight = run.waitUntil(0)
  assert.equal(clockMinuteOf(run.state.mechanics.world_time.elapsed_minutes), 0)
  assert.equal(run.present(), true)
  assert.ok(midnight.events.some((event) => event.event_type === 'NpcPlaced' && event.payload.npc_id === KAELAN), 'рыцарь встаёт на поле')
  const arrival = presenceEvents(midnight)
  assert.equal(arrival.length, 1)
  assert.equal(arrival[0].payload.present, true)
  assert.match(arrival[0].payload.text, /Вечного Стража/u)
  const projected = campaignStateForViewer(run.state, { role: 'player', heroIds: [hero.id] }, hero.id)
  assert.ok(projected.scene_npcs.some((npc) => npc.id === KAELAN), 'игрок видит рыцаря на доске')

  const late = run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 90 })
  assert.equal(run.present(), false)
  assert.equal(presenceEvents(late)[0]?.payload.present, false)
  const afterDeparture = campaignStateForViewer(run.state, { role: 'player', heroIds: [hero.id] }, hero.id)
  assert.equal(afterDeparture.scene_npcs.some((npc) => npc.id === KAELAN), false)

  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.social.npcs.find((npc) => npc.id === KAELAN), run.kaelan(), 'replay сходится')
})

test('пришедший ночью застаёт рыцаря сразу, ушедший оставляет его без свидетелей', async () => {
  const run = await campaign()
  await run.travel(CLIFFS)
  run.waitUntil(1_410)
  assert.equal(run.present(), true, 'в 23:30 рыцарь уже в замке')
  await run.travel('astohan-mittlayd')
  assert.equal(run.present(), false, 'без отряда рыцарь не ждёт')
  assert.equal(run.events.filter((event) => event.event_type === 'ScenarioKnightPresenceChanged' && !event.payload.present).length, 0,
    'уход без свидетелей не рассказывается')

  const back = await (async () => { await run.travel(CLIFFS); return run.events.at(-1) })()
  assert.ok(back)
  assert.equal(run.present(), true, 'отряд вернулся ещё до часа ночи — рыцарь на месте')
})

test('посреди боя присутствие не меняется', async () => {
  const run = await campaign()
  await run.travel(CLIFFS)
  run.waitUntil(0)
  const fighting = structuredClone(run.state)
  fighting.mechanics.world_time.elapsed_minutes += 120
  fighting.mechanics.combat.active = true
  assert.equal(scenarioKnightPresencePlan(fighting), null)
  fighting.mechanics.combat.active = false
  assert.equal(scenarioKnightPresencePlan(fighting)?.present, false)
})

test('«ждём до полуночи» — течение времени до ближайшей полуночи, без отдыха; в бою — отказ', async () => {
  const run = await campaign()
  const intent = await new IntentParser().parse({ message: 'Ждём до полуночи', playerId: hero.id, visibleState: run.state })
  assert.equal(intent.intent, 'wait')
  const plan = await new Adjudicator().createPlan({ intent, state: run.state, retrievedRules: { results: [], confidence: 1 } })
  assert.deepEqual(plan.proposed_commands.map((command) => command.command_type), ['AdvanceTime'])
  assert.equal(plan.proposed_commands[0].amount, 16 * 60, 'с восьми утра до полуночи — шестнадцать часов')
  run.apply(plan.proposed_commands, {})
  assert.equal(clockMinuteOf(run.state.mechanics.world_time.elapsed_minutes), 0)

  const fighting = structuredClone(run.state)
  fighting.mechanics.combat.active = true
  const refused = await new Adjudicator().createPlan({ intent, state: fighting, retrievedRules: { results: [], confidence: 1 } })
  assert.equal(refused.clarification_required, true)
  assert.equal(refused.proposed_commands.length, 0)
})

test('Лунный Судья добавляет 2к8 холодом, Вой Проклятых — 4к8 звуком раз в три хода', async () => {
  const run = await campaign()
  const mechanics = normalizeAuthoredNpcMechanics(run.state.npc_world.profiles[KAELAN] ?? run.state.npc_world.profiles?.find?.((entry) => entry.id === KAELAN))
  const blade = mechanics.action_profiles.find((action) => action.id === 'moon-judge')
  assert.deepEqual(blade.on_hit, { damage_expression: '2d8', damage_type: 'cold' })
  const wail = mechanics.legendary.actions.find((action) => action.id === 'wail-of-the-condemned')
  assert.equal(wail.damage_expression, '4d8')
  assert.equal(wail.damage_type, 'thunder')
  assert.equal(wail.save_ability, 'con')
  assert.equal(wail.half_on_save, true)
  assert.equal(wail.radius_feet, 30)
  assert.equal(wail.cooldown_turns, 3)
})
