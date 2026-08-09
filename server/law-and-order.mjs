import { createHash } from 'node:crypto'

/**
 * Закон и розыск: у преступлений на людях есть цена.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, B6) фиксировал дыру
 * прямо: «репутация фракции падает, но никто не приходит. Ни состояния „в
 * розыске“, ни реакции стражи, ни ареста». Летопись поступков уже знала, что
 * отряд сделал и **при скольких свидетелях** (`server/world-deeds.mjs`), — не
 * хватало второй половины: чтобы поселение это помнило и чтобы у ворот кто-то
 * стоял.
 *
 * Модуль детерминированный и без обращений к модели, как `captives.mjs` и
 * `parley.mjs`. Устроен он так:
 *
 * 1. **Ступень розыска — чистая функция летописи, а не отдельный счётчик.**
 *    Реестр преступлений (`state.law.crimes`) выводится редьюсером из уже
 *    подтверждённых событий: поступок со свидетелями, попавший в летопись,
 *    заводит запись с местом, минутой кампании и весом по тяжести. Ступень
 *    считается по сумме весов **в момент вопроса**, поэтому затухание не
 *    требует ни часов, ни фонового такта: сутки без новых преступлений просто
 *    вычитают очко.
 * 2. **Юрисдикция — регион, а не клетка карты.** Убийство в деревне помнят и в
 *    соседнем городе того же края: закон — это край, а не улица. Место
 *    преступления при этом сохраняется целиком, потому что ведущему нужно
 *    видеть, где именно.
 * 3. **Без свидетелей преступления нет.** Тёмный переулок остаётся тайной
 *    ведущего: поступок с `secret: true` ступень не двигает вовсе. Это то же
 *    правило, что у молвы, и специально то же самое — иначе один и тот же нож
 *    считался бы по двум разным меркам.
 * 4. **Снятие — только событием.** Штраф, сдача и амнистия пишут `WantedCleared`
 *    со списком прощённых преступлений. Границей служит не минута, а сами
 *    записи: прощение «по времени» либо теряло бы преступление той же минуты,
 *    либо прощало бы совершённое секундой позже.
 *
 * Осознанные границы (решено, а не забыто):
 * - **тема боя со стражей взята из существующих** (`warband` — единственная, где
 *   в ростере есть `guard-captain` и `knight`). Заводить свою тему и свои
 *   стат-блоки нельзя: каталог врагов принадлежит другой задаче;
 * - **офицер — карточка сцены, а не житель мира.** Социального профиля ему не
 *   заводится намеренно: парлей уже показал, чем кончается доступный профиль без
 *   адреса — труп остаётся вечным свидетелем каждого следующего поступка
 *   (`rules-engine.mjs`, ветка `ProposeParley`);
 * - **провал побега не начинает бой.** Он поднимает ступень и оставляет встречу
 *   открытой: у отряда остаются штраф и сдача. Тупика, из которого нет выхода
 *   без броска кубика, у закона быть не должно.
 */

export const LAW_SCHEMA_VERSION = 1
export const LAW_POLICY_ID = 'skazanie:law-and-order-v1'

/**
 * Что закон считает преступлением и сколько это стоит в очках розыска. Таблица
 * закрытая и серверная: ни модель, ни клиент в неё не добавляют.
 *
 * Виды — те же, что у летописи поступков (`DEED_KINDS`, `world-deeds.mjs`), но
 * список короче: закон судит не за всё, что мир осуждает. Нарушенное слово —
 * дело чести, а не стражи, и в таблице его нет.
 */
export const WANTED_CRIME_POINTS = Object.freeze({
  murder: 4,
  cruelty: 4,
  treachery: 3,
  arson: 3,
  theft: 2,
  destruction: 2,
  violence: 1,
  vandalism: 1,
  // Сопротивление аресту. Своего поступка в летописи у него нет: он рождается
  // не из действия в мире, а из отказа подчиниться уже пришедшей страже,
  // поэтому вес приходит в payload события, а не из этой таблицы.
  defiance: 0,
})

export const WANTED_CRIME_KINDS = Object.freeze(Object.keys(WANTED_CRIME_POINTS)
  .filter((kind) => WANTED_CRIME_POINTS[kind] > 0))

/**
 * Пороги ступеней. Ступень — наибольшая, чей порог набран: кража (2) поднимает
 * до первой, убийство (4) — до второй, убийство с поджогом (7) — до розыска
 * по всему краю.
 */
export const WANTED_LEVEL_THRESHOLDS = Object.freeze([0, 2, 4, 7])
export const MAX_WANTED_LEVEL = WANTED_LEVEL_THRESHOLDS.length - 1

/** Как ступень называется у ведущего. Игроку цифра не показывается вовсе. */
export const WANTED_LEVEL_LABELS = Object.freeze([
  'закон спокоен',
  'приметили',
  'ищут',
  'розыск по краю',
])

/** Сутки игрового времени без новых преступлений снимают одно очко. */
export const WANTED_DECAY_MINUTES = 1_440

/** Штраф по ступени в медных монетах: 5, 20 и 60 золотых. */
export const WANTED_FINE_CP = Object.freeze({ 1: 500, 2: 2_000, 3: 6_000 })

/**
 * Пассивное Восприятие стражи по ступени. Оно растёт не потому, что стражники
 * умнеют, а потому, что по тревоге на улицах больше глаз.
 */
export const GUARD_PASSIVE_PERCEPTION = Object.freeze({ 1: 11, 2: 13, 3: 15 })

/** Сколько кампанийного времени отнимает сдача под стражу: сутки в холодной. */
export const GUARD_CUSTODY_MINUTES = 1_440

/**
 * Цена неудачного побега в очках розыска. Ступень она поднимает, но встречу не
 * закрывает: стража на месте, и у отряда остаются вира и сдача.
 */
export const WANTED_ESCAPE_FAILURE_POINTS = 2

/**
 * Тема боя со стражей. Взята из **существующих** тем ассемблера: `warband` —
 * единственная, где в ростере стоят `guard-captain` и `knight`. Своей темы и
 * своих стат-блоков закон не заводит.
 */
export const GUARD_ENCOUNTER_THEME = 'warband'

/** Сложность боя со стражей по ступени: чем громче розыск, тем больше пришло. */
export const GUARD_ENCOUNTER_DIFFICULTY = Object.freeze({ 1: 'easy', 2: 'medium', 3: 'hard' })

/** Виды узлов карты мира, где есть кому исполнять закон. */
export const SETTLEMENT_LOCATION_KINDS = Object.freeze(new Set(['town', 'village', 'city', 'port', 'fortress']))

/** Чем кончается встреча со стражей. Список закрытый и серверный. */
export const GUARD_RESOLUTIONS = Object.freeze(['fine', 'surrender', 'fight', 'flee'])

/** Чем давят на побеге: тихо уйти или прорваться. */
export const GUARD_ESCAPE_SKILLS = Object.freeze(['stealth', 'athletics'])

export const LAW_COMMAND_TYPES = Object.freeze(new Set(['ResolveGuardEncounter', 'ClearWantedLevel']))

/** Причины, по которым розыск снимается. */
export const WANTED_CLEAR_REASONS = Object.freeze(['fine', 'surrender', 'amnesty'])

/**
 * Со ступени, на которой торговец отказывается иметь дело. До неё розыск только
 * дорожает: лавка закрывается ровно тогда, когда торговать с отрядом опасно
 * самому торговцу, а не тогда, когда он им недоволен.
 */
export const WANTED_TRADE_REFUSAL_LEVEL = 3

/** Наценка за розыск в базисных пунктах: с меченым отрядом дела дороже. */
export const WANTED_PRICE_BPS = Object.freeze({ 0: 0, 1: 250, 2: 500, 3: 1_000 })

const MAX_CRIMES = 120
const MAX_CLEARED_REGIONS = 40

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

/** Детерминированный выбор из таблицы: одинаковый вход — одинаковый выход. */
function pick(list, seed, salt = '') {
  const values = Array.isArray(list) ? list : []
  if (!values.length) return null
  return values[Number.parseInt(digest(seed, salt).slice(0, 8), 16) % values.length]
}

// ---------------------------------------------------------------------------
// География: где отряд стоит и какому краю он должен
// ---------------------------------------------------------------------------

/**
 * Где отряд числится на карте мира. Берётся `worldMap.currentLocationId` —
 * то самое поле, которое движок обновляет и при нормализации состояния, и
 * редьюсером `SceneAdvanced`. Своего разбора имени сцены здесь нет намеренно:
 * второй способ ответить «где отряд» разошёлся бы с первым на первой же
 * локации, созданной на лету.
 */
export function currentWorldNode(state = {}) {
  const map = state?.worldMap
  const expected = text(map?.currentLocationId, 180)
  if (!expected) return null
  return (Array.isArray(map?.locations) ? map.locations : [])
    .find((node) => text(node?.id, 180) === expected) ?? null
}

function regionNameFor(state, regionId) {
  const expected = text(regionId, 180)
  if (!expected) return ''
  const region = (Array.isArray(state?.worldMap?.regions) ? state.worldMap.regions : [])
    .find((entry) => text(entry?.id, 180) === expected)
  return text(region?.name, 180)
}

/** Край, которому отряд отвечает прямо сейчас, либо пустая строка. */
export function currentRegionId(state = {}) {
  return text(currentWorldNode(state)?.regionId, 180)
}

/** Стоит ли отряд в поселении, где есть кому исполнять закон. */
export function currentSettlement(state = {}) {
  const node = currentWorldNode(state)
  if (!node || !SETTLEMENT_LOCATION_KINDS.has(text(node.kind, 40))) return null
  return {
    node_id: text(node.id, 180),
    name: text(node.name, 180),
    kind: text(node.kind, 40),
    region_id: text(node.regionId, 180),
    region_name: regionNameFor(state, node.regionId),
  }
}

// ---------------------------------------------------------------------------
// Состояние закона
// ---------------------------------------------------------------------------

function safeCrime(value = {}) {
  const id = text(value.id, 140)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/u.test(id)) return null
  const kind = text(value.kind, 40)
  if (!Object.hasOwn(WANTED_CRIME_POINTS, kind)) return null
  const regionId = text(value.region_id, 180)
  if (!regionId) return null
  return {
    id,
    kind,
    points: clamp(integer(value.points, WANTED_CRIME_POINTS[kind] ?? 1), 0, 12),
    region_id: regionId,
    region_name: text(value.region_name, 180),
    node_id: text(value.node_id, 180),
    place_name: text(value.place_name, 180),
    at_minutes: Math.max(0, integer(value.at_minutes, 0)),
    witnesses: Math.max(0, integer(value.witnesses, 0)),
    summary: text(value.summary, 400),
    cleared_at_minutes: value.cleared_at_minutes == null ? null : Math.max(0, integer(value.cleared_at_minutes, 0)),
    cleared_reason: WANTED_CLEAR_REASONS.includes(text(value.cleared_reason, 30)) ? text(value.cleared_reason, 30) : null,
  }
}

function safeEncounter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = text(value.id, 140)
  const regionId = text(value.region_id, 180)
  if (!id || !regionId) return null
  return {
    id,
    region_id: regionId,
    region_name: text(value.region_name, 180),
    node_id: text(value.node_id, 180),
    place_name: text(value.place_name, 180),
    level: clamp(integer(value.level, 1), 1, MAX_WANTED_LEVEL),
    fine_cp: Math.max(0, integer(value.fine_cp, 0)),
    officer_name: text(value.officer_name, 160),
    officer_rank: text(value.officer_rank, 120),
    demand: text(value.demand, 400),
    escape_dc: clamp(integer(value.escape_dc, 11), 5, 30),
    escape_attempts: Math.max(0, integer(value.escape_attempts, 0)),
    started_at_minutes: Math.max(0, integer(value.started_at_minutes, 0)),
    policy_id: LAW_POLICY_ID,
  }
}

export function normalizeLawState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const crimes = []
  const seen = new Set()
  for (const raw of Array.isArray(source.crimes) ? source.crimes : []) {
    const crime = safeCrime(raw)
    if (!crime || seen.has(crime.id)) continue
    seen.add(crime.id)
    crimes.push(crime)
  }
  const clearedSource = source.cleared && typeof source.cleared === 'object' && !Array.isArray(source.cleared)
    ? source.cleared
    : {}
  const cleared = {}
  for (const [regionId, entry] of Object.entries(clearedSource).slice(0, MAX_CLEARED_REGIONS)) {
    const key = text(regionId, 180)
    if (!key) continue
    cleared[key] = {
      at_minutes: Math.max(0, integer(entry?.at_minutes, 0)),
      reason: WANTED_CLEAR_REASONS.includes(text(entry?.reason, 30)) ? text(entry.reason, 30) : 'amnesty',
    }
  }
  return {
    schema_version: LAW_SCHEMA_VERSION,
    crimes: crimes.slice(-MAX_CRIMES),
    cleared,
    encounter: safeEncounter(source.encounter),
  }
}

// ---------------------------------------------------------------------------
// Ступень розыска
// ---------------------------------------------------------------------------

export function wantedLevelForPoints(points) {
  const value = Math.max(0, integer(points, 0))
  let level = 0
  for (let index = 1; index < WANTED_LEVEL_THRESHOLDS.length; index += 1) {
    if (value >= WANTED_LEVEL_THRESHOLDS[index]) level = index
  }
  return level
}

/**
 * Что закон края помнит про отряд прямо сейчас. Чистая функция: одинаковое
 * состояние и одинаковая минута дают одинаковую ступень, поэтому replay
 * воспроизводит розыск без отдельного счётчика и без такта.
 */
export function wantedFor(state = {}, regionId = '') {
  const law = normalizeLawState(state?.law)
  const region = text(regionId, 180)
  const minute = Math.max(0, integer(state?.mechanics?.world_time?.elapsed_minutes, 0))
  const crimes = law.crimes.filter((crime) => crime.region_id === region && crime.cleared_at_minutes == null)
  const raw = crimes.reduce((sum, crime) => sum + crime.points, 0)
  const lastCrimeAtMinutes = crimes.reduce((latest, crime) => Math.max(latest, crime.at_minutes), 0)
  // Затухание считается от последнего преступления, а не от каждого по
  // отдельности: пока отряд продолжает, счёт не тает вовсе.
  const quietMinutes = crimes.length ? Math.max(0, minute - lastCrimeAtMinutes) : 0
  const decay = crimes.length ? Math.floor(quietMinutes / WANTED_DECAY_MINUTES) : 0
  const points = Math.max(0, raw - decay)
  const level = wantedLevelForPoints(points)
  return {
    region_id: region,
    region_name: regionNameFor(state, region) || crimes.at(-1)?.region_name || '',
    points,
    raw_points: raw,
    decayed_points: Math.min(raw, decay),
    level,
    label: WANTED_LEVEL_LABELS[level] ?? WANTED_LEVEL_LABELS[0],
    crime_count: crimes.length,
    last_crime_at_minutes: crimes.length ? lastCrimeAtMinutes : null,
    quiet_minutes: quietMinutes,
    // Сколько игрового времени осталось до следующего снятого очка: ведущему
    // это нужнее самой цифры, потому что решает, стоит ли отряду переждать.
    next_decay_in_minutes: points > 0 ? WANTED_DECAY_MINUTES - (quietMinutes % WANTED_DECAY_MINUTES) : null,
    policy_id: LAW_POLICY_ID,
  }
}

/** Ступень розыска в крае, где отряд стоит прямо сейчас. */
export function wantedLevelHere(state = {}) {
  const region = currentRegionId(state)
  return region ? wantedFor(state, region).level : 0
}

/** Что известно про розыск в текущем крае — одной записью. */
export function wantedHere(state = {}) {
  return wantedFor(state, currentRegionId(state))
}

/** Какие преступления снимет прощение прямо сейчас: список закрывает границу. */
export function pendingCrimeIdsFor(state = {}, regionId = '') {
  const law = normalizeLawState(state?.law)
  const region = text(regionId, 180)
  return law.crimes
    .filter((crime) => crime.region_id === region && crime.cleared_at_minutes == null)
    .map((crime) => crime.id)
}

/** Лента ведущего: по краю на строку, свежие сверху. */
export function wantedFeed(state = {}) {
  const law = normalizeLawState(state?.law)
  const regions = [...new Set(law.crimes.map((crime) => crime.region_id))]
  return regions
    .map((regionId) => {
      const wanted = wantedFor(state, regionId)
      const crimes = law.crimes
        .filter((crime) => crime.region_id === regionId)
        .slice(-12)
        .reverse()
      return { ...wanted, here: regionId === currentRegionId(state), crimes }
    })
    .sort((left, right) => right.level - left.level
      || (right.last_crime_at_minutes ?? 0) - (left.last_crime_at_minutes ?? 0)
      || left.region_id.localeCompare(right.region_id))
}

// ---------------------------------------------------------------------------
// Преступление из уже подтверждённого поступка
// ---------------------------------------------------------------------------

/**
 * Преступление из последней записи летописи поступков. Вызывается редьюсером
 * **после** редьюсера летописи, поэтому свежий поступок уже лежит в состоянии,
 * а искать его по всему реестру не нужно: `applyWorldDeedEvent` добавляет не
 * больше одной записи на событие, и она всегда последняя.
 *
 * @returns {ReturnType<typeof safeCrime> | null}
 */
export function crimeFromDeedLedger(state = {}, event = {}) {
  const deeds = Array.isArray(state?.world_deeds?.deeds) ? state.world_deeds.deeds : []
  const deed = deeds.at(-1)
  if (!deed) return null
  const eventId = text(event?.event_id, 120)
  // Поступок родился именно от этого события, а не лежал в летописи раньше.
  if (!eventId || !(Array.isArray(deed.source_event_ids) ? deed.source_event_ids : []).map(String).includes(eventId)) return null
  // Без свидетелей преступления для закона нет: тёмный переулок остаётся тайной
  // ведущего ровно так же, как для молвы.
  if (deed.secret === true) return null
  const points = WANTED_CRIME_POINTS[text(deed.kind, 40)] ?? 0
  if (points <= 0) return null
  const node = currentWorldNode(state)
  const regionId = text(node?.regionId, 180)
  // Край неизвестен — значит, некому и помнить: карта мира ещё не знает этого
  // места. Заводить безымянную юрисдикцию хуже, чем не заводить никакой.
  if (!regionId) return null
  return safeCrime({
    id: `crime:${digest(deed.id).slice(0, 24)}`,
    kind: deed.kind,
    points,
    region_id: regionId,
    region_name: regionNameFor(state, regionId),
    node_id: text(node?.id, 180),
    place_name: text(deed.location_name, 180) || text(node?.name, 180),
    at_minutes: Math.max(0, integer(deed.at_minutes, 0)),
    witnesses: (Array.isArray(deed.witness_ids) ? deed.witness_ids : []).length,
    summary: text(deed.summary, 400),
  })
}

// ---------------------------------------------------------------------------
// Встреча со стражей
// ---------------------------------------------------------------------------

const OFFICER_RANKS = Object.freeze(['десятник стражи', 'начальник караула', 'сотник городской стражи'])

const OFFICER_NAMES = Object.freeze([
  'Радим', 'Твердислав', 'Гостята', 'Бориcлав', 'Ратмир', 'Вышата',
  'Добрыня', 'Мстислав', 'Улеб', 'Первуша', 'Лютобор', 'Заслав',
])

/**
 * Кто вышел навстречу. Имя и чин выводятся детерминированно из сида кампании,
 * края и ступени, поэтому replay даёт того же человека. Чин растёт со ступенью:
 * за мелким воришкой идёт десятник, за убийцей — сотник.
 */
export function guardOfficerFor(state = {}, { regionId = '', level = 1 } = {}) {
  const seed = digest(text(state?.sessionCode, 60), text(regionId, 180), String(level))
  return {
    name: pick(OFFICER_NAMES, seed, 'name') ?? OFFICER_NAMES[0],
    rank: OFFICER_RANKS[clamp(integer(level, 1), 1, MAX_WANTED_LEVEL) - 1] ?? OFFICER_RANKS[0],
  }
}

export function guardFineCpFor(level) {
  return WANTED_FINE_CP[clamp(integer(level, 1), 1, MAX_WANTED_LEVEL)] ?? WANTED_FINE_CP[1]
}

export function guardEscapeDcFor(level) {
  return GUARD_PASSIVE_PERCEPTION[clamp(integer(level, 1), 1, MAX_WANTED_LEVEL)] ?? GUARD_PASSIVE_PERCEPTION[1]
}

/**
 * Что офицер требует вслух. Формулировка серверная и по ступени: игрок слышит
 * последствие, а не цифру розыска.
 */
export function guardDemandFor(level, { placeName = '', fineCp = 0 } = {}) {
  const place = text(placeName, 180) || 'этом месте'
  const gold = Math.max(1, Math.round(Math.max(0, integer(fineCp, 0)) / 100))
  if (integer(level, 1) >= 3) {
    return `«Стоять. За вами тянется такое, что в «${place}» вас ищут по всему краю. Виру — ${gold} золотых, или пойдёте под замок.»`
  }
  if (integer(level, 1) === 2) {
    return `«Придержите коней. О вас тут спрашивали. Виру — ${gold} золотых, и разойдёмся миром.»`
  }
  return `«Погодите-ка. За вами есть должок перед «${place}». Виру — ${gold} золотых, и ступайте.»`
}

/**
 * Встреча, которую закон обязан начать прямо сейчас, либо `null`. Триггер
 * детерминированный: поселение, ненулевая ступень, нет боя и нет уже открытой
 * встречи.
 */
export function guardEncounterTriggerFor(state = {}, { commandId = '' } = {}) {
  if (normalizeLawState(state?.law).encounter) return null
  if (state?.mechanics?.combat?.active === true) return null
  const settlement = currentSettlement(state)
  if (!settlement) return null
  const wanted = wantedFor(state, settlement.region_id)
  if (wanted.level <= 0) return null
  const officer = guardOfficerFor(state, { regionId: settlement.region_id, level: wanted.level })
  const fineCp = guardFineCpFor(wanted.level)
  return safeEncounter({
    id: `guard-encounter:${digest(text(commandId, 120), settlement.region_id, String(wanted.level)).slice(0, 24)}`,
    region_id: settlement.region_id,
    region_name: settlement.region_name,
    node_id: settlement.node_id,
    place_name: settlement.name,
    level: wanted.level,
    fine_cp: fineCp,
    officer_name: officer.name,
    officer_rank: officer.rank,
    demand: guardDemandFor(wanted.level, { placeName: settlement.name, fineCp }),
    escape_dc: guardEscapeDcFor(wanted.level),
    escape_attempts: 0,
    started_at_minutes: Math.max(0, integer(state?.mechanics?.world_time?.elapsed_minutes, 0)),
  })
}

/** Открытая встреча со стражей либо `null`. */
export function guardEncounterFor(state = {}) {
  return normalizeLawState(state?.law).encounter
}

/**
 * Карточка исходов, которую видит стол. Формулировки серверные: если бы их
 * сочинял клиент, «заплатить» и «сдаться» перестали бы отличаться механикой.
 */
export function guardOptionsFor(encounter) {
  const safe = safeEncounter(encounter)
  if (!safe) return []
  const gold = Math.max(1, Math.round(safe.fine_cp / 100))
  return [
    {
      id: 'fine',
      label: `Заплатить виру · ${gold} зм`,
      summary: 'Стража берёт виру и расходится. Розыск в этом краю снимается.',
      fine_cp: safe.fine_cp,
    },
    {
      id: 'surrender',
      label: 'Сдаться',
      summary: 'Кошель отбирают, отряд проводит сутки под замком. Розыск снимается вместе с ними.',
    },
    {
      id: 'flee',
      label: 'Бежать',
      summary: `Проверка группы против пассивного Восприятия стражи (СЛ ${safe.escape_dc}). Ушли — розыск остаётся; не ушли — станет хуже.`,
      difficulty: safe.escape_dc,
    },
    {
      id: 'fight',
      label: 'Драться',
      summary: 'Стража принимает бой. Розыск поднимется до предела, и это уже не забудут.',
    },
  ]
}

/**
 * Успех группового побега. Правило то же, что за столом: считается половина
 * отряда, а не самый ловкий и не самый неуклюжий.
 */
export function escapeSucceeded(results = []) {
  const rolls = Array.isArray(results) ? results : []
  if (!rolls.length) return false
  const successes = rolls.filter((entry) => entry?.success === true).length
  return successes * 2 >= rolls.length
}

// ---------------------------------------------------------------------------
// Мир, который косится
// ---------------------------------------------------------------------------

/**
 * Что отряд видит вокруг себя вместо цифры розыска. Строки детерминированные и
 * по ступени: игрок узнаёт про розыск из мира, а не из индикатора.
 */
const WANTED_SIGNS = Object.freeze([
  [],
  ['Разговоры у колодца смолкают, когда отряд проходит мимо.'],
  [
    'Стражник у ворот провожает отряд взглядом дольше, чем нужно.',
    'На доске у управы висит свежий лист с описанием чужаков.',
  ],
  [
    'На каждом столбе — «разыскиваются», и приметы читаются знакомо.',
    'Двое стражников идут следом уже вторую улицу и не скрывают этого.',
    'Хозяин лавки прячет глаза и торопится закрыть ставни.',
  ],
])

export function wantedSignsFor(state = {}) {
  const level = wantedLevelHere(state)
  return (WANTED_SIGNS[clamp(level, 0, MAX_WANTED_LEVEL)] ?? []).slice()
}

// ---------------------------------------------------------------------------
// Торговля под розыском
// ---------------------------------------------------------------------------

/** Наценка за розыск в базисных пунктах для текущего края. */
export function wantedPriceBps(state = {}) {
  return WANTED_PRICE_BPS[clamp(wantedLevelHere(state), 0, MAX_WANTED_LEVEL)] ?? 0
}

/**
 * Станет ли торговец вообще иметь дело с отрядом. Отказ — это не каприз славы,
 * а расчёт: продавший меченому отряду отвечает перед той же стражей.
 */
export function wantedTradeAvailable(state = {}) {
  return wantedLevelHere(state) < WANTED_TRADE_REFUSAL_LEVEL
}

export const WANTED_TRADE_REFUSAL_REASON = 'Торговец не станет иметь дела с теми, кого ищет стража'

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/**
 * Что игрок имеет право знать о законе. Ступени, очков и реестра преступлений
 * здесь нет и быть не может: розыск игрок узнаёт по тому, как на него смотрит
 * мир, и по офицеру, который уже стоит перед ним.
 */
export function lawForViewer(state = {}, viewer = {}) {
  const law = normalizeLawState(state?.law)
  if (viewer?.isAdmin === true) {
    return { schema_version: LAW_SCHEMA_VERSION, encounter: law.encounter, regions: wantedFeed(state) }
  }
  const encounter = law.encounter
  return {
    schema_version: LAW_SCHEMA_VERSION,
    signs: wantedSignsFor(state),
    encounter: encounter
      ? {
        id: encounter.id,
        place_name: encounter.place_name,
        officer_name: encounter.officer_name,
        officer_rank: encounter.officer_rank,
        demand: encounter.demand,
        fine_cp: encounter.fine_cp,
        escape_dc: encounter.escape_dc,
        escape_attempts: encounter.escape_attempts,
        options: guardOptionsFor(encounter),
      }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/**
 * Что событие меняет в реестре закона. Реестр выводится из журнала целиком,
 * поэтому replay воспроизводит розыск по построению.
 */
export function applyLawEvent(input, event, state = {}) {
  const type = String(event?.event_type ?? '')
  const normalized = input?.schema_version === LAW_SCHEMA_VERSION && Array.isArray(input.crimes)
    ? input
    : normalizeLawState(input)
  const payload = event?.payload ?? {}
  if (type === 'GuardEncounterStarted') {
    const encounter = safeEncounter(payload.encounter)
    return encounter ? { ...normalized, encounter } : normalized
  }
  if (type === 'GuardEncounterResolved') {
    const escaped = text(payload.resolution, 30) === 'flee' && payload.success !== true
    // Провал побега встречу не закрывает: стража на месте, и отряду ещё
    // выбирать. Закрывают её остальные три исхода и удачный побег.
    if (escaped) {
      const encounter = normalized.encounter
      return encounter
        ? { ...normalized, encounter: { ...encounter, escape_attempts: encounter.escape_attempts + 1 } }
        : normalized
    }
    return { ...normalized, encounter: null }
  }
  if (type === 'WantedLevelRaised') {
    const crime = safeCrime(payload.crime)
    if (!crime || normalized.crimes.some((entry) => entry.id === crime.id)) return normalized
    return normalizeLawState({ ...normalized, crimes: [...normalized.crimes, crime] })
  }
  if (type === 'WantedCleared') {
    const regionId = text(payload.region_id, 180)
    if (!regionId) return normalized
    const forgiven = new Set((Array.isArray(payload.crime_ids) ? payload.crime_ids : []).map((entry) => text(entry, 140)))
    const minute = Math.max(0, integer(payload.at_minutes, 0))
    const reason = WANTED_CLEAR_REASONS.includes(text(payload.reason, 30)) ? text(payload.reason, 30) : 'amnesty'
    return normalizeLawState({
      ...normalized,
      crimes: normalized.crimes.map((crime) => (forgiven.has(crime.id) && crime.cleared_at_minutes == null
        ? { ...crime, cleared_at_minutes: minute, cleared_reason: reason }
        : crime)),
      cleared: { ...normalized.cleared, [regionId]: { at_minutes: minute, reason } },
    })
  }
  // Преступление выводится из уже применённой летописи поступков, а не из
  // собственного разбора события: у закона и у молвы обязан быть один и тот же
  // ответ на вопрос «что отряд сделал и кто это видел».
  const crime = crimeFromDeedLedger(state, event)
  if (!crime || normalized.crimes.some((entry) => entry.id === crime.id)) return normalized
  return normalizeLawState({ ...normalized, crimes: [...normalized.crimes, crime] })
}
