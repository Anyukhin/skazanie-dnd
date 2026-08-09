import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTLEMENT_LOCATION_KINDS as CAPTIVE_SETTLEMENT_KINDS } from '../server/captives.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST, assembleEncounter } from '../server/encounter-assembler.mjs'
import { currencyToCopper } from '../server/merchant-economy.mjs'
import {
  GUARD_CUSTODY_MINUTES,
  GUARD_ENCOUNTER_DIFFICULTY,
  GUARD_ENCOUNTER_THEME,
  SETTLEMENT_LOCATION_KINDS,
  WANTED_DECAY_MINUTES,
  WANTED_ESCAPE_FAILURE_POINTS,
  WANTED_FINE_CP,
  WANTED_LEVEL_THRESHOLDS,
  guardEncounterFor,
  guardOptionsFor,
  normalizeLawState,
  wantedFeed,
  wantedFor,
  wantedLevelHere,
  wantedSignsFor,
} from '../server/law-and-order.mjs'
import { reputationStandingFor } from '../server/reputation-policy.mjs'
import {
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommands,
} from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const VILLAGE = 'Тихий Брод'
const ROAD = 'Старый тракт'
const CAPITAL = 'Стольный Град'
const FAR_CITY = 'Дальний Град'
const NORTH = 'north'

/**
 * Кого закон вправе выставить у ворот. Список тут повторён нарочно: тест
 * проверяет не «тема совпала», а «пришли люди закона». Пока стража собиралась
 * из темы `warband`, деревенского стражника изображал шипастый дьявол.
 */
const LAW_STAT_BLOCK_IDS = [
  'srd_5_2_1:scout', 'srd_5_2_1:spy', 'srd_5_2_1:warrior-veteran',
  'srd_5_2_1:knight', 'srd_5_2_1:guard-captain',
]
const LAW_NAMES = new Set(LAW_STAT_BLOCK_IDS.map((id) => SRD_5_2_1_MONSTER_ALLOWLIST[id].name))

/** Кубик с заранее заданной последовательностью d20: проверки детерминированы. */
function dice(sequence = []) {
  return new DiceService({ rng: new SequenceDiceRng(sequence) })
}

/**
 * Граф мира задан явно, с тремя краями: `normalizeRegions` принимает список
 * только от трёх записей, а ниже нужна пара «здесь» и «в другом краю».
 */
function worldMap() {
  return {
    seed: 'law-seed',
    regions: [
      { id: NORTH, name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
      { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
      { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
    ],
    locations: [
      { id: 'village', name: VILLAGE, kind: 'village', x: 200, y: 200, regionId: NORTH },
      { id: 'road', name: ROAD, kind: 'landmark', x: 260, y: 240, regionId: NORTH },
      { id: 'capital', name: CAPITAL, kind: 'capital', x: 150, y: 160, regionId: NORTH },
      { id: 'farcity', name: FAR_CITY, kind: 'city', x: 820, y: 300, regionId: 'east' },
    ],
    routes: [
      { id: 'r1', from: 'village', to: 'road', kind: 'road' },
      { id: 'r2', from: 'road', to: 'farcity', kind: 'road' },
      { id: 'r3', from: 'road', to: 'capital', kind: 'road' },
    ],
  }
}

/** Поле 16×16 раскрытых клеток: столкновению нужно куда ставить стражу. */
function cells() {
  const grid = []
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) grid.push({ x, y, type: 'floor', revealed: true })
  }
  return grid
}

function villager(id, name, location = VILLAGE) {
  return {
    id, name, role: 'житель', location, visibility: 'party',
    public_summary: `${name} живёт в «${location}».`,
    tags: ['faction:brod-folk'],
  }
}

function campaign({ minutes = 0, npcs = [], locationId = 'village', location = VILLAGE, currency } = {}) {
  return normalizeCampaignState({
    sessionCode: 'LAW',
    campaign: 'Закон и розыск',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'mate'],
    partyName: 'Отряд героев',
    scene: { title: 'Площадь', location, location_id: locationId, cells: cells() },
    players: [
      { id: 'hero', character: 'Ада', level: 1, hp: 10, maxHp: 10, x: 2, y: 2, inventory: [], abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 }, currency: currency ?? { copper: 0, silver: 0, gold: 100, platinum: 0 } },
      { id: 'mate', character: 'Бор', level: 1, hp: 10, maxHp: 10, x: 3, y: 2, inventory: [], abilities: { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } },
    ],
    worldMap: worldMap(),
    social: { npcs },
    mechanics: { world_time: { elapsed_minutes: minutes } },
  })
}

/**
 * Кража на людях: свидетелями летопись поступков считает живых NPC сцены,
 * поэтому фикстура с жителями и без них отличается ровно этим.
 */
function theftEvent({ id = 'evt-theft', commandId = 'cmd-theft', propId = 'chest-1' } = {}) {
  return {
    event_id: id,
    command_id: commandId,
    event_type: 'SceneObjectOperated',
    actor_id: 'hero',
    target_ids: [],
    payload: { prop_id: propId, kind: 'container', intent: 'take' },
    visibility: 'party',
  }
}

function murderEvent({ id = 'evt-murder', commandId = 'cmd-murder', npcId = 'victim' } = {}) {
  return {
    event_id: id,
    command_id: commandId,
    event_type: 'NpcDied',
    actor_id: 'hero',
    target_ids: [npcId],
    payload: { npc_id: npcId, npc_name: 'Возчик Сём', source_actor_id: 'hero', trigger: 'server-collateral' },
    visibility: 'party',
  }
}

function arsonEvent({ id = 'evt-arson', commandId = 'cmd-arson' } = {}) {
  return {
    event_id: id,
    command_id: commandId,
    event_type: 'SceneObjectOperated',
    actor_id: 'hero',
    target_ids: [],
    payload: { prop_id: 'hay-1', kind: 'furnishing', intent: 'ignite' },
    visibility: 'party',
  }
}

/**
 * Кампания со свидетелями: жители стоят там же, где отряд, — иначе поступок
 * останется тайной, и закону нечего будет считать.
 */
function witnessed({ minutes = 0, location = VILLAGE, ...rest } = {}) {
  return campaign({
    minutes,
    location,
    npcs: [villager('baker', 'Пекарь Мила', location), villager('smith', 'Кузнец Гор', location)],
    ...rest,
  })
}

/** Ставит стражу перед отрядом тем же событием, которым это делает движок. */
function withGuardEncounter(state, { commandId = 'cmd-enter' } = {}) {
  return applyGameEvent(state, {
    event_id: `evt-guard:${commandId}`,
    command_id: commandId,
    event_type: 'GuardEncounterStarted',
    actor_id: 'hero',
    target_ids: [],
    payload: {
      encounter: {
        id: `guard-encounter:${commandId}`,
        region_id: NORTH,
        region_name: 'Северный край',
        node_id: 'village',
        place_name: VILLAGE,
        level: wantedFor(state, NORTH).level,
        fine_cp: WANTED_FINE_CP[wantedFor(state, NORTH).level] ?? 500,
        officer_name: 'Радим',
        officer_rank: 'десятник стражи',
        demand: '«Погодите-ка».',
        escape_dc: 11,
        escape_attempts: 0,
        started_at_minutes: Math.max(0, Number(state.mechanics?.world_time?.elapsed_minutes ?? 0)),
      },
    },
    visibility: 'party',
  })
}

// ---------------------------------------------------------------------------
// Ступень, свидетели, затухание
// ---------------------------------------------------------------------------

test('преступление без свидетелей не двигает розыск', () => {
  const empty = applyGameEvent(campaign(), theftEvent())
  assert.equal(empty.world_deeds.deeds.length, 0, 'кража без свидетелей поступком не считается')
  assert.equal(empty.law.crimes.length, 0)
  assert.equal(wantedLevelHere(empty), 0)

  const seen = applyGameEvent(witnessed(), theftEvent())
  assert.deepEqual(seen.world_deeds.deeds.map((deed) => deed.kind), ['theft'])
  assert.deepEqual(seen.law.crimes.map((crime) => crime.kind), ['theft'])
  assert.equal(wantedLevelHere(seen), 1)
})

/**
 * Сторож главного правила шага. Кража без живых NPC поступка не заводит вовсе,
 * поэтому проба выше до отсечки по свидетелям попросту не доходит: с убранной
 * строкой `if (deed.secret === true) return null` она осталась бы зелёной.
 * Убийство в пустой сцене поступок заводит — тайный, — и ловит именно эту
 * строку: без неё закон дал бы crime `murder` и вторую ступень розыска.
 */
test('тайный поступок ступень не двигает: убийство без свидетелей закону не достаётся', () => {
  const alone = applyGameEvent(campaign(), murderEvent())
  const deed = alone.world_deeds.deeds.at(-1)
  assert.equal(deed.kind, 'murder', 'летопись поступок заводит: ведущий про нож знает')
  assert.equal(deed.secret, true, 'и помечает его тайным — свидетелей не было')
  assert.deepEqual(alone.law.crimes, [], 'а закону тёмного переулка не достаётся')
  assert.equal(wantedLevelHere(alone), 0)
  assert.equal(wantedFor(alone, NORTH).points, 0)

  // Тот же нож при свидетелях — уже преступление, и разница ровно в них.
  const seen = applyGameEvent(witnessed(), murderEvent())
  assert.equal(seen.world_deeds.deeds.at(-1).secret, false)
  assert.deepEqual(seen.law.crimes.map((crime) => crime.kind), ['murder'])
  assert.equal(wantedFor(seen, NORTH).level, 2)
})

test('ступень растёт по тяжести, а не по числу поступков', () => {
  const theft = applyGameEvent(witnessed(), theftEvent())
  assert.equal(wantedFor(theft, NORTH).points, 2)
  assert.equal(wantedFor(theft, NORTH).level, 1)

  const murder = applyGameEvent(witnessed(), murderEvent())
  assert.equal(wantedFor(murder, NORTH).points, 4)
  assert.equal(wantedFor(murder, NORTH).level, 2, 'одно убийство весит больше двух краж')

  const both = applyGameEvent(murder, arsonEvent())
  assert.equal(wantedFor(both, NORTH).points, 7)
  assert.equal(wantedFor(both, NORTH).level, 3)
  assert.equal(wantedFor(both, NORTH).label, 'розыск по краю')
})

test('розыск принадлежит краю, а не улице: в другом крае отряд чист', () => {
  const state = applyGameEvent(witnessed(), murderEvent())
  assert.equal(wantedFor(state, NORTH).level, 2)
  assert.equal(wantedFor(state, 'east').level, 0)
  assert.equal(wantedFor(state, 'east').points, 0)
})

test('сутки без новых преступлений снимают очко, и розыск затухает до нуля', () => {
  const crime = applyGameEvent(witnessed(), murderEvent())
  assert.equal(wantedFor(crime, NORTH).points, 4)

  const tick = (minutes) => wantedFor({
    ...crime,
    mechanics: { ...crime.mechanics, world_time: { amount: minutes, unit: 'minute', elapsed_minutes: minutes } },
  }, NORTH)

  assert.equal(tick(WANTED_DECAY_MINUTES - 1).points, 4, 'до конца суток счёт не тает')
  assert.equal(tick(WANTED_DECAY_MINUTES).points, 3)
  assert.equal(tick(WANTED_DECAY_MINUTES * 2).level, 1)
  assert.equal(tick(WANTED_DECAY_MINUTES * 4).points, 0)
  assert.equal(tick(WANTED_DECAY_MINUTES * 4).level, 0)
})

test('новое преступление отменяет накопленное затухание', () => {
  const first = applyGameEvent(witnessed(), murderEvent())
  const quiet = {
    ...first,
    mechanics: { ...first.mechanics, world_time: { amount: WANTED_DECAY_MINUTES * 3, unit: 'minute', elapsed_minutes: WANTED_DECAY_MINUTES * 3 } },
  }
  assert.equal(wantedFor(quiet, NORTH).points, 1)
  const again = applyGameEvent(quiet, theftEvent())
  assert.equal(wantedFor(again, NORTH).points, 6, 'счёт снова полный: затухание считается от последнего преступления')
})

// ---------------------------------------------------------------------------
// Встреча со стражей
// ---------------------------------------------------------------------------

test('вход в поселение с розыском поднимает стражу, а без розыска — нет', () => {
  const clean = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-clean',
    campaign_id: 'LAW',
    scene_args: { location: VILLAGE, title: 'Ворота', objective: 'Осмотреться' },
  }], campaign({ locationId: 'road', location: ROAD }), { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })
  assert.ok(!clean.events.some((event) => event.event_type === 'GuardEncounterStarted'))

  // Убийство на тракте — тот же край, что и деревня: закон помнит краем.
  const guilty = applyGameEvent(witnessed({ locationId: 'road', location: ROAD }), murderEvent())
  assert.equal(wantedFor(guilty, NORTH).level, 2)
  const met = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-enter',
    campaign_id: 'LAW',
    scene_args: { location: VILLAGE, title: 'Ворота', objective: 'Осмотреться' },
  }], guilty, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })

  const started = met.events.find((event) => event.event_type === 'GuardEncounterStarted')
  assert.ok(started, 'стража выходит навстречу при входе в поселение')
  assert.equal(started.payload.encounter.level, 2)
  assert.equal(started.payload.encounter.fine_cp, WANTED_FINE_CP[2])
  assert.ok(started.payload.encounter.officer_name, 'у офицера есть имя')
  assert.deepEqual(guardOptionsFor(started.payload.encounter).map((option) => option.id), ['fine', 'surrender', 'flee', 'fight'])
  assert.ok(guardEncounterFor(met.state), 'встреча остаётся открытой до ответа')
})

test('в столице закон тоже есть: вход поднимает стражу', () => {
  assert.ok(SETTLEMENT_LOCATION_KINDS.has('capital'), 'столица — такой же вид узла карты мира')
  const guilty = applyGameEvent(witnessed({ locationId: 'road', location: ROAD }), murderEvent())
  const met = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-capital',
    campaign_id: 'LAW',
    scene_args: { location: CAPITAL, title: 'Ворота столицы', objective: 'Осмотреться' },
  }], guilty, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })

  const started = met.events.find((event) => event.event_type === 'GuardEncounterStarted')
  assert.ok(started, 'в самом людном городе края стража обязана выйти навстречу')
  assert.equal(started.payload.encounter.place_name, CAPITAL)
})

test('виды поселений у закона и у плена — одно множество', () => {
  // Две копии живут в двух модулях-листьях намеренно: они друг друга не
  // импортируют. Расхождение молча ломало бы то одно правило, то другое.
  assert.deepEqual([...SETTLEMENT_LOCATION_KINDS].sort(), [...CAPTIVE_SETTLEMENT_KINDS].sort())
})

test('от стражи не уходят сменой сцены', () => {
  const stopped = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  assert.throws(() => resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-walk-away',
    campaign_id: 'LAW',
    scene_args: { location: ROAD, title: 'Тракт', objective: 'Уйти' },
  }], stopped, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } }),
  /GUARD_ENCOUNTER_BLOCKS_SCENE|никуда не уходит/u)
})

test('встреча, оставшаяся в чужом краю, закон не выключает и ответа не принимает', () => {
  // Состояние, в котором стража открыта в деревне, а отряд уже в другом краю:
  // так выглядит старое сохранение и рука ведущего. Закон обязан пережить это.
  const stopped = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  const elsewhere = {
    ...stopped,
    scene: { ...stopped.scene, location: FAR_CITY, location_id: 'farcity' },
    worldMap: { ...stopped.worldMap, currentLocationId: 'farcity' },
    social: { ...stopped.social, npcs: [villager('clerk', 'Писец Ольд', FAR_CITY)] },
  }
  const guiltyHere = applyGameEvent(elsewhere, murderEvent({ id: 'evt-far', commandId: 'cmd-far', npcId: 'victim-2' }))
  assert.equal(wantedFor(guiltyHere, 'east').level, 2, 'в новом краю за отрядом числится своё')
  assert.ok(guardEncounterFor(guiltyHere), 'старая встреча всё ещё лежит в состоянии')

  // Виру нельзя заплатить офицеру, оставшемуся в покинутом крае.
  assert.throws(() => resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fine',
    command_id: 'cmd-remote-fine',
    campaign_id: 'LAW',
  }], guiltyHere, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), /GUARD_ENCOUNTER_ELSEWHERE|в другом месте/u)

  // И закон в новом краю не выключен: у тамошних ворот встаёт своя стража.
  const met = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-enter-far',
    campaign_id: 'LAW',
    scene_args: { location: FAR_CITY, title: 'Ворота', objective: 'Осмотреться' },
  }], guiltyHere, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })
  const started = met.events.find((event) => event.event_type === 'GuardEncounterStarted')
  assert.ok(started, 'чужая незакрытая встреча новую не запирает')
  assert.equal(started.payload.encounter.region_id, 'east')
  assert.equal(guardEncounterFor(met.state).region_id, 'east', 'открытой числится встреча здешней стражи')
})

test('посреди боя страже не отвечают ни одним из четырёх исходов', () => {
  const stopped = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  const fighting = {
    ...stopped,
    mechanics: { ...stopped.mechanics, combat: { ...stopped.mechanics.combat, active: true, round: 2 } },
  }
  for (const resolution of ['fine', 'surrender', 'flee', 'fight']) {
    assert.throws(() => resolveCommands([{
      command_type: 'ResolveGuardEncounter',
      actor_id: 'mate',
      resolution,
      skill: 'stealth',
      command_id: `cmd-mid-combat-${resolution}`,
      campaign_id: 'LAW',
    }], fighting, { diceService: dice([18, 18]), context: { allowedActorIds: ['hero', 'mate'] } }),
    /GUARD_ENCOUNTER_DURING_COMBAT|идёт бой/u, `исход ${resolution} прошёл посреди боя`)
  }
  // Именно из-за этого сдача была опасна: она двигала мировые часы на сутки
  // прямо в раунде, не закрывая боя.
  assert.equal(fighting.mechanics.world_time.elapsed_minutes, 0)
  assert.ok(guardEncounterFor(fighting), 'и встреча остаётся открытой')
})

test('вира снимает розыск и списывает монеты', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  const before = guardEncounterFor(state)
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fine',
    command_id: 'cmd-fine',
    campaign_id: 'LAW',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  const resolved = result.events.find((event) => event.event_type === 'GuardEncounterResolved')
  assert.equal(resolved.payload.paid_cp, before.fine_cp)
  assert.ok(result.events.some((event) => event.event_type === 'WantedCleared' && event.payload.reason === 'fine'))
  assert.equal(wantedFor(result.state, NORTH).level, 0)
  assert.equal(guardEncounterFor(result.state), null)
  assert.equal(resolved.payload.balance_after_cp, 10_000 - before.fine_cp)
  assert.equal(currencyToCopper(result.state.players.find((player) => player.id === 'hero').currency), 10_000 - before.fine_cp)
})

test('без монет виру не платят', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed({ currency: { copper: 3, silver: 0, gold: 0, platinum: 0 } }), murderEvent()))
  assert.throws(() => resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fine',
    command_id: 'cmd-broke',
    campaign_id: 'LAW',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), /INSUFFICIENT_FUNDS|хватает/u)
})

test('сдача забирает кошель, отнимает время кампании и снимает розыск', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed({ currency: { copper: 0, silver: 0, gold: 3, platinum: 0 } }), murderEvent()))
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'surrender',
    command_id: 'cmd-surrender',
    campaign_id: 'LAW',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  const resolved = result.events.find((event) => event.event_type === 'GuardEncounterResolved')
  assert.equal(resolved.payload.paid_cp, 300, 'изымают всё, что нашлось, но не больше виры')
  assert.equal(resolved.payload.custody_minutes, GUARD_CUSTODY_MINUTES)
  assert.equal(currencyToCopper(result.state.players.find((player) => player.id === 'hero').currency), 0)
  assert.equal(result.state.mechanics.world_time.elapsed_minutes, GUARD_CUSTODY_MINUTES)
  assert.equal(wantedFor(result.state, NORTH).level, 0)
  assert.equal(guardEncounterFor(result.state), null)
})

test('драка со стражей поднимает розыск до предела и ставит противников на доску', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed(), theftEvent()))
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fight',
    command_id: 'cmd-fight',
    campaign_id: 'LAW',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  assert.ok(result.events.some((event) => event.event_type === 'EncounterCreated'), 'бой собирается существующим ассемблером')
  const created = result.events.find((event) => event.event_type === 'EncounterCreated')
  assert.equal(created.payload.encounter.theme, 'law', 'у стражи свой ростер из существующих стат-блоков')
  assert.ok(created.payload.encounter.enemies.length > 0)
  for (const enemy of created.payload.encounter.enemies) {
    assert.ok(LAW_NAMES.has(String(enemy.name).replace(/\s+\d+$/u, '')), `у ворот встал не человек закона: ${enemy.name}`)
  }
  assert.equal(wantedFor(result.state, NORTH).level, 3)
  // Счёт встаёт ровно на порог, а не выше: иначе затухание тянулось бы дольше
  // задуманного, и старые подтаявшие дела вернулись бы в счёт вторым разом.
  assert.equal(wantedFor(result.state, NORTH).points, WANTED_LEVEL_THRESHOLDS[3])
  assert.equal(guardEncounterFor(result.state), null)
})

test('драка после подтаявшего розыска не возвращает в счёт забытое краем', () => {
  const old = applyGameEvent(witnessed(), murderEvent())
  const quiet = {
    ...old,
    mechanics: { ...old.mechanics, world_time: { amount: WANTED_DECAY_MINUTES * 4, unit: 'minute', elapsed_minutes: WANTED_DECAY_MINUTES * 4 } },
  }
  assert.equal(wantedFor(quiet, NORTH).points, 0, 'край успел забыть')
  // Стража всё же остановила отряд: встреча заводится отдельным событием, а
  // ступень к этому моменту уже подтаяла до нуля.
  const stopped = withGuardEncounter(quiet, { commandId: 'cmd-old' })
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fight',
    command_id: 'cmd-fight-old',
    campaign_id: 'LAW',
  }], stopped, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  assert.equal(wantedFor(result.state, NORTH).points, WANTED_LEVEL_THRESHOLDS[3])
  assert.equal(wantedFor(result.state, NORTH).level, 3)
})

test('удачный побег уводит отряд, а розыск остаётся', () => {
  // Оба героя выбрасывают по 18: успехов больше половины.
  const state = withGuardEncounter(applyGameEvent(witnessed(), theftEvent()))
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'flee',
    skill: 'stealth',
    command_id: 'cmd-flee-ok',
    campaign_id: 'LAW',
  }], state, { diceService: dice([18, 18]), context: { allowedActorIds: ['hero'] } })

  const resolved = result.events.find((event) => event.event_type === 'GuardEncounterResolved')
  assert.equal(resolved.payload.success, true)
  assert.equal(resolved.payload.participants, 2, 'проверка групповая: бросают все живые герои отряда')
  assert.equal(guardEncounterFor(result.state), null, 'ушли — стражи перед отрядом больше нет')
  assert.equal(wantedFor(result.state, NORTH).level, 1, 'закон не забывает того, кто сбежал')
})

test('провал побега не закрывает встречу и добавляет очков розыска', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed(), theftEvent()))
  const pointsBefore = wantedFor(state, NORTH).points
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'flee',
    skill: 'athletics',
    command_id: 'cmd-flee-fail',
    campaign_id: 'LAW',
  }], state, { diceService: dice([1, 2]), context: { allowedActorIds: ['hero'] } })

  const resolved = result.events.find((event) => event.event_type === 'GuardEncounterResolved')
  assert.equal(resolved.payload.success, false)
  assert.ok(result.events.some((event) => event.event_type === 'WantedLevelRaised'))
  assert.equal(wantedFor(result.state, NORTH).points, pointsBefore + WANTED_ESCAPE_FAILURE_POINTS)
  const still = guardEncounterFor(result.state)
  assert.ok(still, 'стража на месте: у отряда остаются вира и сдача')
  assert.equal(still.escape_attempts, 1)
})

test('без открытой встречи страже отвечать нечем', () => {
  assert.throws(() => resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fine',
    command_id: 'cmd-no-guard',
    campaign_id: 'LAW',
  }], witnessed(), { diceService: dice(), context: { allowedActorIds: ['hero'] } }), /GUARD_ENCOUNTER_NOT_ACTIVE|никого не останавливает/u)
})

test('амнистию объявляет только ведущий', () => {
  const state = applyGameEvent(witnessed(), murderEvent())
  assert.throws(() => resolveCommands([{
    command_type: 'ClearWantedLevel',
    command_id: 'cmd-self-amnesty',
    campaign_id: 'LAW',
    region_id: NORTH,
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), /WANTED_CLEAR_FORBIDDEN|только ведущий/u)

  const granted = resolveCommands([{
    command_type: 'ClearWantedLevel',
    command_id: 'cmd-amnesty',
    campaign_id: 'LAW',
    region_id: NORTH,
  }], state, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })
  assert.equal(wantedFor(granted.state, NORTH).level, 0)
  assert.equal(granted.state.law.cleared[NORTH].reason, 'amnesty')
})

test('амнистия распускает и стражу, которая уже стоит перед отрядом', () => {
  // Единственный выход стола из встречи, когда отвечать страже некому: смена
  // сцены при открытом офицере запрещена, поэтому у ведущего обязан быть ключ.
  const stopped = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  assert.ok(guardEncounterFor(stopped))
  const granted = resolveCommands([{
    command_type: 'ClearWantedLevel',
    command_id: 'cmd-amnesty-at-gate',
    campaign_id: 'LAW',
    region_id: NORTH,
  }], stopped, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })

  assert.equal(guardEncounterFor(granted.state), null, 'претензии больше нет — офицер уходит')
  assert.equal(wantedFor(granted.state, NORTH).level, 0)
  // И сцену после этого сменить можно.
  const left = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-leave-after-amnesty',
    campaign_id: 'LAW',
    scene_args: { location: ROAD, title: 'Тракт', objective: 'Уйти' },
  }], granted.state, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })
  assert.ok(left.events.some((event) => event.event_type === 'SceneAdvanced'))
})

// ---------------------------------------------------------------------------
// Торговля
// ---------------------------------------------------------------------------

test('розыск сначала дорожает, а на третьей ступени лавка закрывается', () => {
  const merchant = {
    id: 'merchant-1', name: 'Лавочник', location: VILLAGE, available: true,
    tags: ['faction:brod-folk'], stock: [], services: [],
  }
  const base = witnessed()
  const withMerchant = { ...base, social: { ...base.social, npcs: [...base.social.npcs, merchant] } }

  assert.equal(reputationStandingFor(withMerchant, 'merchant-1').price_adjustment_bps, 0)
  assert.equal(reputationStandingFor(withMerchant, 'merchant-1').trade_available, true)

  const noticed = applyGameEvent(withMerchant, theftEvent())
  assert.equal(wantedLevelHere(noticed), 1)
  assert.equal(reputationStandingFor(noticed, 'merchant-1').price_adjustment_bps, 250)
  assert.equal(reputationStandingFor(noticed, 'merchant-1').trade_available, true)

  const hunted = applyGameEvent(applyGameEvent(withMerchant, murderEvent()), arsonEvent())
  assert.equal(wantedLevelHere(hunted), 3)
  const standing = reputationStandingFor(hunted, 'merchant-1')
  assert.equal(standing.trade_available, false)
  assert.equal(standing.services_available, false)
  assert.ok(standing.trade_refusal_reason)
})

test('торговец отказывает командой, а не молча', () => {
  const base = witnessed()
  const stocked = normalizeCampaignState({
    ...base,
    merchants: [{
      id: 'merchant-1', name: 'Лавочник', location: VILLAGE, available: true,
      stock: [{ stock_id: 'stock-1', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', quantity: 4 }],
      services: [],
    }],
    social: { ...base.social, npcs: [...base.social.npcs, { id: 'merchant-1', name: 'Лавочник', location: VILLAGE, visibility: 'party', tags: ['faction:brod-folk'] }] },
  })
  const hunted = applyGameEvent(applyGameEvent(stocked, murderEvent()), arsonEvent())
  assert.equal(wantedLevelHere(hunted), 3)
  assert.throws(() => resolveCommands([{
    command_type: 'BuyItem',
    actor_id: 'hero',
    merchant_id: 'merchant-1',
    stock_id: 'stock-1',
    quantity: 1,
    command_id: 'cmd-buy',
    campaign_id: 'LAW',
  }], hunted, { diceService: dice(), context: { allowedActorIds: ['hero'] } }), /TRADE_REFUSED_BY_WANTED_LEVEL|ищет стража/u)
})

// ---------------------------------------------------------------------------
// Replay и проекция
// ---------------------------------------------------------------------------

test('розыск переживает replay и не удваивается', () => {
  const events = [theftEvent(), murderEvent(), arsonEvent({ id: 'evt-arson-2', commandId: 'cmd-arson-2' })]
  const direct = events.reduce((state, event) => applyGameEvent(state, event), witnessed())
  const replayed = replayEvents(witnessed(), events)
  assert.deepEqual(replayed.law.crimes.map((crime) => crime.id), direct.law.crimes.map((crime) => crime.id))
  assert.equal(wantedFor(replayed, NORTH).points, wantedFor(direct, NORTH).points)

  const twice = replayEvents(witnessed(), [...events, ...events])
  assert.equal(twice.law.crimes.length, direct.law.crimes.length, 'повтор того же события второго преступления не заводит')
})

test('стража остаётся стражей на всех уровнях отряда и всех ступенях розыска', () => {
  const board = cells()
  const seen = new Set()
  for (const level of [1, 3, 5, 9]) {
    for (const wanted of [1, 2, 3]) {
      const proposal = assembleEncounter({
        scene: { cells: board },
        party: [{ id: 'hero', level, x: 2, y: 2 }, { id: 'mate', level, x: 3, y: 2 }],
        difficulty: GUARD_ENCOUNTER_DIFFICULTY[wanted],
        theme: GUARD_ENCOUNTER_THEME,
        seed: `guard:sample:${level}:${wanted}`,
      })
      assert.ok(proposal.enemies.length > 0, `уровень ${level}, ступень ${wanted}: страже нечем выйти`)
      for (const enemy of proposal.enemies) {
        const name = String(enemy.name).replace(/\s+\d+$/u, '')
        seen.add(name)
        assert.ok(LAW_NAMES.has(name), `уровень ${level}, ступень ${wanted}: у ворот встал ${name}`)
      }
    }
  }
  assert.ok(seen.size >= 2, 'выборка не выродилась в одно существо')
})

test('переполненный реестр снятий теряет старые записи, а не свежие', () => {
  const cleared = {}
  for (let index = 0; index < 45; index += 1) {
    cleared[`region-${String(index).padStart(2, '0')}`] = { at_minutes: index, reason: 'amnesty' }
  }
  const keys = Object.keys(normalizeLawState({ cleared }).cleared)
  assert.equal(keys.length, 40)
  assert.ok(keys.includes('region-44'), 'свежая амнистия остаётся')
  assert.ok(!keys.includes('region-00'), 'а самая старая уходит')
})

test('канал событий не несёт игроку ни ступени, ни списка преступлений', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  const result = resolveCommands([{
    command_type: 'ResolveGuardEncounter',
    actor_id: 'hero',
    resolution: 'fine',
    command_id: 'cmd-fine-projection',
    campaign_id: 'LAW',
  }], state, { diceService: dice(), context: { allowedActorIds: ['hero'] } })

  const player = mechanicsForViewer(result.events, { role: 'player' }, 'hero', state)
  const serialized = JSON.stringify(player)
  assert.ok(player.some((event) => event.event_type === 'GuardEncounterResolved'), 'сам исход игрок видеть обязан')
  assert.ok(!serialized.includes('"level"'), 'ступени розыска в событиях игрока нет')
  assert.ok(!serialized.includes('level_before'))
  assert.ok(!serialized.includes('crime_ids'), 'и реестра преступлений тоже')

  // У ведущего провенанс остаётся целиком: он и решает по числам.
  const master = mechanicsForViewer(result.events, { role: 'admin' }, '', state)
  const cleared = master.find((event) => event.event_type === 'WantedCleared')
  assert.equal(cleared.payload.level_before, 2)
  assert.deepEqual(cleared.payload.crime_ids, state.law.crimes.map((crime) => crime.id))
})

test('карточка встречи уезжает событием уже публичной: офицер есть, ступени нет', () => {
  const guilty = applyGameEvent(witnessed({ locationId: 'road', location: ROAD }), murderEvent())
  const met = resolveCommands([{
    command_type: 'AdvanceScene',
    actor_id: 'hero',
    command_id: 'cmd-enter-projection',
    campaign_id: 'LAW',
    scene_args: { location: VILLAGE, title: 'Ворота', objective: 'Осмотреться' },
  }], guilty, { diceService: dice(), context: { isAdmin: true, allowedActorIds: ['hero'] } })

  const player = mechanicsForViewer(met.events, { role: 'player' }, 'hero', guilty)
  const started = player.find((event) => event.event_type === 'GuardEncounterStarted')
  assert.ok(started, 'выход стражи игрок видит')
  assert.ok(started.payload.encounter.officer_name, 'офицер по имени')
  assert.equal(started.payload.encounter.options.length, 4, 'и четыре ответа')
  assert.equal(started.payload.encounter.level, undefined, 'а ступени в карточке нет')
  assert.equal(started.payload.encounter.region_id, undefined)
  assert.ok(!JSON.stringify(started).includes('"level"'))
  assert.ok(!player.some((event) => event.event_type === 'WantedLevelRaised'), 'gm_only событий у игрока нет вовсе')
})

test('игрок видит последствия, а не ступень; ведущий видит ленту по краям', () => {
  const state = withGuardEncounter(applyGameEvent(witnessed(), murderEvent()))
  const player = campaignStateForViewer(state, { role: 'player' }, 'hero')
  const serialized = JSON.stringify(player.law)

  assert.equal(player.law.encounter.place_name, VILLAGE)
  assert.ok(player.law.encounter.options.length === 4, 'карточка встречи у игрока есть целиком')
  assert.equal(player.law.encounter.level, undefined, 'точной ступени игрок не видит')
  assert.equal(player.law.regions, undefined)
  assert.ok(!('crimes' in player.law), 'реестр преступлений игроку не принадлежит')
  assert.ok(!serialized.includes('"points"'), 'очков розыска в проекции игрока нет')
  assert.ok(player.law.signs.length > 0, 'вместо цифры игрок получает приметы мира')

  const master = campaignStateForViewer(state, { role: 'admin' }, 'hero')
  const north = master.law.regions.find((region) => region.region_id === NORTH)
  assert.equal(north.level, 2)
  assert.equal(north.points, 4)
  assert.equal(north.crimes.length, 1)
  assert.equal(north.here, true)
})

test('приметы мира растут со ступенью, а на нуле их нет', () => {
  assert.deepEqual(wantedSignsFor(campaign()), [])
  assert.equal(wantedSignsFor(applyGameEvent(witnessed(), theftEvent())).length, 1)
  const hunted = applyGameEvent(applyGameEvent(witnessed(), murderEvent()), arsonEvent())
  assert.ok(wantedSignsFor(hunted).length >= 3)
  assert.ok(wantedSignsFor(hunted).some((line) => line.includes('разыскиваются')))
})

test('лента ведущего собирается на сервере и ставит опасный край первым', () => {
  const north = applyGameEvent(witnessed(), theftEvent())
  const moved = {
    ...north,
    scene: { ...north.scene, location: FAR_CITY, location_id: 'farcity' },
    worldMap: { ...north.worldMap, currentLocationId: 'farcity' },
    social: { ...north.social, npcs: [villager('clerk', 'Писец Ольд', FAR_CITY)] },
  }
  const both = applyGameEvent(moved, murderEvent({ id: 'evt-far', commandId: 'cmd-far' }))

  const feed = wantedFeed(both)
  assert.deepEqual(feed.map((region) => region.region_id), ['east', NORTH])
  assert.equal(feed[0].level, 2)
  assert.equal(feed[0].here, true)
  assert.equal(feed[1].level, 1)
})
