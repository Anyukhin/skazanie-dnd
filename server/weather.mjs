import { createHash } from 'node:crypto'

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
 *    избавляет стол от спора «а мы же в трактире».
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

/** Сколько минут в сутках. Тем же числом считает рассвет `item-dawn-recharge`. */
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
 * Список продублирован здесь намеренно, а не импортирован: `scene-themes.mjs`
 * тянет за собой генераторы планировок и расстановку предметов, а этот модуль —
 * лист, как `law-and-order.mjs`.
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

/** Навыки, которым погода и темнота вообще что-то меняют. */
export const WEATHER_AFFECTED_SKILLS = Object.freeze(new Set(['perception', 'survival', 'stealth']))

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
 * Стоит ли сцена под крышей. Ответ берётся из темы уже построенной тактической
 * карты (`scene.map.theme` хранит идентификатор темы), а при её отсутствии — из
 * вида сцены. Своего разбора названия локации здесь нет: он разошёлся бы с
 * опознанием темы на первой же локации, созданной на лету.
 */
export function isIndoorScene(scene = {}) {
  const theme = text(scene?.map?.theme, 60)
  if (INDOOR_SCENE_THEMES.has(theme)) return true
  if (OUTDOOR_SCENE_THEMES.has(theme)) return false
  return INDOOR_SCENE_KINDS.has(text(scene?.scene_kind, 40))
}

export function isIndoors(state = {}) {
  return isIndoorScene(state?.scene ?? {})
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

/** Что действует при таком небе. Чистая функция: состояния не читает вовсе. */
function effectsUnder({ indoors = false, phase = 'day', weather = 'clear' } = {}) {
  if (indoors) return []
  return WEATHER_EFFECTS.filter((effect) => (
    (effect.phase == null || effect.phase === phase)
    && (effect.weather == null || effect.weather === weather)
  ))
}

function activeEffects(state, elapsedMinutes = elapsedMinutesOf(state)) {
  return effectsUnder({
    indoors: isIndoors(state),
    phase: timeOfDayOf(elapsedMinutes),
    weather: weatherOf(state, elapsedMinutes),
  })
}

/** Русские подписи действующих эффектов — для подсказки индикатора и ведущего. */
export function weatherEffectLabels(state = {}) {
  return activeEffects(state).map((effect) => effect.label)
}

/**
 * Преимущество или помеха от неба на проверку навыка. Возвращает `null`, когда
 * небо в этой проверке не участвует, — вызывающему не нужно знать таблицу.
 *
 * Обе стороны сразу вернуться не могут: одна и та же погода не даёт навыку и
 * помеху, и преимущество. Сторож — `test/weather.test.mjs`.
 */
export function weatherCheckSwing(state = {}, skill = '') {
  const id = String(skill ?? '').trim().toLocaleLowerCase('en').replace(/_/gu, '-')
  if (!WEATHER_AFFECTED_SKILLS.has(id)) return null
  const effect = activeEffects(state).find((candidate) => (candidate.skills ?? []).includes(id))
  return effect ? { swing: effect.swing, reason: effect.reason, effect_id: effect.id } : null
}

/** Причина помехи дальней атаке под открытым небом либо `null`. */
export function weatherRangedPenalty(state = {}) {
  const effect = activeEffects(state).find((candidate) => candidate.ranged === true)
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
export function worldClockFor(state = {}, elapsedMinutes = elapsedMinutesOf(state)) {
  const phase = timeOfDayOf(elapsedMinutes)
  const weather = weatherOf(state, elapsedMinutes)
  const indoors = isIndoors(state)
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
    effects: effectsUnder({ indoors, phase, weather }).map((effect) => effect.label),
  }
}

/**
 * То же, но для проекции игроку. Форма совпадает с админской намеренно: небо
 * над отрядом — не тайна ведущего, и прятать от игрока погоду было бы враньём.
 */
export function weatherForViewer(state = {}) {
  return worldClockFor(state)
}

/**
 * Данные для Рассказчика и Режиссёра. Ровно то же, что видит игрок, плюс
 * подписи действующих эффектов: модель не должна догадываться, почему бросок
 * ушёл с помехой.
 */
export function worldClockForAgents(state = {}) {
  const clock = worldClockFor(state)
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
        day: dayAfter + 1,
        at_minutes: after,
      },
    })
  }
  return drafts
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
    return [line, summary].filter(Boolean).join(' ')
  }
  return ''
}
