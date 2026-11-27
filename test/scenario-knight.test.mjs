// Проклятый рыцарь (`server/scenario-knight.mjs`): Каэлан приходит в Замок
// Забытых Скал только с 23:00 до 01:00 по часам мира и только при отряде;
// отряд может дождаться полуночи словами «ждём до полуночи».
//
// Здесь — HTTP-путь; сцену до полуночи у замка готовит код сервера
// (`kit/fixtures.mjs`). Случаи правила, проекции и разбора фразы в процессе —
// `test/scenario-knight-library.test.mjs`.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  campaignScenario, createCampaignState, minutesUntilClock, normalizeCampaignState, planScene, resolveCommands, scenarioClueFactId, scenarioLocationId,
} from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const KAELAN = 'astohan-kaelan'
const CLIFFS = 'astohan-forgotten-cliffs'
const hero = {
  id: 'knight-hero', character: 'Ярра', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник',
  level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30,
}

async function campaign() {
  const initial = await normalizeCampaignState(await createCampaignState({
    code: 'KNIGHT', worldTemplateId: 'astohan-plains', players: [hero],
  }))
  const run = { initial, state: initial, events: [], step: 0 }
  run.apply = async (commands, context = { isAdmin: true }, dice = { fixed: 10 }) => {
    run.step += 1
    const list = (Array.isArray(commands) ? commands : [commands]).map((command, index) => ({ command_id: `knight-${run.step}-${index}`, ...command }))
    const result = await resolveCommands(list, run.state, { ...dice, context })
    run.state = await normalizeCampaignState(result.state)
    run.events.push(...result.events)
    return result
  }
  run.travel = async (locationId) => {
    for (let hop = 0; hop < 8 && await scenarioLocationId(run.state) !== locationId; hop += 1) {
      const { sceneArgs } = await planScene({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
      await run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })
    }
    assert.equal(await scenarioLocationId(run.state), locationId)
  }
  /** Ждать до минуты суток — тем же путём, что «ждём до …» игрока. */
  run.waitUntil = async (minuteOfDay) => run.apply({
    command_type: 'AdvanceTime', unit: 'minute', amount: await minutesUntilClock(run.state.mechanics.world_time.elapsed_minutes, minuteOfDay),
  })
  run.kaelan = () => run.state.social.npcs.find((npc) => npc.id === KAELAN)
  run.present = () => run.kaelan().available !== false
  return run
}

/** Отряд нашёл тайну часовни — тем же фактом `discovery`, что и удачный поиск. */
async function discoverChapel(run) {
  const secretId = await scenarioClueFactId(await campaignScenario(run.state), 'cliffs-chapel')
  const secret = run.state.worldMemory.facts.find((fact) => fact.id === secretId)
  assert.ok(secret, 'тайна часовни записана при входе в замок')
  await run.apply({ command_type: 'RecordWorldFact', fact: {
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
async function standAt(run, x, y) {
  const state = structuredClone(run.state)
  state.mechanics.positions = { ...(state.mechanics.positions ?? {}), [hero.id]: { x, y } }
  const player = state.players.find((entry) => entry.id === hero.id)
  player.x = x
  player.y = y
  run.state = await normalizeCampaignState(state)
}

async function standNextToKnight(run) {
  const post = knightPost(run)
  await standAt(run, Number(post.x) + 1, Number(post.y))
}

async function midnightAtCastle() {
  const run = await campaign()
  await run.travel(CLIFFS)
  await run.waitUntil(0)
  assert.equal(run.present(), true)
  return run
}

test('мирный путь Каэлана доступен игроку через HTTP и переживает перезапуск', { timeout: runnerTimeout(120_000) }, async (t) => {
  const run = await midnightAtCastle()
  await discoverChapel(run)
  await standNextToKnight(run)
  const code = 'KNIGHT-HTTP'
  const server = await startTestServer(t, { dice: { format: 'skazanie.test-dice/1', rules: [{ value: 'max' }] } })
  const { client: admin } = await setupAdmin(server)
  const { campaignConcept, players, mechanics, worldMap, worldMemory, adventure, scene, npc_world, social, scenario_knight } = run.state
  await createCampaign(admin, { code, state: {
    campaignConcept, players, mechanics, worldMap, worldMemory, adventure, npc_world, social, scenario_knight,
    partyMemberIds: [hero.id], activePlayerId: hero.id, scene: { ...scene, cells: [] },
  } })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: [hero.id] })
  const getState = async () => expectStatus(await player.get(`/api/rooms/${code}`)).state
  const choose = (id) => sendCommand(player, code, `knight-${id}`, {
    command_type: 'ChooseDialogueOption', actor_id: hero.id, npc_id: KAELAN, option_id: id,
  })
  assert.ok((await getState()).scene_dialogues?.[KAELAN]?.options.some((option) => option.id === 'head'))
  assert.ok(expectStatus(await choose('head')).mechanics.some((event) => event.event_type === 'ScenarioKnightHeadReturned'))
  assert.ok((await getState()).scene_dialogues?.[KAELAN]?.options.some((option) => option.id === 'release-prayer'))
  const released = expectStatus(await choose('release-prayer'))
  assert.ok(released.mechanics.some((event) => event.event_type === 'ScenarioKnightReleased'))
  await server.restart()
  const repeated = expectStatus(await choose('release-prayer'))
  assert.equal(repeated.idempotent_replay, true)
  const state = await getState()
  assert.equal(state.scene_dialogues?.[KAELAN], undefined)
  assert.equal(state.players[0].inventory.filter((item) => item.name === 'Слеза Проклятого Рыцаря').length, 1)
})
