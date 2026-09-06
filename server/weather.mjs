import { createHash } from 'node:crypto'

import { matchTheme } from './scene-themes.mjs'
import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'
import { worldLocationById } from './world-map.mjs'

/**
 * Время суток и погода: мир идёт своим ходом, а не ждёт отряд.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, D6) описывал дыру
 * коротко: «`world_time` — это только `elapsed_minutes`. Ни времени суток как
 * состояния, ни погоды, ни их влияния на видимость, следопытство и встречи».
 * Часы у кампании были — не хватало производных, которые из них читаются.
 *
 * Модуль детерминированный и без обращений к модели, как `law-and-order.mjs`,
 * `captives.mjs` и `parley.mjs`. Устроен он так:
 *
 * 1. **Ни времени суток, ни погоды в состоянии нет — они выводятся.** Час
 *    считается из `mechanics.world_time.elapsed_minutes`, погода — из сида
 *    кампании (`worldMap.seed`), номера игрового дня и климата края. Обе
 *    величины — чистые функции уже сохранённого состояния, поэтому replay
 *    воспроизводит их по построению, а не потому, что кто-то не забыл про
 *    редьюсер. Своего счётчика заводить было нельзя: он стал бы вторым
 *    авторитетным ответом на вопрос «который час», расходящимся с минутами.
 * 2. **События нужны для смены, а не для значения.** `TimeOfDayChanged` и
 *    `WeatherChanged` выпускаются ровно тогда, когда переход времени пересёк
 *    границу, и несут «было → стало». Из них живёт строка летописи; текущее
 *    состояние неба они не хранят и хранить не должны.
 * 3. **Погода меняется по утрам, и граница утра — она же граница погодного
 *    дня.** Сутки погоды идут от рассвета к рассвету, поэтому «смена по утрам»
 *    не требует отдельного правила: день сменился — сменилась и запись в
 *    таблице. Полдень и полночь границами не служат.
 * 4. **В помещении погоды нет.** Все штрафы и бонусы этого модуля действуют
 *    только под открытым небом. Внутри здания, храма, склепа и пещеры дождь не
 *    заливает глаза, а гроза не глушит шаги: это и физически честно, и
 *    избавляет стол от спора «а мы же в трактире». Крыша опознаётся **тем же**
 *    распознавателем тем, которым сцену строил генератор (`matchTheme`), — см.
 *    `isIndoorScene`.
 * 5. **Каждый эффект — помеха или преимущество, а не число.** Модуль не
 *    придумывает новых модификаторов: он добавляет причину в тот же список,
 *    которым движок уже считает преимущество и помеху
 *    (`srd_5_2_1:core:advantage-disadvantage`). Своей арифметики у погоды нет.
 *
 * Осознанные границы (решено, а не забыто):
 * - **кости здесь не бросаются.** `DiceService` — общий поток случайности, и
 *   выпавшее из него зависит от того, сколько бросков случилось раньше. Погода
 *   обязана зависеть от **сида и дня**, а не от истории ходов, иначе один и тот
 *   же день кампании выдавал бы разное небо после перезапуска и при доигрывании
 *   журнала. Поэтому вместо броска стоит тот же приём, что у имён офицеров
 *   стражи и у генератора карты мира: sha256 от подписи и остаток от деления;
 * - **климат — биом края карты мира, а не собственная таблица.** Своего
 *   справочника климатов модуль не заводит: у региона уже есть `biome`
 *   (`server/world-map.mjs`), и второй список разошёлся бы с первым;
 * - **снега нет.** В тундре зимний осадок остаётся «дождём» — отдельного вида
 *   погоды под него не заведено, потому что механических последствий у него
 *   были бы ровно те же. Это упрощение, а не пропуск;
 * - **встречи погода не назначает.** Влияние ограничено проверками и дальними
 *   атаками; частоту случайных встреч ночью решает Директор, и подмешивать туда
 *   вторую политику без решения владельца нельзя.
 */

export const WEATHER_SCHEMA_VERSION = 1
export const WEATHER_POLICY_ID = 'skazanie:weather-and-time-v1'

/**
 * Сколько минут в сутках.
 *
 * Осторожно: рассвет у мировых часов и «рассвет» перезарядки предметов — разные
 * границы, и общее у них только это число. `dawnCrossings`
 * (`server/item-dawn-recharge.mjs`) считает рассветом кратные 1440 минутам от
 * начала кампании, то есть 08:00 по этим часам; погодные сутки начинаются в
 * 05:00 (`DAY_START_MINUTE`). Предметы, стало быть, перезаряжаются через три
 * часа после того, как в кампании рассвело. Сводить обе границы к одной —
 * решение владельца: у предметов SRD говорит «на рассвете», а рассвет как час
 * придуман здесь.
 */
export const MINUTES_PER_DAY = 1_440

/**
 * Который час в мире на нулевой минуте кампании. Восемь утра выбраны потому,
 * что кампания начинается уже начавшимся днём: отряд просыпается, а не выходит
 * из ниоткуда в полночь.
 */
export const CAMPAIGN_START_MINUTE_OF_DAY = 480

/**
 * Четыре времени суток и минута, с которой каждое начинается. Ночь замыкает
 * круг: от 22:00 до 05:00 следующих суток. Границы — решение исполнителя, а не
 * SRD: в правилах времени суток как состояния нет вовсе.
 */
export const DAY_PHASES = Object.freeze([
  Object.freeze({ id: 'morning', label: 'Утро', start_minute: 300 }),
  Object.freeze({ id: 'day', label: 'День', start_minute: 660 }),
  Object.freeze({ id: 'evening', label: 'Вечер', start_minute: 1_020 }),
  Object.freeze({ id: 'night', label: 'Ночь', start_minute: 1_320 }),
])

/** Минута, с которой начинаются и утро, и новые погодные сутки. */
export const DAY_START_MINUTE = DAY_PHASES[0].start_minute

export const DAY_PHASE_IDS = Object.freeze(DAY_PHASES.map((phase) => phase.id))

/**
 * Погода. Список закрытый и серверный: ни модель, ни клиент в него не
 * добавляют. Пять записей — ровно те, у которых есть механическое последствие
 * либо явное «последствий нет».
 */
export const WEATHER_CONDITIONS = Object.freeze([
  Object.freeze({ id: 'clear', label: 'Ясно', summary: 'Небо чистое.' }),
  Object.freeze({ id: 'overcast', label: 'Пасмурно', summary: 'Небо затянуто, но сухо.' }),
  Object.freeze({ id: 'rain', label: 'Дождь', summary: 'Дождь заливает глаза и смывает следы.' }),
  Object.freeze({ id: 'fog', label: 'Туман', summary: 'Туман скрадывает всё дальше десятка шагов.' }),
  Object.freeze({ id: 'storm', label: 'Гроза', summary: 'Гроза глушит шаги и голоса.' }),
])

export const WEATHER_CONDITION_IDS = Object.freeze(WEATHER_CONDITIONS.map((condition) => condition.id))

/**
 * Веса погоды по климату края. Числа — доли из двадцати; сумма каждой строки
 * равна `WEATHER_TABLE_WEIGHT`, и это проверяет сторож, потому что молча
 * съехавшая сумма перекосила бы всю таблицу.
 *
 * Ключи — биомы карты мира (`server/world-map.mjs`). Числа придуманы
 * исполнителем и ждут решения владельца: они правдоподобны, но не выведены ни
 * из какого источника.
 */
export const WEATHER_TABLE_WEIGHT = 20

export const BIOME_WEATHER_WEIGHTS = Object.freeze({
  plains: Object.freeze({ clear: 8, overcast: 6, rain: 4, fog: 1, storm: 1 }),
  forest: Object.freeze({ clear: 6, overcast: 6, rain: 5, fog: 2, storm: 1 }),
  mountains: Object.freeze({ clear: 6, overcast: 5, rain: 3, fog: 4, storm: 2 }),
  marsh: Object.freeze({ clear: 3, overcast: 5, rain: 5, fog: 6, storm: 1 }),
  desert: Object.freeze({ clear: 14, overcast: 4, rain: 1, fog: 0, storm: 1 }),
  tundra: Object.freeze({ clear: 6, overcast: 8, rain: 3, fog: 3, storm: 0 }),
  coast: Object.freeze({ clear: 5, overcast: 5, rain: 4, fog: 4, storm: 2 }),
  wastes: Object.freeze({ clear: 7, overcast: 7, rain: 2, fog: 2, storm: 2 }),
})

/** Край без известного климата. Та же строка, что у равнины. */
export const DEFAULT_BIOME = 'plains'

/**
 * Темы сцены, которые считаются помещением. Идентификаторы — из каталога тем
 * (`SCENE_THEMES`, `server/scene-themes.mjs`), и обе половины списка обязаны
 * покрывать его целиком: тема, не попавшая ни в один набор, молча стала бы
 * улицей. Сторож — `test/weather.test.mjs`.
 *
 * Разделение на «под крышей» и «под небом» — знание погоды, а не каталога тем,
 * поэтому наборы живут здесь. Само же опознание темы берётся из каталога
 * (`matchTheme`): второй разбор названия локации разошёлся бы с генератором.
 */
export const INDOOR_SCENE_THEMES = Object.freeze(new Set(['building', 'temple', 'crypt', 'cave']))

/** Темы под открытым небом. Поселение — улица, а не дом: крыши над отрядом нет. */
export const OUTDOOR_SCENE_THEMES = Object.freeze(new Set(['forest', 'road', 'settlement']))

/**
 * Виды сцены, которые считаются помещением, когда тема карты ещё не известна
 * (сцена без сгенерированной карты). Подземелье — единственный такой вид.
 */
export const INDOOR_SCENE_KINDS = Object.freeze(new Set(['dungeon']))

/** Типы событий мировых часов. */
export const TIME_OF_DAY_CHANGED_EVENT = 'TimeOfDayChanged'
export const WEATHER_CHANGED_EVENT = 'WeatherChanged'
export const WORLD_CLOCK_EVENT_TYPES = Object.freeze(new Set([TIME_OF_DAY_CHANGED_EVENT, WEATHER_CHANGED_EVENT]))

const MAX_WORLD_MINUTE = 5_000_000

const text = (value, maximum = 180) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function minutes(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) return 0
  return Math.max(0, Math.min(MAX_WORLD_MINUTE, number))
}

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

// ---------------------------------------------------------------------------
// Часы: минута кампании → сутки и время суток
// ---------------------------------------------------------------------------

/** Минуты кампании из состояния. Единственное место, где читается это поле. */
export function elapsedMinutesOf(state = {}) {
  return minutes(state?.mechanics?.world_time?.elapsed_minutes)
}

/** Абсолютная минута мировых часов: кампания стартует не в полночь. */
function absoluteMinute(elapsedMinutes) {
  return CAMPAIGN_START_MINUTE_OF_DAY + minutes(elapsedMinutes)
}

/** Минута внутри суток, 0…1439. */
export function clockMinuteOf(elapsedMinutes) {
  return absoluteMinute(elapsedMinutes) % MINUTES_PER_DAY
}

/** Часы и минуты строкой: «18:20». Ведущему нужнее цифра, чем слово. */
export function clockLabelOf(elapsedMinutes) {
  const minute = clockMinuteOf(elapsedMinutes)
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/**
 * Номер погодных суток, начиная с нуля. Сутки идут от рассвета к рассвету,
 * поэтому пересечение этой границы — и есть «наступило утро».
 */
export function campaignDayOf(elapsedMinutes) {
  return Math.floor((absoluteMinute(elapsedMinutes) - DAY_START_MINUTE) / MINUTES_PER_DAY)
}

/** Фазы в обратном порядке: искать надо последнюю начавшуюся. */
const DAY_PHASES_LATEST_FIRST = Object.freeze([...DAY_PHASES].reverse())

/** Время суток на эту минуту. */
export function timeOfDayOf(elapsedMinutes) {
  const minute = clockMinuteOf(elapsedMinutes)
  if (minute < DAY_START_MINUTE) return 'night'
  return DAY_PHASES_LATEST_FIRST.find((phase) => minute >= phase.start_minute)?.id ?? 'night'
}

export function dayPhaseLabel(phaseId) {
  return DAY_PHASES.find((phase) => phase.id === String(phaseId))?.label ?? ''
}

export function weatherConditionLabel(conditionId) {
  return WEATHER_CONDITIONS.find((condition) => condition.id === String(conditionId))?.label ?? ''
}

export function weatherConditionSummary(conditionId) {
  return WEATHER_CONDITIONS.find((condition) => condition.id === String(conditionId))?.summary ?? ''
}

// ---------------------------------------------------------------------------
// Погода: сид кампании + день + климат края
// ---------------------------------------------------------------------------

/** Где отряд числится на карте мира и в каком крае этот узел лежит. */
export function currentRegionOf(state = {}) {
  const map = state?.worldMap
  const node = worldLocationById(map, text(map?.currentLocationId, 120))
  const regionId = text(node?.regionId, 120)
  if (!regionId) return null
  return (Array.isArray(map?.regions) ? map.regions : [])
    .find((region) => text(region?.id, 120) === regionId) ?? null
}

/** Климат края. Неизвестный биом считается равнинным. */
export function currentBiomeOf(state = {}) {
  const biome = text(currentRegionOf(state)?.biome, 40)
  return Object.hasOwn(BIOME_WEATHER_WEIGHTS, biome) ? biome : DEFAULT_BIOME
}

/**
 * Погода одного дня. Чистая функция: одинаковый сид, день и климат дают
 * одинаковое небо сколько угодно раз подряд и после перезапуска сервера.
 */
export function weatherOnDay({ seed = '', day = 0, biome = DEFAULT_BIOME } = {}) {
  const weights = BIOME_WEATHER_WEIGHTS[String(biome)] ?? BIOME_WEATHER_WEIGHTS[DEFAULT_BIOME]
  const table = WEATHER_CONDITION_IDS.flatMap((id) => Array.from({ length: Math.max(0, weights[id] ?? 0) }, () => id))
  if (!table.length) return 'clear'
  const roll = Number.parseInt(digest(seed, 'weather', Math.trunc(Number(day) || 0), biome).slice(0, 8), 16)
  return table[roll % table.length]
}

/** Сид кампании. Тот же, из которого построена карта мира. */
export function campaignSeedOf(state = {}) {
  return text(state?.worldMap?.seed, 120) || text(state?.sessionCode, 120)
}

/** Погода прямо сейчас. */
export function weatherOf(state = {}, elapsedMinutes = elapsedMinutesOf(state)) {
  return weatherOnDay({
    seed: campaignSeedOf(state),
    day: campaignDayOf(elapsedMinutes),
    biome: currentBiomeOf(state),
  })
}

// ---------------------------------------------------------------------------
// Под небом или под крышей
// ---------------------------------------------------------------------------

/**
 * Тема сцены так, как её понимает каталог тем. Источники идут от прочного к
 * восстанавливаемому:
 *
 * 1. `scene.map.theme` — тема уже построенной тактической карты. Доживает до
 *    состояния только у тем, чей идентификатор совпал со старым `pattern`
 *    (сейчас это `crypt`): карта сцены доезжает **старыми клетками**, а
 *    `legacyCellsFromTacticalMap` пишет `cell.pattern` лишь для legacy-узоров.
 *    Первым источником поле стоит потому, что это ответ самой карты.
 * 2. `matchTheme` по словам картографа — та же функция и те же три аргумента,
 *    которыми тему выбирал генератор сцены (`generateSceneCellsFor`,
 *    `server/adventure-director.mjs`). Это не второй разбор названия, а тот же
 *    самый: разойтись с генератором ему негде.
 *
 * Честная граница: если генератор узнал тему **не** по словам, а по заявке на
 * карту (`layout: 'cavern'` без слова «пещера» в названии), восстановить её
 * отсюда нечем — заявка в состоянии не хранится. Такая сцена считается
 * открытой; тема `crypt` из узора спасается пунктом 1.
 */
function sceneThemeIdOf(scene = {}) {
  const stored = text(scene?.map?.theme, 60)
  if (INDOOR_SCENE_THEMES.has(stored) || OUTDOOR_SCENE_THEMES.has(stored)) return stored
  return matchTheme({
    location: text(scene?.location, 120),
    theme: text(scene?.theme, 120),
    sceneKind: text(scene?.scene_kind, 40),
  })?.id ?? ''
}

/**
 * Стоит ли сцена под крышей. Ответ берётся из опознанной темы сцены, а когда
 * тема не опознана — из вида сцены: подземелье без карты всё равно помещение.
 */
export function isIndoorScene(scene = {}) {
  const theme = sceneThemeIdOf(scene)
  if (INDOOR_SCENE_THEMES.has(theme)) return true
  if (OUTDOOR_SCENE_THEMES.has(theme)) return false
  return INDOOR_SCENE_KINDS.has(text(scene?.scene_kind, 40))
}

function actorPositionForWeather(state, actorIdValue) {
  const id = String(actorIdValue ?? '').trim()
  if (!id) return null
  const stored = state?.mechanics?.positions?.[id]
  const actor = [...(Array.isArray(state?.players) ? state.players : []), ...(Array.isArray(state?.actors) ? state.actors : []), ...(Array.isArray(state?.enemies) ? state.enemies : [])]
    .find((candidate) => String(candidate?.id ?? candidate?.actor_id ?? '') === id)
  const x = Number(stored?.x ?? actor?.x)
  const y = Number(stored?.y ?? actor?.y)
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null
}

function defaultWeatherActorId(state = {}) {
  const active = String(state?.activePlayerId ?? '').trim()
  if (active) return active
  const firstPlayer = Array.isArray(state?.players) ? state.players[0] : null
  const first = String(firstPlayer?.id ?? firstPlayer?.actor_id ?? '').trim()
  return first || null
}

function resolvedWeatherActorId(state, actorIdValue) {
  const explicit = String(actorIdValue ?? '').trim()
  return explicit || defaultWeatherActorId(state)
}

/**
 * Возвращает покрытие клетки из богатой карты, если оно однозначно известно.
 * Ошибочная или старая форма карты отдаётся прежнему сценическому fallback'у.
 */
function richMapIndoorFor(state, actorIdValue) {
  const position = actorPositionForWeather(state, actorIdValue)
  const rawMap = state?.scene?.map
  if (!position || !rawMap || typeof rawMap !== 'object' || !Array.isArray(rawMap.zones) || !rawMap.layers) return null
  try {
    const map = ArrayBuffer.isView(rawMap.layers.zoneId) ? rawMap : deserializeTacticalMap(rawMap)
    const cell = cellAt(map, position.x, position.y)
    const zone = map.zones.find((candidate) => candidate.id === cell?.zone)
    if (zone?.kind === 'interior') return true
    if (zone?.kind === 'exterior') return false
  } catch {
    // Legacy/повреждённая карта не должна отключать прежнюю сценическую оценку.
  }
  return null
}

export function isIndoors(state = {}, actorIdValue = null) {
  return richMapIndoorFor(state, actorIdValue) ?? isIndoorScene(state?.scene ?? {})
}

// ---------------------------------------------------------------------------
// Влияние на игру
// ---------------------------------------------------------------------------

/**
 * Что именно небо делает с проверками и выстрелами. Таблица закрытая: каждая
 * строка — одна помеха или одно преимущество, и ничего кроме.
 *
 * Ключ `phase` означает время суток, `weather` — погоду. `skills` — навыки, чью
 * проверку строка трогает; `ranged` — дальние атаки оружием.
 */
const WEATHER_EFFECTS = Object.freeze([
  Object.freeze({
    id: 'rain-perception',
    weather: 'rain',
    skills: Object.freeze(['perception', 'survival']),
    swing: 'disadvantage',
    reason: 'дождь',
    label: 'Дождь: помеха Восприятию и Выживанию',
  }),
  Object.freeze({
    id: 'fog-ranged',
    weather: 'fog',
    ranged: true,
    swing: 'disadvantage',
    reason: 'туман',
    label: 'Туман: помеха дальним атакам',
  }),
  Object.freeze({
    id: 'storm-stealth',
    weather: 'storm',
    skills: Object.freeze(['stealth']),
    swing: 'advantage',
    reason: 'гроза',
    label: 'Гроза: преимущество на Скрытность',
  }),
  Object.freeze({
    id: 'night-perception',
    phase: 'night',
    skills: Object.freeze(['perception']),
    swing: 'disadvantage',
    reason: 'ночь',
    label: 'Ночь: помеха Восприятию',
  }),
])

export const WEATHER_EFFECT_IDS = Object.freeze(WEATHER_EFFECTS.map((effect) => effect.id))

/**
 * Навыки, которым погода и темнота вообще что-то меняют. Выводится из самой
 * таблицы, а не перечисляется рядом с ней: руками написанный набор молча
 * отключал бы новую строку — `weatherCheckSwing` выходит по нему до обращения к
 * таблице, и эффект для навыка вне набора не сработал бы ни разу.
 */
export const WEATHER_AFFECTED_SKILLS = Object.freeze(new Set(WEATHER_EFFECTS.flatMap((effect) => effect.skills ?? [])))

/**
 * Что действует при таком небе. Чистая функция: состояния не читает вовсе.
 *
 * Экспортируется ради сторожа: `weatherCheckSwing` отдаёт **один** эффект, и
 * конфликт в таблице (одно небо, один навык, обе стороны) из её ответа не виден.
 * Перебор фаз × погоды × навыков живёт в `test/weather.test.mjs` и опирается
 * именно на эту функцию.
 */
export function weatherEffectsUnder({ indoors = false, phase = 'day', weather = 'clear' } = {}) {
  if (indoors) return []
  return WEATHER_EFFECTS.filter((effect) => (
    (effect.phase == null || effect.phase === phase)
    && (effect.weather == null || effect.weather === weather)
  ))
}

function activeEffects(state, elapsedMinutes = elapsedMinutesOf(state), actorIdValue = null) {
  return weatherEffectsUnder({
    indoors: isIndoors(state, actorIdValue),
    phase: timeOfDayOf(elapsedMinutes),
    weather: weatherOf(state, elapsedMinutes),
  })
}

/** Русские подписи действующих эффектов — для подсказки индикатора и ведущего. */
/** @param {number|string|null|undefined} [actorIdValue] */
export function weatherEffectLabels(state = {}, actorIdValue = null) {
  return activeEffects(state, undefined, resolvedWeatherActorId(state, actorIdValue)).map((effect) => effect.label)
}

/**
 * Преимущество или помеха от неба на проверку навыка. Возвращает `null`, когда
 * небо в этой проверке не участвует, — вызывающему не нужно знать таблицу.
 *
 * Обе стороны сразу вернуться не могут: одна и та же погода не даёт навыку и
 * помеху, и преимущество. Сторож — `test/weather.test.mjs`.
 */
export function weatherCheckSwing(state = {}, skill = '', actorIdValue = null) {
  const id = String(skill ?? '').trim().toLocaleLowerCase('en').replace(/_/gu, '-')
  if (!WEATHER_AFFECTED_SKILLS.has(id)) return null
  const effect = activeEffects(state, undefined, actorIdValue).find((candidate) => (candidate.skills ?? []).includes(id))
  return effect ? { swing: effect.swing, reason: effect.reason, effect_id: effect.id } : null
}

/** Причина помехи дальней атаке под открытым небом либо `null`. */
export function weatherRangedPenalty(state = {}, actorIdValue = null) {
  const effect = activeEffects(state, undefined, actorIdValue).find((candidate) => candidate.ranged === true)
  return effect ? { reason: effect.reason, effect_id: effect.id } : null
}

// ---------------------------------------------------------------------------
// Сводка: что показывать и что отдавать агентам
// ---------------------------------------------------------------------------

/**
 * Полный вывод мировых часов на текущую минуту. Одна функция на индикатор,
 * проекцию, контекст Рассказчика и карточку ведущего: второго ответа на вопрос
 * «который час и что на небе» быть не должно.
 */
/**
 * @param {object} [state]
 * @param {number|string|undefined} [elapsedMinutesOrActorId]
 * @param {number|string|null|undefined} [actorIdValue]
 */
export function worldClockFor(state = {}, elapsedMinutesOrActorId, actorIdValue = null) {
  const elapsedMinutes = typeof elapsedMinutesOrActorId === 'number'
    ? elapsedMinutesOrActorId
    : elapsedMinutesOf(state)
  const actorId = typeof elapsedMinutesOrActorId === 'string' ? elapsedMinutesOrActorId : actorIdValue
  const phase = timeOfDayOf(elapsedMinutes)
  const weather = weatherOf(state, elapsedMinutes)
  const indoors = isIndoors(state, resolvedWeatherActorId(state, actorId))
  const phaseLabel = dayPhaseLabel(phase)
  const weatherLabel = weatherConditionLabel(weather)
  return {
    schema_version: WEATHER_SCHEMA_VERSION,
    policy_id: WEATHER_POLICY_ID,
    day: campaignDayOf(elapsedMinutes) + 1,
    clock: clockLabelOf(elapsedMinutes),
    phase,
    phase_label: phaseLabel,
    weather,
    weather_label: weatherLabel,
    weather_summary: weatherConditionSummary(weather),
    biome: currentBiomeOf(state),
    region_name: text(currentRegionOf(state)?.name, 120),
    indoors,
    indicator: `${phaseLabel} · ${weatherLabel}`,
    effects: weatherEffectsUnder({ indoors, phase, weather }).map((effect) => effect.label),
  }
}

/**
 * То же, но для проекции игроку. Форма совпадает с админской намеренно: небо
 * над отрядом — не тайна ведущего, и прятать от игрока погоду было бы враньём.
 */
/** @param {number|string|null|undefined} [actorIdValue] */
export function weatherForViewer(state = {}, actorIdValue = null) {
  return worldClockFor(state, actorIdValue)
}

/**
 * Данные для Рассказчика и Режиссёра. Ровно то же, что видит игрок, плюс
 * подписи действующих эффектов: модель не должна догадываться, почему бросок
 * ушёл с помехой.
 */
/** @param {number|string|null|undefined} [actorIdValue] */
export function worldClockForAgents(state = {}, actorIdValue = null) {
  const clock = worldClockFor(state, actorIdValue)
  return {
    day: clock.day,
    clock: clock.clock,
    time_of_day: clock.phase,
    time_of_day_label: clock.phase_label,
    weather: clock.weather,
    weather_label: clock.weather_label,
    weather_summary: clock.weather_summary,
    indoors: clock.indoors,
    effects: clock.effects,
  }
}

// ---------------------------------------------------------------------------
// События смены
// ---------------------------------------------------------------------------

/**
 * Что мировые часы обязаны записать, когда время шагнуло с `elapsedMinutes` на
 * `elapsedMinutes + advancedMinutes`.
 *
 * Событие выпускается только на **смену**: время суток — когда пересечена
 * граница фазы, погода — когда сменились сутки **и** небо действительно стало
 * другим. Утро с тем же дождём, что вчера, летописи не нужно.
 *
 * Прыжок сразу через несколько суток (сутки под стражей, восемь часов сна)
 * записывается одним событием: игрок пропустил не четыре смены погоды, а один
 * промежуток, и рассказывать про каждый пропущенный рассвет было бы враньём про
 * то, чего отряд не видел.
 *
 * Край здесь один — тот, в котором отряд стоит **сейчас**: время идёт до
 * перехода, и небо этих минут принадлежит покидаемому краю. Смену неба от
 * пересечения границы края пишет отдельный черновик
 * (`regionWeatherEventDraft`), иначе «было → стало» опровергалось бы индикатором
 * сразу по прибытии.
 */
export function worldClockEventDrafts(state = {}, advancedMinutes = 0) {
  const advanced = minutes(advancedMinutes)
  if (advanced <= 0) return []
  const before = elapsedMinutesOf(state)
  const after = before + advanced
  const drafts = []

  const phaseBefore = timeOfDayOf(before)
  const phaseAfter = timeOfDayOf(after)
  if (phaseBefore !== phaseAfter) {
    drafts.push({
      event_type: TIME_OF_DAY_CHANGED_EVENT,
      visibility: 'party',
      payload: {
        schema_version: WEATHER_SCHEMA_VERSION,
        policy_id: WEATHER_POLICY_ID,
        phase_before: phaseBefore,
        phase_after: phaseAfter,
        phase_label: dayPhaseLabel(phaseAfter),
        clock: clockLabelOf(after),
        day: campaignDayOf(after) + 1,
        at_minutes: after,
      },
    })
  }

  const dayBefore = campaignDayOf(before)
  const dayAfter = campaignDayOf(after)
  const weatherBefore = weatherOf(state, before)
  const weatherAfter = weatherOf(state, after)
  if (dayBefore !== dayAfter && weatherBefore !== weatherAfter) {
    drafts.push({
      event_type: WEATHER_CHANGED_EVENT,
      visibility: 'party',
      payload: {
        schema_version: WEATHER_SCHEMA_VERSION,
        policy_id: WEATHER_POLICY_ID,
        weather_before: weatherBefore,
        weather_after: weatherAfter,
        weather_label: weatherConditionLabel(weatherAfter),
        biome: currentBiomeOf(state),
        region_name: text(currentRegionOf(state)?.name, 120),
        reason: 'day',
        day: dayAfter + 1,
        at_minutes: after,
      },
    })
  }
  return drafts
}

/**
 * Смена неба от перехода в другой край. Погода принадлежит климату края
 * (`BIOME_WEATHER_WEIGHTS`), поэтому граница между равниной и топью — такая же
 * причина сменить небо, как наступившее утро, и молчать о ней нельзя: индикатор
 * у игрока пересчитывается сразу по прибытии, а летопись бы об этом не сказала
 * ни слова — да ещё и опровергала бы только что записанное «стало ясно».
 *
 * Считается по двум состояниям — до перехода и после, — потому что край берётся
 * из `worldMap.currentLocationId`, а его меняет само событие сцены. Время между
 * ними не идёт: сравнивать минуты не нужно, разойтись эти два ответа могут
 * только климатом.
 *
 * Возвращает `null`, когда небо то же самое: переход внутри одного края — не
 * событие погоды.
 */
export function regionWeatherEventDraft(before = {}, after = {}) {
  const weatherBefore = weatherOf(before)
  const weatherAfter = weatherOf(after)
  if (weatherBefore === weatherAfter) return null
  return {
    event_type: WEATHER_CHANGED_EVENT,
    visibility: 'party',
    payload: {
      schema_version: WEATHER_SCHEMA_VERSION,
      policy_id: WEATHER_POLICY_ID,
      weather_before: weatherBefore,
      weather_after: weatherAfter,
      weather_label: weatherConditionLabel(weatherAfter),
      biome: currentBiomeOf(after),
      region_name: text(currentRegionOf(after)?.name, 120),
      region_before: text(currentRegionOf(before)?.name, 120),
      reason: 'region',
      day: campaignDayOf(elapsedMinutesOf(after)) + 1,
      at_minutes: elapsedMinutesOf(after),
    },
  }
}

/**
 * Строка летописи про смену. Детерминированная и серверная: модель к описанию
 * неба не допускается, потому что механика уже решена и свободный текст способен
 * только с ней разойтись (`server/deterministic-narration.mjs`).
 */
const PHASE_ARRIVAL_LINES = Object.freeze({
  morning: 'Светает: над отрядом занимается утро.',
  day: 'Солнце поднимается — наступил день.',
  evening: 'Свет уходит, ложатся длинные тени: наступил вечер.',
  night: 'Темнеет окончательно — наступила ночь.',
})

const WEATHER_ARRIVAL_LINES = Object.freeze({
  clear: 'Небо расчистилось.',
  overcast: 'Небо затянуло сплошной пеленой.',
  rain: 'Зарядил дождь.',
  fog: 'С низин поднялся туман.',
  storm: 'Собралась гроза.',
})

export function worldClockNarration(event = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  if (type === TIME_OF_DAY_CHANGED_EVENT) {
    return PHASE_ARRIVAL_LINES[String(payload.phase_after)] ?? ''
  }
  if (type === WEATHER_CHANGED_EVENT) {
    const line = WEATHER_ARRIVAL_LINES[String(payload.weather_after)] ?? ''
    const summary = weatherConditionSummary(payload.weather_after)
    // Небо, сменившееся от перехода границы края, объявляется иначе: «зарядил
    // дождь» посреди пути звучало бы как погода, а не как другой климат.
    const prefix = String(payload.reason) === 'region' ? 'За краем — другое небо.' : ''
    return [prefix, line, summary].filter(Boolean).join(' ')
  }
  return ''
}
