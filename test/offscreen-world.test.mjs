// «Пока вас не было…»: мир живёт, когда отряд спит.
//
// Проверяется ровно то, чем этот слой отличается от украшения:
//   1. короткий скачок мир не двигает, а существенный — двигает один раз;
//   2. два одинаковых скачка от одного состояния дают один и тот же мир;
//   3. протухшее задание пишет факт памяти, и Режиссёр его находит;
//   4. карточка летописи доезжает столу, а не остаётся у ведущего;
//   5. всё это переживает replay журнала.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  FACTION_MOVE_KINDS,
  OFFSCREEN_CARD_TITLE,
  OFFSCREEN_CARD_TITLE_PREFIX,
  OFFSCREEN_QUEST_EXPIRY_MINUTES,
  OFFSCREEN_STEP_INTERVAL_MINUTES,
  OFFSCREEN_STEP_MINIMUM_MINUTES,
  OFFSCREEN_WORLD_EVENT_TYPE,
  antagonistFactionFor,
  offscreenChronicleEntry,
  offscreenWorldFeed,
  planOffscreenWorldStep,
} from '../server/offscreen-world.mjs'
import { deterministicRecapText, recapSources } from '../server/campaign-recap.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { retrieveWorldMemory } from '../server/world-memory.mjs'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const dice = () => new DiceService({ rng: new SequenceDiceRng([]) })
const options = () => ({ diceService: dice(), context: { isAdmin: true, serverAuthoritativeCombat: true } })
const advance = (state, minutes) => resolveCommand(
  { command_type: 'AdvanceTime', amount: minutes, unit: 'minute', server_authoritative: true },
  state,
  options(),
)
const applyAll = (state, events) => events.reduce((next, event) => applyGameEvent(next, event), state)
const offscreenEvents = (events) => events.filter((event) => event.event_type === OFFSCREEN_WORLD_EVENT_TYPE)

/**
 * Отряд у каравана: одно party-видимое задание с часами, враждебная фракция и
 * двое известных NPC — один в сцене, второй в соседнем селе. Ровно тот минимум,
 * на котором ход мира вообще возможен.
 */
function campaign({ minutes = 0, questClock = { current: 0, max: 4 }, offscreen, reputations = { 'faction-wolves': -30 } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'OFFSCREEN',
    campaign: 'Караван, который не дождался',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12, inventory: [] }],
    scene: { title: 'Двор постоялого', location: 'Тихий Брод', location_id: 'village', cells: [] },
    worldMap: {
      seed: 'offscreen-seed',
      currentLocationId: 'village',
      locations: [
        { id: 'village', name: 'Тихий Брод', kind: 'village', x: 100, y: 300 },
        { id: 'mill', name: 'Мельница', kind: 'landmark', x: 300, y: 300 },
      ],
      routes: [{ id: 'r1', from: 'village', to: 'mill', kind: 'road' }],
    },
    social: {
      npcs: [
        { id: 'innkeeper', name: 'Ждан', role: 'трактирщик', location: 'Тихий Брод', visibility: 'party', public_summary: 'Держит двор.' },
        { id: 'miller', name: 'Мельник Гость', role: 'мельник', location: 'Мельница', visibility: 'party', public_summary: 'Мелет зерно.' },
      ],
    },
    worldMemory: {
      entities: [
        { id: 'faction-wolves', kind: 'faction', name: 'Волчья ватага', summary: 'Ватага на трактах.', visibility: 'party', tags: [] },
      ],
      quests: [{
        id: 'quest-caravan',
        title: 'Караван у брода',
        summary: 'Караван ждёт помощи у брода.',
        status: 'active',
        visibility: 'party',
        entity_ids: [],
        objectives: ['Дойти до каравана'],
        clock: { ...questClock, label: 'Караван ждёт' },
      }],
    },
    autonomy: { reputations },
    mechanics: { world_time: { elapsed_minutes: minutes } },
    ...(offscreen ? { offscreen_world: offscreen } : {}),
  })
}

test('короткий скачок мир не двигает, а продолжительный отдых — двигает', () => {
  const state = campaign()
  assert.equal(planOffscreenWorldStep(state, { elapsedMinutes: OFFSCREEN_STEP_MINIMUM_MINUTES - 1 }), null)
  assert.equal(offscreenEvents(advance(state, 60).events).length, 0)
  assert.equal(offscreenEvents(advance(state, 10).events).length, 0)

  const long = advance(state, OFFSCREEN_STEP_MINIMUM_MINUTES)
  const [step] = offscreenEvents(long.events)
  assert.ok(step, 'продолжительный отдых обязан двигать мир')
  assert.equal(step.visibility, 'party')
  assert.ok(step.payload.step.lines.length >= 1 && step.payload.step.lines.length <= 3)
})

test('два одинаковых скачка от одного состояния дают один и тот же мир', () => {
  const state = campaign()
  const first = advance(state, 720)
  const second = advance(state, 720)
  const strip = (events) => events.map(({ event_type, payload, visibility }) => ({ event_type, payload, visibility }))
  assert.deepEqual(strip(first.events), strip(second.events))
  assert.deepEqual(
    applyAll(campaign(), first.events).offscreen_world,
    applyAll(campaign(), second.events).offscreen_world,
  )
  assert.equal(first.rolls.length, 0, 'ход мира обязан обходиться без костей')
})

test('мир ходит не чаще раза в игровые сутки', () => {
  const state = campaign()
  const night = advance(state, OFFSCREEN_STEP_MINIMUM_MINUTES)
  const rested = applyAll(state, night.events)
  assert.equal(offscreenEvents(night.events).length, 1)

  // Второй отдых в те же сутки: мир уже сходил, и второй катастрофы не будет.
  const sameDay = advance(rested, OFFSCREEN_STEP_MINIMUM_MINUTES)
  assert.equal(offscreenEvents(sameDay.events).length, 0)

  // Следующие сутки — снова ход.
  const nextDay = advance(rested, OFFSCREEN_STEP_INTERVAL_MINUTES)
  assert.equal(offscreenEvents(nextDay.events).length, 1)
})

test('часы задания мир доводит до последнего деления, но развязку оставляет столу', () => {
  let state = campaign({ questClock: { current: 0, max: 3 } })
  const clockOf = (value) => value.worldMemory.quests.find((quest) => quest.id === 'quest-caravan').clock
  for (let day = 0; day < 6; day += 1) {
    state = applyAll(state, advance(state, OFFSCREEN_STEP_INTERVAL_MINUTES).events)
  }
  const clock = clockOf(state)
  assert.equal(clock.max, 3)
  assert.equal(clock.current, 2, 'последнее деление часов ставит стол, а не мир')
  assert.equal(clock.triggered, false)
})

test('заполненные часы сначала попадают под наблюдение, а сутки спустя протухают', () => {
  const state = campaign({ questClock: { current: 4, max: 4 } })
  const watched = applyAll(state, advance(state, OFFSCREEN_STEP_MINIMUM_MINUTES).events)
  assert.deepEqual(watched.offscreen_world.watch.map((entry) => entry.quest_id), ['quest-caravan'])
  assert.equal(watched.worldMemory.quests[0].status, 'active', 'сутки форы Режиссёру обязаны остаться')

  const expiredEvents = advance(watched, OFFSCREEN_QUEST_EXPIRY_MINUTES).events
  const expired = applyAll(watched, expiredEvents)
  assert.equal(expired.worldMemory.quests[0].status, 'failed')

  // Факт памяти мира — то, ради чего протухание вообще нужно: Режиссёр обязан
  // найти его обычным поиском, а не читая ленту ведущего.
  const found = retrieveWorldMemory(expired.worldMemory, { isAdmin: true }, { query: 'караван срок помощи', limit: 8 })
  const fact = found.find((entry) => entry.kind === 'fact' && entry.fact?.predicate === 'quest_deadline_missed')
  assert.ok(fact, 'протухшее задание обязано оставить факт памяти мира')
  assert.match(fact.summary, /срок вышел/u)
  assert.equal(fact.fact.visibility, 'party')
  assert.deepEqual(offscreenEvents(expiredEvents)[0].payload.step.entries.map((entry) => entry.kind).filter((kind) => kind === 'quest_expired'), ['quest_expired'])
})

test('ход фракции-антагониста берётся из закрытого набора и не выдумывает существ', () => {
  const state = campaign()
  const faction = antagonistFactionFor(state)
  assert.equal(faction?.id, 'faction-wolves')

  const plan = planOffscreenWorldStep(state, { elapsedMinutes: 720 })
  const move = plan.step.entries.find((entry) => entry.kind === 'faction_move')
  assert.ok(move, 'враждебная фракция обязана сходить')
  assert.ok(FACTION_MOVE_KINDS.includes(move.move_kind))
  if (move.move_kind === 'took_hostage') {
    assert.ok(['innkeeper', 'miller'].includes(move.npc_id), 'заложник берётся только из известных NPC')
    assert.notEqual(move.npc_id, 'innkeeper', 'NPC текущей сцены за кадром не уводят')
  }
  const spawned = plan.drafts.filter((draft) => ['EntitySpawned', 'EncounterCreated', 'NpcSocialProfileUpserted'].includes(draft.event_type))
  assert.deepEqual(spawned, [], 'ход фракции меняет только память мира — ни стат-блоков, ни новых существ')
})

test('без враждебной фракции мир противника не выдумывает', () => {
  const peaceful = campaign({ reputations: { 'faction-wolves': 15 } })
  assert.equal(antagonistFactionFor(peaceful), null)
  const plan = planOffscreenWorldStep(peaceful, { elapsedMinutes: 720 })
  assert.equal((plan?.step.entries ?? []).some((entry) => entry.kind === 'faction_move'), false)
})

test('карточка «Пока вас не было…» доезжает столу и переживает replay', () => {
  const state = campaign()
  const advanced = advance(state, 720)
  const applied = applyAll(state, advanced.events)

  const entry = offscreenChronicleEntry(offscreenEvents(advanced.events)[0])
  assert.equal(entry.speaker, 'system')
  assert.equal(entry.author, OFFSCREEN_CARD_TITLE)
  assert.ok(entry.offscreen.lines.length >= 1)

  const player = campaignStateForViewer(applied, { role: 'player' }, 'hero')
  assert.ok(player.offscreen_world.steps.length >= 1, 'ход мира обязан быть виден столу')
  assert.deepEqual(player.offscreen_world.steps[0].lines, applied.offscreen_world.steps[0].lines)
  const admin = campaignStateForViewer(applied, { role: 'admin' }, 'hero')
  assert.deepEqual(
    admin.offscreen_world.steps.map((step) => step.id),
    player.offscreen_world.steps.map((step) => step.id),
    'ход мира — монтаж для всего стола: второй формы у него нет',
  )
  assert.ok(admin.offscreen_world.steps[0].entries.every((item) => item.label), 'ведущему подписи приходят готовыми')

  const replayed = replayEvents(state, advanced.events)
  assert.deepEqual(replayed.offscreen_world, applied.offscreen_world)
  assert.deepEqual(offscreenWorldFeed(replayed), offscreenWorldFeed(applied))
})

test('рекап «В прошлой серии» подхватывает ход мира', () => {
  const state = campaign()
  const applied = applyAll(state, advance(state, 720).events)
  const sources = recapSources(applied)
  // Заголовок ищется по началу: память мира приводит текст к NFKC, и `…`
  // ложится в неё тремя точками.
  const summary = sources.summaries.find((item) => item.title.startsWith(OFFSCREEN_CARD_TITLE_PREFIX))
  assert.ok(summary, 'ход мира обязан оставить сводку памяти мира для рекапа')
  assert.equal(summary.summary, applied.offscreen_world.steps.at(-1).lines.join(' '))
  assert.ok(deterministicRecapText(sources).includes(OFFSCREEN_CARD_TITLE_PREFIX))
})

test('ход мира вшит в общий контур мировых минут, а не в отдельный такт', () => {
  const rules = source('server/rules-engine.mjs')
  const block = rules.slice(rules.indexOf('const appendTimeAdvance ='), rules.indexOf('const damageTurnKey ='))
  assert.match(block, /planOffscreenWorldStep\(state, \{ elapsedMinutes \}\)/u)
  // Свой RecordRumor слой не пишет: молву рождает драйвер часов молвы.
  assert.equal(source('server/offscreen-world.mjs').includes("'RecordRumor'"), false)
  // И своих костей у него нет: одинаковый скачок обязан давать одинаковый мир.
  assert.equal(/diceService|\brng\b/u.test(source('server/offscreen-world.mjs')), false)
})
