// Проклятый рыцарь (`server/scenario-knight.mjs`): Каэлан приходит в Замок
// Забытых Скал только с 23:00 до 01:00 по часам мира и только при отряде;
// отряд может дождаться полуночи словами «ждём до полуночи».
import assert from 'node:assert/strict'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { normalizeAuthoredNpcMechanics } from '../server/authored-npc.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId, scenarioLocationId } from '../server/campaign-scenario.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { scenarioKnightPresencePlan, scenarioKnightState } from '../server/scenario-knight.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { clockMinuteOf, minutesUntilClock } from '../server/weather.mjs'
import { fixedDice, maxDice, minDice } from './kit/dice.mjs'

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
  run.apply = (commands, context = { isAdmin: true }, diceService = fixedDice(10)) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `knight-${run.step}-${index}`, ...command }))
    const result = resolveCommands(list, run.state, { diceService, context })
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

// ---------------------------------------------------------------------------
// Загадка: голова, защита, ужас и мирный путь

/** Отряд нашёл тайну часовни — тем же фактом `discovery`, что и удачный поиск. */
function discoverChapel(run) {
  const secretId = scenarioClueFactId(campaignScenario(run.state), 'cliffs-chapel')
  const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
  assert.ok(secret, 'тайна часовни записана при входе в замок')
  run.apply({ command_type: 'RecordWorldFact', fact: {
    id: 'fact-secret-found-chapel', subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
    summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
  } })
}

/** Пост рыцаря на карте. */
function knightPost(run) {
  const placements = run.state.npc_world.placements ?? {}
  const post = placements[KAELAN] ?? Object.values(placements).flat().find((entry) => entry?.npc_id === KAELAN)
  assert.ok(post, 'у рыцаря есть пост')
  return post
}

/** Герой ставится рядом с рыцарем: подготовка сцены, а не проверяемое правило. */
function standAt(run, x, y) {
  const state = structuredClone(run.state)
  state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [hero.id]: { x, y } }
  const player = state.players.find((entry) => entry.id === hero.id)
  player.x = x
  player.y = y
  run.state = normalizeCampaignState(state)
}

function standNextToKnight(run) {
  const post = knightPost(run)
  standAt(run, Number(post.x) + 1, Number(post.y))
}

async function midnightAtCastle() {
  const run = await campaign()
  await run.travel(CLIFFS)
  run.waitUntil(0)
  assert.equal(run.present(), true)
  return run
}

test('голову ставят перед рыцарем, только разгадав загадку и подойдя вплотную', async () => {
  const run = await campaign()
  await run.travel(CLIFFS)
  assert.throws(() => run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {}), { code: 'SCENARIO_KNIGHT_NOT_PRESENT' })
  run.waitUntil(0)
  assert.throws(() => run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {}), { code: 'SCENARIO_KNIGHT_RIDDLE_UNSOLVED' })
  discoverChapel(run)
  const post = knightPost(run)
  standAt(run, Number(post.x) + 6, Number(post.y))
  assert.throws(() => run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {}), { code: 'TARGET_OUT_OF_RANGE' })
  standNextToKnight(run)
  const returned = run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})
  assert.ok(returned.events.some((event) => event.event_type === 'ScenarioKnightHeadReturned'))
  assert.equal(scenarioKnightState(run.state).head_returned, true)
  assert.throws(() => run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {}), { code: 'SCENARIO_KNIGHT_HEAD_RETURNED' })
})

test('до возвращения головы рыцарь неуязвим и смеётся с подсказкой; после — сопротивление всему, кроме силы', async () => {
  const run = await midnightAtCastle()
  run.apply({ command_type: 'CreateEncounter', npc_id: KAELAN, difficulty: 'deadly', seed: 'knight-fight' }, { isDirector: true })
  run.apply({ command_type: 'StartCombat', server_authoritative: true }, { isDirector: true })
  const hit = (type) => run.apply({ command_type: 'ApplyDamage', actor_id: hero.id, target_id: KAELAN, amount: 20, damage_type: type, ruling_id: 'test-knight-damage' })
    .events.find((event) => event.event_type === 'DamageApplied')
  const warded = hit('slashing')
  assert.equal(warded.payload.immune, true)
  assert.equal(warded.payload.applied_amount, 0)
  const narration = combatNarration([warded], run.state)
  assert.match(typeof narration === 'string' ? narration : JSON.stringify(narration), /Голова спит там, где пали небеса/u)

  const withHead = structuredClone(run.state)
  withHead.scenario_knight = { ...withHead.scenario_knight, head_returned: true }
  run.state = normalizeCampaignState(withHead)
  assert.equal(hit('slashing').payload.applied_amount, 10, 'сопротивление режущему')
  assert.equal(hit('force').payload.applied_amount, 20, 'силовой урон проходит целиком')
})

test('ужас рыцаря: герой рядом бросает Мудрость СЛ 15 в начале хода', async () => {
  const run = await midnightAtCastle()
  standNextToKnight(run)
  run.apply({ command_type: 'CreateEncounter', npc_id: KAELAN, difficulty: 'deadly', seed: 'knight-dread' }, { isDirector: true })
  run.apply({ command_type: 'StartCombat', server_authoritative: true }, { isDirector: true })
  const combat = run.state.mechanics.combat
  const active = String(combat.initiative[combat.active_index].actor_id)
  // Ход передаётся до начала хода героя: на нём и бросается спасбросок.
  const scheduler = { isNpcScheduler: true, isAdmin: true, serverAuthoritativeCombat: true }
  const handed = active === hero.id
    ? run.apply([{ command_type: 'EndTurn', actor_id: hero.id }, { command_type: 'EndTurn', actor_id: KAELAN }], scheduler, minDice())
    : run.apply({ command_type: 'EndTurn', actor_id: active }, scheduler, minDice())
  const dread = handed.events.find((event) => event.event_type === 'SavingThrowResolved' && event.payload.source === 'scenario-knight-dread')
  assert.ok(dread, 'спасбросок от ужаса в начале хода героя')
  assert.equal(dread.payload.difficulty, 15)
  assert.equal(dread.payload.ability, 'wis')
  assert.equal(dread.payload.saved, false)
  assert.ok(handed.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'frightened' && event.target_ids.includes(hero.id)))
})

test('мирный путь: голова перед ним, Убеждение или Религия СЛ 18 — он уходит и отдаёт Слезу; провал — одна попытка за ночь', async () => {
  const run = await midnightAtCastle()
  discoverChapel(run)
  standNextToKnight(run)
  assert.throws(() => run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: 'religion' }, {}), { code: 'SCENARIO_KNIGHT_HEAD_MISSING' })
  run.apply({ command_type: 'ReturnKnightHead', actor_id: hero.id }, {})

  const failed = run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: 'religion' }, {}, minDice())
  const failedCheck = failed.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(failedCheck.payload.skill, 'religion')
  assert.equal(failedCheck.payload.success, false)
  assert.ok(failed.events.some((event) => event.event_type === 'ScenarioKnightReleaseFailed'))
  assert.throws(() => run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: 'persuasion' }, {}), { code: 'SCENARIO_KNIGHT_ATTEMPT_SPENT' })

  // Следующая ночь: рыцарь снова приходит, и герой может попробовать ещё раз.
  run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 120 })
  run.waitUntil(0)
  assert.equal(run.present(), true)
  standNextToKnight(run)
  const released = run.apply({ command_type: 'ReleaseCursedKnight', actor_id: hero.id, skill: 'persuasion' }, {}, maxDice())
  assert.ok(released.events.some((event) => event.event_type === 'ScenarioKnightReleased'))
  const tear = released.events.find((event) => event.event_type === 'ItemGranted')
  assert.equal(tear.payload.item.name, 'Слеза Проклятого Рыцаря')
  assert.ok(run.state.players.find((player) => player.id === hero.id).inventory.some((item) => item.name === 'Слеза Проклятого Рыцаря'))
  // Та самая вещь из его лат, а не вторая копия: у рыцаря её больше нет.
  assert.equal(tear.payload.source_npc_id, KAELAN)
  assert.deepEqual(run.state.npc_world.inventories[KAELAN] ?? [], [])
  assert.equal(run.present(), false, 'обретший покой уходит')
  assert.equal(scenarioKnightState(run.state).released, true)
  run.apply({ command_type: 'AdvanceTime', unit: 'minute', amount: 120 })
  run.waitUntil(0)
  assert.equal(run.present(), false, 'и больше не приходит')
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.scenario_knight, run.state.scenario_knight)
})

test('фразы игрока: «ставлю голову перед рыцарем» и «молюсь об упокоении Каэлана» — команды рыцаря', async () => {
  const run = await campaign()
  for (const [message, expected] of [
    ['Ставлю голову перед рыцарем', { command_type: 'ReturnKnightHead' }],
    ['Молюсь об упокоении Каэлана', { command_type: 'ReleaseCursedKnight', skill: 'religion' }],
    ['Убеждаю рыцаря обрести покой', { command_type: 'ReleaseCursedKnight', skill: 'persuasion' }],
  ]) {
    const intent = await new IntentParser().parse({ message, playerId: hero.id, visibleState: run.state })
    assert.equal(intent.intent, 'scenario_knight', message)
    const plan = await new Adjudicator().createPlan({ intent, state: run.state, retrievedRules: { results: [], confidence: 1 } })
    assert.equal(plan.proposed_commands[0].command_type, expected.command_type, message)
    if (expected.skill) assert.equal(plan.proposed_commands[0].skill, expected.skill, message)
  }
})

test('Слеза лежит в латах рыцаря: павший в бою Каэлан оставляет её в своём контейнере', async () => {
  const run = await midnightAtCastle()
  const carried = run.state.npc_world.inventories[KAELAN] ?? []
  assert.deepEqual(carried.map((item) => item.catalog_id), ['scenario_astohan:kaelan-tear'], 'Слеза у рыцаря с начала кампании')
  standNextToKnight(run)
  run.apply({ command_type: 'CreateEncounter', npc_id: KAELAN, difficulty: 'deadly', seed: 'knight-fall' }, { isDirector: true })
  run.apply({ command_type: 'StartCombat', server_authoritative: true }, { isDirector: true })
  // Голова уже перед ним: неуязвимость снята, силовой урон проходит целиком.
  const withHead = structuredClone(run.state)
  withHead.scenario_knight = { ...withHead.scenario_knight, head_returned: true }
  run.state = normalizeCampaignState(withHead)
  const killed = run.apply({ command_type: 'ApplyDamage', actor_id: hero.id, target_id: KAELAN, amount: 999, damage_type: 'force', ruling_id: 'test-knight-fall' })
  const created = killed.events.find((event) => event.event_type === 'LootContainerCreated')
  assert.ok(created, 'павший рыцарь оставляет контейнер')
  assert.deepEqual(created.payload.container.items.map((item) => item.catalog_id), ['scenario_astohan:kaelan-tear'])
  assert.deepEqual(run.state.npc_world.inventories[KAELAN] ?? [], [], 'вещь одна: из лат она переехала в контейнер')
  const replayed = replayEvents(run.initial, run.events)
  assert.deepEqual(replayed.npc_world.inventories[KAELAN] ?? [], [])
})
