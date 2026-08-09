import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { currencyToCopper } from '../server/merchant-economy.mjs'
import {
  GUARD_CUSTODY_MINUTES,
  WANTED_DECAY_MINUTES,
  WANTED_ESCAPE_FAILURE_POINTS,
  WANTED_FINE_CP,
  WANTED_LEVEL_THRESHOLDS,
  guardEncounterFor,
  guardOptionsFor,
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
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const VILLAGE = 'Тихий Брод'
const ROAD = 'Старый тракт'
const FAR_CITY = 'Дальний Град'
const NORTH = 'north'

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
      { id: 'farcity', name: FAR_CITY, kind: 'city', x: 820, y: 300, regionId: 'east' },
    ],
    routes: [
      { id: 'r1', from: 'village', to: 'road', kind: 'road' },
      { id: 'r2', from: 'road', to: 'farcity', kind: 'road' },
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
  assert.equal(created.payload.encounter.theme, 'warband', 'тема взята из существующих, своих стат-блоков закон не заводит')
  assert.ok(created.payload.encounter.enemies.length > 0)
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
