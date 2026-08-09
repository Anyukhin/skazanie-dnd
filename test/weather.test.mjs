// Погода и время суток: мир идёт своим ходом.
//
// Проверяется ровно то, чем эта механика отличается от украшения:
//   1. небо детерминировано сидом кампании и игровым днём, а не броском;
//   2. смена приходит событиями и переживает replay;
//   3. помеха действительно попадает в кость — числами, а не подписью;
//   4. под крышей штрафов нет;
//   5. индикатор доезжает игроку готовой строкой, и своей таблицы у клиента нет.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { combatNarration } from '../server/combat-narration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { SCENE_THEMES } from '../server/scene-themes.mjs'
import {
  BIOME_WEATHER_WEIGHTS,
  CAMPAIGN_START_MINUTE_OF_DAY,
  DAY_PHASES,
  INDOOR_SCENE_THEMES,
  MINUTES_PER_DAY,
  OUTDOOR_SCENE_THEMES,
  WEATHER_CONDITION_IDS,
  WEATHER_TABLE_WEIGHT,
  campaignDayOf,
  clockLabelOf,
  isIndoorScene,
  timeOfDayOf,
  weatherCheckSwing,
  weatherOnDay,
  worldClockEventDrafts,
  worldClockFor,
  worldClockNarration,
} from '../server/weather.mjs'
import { normalizeCampaignState, previewD20Check, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const app = source('src/App.tsx')
const styles = source('src/styles.css')

const SEED = 'weather-seed'
const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `weather-roll-${++id}`, now: () => '2026-08-09T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function worldMap() {
  return {
    seed: SEED,
    currentLocationId: 'road',
    regions: [
      { id: 'north', name: 'Северный край', biome: 'plains', x: 200, y: 200, radius: 205 },
      { id: 'south', name: 'Южный край', biome: 'marsh', x: 200, y: 520, radius: 205 },
      { id: 'east', name: 'Восточный край', biome: 'coast', x: 820, y: 300, radius: 205 },
    ],
    locations: [
      { id: 'road', name: 'Старый тракт', kind: 'landmark', x: 200, y: 200, regionId: 'north' },
      { id: 'fen', name: 'Гиблая топь', kind: 'wilds', x: 200, y: 520, regionId: 'south' },
    ],
    routes: [{ id: 'r1', from: 'road', to: 'fen', kind: 'road' }],
  }
}

/**
 * Отряд на тракте: карта раскрыта, противник в двадцати футах, лук и меч в
 * руках. Сцена без темы карты и без вида — то есть под открытым небом, как и
 * должно быть на тракте.
 */
function field({ minutes = 0, sceneKind = null, locationId = 'road', foeAt = { x: 5, y: 1 } } = {}) {
  const cells = Array.from({ length: 160 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'WEATHER-1',
    campaign: 'Небо над трактом',
    partyMemberIds: ['scout'],
    activePlayerId: 'scout',
    players: [{
      id: 'scout', character: 'Вельга', characterClass: 'ranger', level: 5, hp: 34, maxHp: 34,
      armor: 15, speed: 30, proficiency: 3, abilities: { str: 12, dex: 16, con: 12, int: 10, wis: 14, cha: 10 },
      inventory: [BOW, SWORD], x: 1, y: 1,
    }],
    enemies: [{ id: 'foe', name: 'Разбойник', creature_type: 'humanoid', hp: 30, maxHp: 30, armor: 13, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, title: 'Тракт', location: 'Старый тракт', location_id: locationId, cells, ...(sceneKind ? { scene_kind: sceneKind } : {}) },
    worldMap: { ...worldMap(), currentLocationId: locationId },
    mechanics: {
      world_time: { elapsed_minutes: minutes },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'scout', total: 20 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          scout: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

/** Полдень заданного дня кампании в минутах от её начала. */
const noonOfDay = (day) => day * MINUTES_PER_DAY + (DAY_PHASES[1].start_minute - CAMPAIGN_START_MINUTE_OF_DAY)

/**
 * Полдень того дня кампании, в который небо равно заданному. Искать день
 * приходится, а не назначать: числа таблицы принадлежат политике, и жёсткая
 * привязка теста к дню номер четыре ломалась бы от любой её правки.
 */
function minutesWithWeather(condition, { biome = 'plains', limit = 400 } = {}) {
  for (let day = 0; day < limit; day += 1) {
    if (weatherOnDay({ seed: SEED, day, biome }) === condition) return noonOfDay(day)
  }
  throw new Error(`за ${limit} дней климат ${biome} ни разу не дал «${condition}»`)
}

/** Полдень последнего дня перед тем, как небо действительно сменится. */
function minutesBeforeSkyChanges({ biome = 'plains', limit = 400 } = {}) {
  for (let day = 0; day < limit; day += 1) {
    if (weatherOnDay({ seed: SEED, day, biome }) !== weatherOnDay({ seed: SEED, day: day + 1, biome })) return noonOfDay(day)
  }
  throw new Error(`за ${limit} дней климат ${biome} ни разу не сменился`)
}

const skillCheck = (state, skill, values) => resolveCommand(
  authoritative({ command_type: 'MakeAbilityCheck', actor_id: 'scout', skill, difficulty: 15 }),
  state,
  options(dice(values)),
)

const shoot = (state, values, item = 'bow') => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'scout', target_id: 'foe', item_id: item }),
  state,
  options(dice(values)),
)

const attackRoll = (result) => result.rolls.find((roll) => roll.purpose === 'attack')

// ---------------------------------------------------------------------------
// Детерминизм
// ---------------------------------------------------------------------------

test('погода — чистая функция сида, дня и климата', () => {
  for (let day = 0; day < 12; day += 1) {
    const first = weatherOnDay({ seed: SEED, day, biome: 'plains' })
    assert.equal(weatherOnDay({ seed: SEED, day, biome: 'plains' }), first, 'повторный вопрос даёт тот же ответ')
    assert.ok(WEATHER_CONDITION_IDS.includes(first), 'погода берётся только из закрытого списка')
  }
  const mine = Array.from({ length: 30 }, (_, day) => weatherOnDay({ seed: SEED, day, biome: 'plains' }))
  const other = Array.from({ length: 30 }, (_, day) => weatherOnDay({ seed: 'иной-сид', day, biome: 'plains' }))
  const swamp = Array.from({ length: 30 }, (_, day) => weatherOnDay({ seed: SEED, day, biome: 'marsh' }))
  assert.notDeepEqual(mine, other, 'у другой кампании своя погода')
  assert.notDeepEqual(mine, swamp, 'в топях небо не такое, как на равнине')
})

test('таблицы климата закрыты, полны и не съехали по сумме', () => {
  const declared = new Set([...source('server/world-map.mjs').matchAll(/const BIOMES = new Set\(\[([^\]]+)\]\)/g)]
    .flatMap(([, list]) => [...list.matchAll(/'([a-z]+)'/g)].map(([, id]) => id)))
  assert.ok(declared.size >= 8, 'список биомов карты мира не разобрался — проверьте регулярку')
  assert.deepEqual(new Set(Object.keys(BIOME_WEATHER_WEIGHTS)), declared, 'у климата карты мира нет строки в таблице погоды (или наоборот)')
  for (const [biome, weights] of Object.entries(BIOME_WEATHER_WEIGHTS)) {
    assert.deepEqual(Object.keys(weights), WEATHER_CONDITION_IDS, `в строке ${biome} перечислена не та погода`)
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
    assert.equal(total, WEATHER_TABLE_WEIGHT, `сумма весов климата ${biome} съехала`)
  }
})

test('время суток и календарь считаются по границам, а не по настроению', () => {
  assert.equal(clockLabelOf(0), '08:00', 'кампания начинается утром, а не в полночь')
  assert.equal(timeOfDayOf(0), 'morning')
  assert.equal(timeOfDayOf(3 * 60), 'day', '11:00 — уже день')
  assert.equal(timeOfDayOf(9 * 60), 'evening', '17:00 — вечер')
  assert.equal(timeOfDayOf(14 * 60), 'night', '22:00 — ночь')
  assert.equal(timeOfDayOf(20 * 60), 'night', '04:00 — ещё ночь')
  assert.equal(timeOfDayOf(21 * 60), 'morning', '05:00 — рассвет')

  // Погодные сутки идут от рассвета к рассвету: «смена по утрам» — это та же
  // граница, а не отдельное правило.
  assert.equal(campaignDayOf(0), 0)
  assert.equal(campaignDayOf(20 * 60 + 59), 0, 'без четырёх минут пять утра — ещё вчерашний день')
  assert.equal(campaignDayOf(21 * 60), 1, 'ровно в пять утра начинаются новые сутки')
})

test('темы сцены разделены на «под крышей» и «под небом» без остатка', () => {
  for (const theme of SCENE_THEMES) {
    const indoor = INDOOR_SCENE_THEMES.has(theme.id)
    const outdoor = OUTDOOR_SCENE_THEMES.has(theme.id)
    assert.ok(indoor !== outdoor, `тема ${theme.id} не отнесена ни к помещению, ни к улице (или сразу к обоим)`)
    assert.equal(isIndoorScene({ map: { theme: theme.id } }), indoor)
  }
  // Сцена без построенной карты опознаётся по виду: подземелье — под крышей.
  assert.equal(isIndoorScene({ scene_kind: 'dungeon' }), true)
  assert.equal(isIndoorScene({ scene_kind: 'wilderness' }), false)
  assert.equal(isIndoorScene({}), false, 'без данных сцена считается открытой — погода честнее молчания')
})

// ---------------------------------------------------------------------------
// Влияние: числа, а не подписи
// ---------------------------------------------------------------------------

test('дождь приводит Восприятие и Выживание к помехе — двумя костями', () => {
  const state = field({ minutes: minutesWithWeather('rain') })
  assert.equal(worldClockFor(state).weather, 'rain')

  const perception = skillCheck(state, 'perception', [18, 4])
  assert.equal(perception.rolls[0].mode, 'disadvantage')
  assert.deepEqual(perception.rolls[0].dice, [18, 4])
  assert.equal(perception.rolls[0].kept, 4, 'из двух костей осталась меньшая')
  const payload = perception.events.find((event) => event.event_type === 'AbilityCheckResolved').payload
  assert.equal(payload.weather_disadvantage, 'дождь')
  assert.equal(payload.total, 4 + payload.modifier)

  const survival = skillCheck(state, 'survival', [18, 4])
  assert.equal(survival.rolls[0].mode, 'disadvantage', 'следопытство под дождём тоже с помехой')

  // Дождю нет дела до убеждения: таблица закрыта тремя навыками.
  assert.equal(skillCheck(state, 'persuasion', [18]).rolls[0].mode, 'normal')
})

test('в помещении дождя нет: та же минута, тот же навык, обычный бросок', () => {
  const minutes = minutesWithWeather('rain')
  const indoors = field({ minutes, sceneKind: 'dungeon' })
  assert.equal(worldClockFor(indoors).indoors, true)
  assert.deepEqual(worldClockFor(indoors).effects, [], 'под крышей действующих помех нет вовсе')

  const check = skillCheck(indoors, 'perception', [18])
  assert.equal(check.rolls[0].mode, 'normal')
  assert.equal(check.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.weather_disadvantage, undefined)
})

test('ночь мешает Восприятию, но не следопытству', () => {
  // Ясная ночь: смотреть мешает темнота, а не небо.
  const clearDay = minutesWithWeather('clear')
  const night = field({ minutes: clearDay + (DAY_PHASES[3].start_minute - DAY_PHASES[1].start_minute) })
  const clock = worldClockFor(night)
  assert.equal(clock.phase, 'night')
  assert.equal(clock.weather, 'clear')

  assert.equal(skillCheck(night, 'perception', [18, 4]).rolls[0].mode, 'disadvantage')
  assert.equal(skillCheck(night, 'survival', [18]).rolls[0].mode, 'normal', 'по следам ночью идут не хуже — темнота бьёт по глазам')
})

test('гроза даёт Скрытности преимущество, и это тоже видно числами', () => {
  const state = field({ minutes: minutesWithWeather('storm', { biome: 'plains' }) })
  assert.equal(worldClockFor(state).weather, 'storm')

  const stealth = skillCheck(state, 'stealth', [4, 18])
  assert.equal(stealth.rolls[0].mode, 'advantage')
  assert.equal(stealth.rolls[0].kept, 18, 'из двух костей осталась большая')
  assert.equal(stealth.events.find((event) => event.event_type === 'AbilityCheckResolved').payload.weather_advantage, 'гроза')
})

test('туман мешает выстрелу, но не удару в упор и не под крышей', () => {
  // Отряд стоит в топях: климат берётся с карты мира, а не назначается тестом,
  // поэтому и день ищется по строке того же края.
  const inFog = field({ minutes: minutesWithWeather('fog', { biome: 'marsh' }), locationId: 'fen' })
  assert.equal(worldClockFor(inFog).weather, 'fog')

  const arrow = shoot(inFog, [16, 3, 4])
  assert.equal(attackRoll(arrow).mode, 'disadvantage')
  assert.ok(arrow.events.find((event) => event.event_type === 'AttackResolved').payload.disadvantage_sources.includes('туман'))

  // Меч тумана не замечает: на длине руки видно и в молоке.
  const melee = field({ minutes: minutesWithWeather('fog', { biome: 'marsh' }), locationId: 'fen', foeAt: { x: 2, y: 1 } })
  assert.equal(attackRoll(shoot(melee, [16, 4], 'sword')).mode, 'normal')

  const roofed = normalizeCampaignState({ ...inFog, scene: { ...inFog.scene, scene_kind: 'dungeon' } })
  assert.equal(attackRoll(shoot(roofed, [16, 4])).mode, 'normal', 'под крышей тумана нет')
})

test('предпросмотр ручного броска показывает ту же помеху, что и сервер', () => {
  const state = field({ minutes: minutesWithWeather('rain') })
  const preview = previewD20Check(state, { actorId: 'scout', kind: 'check', skill: 'perception', difficulty: 15 })
  assert.equal(preview.disadvantage, true)
  assert.equal(preview.weather_reason, 'дождь')
  // Карточка и бросок считаются одним кодом: разойтись им негде.
  assert.equal(skillCheck(state, 'perception', [18, 4]).rolls[0].mode, 'disadvantage')
  assert.equal(weatherCheckSwing(state, 'perception').swing, 'disadvantage')
})

// ---------------------------------------------------------------------------
// События и replay
// ---------------------------------------------------------------------------

test('смена времени суток и погоды приходит событиями', () => {
  const state = field({ minutes: 0 })
  const advanced = resolveCommand(
    authoritative({ command_type: 'AdvanceTime', amount: 12, unit: 'hour' }),
    state,
    options(dice([])),
  )
  const phase = advanced.events.find((event) => event.event_type === 'TimeOfDayChanged')
  assert.ok(phase, 'полсуток обязаны перевести время суток')
  assert.equal(phase.payload.phase_before, 'morning')
  assert.equal(phase.payload.phase_after, 'evening')
  assert.equal(phase.visibility, 'party', 'небо видно всему столу')
  assert.equal(phase.payload.policy_id, 'skazanie:weather-and-time-v1')

  // Внутри одних суток погода не меняется: она принадлежит дню, а не часу.
  assert.equal(advanced.events.some((event) => event.event_type === 'WeatherChanged'), false)
})

test('сутки пути меняют небо ровно один раз и переживают replay', () => {
  const start = minutesBeforeSkyChanges()
  const state = field({ minutes: start })
  const advanced = resolveCommand(
    authoritative({ command_type: 'AdvanceTime', amount: 1, unit: 'day' }),
    state,
    options(dice([])),
  )
  const weatherEvents = advanced.events.filter((event) => event.event_type === 'WeatherChanged')
  assert.equal(weatherEvents.length, 1, 'через сутки небо объявляется один раз, а не по разу на пропущенный час')
  assert.equal(weatherEvents[0].payload.weather_before, worldClockFor(state).weather)

  const after = replayEvents(state, advanced.events)
  assert.equal(after.mechanics.world_time.elapsed_minutes, start + MINUTES_PER_DAY)
  assert.equal(worldClockFor(after).weather, weatherEvents[0].payload.weather_after, 'выведенное небо совпадает с записанным')
  assert.equal(campaignDayOf(after.mechanics.world_time.elapsed_minutes), campaignDayOf(start) + 1)

  // Replay того же журнала с нуля даёт то же самое: погода — функция состояния,
  // а не накопленный счётчик.
  const replayedTwice = replayEvents(state, advanced.events)
  assert.deepEqual(worldClockFor(replayedTwice), worldClockFor(after))
})

test('второй шаг времени не переигрывает уже пересечённую границу', () => {
  const state = field({ minutes: 0 })
  const first = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 8, unit: 'hour' }), state, options(dice([])))
  const midday = replayEvents(state, first.events)
  const second = resolveCommand(authoritative({ command_type: 'AdvanceTime', amount: 1, unit: 'minute' }), midday, options(dice([])))
  assert.deepEqual(second.events.filter((event) => ['TimeOfDayChanged', 'WeatherChanged'].includes(event.event_type)), [])
})

test('черновики событий — чистая функция состояния и шага', () => {
  const state = field({ minutes: 0 })
  assert.deepEqual(worldClockEventDrafts(state, 480), worldClockEventDrafts(state, 480))
  assert.deepEqual(worldClockEventDrafts(state, 0), [], 'нулевой шаг не двигает ничего')
})

test('строка про небо дописывается последней и не вытесняет события хода', () => {
  const state = field({ minutes: 0 })
  const dusk = { event_type: 'TimeOfDayChanged', payload: { phase_after: 'night' }, target_ids: [] }
  const knockout = { event_type: 'RestCompleted', actor_id: 'scout', target_ids: ['scout'], payload: { kind: 'short', reason: 'knockout' } }

  const together = combatNarration([knockout, dusk], state)
  assert.match(together, /сознание/u, 'событие хода осталось на месте')
  assert.ok(together.endsWith(worldClockNarration(dusk)), 'небо стоит последним')

  // На ходу, где кроме неба не случилось ничего, строка про небо остаётся
  // единственной: иначе смену времени суток игрок не увидел бы вовсе.
  assert.equal(combatNarration([dusk], state), worldClockNarration(dusk))
})

test('строка летописи детерминированная и по-русски', () => {
  const phase = worldClockNarration({ event_type: 'TimeOfDayChanged', payload: { phase_after: 'night' } })
  const sky = worldClockNarration({ event_type: 'WeatherChanged', payload: { weather_after: 'storm' } })
  assert.match(phase, /^[А-ЯЁ].*ночь\./u)
  assert.match(sky, /^Собралась гроза\./u)
  assert.equal(worldClockNarration({ event_type: 'TimeOfDayChanged', payload: { phase_after: 'night' } }), phase)
  assert.equal(worldClockNarration({ event_type: 'AttackResolved', payload: {} }), '', 'чужое событие рассказчик неба не описывает')
})

// ---------------------------------------------------------------------------
// Проекция и интерфейс
// ---------------------------------------------------------------------------

test('индикатор доезжает и игроку, и ведущему одной строкой', () => {
  const state = field({ minutes: minutesWithWeather('rain') })
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['scout'] }, 'scout')
  const admin = campaignStateForViewer(state, { id: 'user-gm', role: 'admin', heroIds: [] }, '')

  assert.equal(player.weather.indicator, `${player.weather.phase_label} · ${player.weather.weather_label}`)
  assert.match(player.weather.indicator, /^[А-ЯЁ][а-яё]+ · [А-ЯЁ][а-яё]+$/u)
  assert.equal(player.weather.indoors, false)
  assert.ok(player.weather.effects.length > 0, 'игрок видит, чем именно небо сейчас мешает')
  assert.equal(player.weather.clock, clockLabelOf(state.mechanics.world_time.elapsed_minutes))
  // Небо тайной ведущего не является: обе проекции совпадают целиком.
  assert.deepEqual(admin.weather, player.weather)
})

test('шапка сцены показывает время и погоду, а таблицы неба у клиента нет', () => {
  assert.match(app, /className=\{`scene-weather phase-\$\{weather\.phase\} sky-\$\{weather\.weather\}`\}/u)
  assert.match(app, /weather=\{state\.weather\}/u)
  assert.match(app, /<SceneWeather weather=\{weather\} \/>/u)
  assert.match(styles, /\.scene-weather \{/u)
  assert.match(styles, /\.scene-weather\.phase-night \{/u)
  // Подписи и строку индикатора считает сервер. Появление русских названий
  // погоды в клиенте означало бы вторую таблицу, расходящуюся с броском.
  for (const label of ['Пасмурно', 'Гроза', 'Ясно']) {
    assert.ok(!app.includes(`'${label}'`), `клиент завёл свою подпись погоды «${label}»`)
  }
})
