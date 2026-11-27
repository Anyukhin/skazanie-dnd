import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { resolveExplorationCommand } from '../server/free-action-adjudication.mjs'
import { normalizeDeclaredLevels } from '../server/level-generator.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents } from '../server/rules-engine.mjs'
import { cellAt, legacyCellsFromTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'

/**
 * «Поднимаемся по лестнице на второй этаж» свободной фразой (живая сессия
 * 2026-10-02). Прежде заявка уходила арбитру как проверка навыка, рассказчик
 * отвечал «Вышло: подняться на второй этаж», а карта не менялась. Теперь
 * фраза доходит до той же команды `UseLevelTransition`, что и выбор лестницы
 * на карте, или честно уточняет, почему подняться нельзя.
 */

const CAMPAIGN_ID = 'STAIRS-PHRASE'
const PARTY = ['hero-a', 'hero-b']

function tavernMap({ reveal = true } = {}) {
  const map = generateBuildingScene({ seed: 'лестница словами', locationId: 'loc-tavern', levels: normalizeDeclaredLevels([{ offset: 1, hint: 'комнаты постояльцев' }]) })
  if (reveal) for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
  return map
}

/** Две клетки отряда: рядом с лестницей или в самом дальнем углу зала. */
function spotsFor(map, { near }) {
  const stairs = map.props.find((prop) => prop.transition)
  const anchor = { x: Math.floor(stairs.x), y: Math.floor(stairs.y) }
  const cells = []
  // Герой не стоит на столе: клетки под мебелью, мешающей шагу, не берутся.
  const furniture = new Set(map.props.filter((prop) => prop.blocksMove && !prop.mount).flatMap((prop) => prop.footprint.map((cell) => `${cell.x},${cell.y}`)))
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.passable && cell.zone === 'hall' && !(x === anchor.x && y === anchor.y) && !furniture.has(`${x},${y}`)) cells.push({ x, y, d: Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) })
  }
  // Дальний угол — правый: в левом герой зажат мебелью и соседом, и пути
  // нет по-честному.
  cells.sort((left, right) => (near ? left.d - right.d : right.d - left.d) || left.y - right.y || (near ? left.x - right.x : right.x - left.x))
  return cells.slice(0, PARTY.length)
}

function stateFor(map, spots) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN_ID,
    campaign: 'Лестница словами',
    engine_mode: 'enforce',
    partyMemberIds: [...PARTY],
    activePlayerId: PARTY[0],
    players: PARTY.map((id, index) => ({
      id, character: `Герой ${index + 1}`, level: 1, hp: 10, maxHp: 10, speed: 30,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], ...spots[index],
    })),
    worldMap: { seed: 'stairs-seed', currentLocationId: 'loc-tavern', locations: [{ id: 'loc-tavern', name: 'Постоялый двор', kind: 'settlement' }] },
    scene: {
      title: 'Постоялый двор', location: 'Постоялый двор', location_id: 'loc-tavern', objective: 'Найти хозяина', turn: 1,
      levels: normalizeDeclaredLevels([{ offset: 1, hint: 'комнаты постояльцев' }]),
      map: serializeTacticalMap(map), cells: legacyCellsFromTacticalMap(map),
    },
    mechanics: { positions: Object.fromEntries(PARTY.map((id, index) => [id, { x: spots[index].x, y: spots[index].y }])), world_time: { elapsed_minutes: 0 } },
  })
}

async function fixture(t, state) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-stairs-phrase-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: state })
  let modelCalls = 0
  // Арбитр не нужен: переход между этажами — существующая команда.
  const actionAdjudicator = new ActionAdjudicator({ llmClient: { completeJson: async () => { modelCalls += 1; throw new Error('арбитр не должен вызываться') } } })
  const autonomy = new AutonomousCampaignOrchestrator({
    eventStore, rulesEngine: new (await import('../server/rules-engine.mjs')).RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([10, 10, 10]) }) }),
    actionAdjudicator, now: () => 1_790_000_000_000,
  })
  return { eventStore, autonomy, modelCalls: () => modelCalls }
}

const say = (autonomy, key, action) => autonomy.handleUnknownAction({ campaignId: CAMPAIGN_ID, playerId: PARTY[0], action, idempotencyKey: key })
const types = (result) => (result.events ?? []).map((event) => event.event_type)

test('у лестницы фраза «поднимаемся на второй этаж» — настоящий переход, без арбитра', async (t) => {
  const map = tavernMap()
  const { eventStore, autonomy, modelCalls } = await fixture(t, stateFor(map, spotsFor(map, { near: true })))
  const result = await say(autonomy, 'stairs-near', 'Поднимаемся по лестнице на второй этаж.')
  assert.equal(result.kind, 'scene_interaction', result.narration)
  assert.ok(types(result).includes('MapLevelChanged'), `нет перехода: ${types(result)}`)
  assert.equal(modelCalls(), 0)
  const loaded = await eventStore.load(CAMPAIGN_ID)
  assert.equal(loaded.state.scene.map.levelIndex, 1, 'отряд не на втором этаже')
  // Повтор с тем же ключом — тот же коммит, второй переход не появляется.
  const again = await say(autonomy, 'stairs-near', 'Поднимаемся по лестнице на второй этаж.')
  assert.equal((await eventStore.load(CAMPAIGN_ID)).state_version, loaded.state_version)
  assert.ok(again)
})

test('издалека отряд подходит к лестнице и поднимается одним коммитом, replay сходится', async (t) => {
  const map = tavernMap()
  const initial = stateFor(map, spotsFor(map, { near: false }))
  const { eventStore, autonomy } = await fixture(t, initial)
  const result = await say(autonomy, 'stairs-far', 'Идём наверх, на второй этаж.')
  const kinds = types(result)
  assert.ok(kinds.includes('MapLevelChanged'), `нет перехода: ${kinds}`)
  assert.ok(kinds.includes('ActorMoved') && kinds.indexOf('ActorMoved') < kinds.indexOf('MapLevelChanged'), `подход должен идти до перехода: ${kinds}`)
  const loaded = await eventStore.load(CAMPAIGN_ID)
  const replayed = replayEvents(initial, result.events)
  assert.equal(replayed.scene.map.levelIndex, loaded.state.scene.map.levelIndex)
})

test('спуска нет или лестница под туманом — честное уточнение без коммита', async (t) => {
  const map = tavernMap()
  const { eventStore, autonomy } = await fixture(t, stateFor(map, spotsFor(map, { near: true })))
  const before = (await eventStore.load(CAMPAIGN_ID)).state_version
  const down = await say(autonomy, 'stairs-down', 'Спускаемся по лестнице в подвал.')
  assert.equal(down.kind, 'clarification')
  assert.match(down.narration, /Спуска вниз отсюда не видно/u)
  assert.equal((await eventStore.load(CAMPAIGN_ID)).state_version, before, 'уточнение ничего не коммитит')

  const hidden = tavernMap({ reveal: false })
  const stairs = hidden.props.find((prop) => prop.transition)
  for (const cell of stairs.footprint) setCell(hidden, cell.x, cell.y, { revealed: false })
  const state = stateFor(hidden, spotsFor(hidden, { near: false }))
  const resolved = resolveExplorationCommand(state, PARTY[0], 'Поднимаемся по лестнице на второй этаж')
  assert.equal(resolved?.status, 'clarification')
  assert.doesNotMatch(resolved.narration, /комнаты постояльцев|Второй этаж/u, 'нераскрытая лестница не называется')
})

test('фраза без подъёма и спуска к лестнице не относится', () => {
  const map = tavernMap()
  const state = stateFor(map, spotsFor(map, { near: true }))
  for (const phrase of ['Поднимаю упавшую кружку', 'Спускаю собаку с поводка', 'Иду к стойке', 'Поднимаемся наверх по склону к замку', 'Спускаемся вниз к реке']) {
    const resolved = resolveExplorationCommand(state, PARTY[0], phrase)
    assert.ok(!resolved || !(resolved.commands ?? [resolved.command]).some((command) => command?.command_type === 'UseLevelTransition'), phrase)
  }
})
