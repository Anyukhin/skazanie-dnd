import { createHash } from 'node:crypto'

import { campaignElapsedMinutes } from './npc-social.mjs'
import { sceneLocationId } from './npc-positioning.mjs'

/**
 * Приручение зверя: «мы его не убили и не прогнали, а увели с собой».
 *
 * До этого модуля у стола была ровно та дыра, которую фиксировал каталог
 * ситуаций (`docs/dnd-table-situations.md`, F1): навык «Уход за животными» лежал
 * на листе героя и в списке свободных действий, а приручать им было некого.
 * Волк, сломленный моралью, убегал в туман и переставал существовать; волк,
 * встреченный вне боя, умел только нападать.
 *
 * Модуль замыкает середину и устроен так:
 *
 * 1. **Лестница из трёх ступеней, а не одна кнопка.** `wary` → `calmed` →
 *    `fed` → `tamed`. Первая и третья ступени — проверка Ухода за животными
 *    (двухфазный ручной d20), между ними стоит кормление, и оно списывает
 *    настоящий паёк из инвентаря героя. Одним удачным броском зверя не уводят.
 * 2. **СЛ выводится из зверя, а не из таблицы «сложность приручения».** Её
 *    составляют CR стат-блока, повадка (хищник или травоядный), рана и то,
 *    сломлена ли уже мораль. Все слагаемые объявлены на карточке броска: игрок
 *    бросает против числа, которое видит, и видит, из чего оно сложилось.
 * 3. **Провал с хищником стоит крови.** Не «попробуйте ещё раз», а укус:
 *    небольшой урон, посчитанный от CR того же стат-блока. Травоядный при
 *    провале просто отходит — и это разница, ради которой повадка вообще
 *    заведена.
 * 4. **Приручённый — спутник, а не боевой актор.** Он перестаёт быть врагом на
 *    доске, идёт за отрядом по сценам, держит стражу на привале (преимущество
 *    на Восприятие, пока отряд отдыхает) и умеет отогнать мелкую тварь — одной
 *    строкой в летописи, без урона и без броска.
 *
 * Осознанные границы (решено, а не забыто):
 * - **боевого спутника здесь нет.** Приручённый зверь не встаёт в инициативу,
 *   не ходит и не атакует. Питомец как боевой актор — отдельное решение
 *   владельца: он тянет за собой очередь хода, ИИ спутника, его смерть,
 *   воскрешение и долю в опыте, и делать это «заодно» нельзя;
 * - **список приручаемых закрыт и серверный** (`BEAST_TAMING_DIETS`). Паука,
 *   скорпиона и многоножку с руки не кормят: приручение — это ладонь, еда и
 *   доверие, а не «зверь ли по типу существа»;
 * - **отпугивание — строка нарратива, и только.** Ни урона, ни проверки, ни
 *   изменения сцены за ним нет, и подписано это прямо в тексте события;
 * - **зверь не умирает спутником.** Он ушёл с доски целиком, бить его нечем, и
 *   ветки смерти у реестра нет — это прямое следствие «не боевого актора».
 */

export const BEAST_TAMING_SCHEMA_VERSION = 1
export const BEAST_TAMING_POLICY_ID = 'skazanie:beast-taming-v1'

/** Навык и характеристика проверки. Оба серверные и клиентом не выбираются. */
export const BEAST_TAMING_SKILL = 'animal-handling'
export const BEAST_TAMING_ABILITY = 'wis'

/**
 * Ступени приручения. Порядок и есть правило: кормят только успокоенного,
 * приручают только накормленного.
 */
export const BEAST_STAGES = Object.freeze(['wary', 'calmed', 'fed', 'tamed'])
export const BEAST_STATUSES = Object.freeze(['wild', 'companion'])

export const BEAST_PLAYER_COMMAND_TYPES = Object.freeze(new Set(['CalmBeast', 'FeedBeast', 'ScareWithBeast']))
export const BEAST_COMMAND_TYPES = BEAST_PLAYER_COMMAND_TYPES

/**
 * Кого вообще уводят с собой и с какой повадкой. Список закрытый и серверный по
 * той же причине, что и список пленных (`CAPTURABLE_CREATURE_TYPES`,
 * `server/captives.mjs`): приручение — это ладонь с едой и доверие, а не тип
 * существа в стат-блоке. Гигантский паук, скорпион и многоножка формально тоже
 * `beast`, и их здесь нет намеренно.
 *
 * Повадка зоологическая, а не «насколько страшный»: гиппопотам — травоядное,
 * хотя опаснее любого волка. Его опасность уже оплачена CR 4, и приписывать ему
 * хищность второй раз значило бы посчитать одно и то же дважды.
 */
export const BEAST_TAMING_DIETS = Object.freeze({
  'srd_5_2_1:wolf': 'predator',
  'srd_5_2_1:dire-wolf': 'predator',
  'srd_5_2_1:lion': 'predator',
  'srd_5_2_1:tiger': 'predator',
  'srd_5_2_1:brown-bear': 'predator',
  'srd_5_2_1:giant-rat': 'predator',
  'srd_5_2_1:giant-boar': 'herbivore',
  'srd_5_2_1:ankylosaurus': 'herbivore',
  'srd_5_2_1:hippopotamus': 'herbivore',
})

export const BEAST_DIETS = Object.freeze(['predator', 'herbivore'])

/** Базовая СЛ. Всё остальное — слагаемые к ней, и каждое объявлено. */
export const BEAST_BASE_DC = 10
/** Хищник дороже травоядного: у него зубы и другая цена ошибки. */
export const BEAST_PREDATOR_DC_SHIFT = 3
/** Раненый зверь загнан и оттого пугливее целого. */
export const BEAST_WOUNDED_DC_SHIFT = 2
/** Мораль уже сломана — зверь и сам ищет, куда деться. */
export const BEAST_BROKEN_MORALE_DC_SHIFT = -2
/** С руки поел — дальше идёт легче, и это единственная скидка, которую покупают. */
export const BEAST_FED_DC_SHIFT = -4
/** Каждая неудача делает зверя настороженнее. Потолок — чтобы не было тупика. */
export const BEAST_ATTEMPT_DC_STEP = 1
export const BEAST_ATTEMPT_DC_CAP = 3

/** Реже раза в игровой час зверь не отпугивает: иначе это кнопка, а не сцена. */
export const BEAST_SCARE_COOLDOWN_MINUTES = 60

const MAX_BEASTS = 40

const clone = (value) => structuredClone(value)
const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const comparable = (value) => text(value, 180).toLocaleLowerCase('ru')
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

// ---------------------------------------------------------------------------
// Стат-блок зверя: повадка, CR, рана
// ---------------------------------------------------------------------------

function creatureTypeOf(enemy = {}) {
  return comparable(enemy.creature_type ?? enemy.creatureType ?? enemy.monster_type ?? enemy.kind)
}

function statBlockIdOf(enemy = {}) {
  return text(enemy.stat_block_id ?? enemy.statBlockId, 120)
}

/**
 * Повадка зверя. `null` — зверь не из списка приручаемых, и это отказ, а не
 * «неизвестно»: догадываться о повадке по имени модуль не имеет права.
 *
 * @param {Record<string, any>} [enemy]
 * @returns {'predator' | 'herbivore' | null}
 */
export function beastDietFor(enemy = {}) {
  if (creatureTypeOf(enemy) !== 'beast') return null
  return BEAST_TAMING_DIETS[statBlockIdOf(enemy)] ?? null
}

/** Приручаемость — единственный вход: `beastDietFor` уже проверил и тип, и список. */
export function isTameableBeast(enemy = {}) {
  return beastDietFor(enemy) != null
}

/**
 * CR стат-блока числом. Провенанс врага несёт его строкой SRD («1/4», «2»), и
 * разбирать её здесь — не парсинг ради парсинга: без числа не сложить СЛ.
 *
 * @param {Record<string, any>} [enemy]
 * @returns {number}
 */
export function beastChallengeRating(enemy = {}) {
  const raw = text(enemy?.provenance?.challenge_rating ?? enemy?.challenge_rating, 12)
  const fraction = raw.match(/^(\d+)\s*\/\s*(\d+)$/u)
  if (fraction) {
    const denominator = Number(fraction[2])
    return denominator > 0 ? Number(fraction[1]) / denominator : 0
  }
  const plain = Number(raw)
  return Number.isFinite(plain) && plain >= 0 ? plain : 0
}

const CR_DC_SHIFTS = Object.freeze([
  Object.freeze({ upTo: 0.125, shift: -2 }),
  Object.freeze({ upTo: 0.25, shift: 0 }),
  Object.freeze({ upTo: 0.5, shift: 1 }),
  Object.freeze({ upTo: 1, shift: 3 }),
  Object.freeze({ upTo: 2, shift: 5 }),
  Object.freeze({ upTo: 3, shift: 7 }),
])

/** Прибавка к СЛ за силу зверя. Крыса и медведь не могут стоить одинаково. */
export function beastChallengeDcShift(challengeRating) {
  const value = Number.isFinite(Number(challengeRating)) ? Number(challengeRating) : 0
  return CR_DC_SHIFTS.find((entry) => value <= entry.upTo)?.shift ?? 9
}

function actorHitPoints(enemy = {}) {
  return Math.max(0, integer(enemy.hp ?? enemy.hitPoints, 0))
}

function actorMaxHitPoints(enemy = {}) {
  return Math.max(1, integer(enemy.maxHp ?? enemy.max_hp ?? enemy.hp, 1))
}

/** Раненый — тот, у кого меньше половины хитов. Половина ровно раной не считается. */
export function beastIsWounded(enemy = {}) {
  return actorHitPoints(enemy) * 2 < actorMaxHitPoints(enemy)
}

function conditionIds(state, actorId) {
  return new Set((state?.mechanics?.conditions?.[String(actorId)] ?? [])
    .map((condition) => String(condition?.id ?? condition)))
}

/** Мораль зверя уже сломана: он бежит или сдался. */
export function beastMoraleBroken(state = {}, enemyId = '') {
  const conditions = conditionIds(state, enemyId)
  return conditions.has('fled') || conditions.has('surrendered')
}

// ---------------------------------------------------------------------------
// Реестр
// ---------------------------------------------------------------------------

function safeBeast(value = {}) {
  const id = text(value.id, 120)
  const actorId = text(value.actor_id, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id) || !actorId) return null
  const stage = BEAST_STAGES.includes(value.stage) ? String(value.stage) : 'wary'
  return {
    id,
    actor_id: actorId,
    name: text(value.name, 160),
    diet: BEAST_DIETS.includes(value.diet) ? String(value.diet) : 'predator',
    stat_block_id: text(value.stat_block_id, 120),
    challenge_rating: text(value.challenge_rating, 12),
    stage,
    status: stage === 'tamed' ? 'companion' : (BEAST_STATUSES.includes(value.status) ? String(value.status) : 'wild'),
    attempts: Math.max(0, integer(value.attempts, 0)),
    bites: Math.max(0, integer(value.bites, 0)),
    location_id: text(value.location_id, 180),
    location_name: text(value.location_name, 180),
    met_at_minutes: Math.max(0, integer(value.met_at_minutes, 0)),
    calmed_at_minutes: value.calmed_at_minutes == null ? null : Math.max(0, integer(value.calmed_at_minutes, 0)),
    fed_at_minutes: value.fed_at_minutes == null ? null : Math.max(0, integer(value.fed_at_minutes, 0)),
    tamed_at_minutes: value.tamed_at_minutes == null ? null : Math.max(0, integer(value.tamed_at_minutes, 0)),
    scared_at_minutes: value.scared_at_minutes == null ? null : Math.max(0, integer(value.scared_at_minutes, 0)),
    policy_id: BEAST_TAMING_POLICY_ID,
  }
}

export function normalizeBeastState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const beasts = []
  const seen = new Set()
  for (const raw of Array.isArray(source.beasts) ? source.beasts : []) {
    const beast = safeBeast(raw)
    if (!beast || seen.has(beast.id)) continue
    seen.add(beast.id)
    beasts.push(beast)
  }
  return { schema_version: BEAST_TAMING_SCHEMA_VERSION, beasts: beasts.slice(-MAX_BEASTS) }
}

export function beastList(state = {}) {
  return normalizeBeastState(state?.beasts).beasts
}

export function beastFor(state = {}, beastId) {
  const expected = text(beastId, 120)
  return beastList(state).find((beast) => beast.id === expected) ?? null
}

export function beastCompanions(state = {}) {
  return beastList(state).filter((beast) => beast.status === 'companion')
}

/** Идентификатор записи. Детерминирован от сида кампании и актора: replay даёт тот же. */
export function beastIdFor(state = {}, actorId) {
  return `beast:${digest(text(state?.sessionCode, 60), text(actorId, 120)).slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// Кого и когда можно уговаривать
// ---------------------------------------------------------------------------

/**
 * Почему зверя нельзя трогать прямо сейчас. `null` — можно.
 *
 * Правило одно и оно из брифа: вне боя — любого живого зверя, в бою — только
 * того, у кого уже сломлена мораль. Успокаивать волка в прыжке нельзя; волка,
 * который развернулся и побежал, — можно, и это ровно та середина, которой не
 * было.
 */
export function beastApproachBlockedReason(state = {}, enemy = {}) {
  if (actorHitPoints(enemy) <= 0 || enemy?.alive === false) return 'beast_down'
  if (state?.mechanics?.combat?.active === true && !beastMoraleBroken(state, enemy.id)) return 'combat_active'
  return null
}

/**
 * Живые приручаемые звери сцены вместе со своей записью реестра (если она уже
 * заведена). Порядок детерминирован идентификатором актора.
 */
export function tameableBeasts(state = {}) {
  const registry = new Map(beastList(state).map((beast) => [beast.actor_id, beast]))
  return (Array.isArray(state?.enemies) ? state.enemies : [])
    .filter((enemy) => enemy?.id && isTameableBeast(enemy))
    .map((enemy) => ({
      enemy,
      beast: registry.get(String(enemy.id)) ?? null,
      blocked_reason: beastApproachBlockedReason(state, enemy),
    }))
    .filter((entry) => entry.beast?.status !== 'companion')
    .sort((left, right) => String(left.enemy.id).localeCompare(String(right.enemy.id)))
}

/** Запись зверя по идентификатору либо черновик для ещё не заведённой. */
export function beastDraftFor(state = {}, enemy = {}) {
  const minutes = campaignElapsedMinutes(state)
  return safeBeast({
    id: beastIdFor(state, enemy.id),
    actor_id: String(enemy.id ?? ''),
    name: text(enemy.name, 160),
    diet: beastDietFor(enemy) ?? 'predator',
    stat_block_id: statBlockIdOf(enemy),
    challenge_rating: text(enemy?.provenance?.challenge_rating, 12),
    stage: 'wary',
    status: 'wild',
    location_id: sceneLocationId(state),
    location_name: text(state?.scene?.location ?? state?.scene?.title, 180),
    met_at_minutes: minutes,
  })
}

// ---------------------------------------------------------------------------
// Политика проверки
// ---------------------------------------------------------------------------

/**
 * СЛ уговора и её слагаемые. Возвращается разложенной намеренно: карточка
 * ручного броска показывает игроку не только число, но и из чего оно сложилось,
 * — иначе «СЛ 18» читается как произвол ведущего.
 *
 * @param {Record<string, any>} [state]
 * @param {Record<string, any>} [enemy] боевой актор зверя
 * @param {Record<string, any> | null} [beast] запись реестра, если уже заведена
 */
export function beastTamingPolicy(state = {}, enemy = {}, beast = null) {
  const diet = beastDietFor(enemy) ?? beast?.diet ?? 'predator'
  const challengeRating = beastChallengeRating(enemy)
  const wounded = beastIsWounded(enemy)
  const brokenMorale = beastMoraleBroken(state, enemy?.id)
  const stage = BEAST_STAGES.includes(beast?.stage) ? String(beast.stage) : 'wary'
  const attempts = Math.max(0, integer(beast?.attempts, 0))
  const parts = [
    { id: 'base', label: 'основа', shift: BEAST_BASE_DC },
    { id: 'challenge', label: `сила зверя (CR ${text(enemy?.provenance?.challenge_rating, 12) || '—'})`, shift: beastChallengeDcShift(challengeRating) },
  ]
  if (diet === 'predator') parts.push({ id: 'predator', label: 'хищник', shift: BEAST_PREDATOR_DC_SHIFT })
  if (wounded) parts.push({ id: 'wounded', label: 'ранен и загнан', shift: BEAST_WOUNDED_DC_SHIFT })
  if (brokenMorale) parts.push({ id: 'morale', label: 'мораль уже сломана', shift: BEAST_BROKEN_MORALE_DC_SHIFT })
  if (stage === 'fed') parts.push({ id: 'fed', label: 'поел с руки', shift: BEAST_FED_DC_SHIFT })
  const attemptShift = Math.min(BEAST_ATTEMPT_DC_CAP, attempts * BEAST_ATTEMPT_DC_STEP)
  if (attemptShift > 0) parts.push({ id: 'attempts', label: `неудачные попытки (${attempts})`, shift: attemptShift })
  const difficulty = clamp(parts.reduce((total, part) => total + part.shift, 0), 5, 25)
  return {
    skill: BEAST_TAMING_SKILL,
    ability: BEAST_TAMING_ABILITY,
    difficulty,
    diet,
    wounded,
    broken_morale: brokenMorale,
    stage,
    stage_after: stage === 'fed' ? 'tamed' : 'calmed',
    attempts,
    challenge_rating: text(enemy?.provenance?.challenge_rating, 12),
    // Кусает только хищник и только пока не подпущен: тот, кто уже взял еду с
    // руки, при неудаче отходит, а не бросается.
    bites_on_failure: diet === 'predator' && stage === 'wary',
    bite_damage: beastBiteDamage(challengeRating),
    parts,
    policy_id: BEAST_TAMING_POLICY_ID,
  }
}

/** Укус при провале. Небольшой и выведенный из CR, а не из новой таблицы урона. */
export function beastBiteDamage(challengeRating) {
  const value = Number.isFinite(Number(challengeRating)) ? Number(challengeRating) : 0
  if (value <= 0.5) return '1d4'
  if (value <= 2) return '1d6'
  return '1d8'
}

// ---------------------------------------------------------------------------
// Кормление
// ---------------------------------------------------------------------------

const FOOD_NAME_PATTERN = /(па[её]к|провиз|снедь|сухар|вялен|мяс)/iu

/**
 * Чем кормить. Ищется в инвентаре героя и **только** там: зверь ест настоящий
 * предмет, который спишется, а не абстрактную «еду».
 *
 * Каталог сюда не импортируется — он принадлежит другому потоку работ, и
 * тянуть его в лист было бы связью ради одного поля. Вместо этого разрешение
 * каталожной записи передаётся снаружи (`resolveCatalogItem`): Rules Engine
 * отдаёт свой `catalogItem`, а тест — заглушку.
 *
 * @param {Record<string, any>} [actor]
 * @param {(catalogId: string) => Record<string, any> | null} [resolveCatalogItem]
 * @returns {Record<string, any> | null}
 */
export function beastFoodItemFor(actor = {}, resolveCatalogItem = null) {
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  return inventory.find((item) => {
    if (!item || Math.max(0, integer(item.quantity, 1)) <= 0) return false
    const catalogId = text(item.catalog_id ?? item.catalogId, 120)
    const entry = typeof resolveCatalogItem === 'function' && catalogId ? resolveCatalogItem(catalogId) : null
    if (entry?.use?.kind === 'ration') return true
    if (/rations?-one-day$/u.test(catalogId)) return true
    return FOOD_NAME_PATTERN.test(text(item.name, 120))
  }) ?? null
}

// ---------------------------------------------------------------------------
// Спутник
// ---------------------------------------------------------------------------

/** Отряд на привале: у кого-то из героев идёт отдых. */
export function partyIsResting(state = {}) {
  const resting = state?.mechanics?.resting ?? {}
  return Object.values(resting).some((entry) => entry && entry.reason !== 'knockout')
}

/**
 * Что зверь даёт отряду механически — ровно одно и честное: пока отряд стоит
 * лагерем, зверь слышит то, чего не слышит уставший часовой.
 *
 * Форма ответа повторяет `weatherCheckSwing` (`server/weather.mjs`) не для
 * красоты: обе поправки складываются в одном месте — в `previewD20Check` и в
 * исполнении `MakeAbilityCheck`, — и одинаковая форма означает, что карточка
 * ручного броска и движок читают их одним движением.
 *
 * @returns {{ swing: 'advantage', reason: string } | null}
 */
export function beastWatchSwing(state = {}, skill = '') {
  if (String(skill ?? '').trim().toLocaleLowerCase('en').replace(/_/gu, '-') !== 'perception') return null
  if (!partyIsResting(state)) return null
  const companion = beastCompanions(state)[0]
  if (!companion) return null
  return { swing: 'advantage', reason: `${companion.name || 'Зверь'} на страже лагеря` }
}

const SCARE_LINES = Object.freeze([
  '{beast} поднимает голову, скалится в темноту — и то мелкое, что подбиралось к лагерю, уходит прочь.',
  '{beast} коротко рычит в сторону кустов. Шорох там обрывается и больше не повторяется.',
  '{beast} встаёт между отрядом и темнотой. Кто бы там ни был, связываться он не стал.',
  '{beast} вскидывается на шум и делает шаг вперёд. Этого хватило: дальше тихо.',
])

/**
 * Строка отпугивания. Детерминирована от записи зверя и минуты мира: replay
 * даёт ту же строку. Механики за ней нет и не заявлено — это сцена, а не
 * правило.
 */
export function beastScareLine(beast = {}, minutes = 0) {
  const index = Number.parseInt(digest(beast?.id, Math.floor(Math.max(0, integer(minutes, 0)) / 60)).slice(0, 8), 16) % SCARE_LINES.length
  return SCARE_LINES[index].replaceAll('{beast}', text(beast?.name, 60) || 'Зверь')
}

/** Сколько минут ещё ждать до следующего отпугивания. Ноль — можно сейчас. */
export function beastScareCooldownLeft(beast = {}, minutes = 0) {
  const last = beast?.scared_at_minutes
  if (last == null) return 0
  return Math.max(0, BEAST_SCARE_COOLDOWN_MINUTES - (Math.max(0, integer(minutes, 0)) - Math.max(0, integer(last, 0))))
}

/**
 * Спутник идёт за отрядом. Без этого приручённый оставался бы в том лесу, где
 * его накормили, а панель отряда показывала бы зверя за три перехода отсюда.
 */
export function planBeastFollowDrafts(state = {}) {
  const locationId = sceneLocationId(state)
  const locationName = text(state?.scene?.location ?? state?.scene?.title, 180)
  const drafts = []
  for (const beast of beastCompanions(state)) {
    if (beast.location_id === locationId && comparable(beast.location_name) === comparable(locationName)) continue
    drafts.push({
      event_type: 'BeastMoved',
      payload: {
        beast_id: beast.id,
        actor_id: beast.actor_id,
        beast_name: beast.name,
        location_id: locationId,
        location_name: locationName,
        policy_id: BEAST_TAMING_POLICY_ID,
      },
      target_ids: [],
      visibility: 'party',
    })
  }
  return drafts
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

const BEAST_DIET_LABELS = Object.freeze({ predator: 'хищник', herbivore: 'травоядный' })
const BEAST_STAGE_LABELS = Object.freeze({
  wary: 'сторожится',
  calmed: 'успокоен',
  fed: 'накормлен с руки',
  tamed: 'идёт с отрядом',
})

export function beastDietLabel(diet) {
  return BEAST_DIET_LABELS[String(diet ?? '')] ?? ''
}

export function beastStageLabel(stage) {
  return BEAST_STAGE_LABELS[String(stage ?? '')] ?? ''
}

/**
 * Одна запись глазами отряда. Вырезаны `stat_block_id` и `challenge_rating` —
 * по той же причине, по которой их вырезает запись пленного (`captiveForViewer`,
 * `server/captives.mjs`): опознание врага закрыто знанием отряда
 * (`publicEnemyFor`), и приручение не должно быть дверью в обход него. Повадка
 * при этом остаётся: хищник перед тобой или травоядное, видно глазами.
 *
 * Отбор вынесен отдельной функцией, потому что каналов у одной и той же записи
 * два: проекция состояния и событие `BeastEncountered`, которое несёт её же.
 */
export function beastForViewer(beast = {}) {
  const normalized = safeBeast(beast)
  if (!normalized) return null
  const { stat_block_id: _statBlock, challenge_rating: _cr, ...visible } = normalized
  return clone({
    ...visible,
    diet_label: beastDietLabel(normalized.diet),
    stage_label: beastStageLabel(normalized.stage),
  })
}

/**
 * Реестр зверей глазами отряда плюс список тех, к кому можно подойти прямо
 * сейчас. Кандидаты собираются сервером целиком — вместе с объявленной СЛ и её
 * слагаемыми: клиенту нечего досчитывать, и второй формулы сложности у него не
 * появляется.
 */
export function beastsForViewer(state = {}, viewer = {}) {
  const beasts = beastList(state)
  const minutes = campaignElapsedMinutes(state)
  const candidates = tameableBeasts(state).map(({ enemy, beast, blocked_reason: blockedReason }) => {
    const policy = beastTamingPolicy(state, enemy, beast)
    return {
      id: beast?.id ?? beastIdFor(state, enemy.id),
      actor_id: String(enemy.id),
      name: text(enemy.name, 160),
      diet: policy.diet,
      diet_label: beastDietLabel(policy.diet),
      stage: policy.stage,
      stage_label: beastStageLabel(policy.stage),
      wounded: policy.wounded,
      broken_morale: policy.broken_morale,
      difficulty: policy.difficulty,
      skill: policy.skill,
      ability: policy.ability,
      attempts: policy.attempts,
      bites_on_failure: policy.bites_on_failure,
      parts: policy.parts.map((part) => ({ id: part.id, label: part.label, shift: part.shift })),
      ...(blockedReason ? { blocked_reason: blockedReason } : {}),
    }
  })
  const companions = beastCompanions(state).map((beast) => ({
    id: beast.id,
    name: beast.name,
    scare_cooldown_minutes: beastScareCooldownLeft(beast, minutes),
  }))
  if (viewer?.isAdmin === true) {
    return { schema_version: BEAST_TAMING_SCHEMA_VERSION, beasts: clone(beasts), candidates, companions, watch_advantage: beastWatchSwing(state, 'perception') != null }
  }
  return {
    schema_version: BEAST_TAMING_SCHEMA_VERSION,
    beasts: beasts.map((beast) => beastForViewer(beast)).filter(Boolean),
    candidates,
    companions,
    watch_advantage: beastWatchSwing(state, 'perception') != null,
  }
}

// ---------------------------------------------------------------------------
// Карточка летописи
// ---------------------------------------------------------------------------

export const BEAST_CARD_TITLE = 'Зверь и отряд'

/**
 * Карточка летописи из уже подтверждённого события — ступень лестницы с
 * подписью. Строится на сервере по той же причине, что и конверт почты
 * (`courierLetterChronicleEntry`, `server/courier-letters.mjs`): подписи ступеней
 * обязаны быть одни и те же у стола и у ведущего, а две копии разошлись бы
 * молча.
 *
 * Карточку получают только три события лестницы. Провал и укус остаются
 * обычной строкой рассказчика: рамка вокруг «волк не подпустил» превратила бы
 * летопись в ленту уведомлений.
 */
export function beastChronicleEntry(event = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  const beastId = text(payload.beast_id, 140)
  const name = text(payload.beast_name, 120) || 'Зверь'
  if (!beastId) return null
  const card = type === 'BeastSoothingResolved' && payload.success === true && payload.stage_after === 'calmed'
    ? {
      kind: 'calmed',
      title: 'Зверь подпустил',
      text: `${name} перестал видеть в отряде добычу. Теперь ему нужна еда с руки — без неё дальше не будет.`,
    }
    : type === 'BeastFed'
      ? {
        kind: 'fed',
        title: 'Зверь ест с руки',
        text: `${name} берёт ${text(payload.item_name, 120) || 'еду'} с ладони. Осталось последнее: позвать его с собой.`,
      }
      : type === 'BeastTamed'
        ? {
          kind: 'tamed',
          title: 'Зверь идёт с отрядом',
          text: `${name} остаётся рядом. Он держит стражу у костра и отгоняет мелкое зверьё, но в строй не встаёт: боевого спутника у отряда нет.`,
        }
        : null
  if (!card) return null
  return {
    id: `chronicle:${beastId}:${card.kind}`,
    speaker: 'system',
    author: BEAST_CARD_TITLE,
    text: card.text,
    beast: {
      kind: card.kind,
      title: card.title,
      name,
      diet_label: beastDietLabel(payload.diet),
      text: card.text,
    },
  }
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/**
 * Редьюсер реестра. Третий аргумент — уже применённое состояние: из него
 * берётся время кампании, когда его нет в самом событии.
 */
export function applyBeastEvent(input, event, state = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  const normalized = input?.schema_version === BEAST_TAMING_SCHEMA_VERSION && Array.isArray(input.beasts)
    ? input
    : normalizeBeastState(input)
  const patch = (beastId, updater) => {
    const expected = text(beastId, 120)
    if (!expected) return normalized
    return normalizeBeastState({
      ...normalized,
      beasts: normalized.beasts.map((beast) => beast.id === expected ? updater(beast) : beast),
    })
  }
  if (type === 'BeastEncountered') {
    const beast = safeBeast(payload.beast)
    if (!beast || normalized.beasts.some((entry) => entry.id === beast.id)) return normalized
    return normalizeBeastState({ ...normalized, beasts: [...normalized.beasts, beast] })
  }
  if (type === 'BeastSoothingResolved') {
    return patch(payload.beast_id, (beast) => payload.success === true
      ? {
        ...beast,
        stage: BEAST_STAGES.includes(payload.stage_after) ? String(payload.stage_after) : beast.stage,
        // Успех обнуляет счётчик настороженности: зверь подпустил, и прошлые
        // промахи больше не висят прибавкой к следующей ступени.
        attempts: 0,
        calmed_at_minutes: payload.stage_after === 'calmed'
          ? Math.max(0, integer(payload.at_minutes, campaignElapsedMinutes(state)))
          : beast.calmed_at_minutes,
      }
      : { ...beast, attempts: beast.attempts + 1 })
  }
  if (type === 'BeastBit') {
    return patch(payload.beast_id, (beast) => ({ ...beast, bites: beast.bites + 1 }))
  }
  if (type === 'BeastFed') {
    return patch(payload.beast_id, (beast) => ({
      ...beast,
      stage: 'fed',
      fed_at_minutes: Math.max(0, integer(payload.at_minutes, campaignElapsedMinutes(state))),
    }))
  }
  if (type === 'BeastTamed') {
    return patch(payload.beast_id, (beast) => ({
      ...beast,
      stage: 'tamed',
      status: 'companion',
      tamed_at_minutes: Math.max(0, integer(payload.at_minutes, campaignElapsedMinutes(state))),
    }))
  }
  if (type === 'BeastMoved') {
    return patch(payload.beast_id, (beast) => ({
      ...beast,
      location_id: text(payload.location_id, 180),
      location_name: text(payload.location_name, 180),
    }))
  }
  if (type === 'BeastScaredThreat') {
    return patch(payload.beast_id, (beast) => ({
      ...beast,
      scared_at_minutes: Math.max(0, integer(payload.at_minutes, campaignElapsedMinutes(state))),
    }))
  }
  return normalized
}
