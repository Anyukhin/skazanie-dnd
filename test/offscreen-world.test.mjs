// «Пока вас не было…»: мир живёт, когда отряд спит.
//
// Проверяется ровно то, чем этот слой отличается от украшения:
//   1. короткий скачок мир не двигает, а существенный — двигает один раз;
//   2. два одинаковых скачка от одного состояния дают один и тот же мир;
//   3. тайные нити ведущего в ход мира не попадают — ни квесты, ни фракции, ни NPC;
//   4. протухшее задание пишет факт памяти, и Режиссёр его находит;
//   5. увод заложника действительно закрывает NPC, а не только говорит об этом;
//   6. карточка летописи доезжает столу, а не остаётся у ведущего;
//   7. всё это переживает replay журнала.
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
import { npcProfileAtWorldTime } from '../server/npc-social.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { planWorldRumorTick } from '../server/world-deeds.mjs'
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
 * Единая метка тайной памяти ведущего. Всё, что помечено ею в фикстуре, обязано
 * остаться за кадром: и в записях хода мира, и в проекции игрока.
 */
const SECRET = 'ТАЙНА-ВЕДУЩЕГО'

/**
 * Отряд у каравана: одно party-видимое задание с часами, враждебная фракция и
 * двое известных NPC — один в сцене, второй в соседнем селе. Ровно тот минимум,
 * на котором ход мира вообще возможен.
 *
 * Рядом с каждым party-видимым участником стоит его тайный двойник: квест,
 * фракция с явным тегом `antagonist` и NPC, который по алфавиту идёт первым
 * среди кандидатов в заложники. Двойники подобраны так, что **выигрывают** у
 * открытых, если снять фильтр видимости, — иначе фикстура молчала бы о трёх
 * фильтрах, на которых держится вся безопасность слоя.
 */
function campaign({
  minutes = 0,
  questClock = { current: 0, max: 4 },
  offscreen,
  reputations = { 'faction-wolves': -30 },
  summaries = [],
  deeds = [],
  merchants = [],
} = {}) {
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
        // `assassin` идёт первым по алфавиту: без фильтра видимости именно его
        // фракция и увела бы, назвав отряду имя, которого он знать не должен.
        { id: 'assassin', name: `Тень ${SECRET}`, role: 'соглядатай', location: 'Мельница', visibility: 'gm_only', public_summary: 'Ходит следом.' },
        { id: 'innkeeper', name: 'Ждан', role: 'трактирщик', location: 'Тихий Брод', visibility: 'party', public_summary: 'Держит двор.' },
        { id: 'miller', name: 'Мельник Гость', role: 'мельник', location: 'Мельница', visibility: 'party', public_summary: 'Мелет зерно.' },
      ],
    },
    worldMemory: {
      entities: [
        // Явная пометка автора выигрывает у славы: без фильтра видимости
        // антагонистом стал бы именно этот культ.
        { id: 'faction-cult', kind: 'faction', name: `Круг ${SECRET}`, summary: 'Тайный культ ведущего.', visibility: 'gm_only', tags: ['antagonist'] },
        { id: 'faction-wolves', kind: 'faction', name: 'Волчья ватага', summary: 'Ватага на трактах.', visibility: 'party', tags: [] },
      ],
      quests: [
        {
          id: 'quest-caravan',
          title: 'Караван у брода',
          summary: 'Караван ждёт помощи у брода.',
          status: 'active',
          visibility: 'party',
          entity_ids: [],
          objectives: ['Дойти до каравана'],
          clock: { ...questClock, label: 'Караван ждёт' },
        },
        {
          id: 'quest-gm-thread',
          title: `Нить ${SECRET}`,
          summary: 'Тайная нить ведущего с собственными часами.',
          status: 'active',
          visibility: 'gm_only',
          entity_ids: [],
          objectives: ['Дождаться новолуния'],
          clock: { current: 0, max: 4, label: 'Новолуние' },
        },
      ],
      summaries,
    },
    autonomy: { reputations },
    mechanics: { world_time: { elapsed_minutes: minutes } },
    ...(merchants.length ? { merchants } : {}),
    ...(deeds.length ? { world_deeds: { deeds } } : {}),
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

test('скачок любой длины даёт ровно один ход мира', () => {
  // Оба порога считают разрыв между ходами, а не длину скачка: одна команда
  // времени — не больше одного хода. Месяц под замком двигает часы задания на
  // одно деление, ровно как ночёвка. Это решение, а не побочный эффект:
  // иначе месячный скачок выдал бы столу тридцать врезок разом и провалил бы
  // все открытые задания в одном коммите, ни разу не спросив стол.
  const month = advance(campaign(), OFFSCREEN_STEP_INTERVAL_MINUTES * 30)
  assert.equal(offscreenEvents(month.events).length, 1)
  assert.equal(month.events.filter((event) => event.event_type === 'QuestClockAdvanced').length, 1)

  const night = advance(campaign(), OFFSCREEN_STEP_MINIMUM_MINUTES)
  assert.equal(offscreenEvents(night.events).length, 1)
  assert.equal(night.events.filter((event) => event.event_type === 'QuestClockAdvanced').length, 1)

  // Разрыв всё же считается: следующая команда через сутки снова двигает мир.
  const after = applyAll(campaign(), month.events)
  assert.equal(offscreenEvents(advance(after, OFFSCREEN_STEP_INTERVAL_MINUTES).events).length, 1)
})

test('тайные нити ведущего в ход мира не попадают', () => {
  // Три фильтра `visibleToParty` — единственное, что отделяет монтаж для стола
  // от слива кампании: `offscreen_world` уезжает игроку той же лентой, что и
  // ведущему, поэтому утечка была бы сквозной и молчаливой.
  const state = campaign()
  assert.equal(antagonistFactionFor(state)?.id, 'faction-wolves', 'помеченный тегом, но тайный культ антагонистом не становится')

  let current = state
  const entries = []
  const events = []
  for (let day = 0; day < 6; day += 1) {
    const resolved = advance(current, OFFSCREEN_STEP_INTERVAL_MINUTES).events
    events.push(...resolved)
    entries.push(...(offscreenEvents(resolved)[0]?.payload.step.entries ?? []))
    current = applyAll(current, resolved)
  }

  assert.deepEqual([...new Set(entries.filter((entry) => entry.quest_id).map((entry) => entry.quest_id))], ['quest-caravan'])
  assert.deepEqual([...new Set(entries.filter((entry) => entry.faction_id).map((entry) => entry.faction_id))], ['faction-wolves'])
  assert.deepEqual([...new Set(entries.filter((entry) => entry.npc_id).map((entry) => entry.npc_id))], ['miller'])
  assert.equal(current.worldMemory.quests.find((quest) => quest.id === 'quest-gm-thread').clock.current, 0, 'часы тайной нити мир не двигает')
  assert.equal(current.social.npcs.find((npc) => npc.id === 'assassin').available, true, 'тайного NPC за кадром не уводят')

  // И ни одна строка ленты, ни одно событие хода, ни одна проекция не называет
  // тайное даже по имени: имена — это ровно то, чем «тема кампании» входит в
  // текст карточки.
  const player = campaignStateForViewer(current, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  const admin = campaignStateForViewer(current, { id: 'user-gm', role: 'admin', heroIds: [] }, '')
  for (const [what, value] of [
    ['записи ленты', entries],
    ['события хода мира', events.filter((event) => offscreenEvents([event]).length || event.event_type.startsWith('Quest') || event.event_type.startsWith('World') || event.event_type === 'NarrativeSummaryRecorded')],
    ['проекция игрока', player.offscreen_world],
    ['проекция ведущего', admin.offscreen_world],
  ]) {
    assert.equal(JSON.stringify(value).includes(SECRET), false, `тайная память ведущего утекла в ${what}`)
  }
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
  const spawned = plan.drafts.filter((draft) => ['EntitySpawned', 'EncounterCreated', 'NpcPlaced'].includes(draft.event_type))
  assert.deepEqual(spawned, [], 'ход фракции не заводит ни стат-блоков, ни новых существ, ни фигур на доске')
  // Профиль NPC — единственное, что ход правит помимо памяти мира, и только
  // при уводе: он гасит доступность уже известного NPC, а не создаёт нового.
  const profiles = plan.drafts.filter((draft) => draft.event_type === 'NpcSocialProfileUpserted')
  assert.equal(profiles.length, move.move_kind === 'took_hostage' ? 1 : 0)
  for (const draft of profiles) {
    assert.equal(draft.payload.npc.id, move.npc_id)
    assert.equal(draft.payload.npc.available, false)
  }
})

test('увод заложника действительно закрывает NPC, а не только говорит об этом', () => {
  // Расписание у мельника — «утром на мельнице, доступен»: без его гашения
  // `npcProfileAtWorldTime` вернул бы уведённого к людям в ближайшую смену.
  // Торговец `baker` идёт по алфавиту раньше мельника и без отдельного фильтра
  // ушёл бы в заложники первым — а его доступность пересобирается из
  // `state.merchants` при каждой нормализации, и обещание карточки не сбылось бы.
  const base = campaign({ merchants: [{ id: 'baker', name: 'Пекарь Милана', title: 'пекарь', location: 'Мельница', description: 'Печёт хлеб.', inventory: [] }] })
  const state = normalizeCampaignState({
    ...base,
    social: {
      ...base.social,
      npcs: base.social.npcs.map((npc) => npc.id === 'miller'
        ? { ...npc, schedule: [{ id: 'day', days: [], start_minute: 0, end_minute: 1_439, location: 'Мельница', available: true, summary: 'У жерновов', visibility: 'party' }] }
        : npc),
    },
  })

  let current = state
  let taken = null
  const journal = []
  for (let day = 0; day < 8 && !taken; day += 1) {
    const events = advance(current, OFFSCREEN_STEP_INTERVAL_MINUTES).events
    journal.push(...events)
    current = applyAll(current, events)
    taken = offscreenEvents(events)[0]?.payload.step.entries
      .find((entry) => entry.kind === 'faction_move' && entry.move_kind === 'took_hostage') ?? null
  }
  assert.ok(taken, 'на восьми сутках фракция обязана дойти до увода заложника')
  assert.equal(taken.npc_id, 'miller', 'торговца за кадром не уводят: его доступность пересобирается из лавки')
  assert.equal(current.social.npcs.find((npc) => npc.id === 'baker').available, true)

  // `available` — живой контракт: его читают `available_npcs` Режиссёра, разбор
  // намерения, адъюдикаторы свободного действия и политика цикла. Пока он
  // `true`, уведённый NPC выйдет к отряду в следующей же сцене.
  const hostage = current.social.npcs.find((npc) => npc.id === 'miller')
  assert.equal(hostage.available, false, 'уведённый NPC обязан стать недоступным')
  assert.deepEqual(hostage.schedule.map((entry) => entry.available), [false], 'расписание не должно вернуть уведённого к людям')
  assert.equal(current.social.npcs.find((npc) => npc.id === 'innkeeper').available, true, 'остальных ход не трогает')

  // Доступность сервер читает не из записи, а из её проекции на текущий час
  // (`npcProfileAtWorldTime`): активная запись расписания перебивает поле
  // профиля, поэтому проверяется весь круг суток, а не одна минута.
  for (const minute of [0, 480, 900, 1_439]) {
    assert.equal(npcProfileAtWorldTime(hostage, minute).available, false, `уведённый снова доступен на минуте ${minute}`)
  }
  const player = campaignStateForViewer(current, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')
  assert.equal(player.social.npcs.find((npc) => npc.id === 'miller').available, false, 'стол видит уведённого недоступным')

  // Недоступность — свойство журнала, а не памяти процесса: replay обязан
  // восстановить её без обращения к планировщику.
  const replayed = replayEvents(state, journal)
  assert.deepEqual(
    replayed.social.npcs.map((npc) => [npc.id, npc.available]),
    current.social.npcs.map((npc) => [npc.id, npc.available]),
  )

  // Дважды одного и того же не уводят, и профиль второй раз не переписывается.
  const again = advance(current, OFFSCREEN_STEP_INTERVAL_MINUTES).events
  const repeat = offscreenEvents(again)[0]?.payload.step.entries
    .find((entry) => entry.kind === 'faction_move' && entry.move_kind === 'took_hostage')
  assert.equal(repeat, undefined)
  assert.deepEqual(again.filter((event) => event.event_type === 'NpcSocialProfileUpserted'), [])
})

test('формулировки ходов фракции идут по кругу и не повторяются дословно подряд', () => {
  // Набор ходов закрытый, и на длинной кампании он вырождается: известные NPC
  // кончаются, и остаются два хода. Это осознанный потолок слоя — но лента
  // ведущего не должна повторять одну и ту же строку слово в слово.
  let state = campaign()
  const moves = []
  for (let day = 0; day < 6; day += 1) {
    const events = advance(state, OFFSCREEN_STEP_INTERVAL_MINUTES).events
    state = applyAll(state, events)
    const move = offscreenEvents(events)[0]?.payload.step.entries.find((entry) => entry.kind === 'faction_move')
    assert.ok(move, 'враждебная фракция ходит каждый ход мира')
    moves.push(move)
  }
  assert.deepEqual([...new Set(moves.map((move) => move.move_kind))].sort(), ['moved_camp', 'reinforced_posts', 'took_hostage'])
  for (let index = 1; index < moves.length; index += 1) {
    assert.notEqual(moves[index].summary, moves[index - 1].summary, 'дословный повтор в ленте читается как залипший движок')
  }
  const repeated = moves.filter((move) => move.move_kind === 'reinforced_posts')
  assert.ok(repeated.length >= 3, 'вырождение до одного вида на длинной кампании — часть проверки')
  assert.ok(new Set(repeated.map((move) => move.summary)).size >= 3, 'у самого частого хода обязано быть несколько формулировок')
})

test('без враждебной фракции мир противника не выдумывает', () => {
  const peaceful = campaign({ reputations: { 'faction-wolves': 15 } })
  assert.equal(antagonistFactionFor(peaceful), null)
  const plan = planOffscreenWorldStep(peaceful, { elapsedMinutes: 720 })
  assert.equal((plan?.step.entries ?? []).some((entry) => entry.kind === 'faction_move'), false)
})

test('число в строке молвы совпадает с тем, что запишет такт молвы', () => {
  // Это единственная цифра, которую карточка показывает столу как факт, и
  // одновременно прогноз: записывать слухи будет другой контур
  // (`planWorldRumorTick` под драйвером `nudgeWorldClocks`). Расхождение
  // прогноза и записи прошло бы молча, поэтому счётчики сверяются напрямую.
  const deed = {
    id: 'deed-brod',
    kind: 'rescue',
    actor_ids: ['hero'],
    actor_names: ['Ада'],
    subject: 'обоз у брода',
    location_id: 'village',
    location_name: 'Тихий Брод',
    at_minutes: 0,
    witness_ids: ['hero'],
    summary: 'Отряд отбил обоз у брода.',
    source_event_ids: [],
    spread_at_minutes: 600,
  }
  const state = campaign({ deeds: [deed] })
  const rumorsAt = (minutes) => planWorldRumorTick(state, { worldMinute: minutes })
    .commands.filter((command) => command.command_type === 'RecordRumor').length

  // К минуте команды молва ещё никуда не дошла: счёт по текущей минуте вместо
  // минуты прибытия оставил бы карточку немой.
  assert.equal(rumorsAt(0), 0)

  const plan = planOffscreenWorldStep(state, { elapsedMinutes: 720 })
  const rumor = plan.step.entries.find((entry) => entry.kind === 'rumor_spread')
  assert.ok(rumor, 'дошедшая к утру молва обязана попасть в карточку')
  assert.equal(rumor.count, rumorsAt(720), 'карточка называет ровно столько ушей, сколько запишет такт молвы')
  assert.match(rumor.summary, new RegExp(`${rumor.count}|одного человека`, 'u'))

  // Через двое суток слух перевалит через соседний узел, и счёт вырастет.
  const later = planOffscreenWorldStep(campaign({ deeds: [deed], minutes: 1_440 }), { elapsedMinutes: 720 })
  const grown = later.step.entries.find((entry) => entry.kind === 'rumor_spread')
  assert.equal(grown.count, rumorsAt(2_160))
  assert.ok(grown.count > rumor.count, 'счёт обязан следовать за минутой, а не быть константой')
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

test('рекап «В прошлой серии» подхватывает ход мира, не вытесняя дела отряда', () => {
  // Сводки стола: два вечера живой игры до череды ночёвок.
  const table = [
    { id: 'summary:gate', kind: 'scene', title: 'Северные ворота', summary: 'Отряд нашёл синюю нить на засове.', visibility: 'party', entity_ids: [], thread_ids: [], source_event_ids: [], recorded_at_minutes: 0 },
    { id: 'summary:inn', kind: 'scene', title: 'Двор постоялого', summary: 'Отряд сговорился с трактирщиком о лошадях.', visibility: 'party', entity_ids: [], thread_ids: [], source_event_ids: [], recorded_at_minutes: 0 },
  ]
  const state = campaign({ summaries: table })
  const applied = applyAll(state, advance(state, 720).events)
  const sources = recapSources(applied)
  // Заголовок ищется по началу: память мира приводит текст к NFKC, и `…`
  // ложится в неё тремя точками.
  const summary = sources.summaries.find((item) => item.title.startsWith(OFFSCREEN_CARD_TITLE_PREFIX))
  assert.ok(summary, 'ход мира обязан оставить сводку памяти мира для рекапа')
  assert.equal(summary.summary, applied.offscreen_world.steps.at(-1).lines.join(' '))
  assert.ok(deterministicRecapText(sources).includes(OFFSCREEN_CARD_TITLE_PREFIX))

  // Три ночёвки подряд — обычный конец игрового вечера. Детерминированный
  // рекап берёт всего три последние сводки, и без свёртки рубрики «В прошлой
  // серии» открылось бы тремя врезками «Пока вас не было…» подряд, вытеснив
  // всё, что делал стол.
  let rested = applied
  for (let night = 0; night < 2; night += 1) {
    rested = applyAll(rested, advance(rested, OFFSCREEN_STEP_INTERVAL_MINUTES).events)
  }
  const afterNights = recapSources(rested)
  const offscreenCount = afterNights.summaries.filter((item) => item.title.startsWith(OFFSCREEN_CARD_TITLE_PREFIX)).length
  assert.equal(offscreenCount, 1, 'из повторяющейся рубрики в рекапе остаётся только свежая запись')
  assert.equal(
    afterNights.summaries.find((item) => item.title.startsWith(OFFSCREEN_CARD_TITLE_PREFIX)).summary,
    rested.offscreen_world.steps.at(-1).lines.join(' '),
    'и это именно последний ход мира, а не первый',
  )

  const text = deterministicRecapText(afterNights)
  assert.ok(text.includes('синюю нить'), 'дела отряда обязаны пережить череду ночёвок')
  assert.ok(text.includes('о лошадях'))
  assert.ok(text.includes(OFFSCREEN_CARD_TITLE_PREFIX))
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
