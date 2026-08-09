import { createHash } from 'node:crypto'

import { normalizeNpcWorldState, presentSceneNpcs, sceneLocationId } from './npc-positioning.mjs'

/**
 * Жизнь таверны: кости на деньги и выпивка.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, E1 и E2) держал обе
 * строки в «нет», и обе — по одной причине: общий кубик на стол в проекте был
 * (`POST /api/rooms/:code/dice`, событие `PublicDieRolled`), а игры не было —
 * ни ставки, ни банка, ни проигранных денег. У выпивки не было даже источника:
 * единственный путь к истощению вёл через заклинание.
 *
 * Модуль детерминированный и без обращений к модели, как `captives.mjs`,
 * `parley.mjs` и `law-and-order.mjs`. Устроен он так:
 *
 * 1. **Соперник мечет первым, герой отвечает.** Раунд разложен на две команды
 *    не ради красоты: ручной бросок героя обязан идти против **объявленного**
 *    числа, а «перебить соперника» — это его бросок, и до него числа не
 *    существует. Поэтому `OpenTavernDiceRound` кидает публичный d20 соперника
 *    и закрепляет раунд в состоянии, а `AnswerTavernDiceRound` уже знает СЛ:
 *    она равна `npc_total + 1`. Карточка ручного броска не врёт ни разу.
 * 2. **Характер соперника — чистая функция сида кампании.** Честный он или
 *    шулер, насколько внимателен и насколько ловки его руки — всё выводится
 *    из `sessionCode` и идентификатора NPC, поэтому replay даёт того же
 *    человека. В состоянии этот флаг **не хранится**: то, чего нет в снимке,
 *    не может утечь игроку.
 * 3. **Шулер подменяет кость, а не прибавляет к сумме.** Если бы надбавка
 *    складывалась поверх выпавшего, стол видел бы «выпало 7, засчитано 12» и
 *    ловил бы шулера глазами, а не Проницательностью. Поэтому на стол
 *    кладётся уже подменённое число, а настоящая кость остаётся в броске с
 *    видимостью `gm_only`.
 * 4. **Кошелёк не уходит в минус.** Ставка проверяется до первого события, а
 *    банк переезжает целиком: победа приносит ставку соперника, поражение
 *    отдаёт свою, ничья не двигает ничего.
 *
 * Осознанные границы (решено, а не забыто):
 * - **своего реестра бросков здесь нет**: ручной кубик героя идёт тем же
 *   двухфазным путём (`server/roll-registry.mjs`), что у парлея и побега от
 *   стражи;
 * - **шулерство закон не судит.** Поступок в летописи (`world-deeds.mjs`) он
 *   заводит и молву рождает, но в таблицу преступлений (`law-and-order.mjs`)
 *   не входит: за руку ловит хозяин заведения, а не стража;
 * - **опьянение — существующее состояние `poisoned`**, а не своё. Помеха на
 *   проверки нужна была вся, и заводить рядом второе состояние с тем же
 *   смыслом значило бы развести числа по двум таблицам;
 * - **счёт кружек и скандалов живёт в сцене.** Ушли из таверны — счёт обнулён;
 *   похмелье при этом остаётся, потому что оно состояние героя, а не заведения.
 */

export const TAVERN_LIFE_SCHEMA_VERSION = 1
export const TAVERN_POLICY_ID = 'skazanie:tavern-life-v1'

/** Команды жизни таверны. Все три доступны игроку и все три — вне боя. */
export const TAVERN_COMMAND_TYPES = Object.freeze(new Set([
  'OpenTavernDiceRound', 'AnswerTavernDiceRound', 'OrderTavernDrink',
]))

/**
 * Как герой отвечает на бросок соперника. Список закрытый и серверный.
 *
 * `fair` — просто бросить; `cheat` — подкрутить кость (Ловкость рук против
 * пассивной Проницательности соперника); `watch` — бросить и одновременно
 * следить за чужими руками (Проницательность против его ловкости).
 */
export const TAVERN_DICE_APPROACHES = Object.freeze(['fair', 'cheat', 'watch'])

/** Ставки. Закрытый серверный набор: клиент выбирает из него, а не называет сумму. */
export const TAVERN_STAKES_CP = Object.freeze([10, 50, 200])

/** Подписи ставок для карточки действия. Сочиняет их сервер, а не клиент. */
export const TAVERN_STAKE_LABELS = Object.freeze({
  10: 'на медяки',
  50: 'на серебро',
  200: 'по-крупному',
})

/**
 * Насколько подкрученная кость лучше честной. Пять — это разница между
 * «повезло» и «выиграл»: меньше не окупает риска скандала, больше делает
 * шулерство единственным разумным выбором.
 */
export const TAVERN_CHEAT_BONUS = 5

/** Доля шулеров за столом в процентах. Треть — и стол это чувствует. */
export const TAVERN_CHEAT_SHARE = 30

/**
 * Чем мухлюют и чем ловят. Навыки серверные и закрытые: подкрутить кость — это
 * Ловкость рук, разглядеть чужие руки — Проницательность, и подменить их
 * клиенту нечем.
 *
 * Характеристика у Ловкости рук объявлена отдельно намеренно: каталог навыков
 * знает её как `sleight_of_hand`, а канонизация команд приводит идентификатор к
 * `sleight-of-hand` — по такому ключу таблица характеристик молчит, и без явного
 * `dex` проверка ушла бы в Силу.
 */
export const TAVERN_CHEAT_SKILL = 'sleight-of-hand'
export const TAVERN_CHEAT_ABILITY = 'dex'
export const TAVERN_SPOT_SKILL = 'insight'

/**
 * Сколько скандалов терпит заведение. Первый раз выводят на чистую воду и
 * прощают, второй — выставляют за дверь.
 */
export const TAVERN_SCANDALS_BEFORE_EJECTION = 2

/** Насколько падает отношение пойманного за руку соперника. */
export const TAVERN_CHEAT_RELATIONSHIP_DELTA = -12

/** Насколько падает отношение соперника, которого разоблачили самого. */
export const TAVERN_EXPOSED_RELATIONSHIP_DELTA = -8

/** Кружка эля по SRD 5.2.1 — 4 медяка. Цена честная и серверная. */
export const TAVERN_DRINK_PRICE_CP = 4

/** До скольких кружек включительно выпивка ещё помогает, а не мешает. */
export const TAVERN_SOBER_DRINKS = 2

/** Насколько разговорчивее герой после первой-второй кружки. */
export const TAVERN_SOCIAL_BONUS = 1

/** Навык, которому помогает застолье. */
export const TAVERN_SOCIAL_SKILL = 'persuasion'

/** База СЛ спасброска Телосложения. Третья кружка — СЛ 11, дальше по единице. */
export const TAVERN_DRINK_BASE_DC = 10

/** Чем кончается провал спасброска: существующее состояние, а не своё. */
export const TAVERN_DRUNK_CONDITION = 'poisoned'

/**
 * Срок опьянения. Любая непустая и не «вечная» длительность сметается
 * продолжительным отдыхом (`RestCompleted`, `server/rules-engine.mjs`), а
 * раундами не тикает — счётчик знает только `until-next-turn` и `rounds:N`.
 * Это ровно «до отдыха» и ничего сверх.
 */
export const TAVERN_DRUNK_DURATION = 'until-long-rest'

/** Сколько минут кампании отнимает кружка и один раунд костей. */
export const TAVERN_DRINK_MINUTES = 15
export const TAVERN_DICE_ROUND_MINUTES = 10

const MAX_PATRONS = 12

const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, integer(value, minimum)))

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function spread(seed, salt, size) {
  return Number.parseInt(digest(seed, salt).slice(0, 8), 16) % Math.max(1, size)
}

// ---------------------------------------------------------------------------
// Где всё это вообще происходит
// ---------------------------------------------------------------------------

/**
 * Слова, по которым сцена опознаётся таверной. Список **уже** таверны из
 * `scene-themes.mjs`: там та же тема застройки берёт и дом, и лавку, и терем,
 * а кости с выпивкой предлагать в чужой избе нельзя.
 */
const TAVERN_PATTERN = /таверн|трактир|корчм|харчевн|постоял|кабак|шинок|пивн|tavern|inn(?![а-яёa-z])|alehouse|pub(?![а-яёa-z])/iu

function sceneSignature(state = {}) {
  const scene = state?.scene ?? {}
  return [scene.title, scene.location, scene.theme, scene.material, scene.map?.layout, scene.map?.theme]
    .map((value) => text(value, 200))
    .join(' ')
}

/**
 * Таверна ли это. Опознаётся по названию и теме сцены — то есть по тому же
 * тексту, который видит игрок в шапке. Ни цели отряда, ни настроения здесь
 * нет намеренно: «встретиться в трактире» — это задание, а не место, и
 * предлагать выпивку посреди леса из-за такой строки нельзя.
 */
export function isTavernScene(state = {}) {
  return TAVERN_PATTERN.test(sceneSignature(state))
}

/**
 * С кем за этим столом можно сыграть. Живые NPC текущей сцены, которых видит
 * отряд, и ни одного враждебного: с тем, кто уже взялся за нож, не играют.
 */
export function tavernOpponents(state = {}) {
  if (!isTavernScene(state)) return []
  const stances = normalizeNpcWorldState(state?.npc_world).stances
  return presentSceneNpcs(state)
    .filter((npc) => npc.visibility !== 'gm_only')
    .filter((npc) => String(stances[String(npc.id)]?.stance ?? 'neutral') !== 'hostile')
    .map((npc) => ({ id: String(npc.id), name: text(npc.name, 160), role: text(npc.role, 160) }))
}

export function isTavernOpponent(state = {}, npcId = '') {
  const expected = text(npcId, 120)
  return tavernOpponents(state).some((npc) => npc.id === expected)
}

// ---------------------------------------------------------------------------
// Характер соперника
// ---------------------------------------------------------------------------

/**
 * Кто сидит напротив. Чистая функция сида кампании и идентификатора NPC:
 * одинаковый вход — одинаковый выход, поэтому replay сажает за стол того же
 * человека, и хранить этот профиль в состоянии не нужно.
 *
 * `crooked` — серверная тайна: он не попадает ни в одно событие игрока и ни в
 * одно поле проекции. Игрок узнаёт про шулера Проницательностью или не узнаёт
 * вовсе.
 */
export function tavernGamblerFor(state = {}, npcId = '') {
  const id = text(npcId, 120)
  const npc = tavernOpponents(state).find((candidate) => candidate.id === id)
    ?? { id, name: id, role: '' }
  const seed = digest(text(state?.sessionCode, 60), id, 'tavern-gambler')
  const crooked = spread(seed, 'crook', 100) < TAVERN_CHEAT_SHARE
  const attention = spread(seed, 'attention', 5)
  const slyness = spread(seed, 'slyness', 5)
  return Object.freeze({
    npc_id: npc.id,
    name: npc.name,
    role: npc.role,
    crooked,
    // Пассивная Проницательность соперника: против неё идёт Ловкость рук героя.
    // Шулер видит чужие руки лучше — он знает, куда смотреть.
    insight_passive: 10 + attention + (crooked ? 2 : 0),
    // Насколько трудно разглядеть его собственную подмену.
    tell_dc: 10 + slyness + (crooked ? 2 : 0),
    dice_bonus: crooked ? TAVERN_CHEAT_BONUS : 0,
  })
}

/**
 * Что показывает кость соперника. Шулер не прибавляет к сумме, а подменяет
 * кость: на стол ложится уже другое число, и разницы между «выпало» и
 * «засчитано» стол не видит.
 */
export function tavernOpponentDie(gambler, naturalDie) {
  const natural = clamp(naturalDie, 1, 20)
  if (!gambler?.crooked) return natural
  return Math.min(20, natural + Math.max(0, integer(gambler.dice_bonus, 0)))
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

function safeRound(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = text(value.id, 140)
  const heroId = text(value.hero_id, 120)
  const npcId = text(value.npc_id, 120)
  if (!id || !heroId || !npcId) return null
  const stakeCp = TAVERN_STAKES_CP.includes(integer(value.stake_cp, 0)) ? integer(value.stake_cp, 0) : TAVERN_STAKES_CP[0]
  const npcTotal = clamp(value.npc_total, 1, 20)
  return {
    id,
    hero_id: heroId,
    npc_id: npcId,
    npc_name: text(value.npc_name, 160),
    stake_cp: stakeCp,
    npc_total: npcTotal,
    // Число, которое герою надо перебить. Хранится рядом с броском, потому что
    // именно оно уезжает в карточку ручного броска: считать его дважды —
    // значит однажды посчитать по-разному.
    target: npcTotal + 1,
    opened_at_minutes: Math.max(0, integer(value.opened_at_minutes, 0)),
  }
}

function safePatron(value) {
  return {
    drinks: clamp(value?.drinks, 0, 99),
    scandals: clamp(value?.scandals, 0, 99),
    ejected: value?.ejected === true,
  }
}

export function normalizeTavernState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const patrons = {}
  for (const [heroId, patron] of Object.entries(source.patrons ?? {}).slice(0, MAX_PATRONS)) {
    const id = text(heroId, 120)
    if (id) patrons[id] = safePatron(patron)
  }
  return {
    schema_version: TAVERN_LIFE_SCHEMA_VERSION,
    round: safeRound(source.round),
    patrons,
  }
}

function patronFor(state = {}, heroId = '') {
  return safePatron(normalizeTavernState(state?.tavern).patrons[text(heroId, 120)])
}

export function tavernRoundFor(state = {}) {
  return normalizeTavernState(state?.tavern).round
}

export function tavernDrinksFor(state = {}, heroId = '') {
  return patronFor(state, heroId).drinks
}

export function tavernScandalsFor(state = {}, heroId = '') {
  return patronFor(state, heroId).scandals
}

export function tavernEjected(state = {}, heroId = '') {
  return patronFor(state, heroId).ejected === true
}

// ---------------------------------------------------------------------------
// Выпивка
// ---------------------------------------------------------------------------

/**
 * СЛ спасброска за следующую кружку. Первые две проходят без броска: две
 * кружки за вечер не валят никого. Третья идёт против СЛ 11, и дальше СЛ
 * растёт на единицу за кружку.
 *
 * `null` означает «эта кружка ещё безопасна» — и это не то же самое, что СЛ 0.
 */
export function tavernNextDrinkDc(state = {}, heroId = '') {
  const next = tavernDrinksFor(state, heroId) + 1
  if (next <= TAVERN_SOBER_DRINKS) return null
  return TAVERN_DRINK_BASE_DC + (next - TAVERN_SOBER_DRINKS)
}

/**
 * Прибавка застолья к Убеждению. Одна кружка развязывает язык, третья его
 * заплетает: после перебора бонуса нет независимо от того, устоял герой или
 * нет. Считается по счёту сцены, поэтому уход из таверны её и снимает.
 */
export function tavernSocialBonus(state = {}, heroId = '', skill = '') {
  if (String(skill ?? '').replace(/_/gu, '-') !== TAVERN_SOCIAL_SKILL) return 0
  const drinks = tavernDrinksFor(state, heroId)
  return drinks >= 1 && drinks <= TAVERN_SOBER_DRINKS ? TAVERN_SOCIAL_BONUS : 0
}

/**
 * Разговорчивость стола для социального движка. Уезжает в бриф NPC
 * (`server/npc-social-controller.mjs`) данными, а не числом в СЛ: собеседник
 * должен слышать, что перед ним человек с кружкой, но проверку это не
 * подменяет.
 */
export function tavernTableMood(state = {}, heroId = '') {
  const drinks = tavernDrinksFor(state, heroId)
  if (!isTavernScene(state) || drinks <= 0) return null
  return Object.freeze({
    drinks,
    shared_drink: true,
    talkative: drinks <= TAVERN_SOBER_DRINKS,
    over_the_edge: drinks > TAVERN_SOBER_DRINKS,
  })
}

// ---------------------------------------------------------------------------
// Проекция
// ---------------------------------------------------------------------------

/**
 * Карточка таверны для стола. Здесь и только здесь решается, что игрок видит:
 * с кем можно сыграть, какие ставки открыты, сколько стоит кружка и чем
 * грозит следующая. Характера соперника в карточке нет — ни честного, ни
 * шулерского.
 *
 * Функция одна на оба канала — проекцию состояния и канал событий: второго
 * ответа на вопрос «что видно за столом» быть не должно.
 */
export function tavernForViewer(state = {}, viewer = {}) {
  if (!isTavernScene(state)) return null
  const heroId = text(viewer?.playerId, 120)
  const round = tavernRoundFor(state)
  const patron = patronFor(state, heroId)
  return {
    schema_version: TAVERN_LIFE_SCHEMA_VERSION,
    place_name: text(state?.scene?.location ?? state?.scene?.title, 180),
    location_id: sceneLocationId(state),
    opponents: tavernOpponents(state),
    stakes: TAVERN_STAKES_CP.map((stake) => ({ stake_cp: stake, label: TAVERN_STAKE_LABELS[stake] ?? `${stake} мм` })),
    approaches: TAVERN_DICE_APPROACHES.slice(),
    round: round && (!heroId || round.hero_id === heroId) ? publicTavernRoundFor(round) : null,
    drink_price_cp: TAVERN_DRINK_PRICE_CP,
    drinks: patron.drinks,
    next_drink_dc: tavernNextDrinkDc(state, heroId),
    social_bonus: tavernSocialBonus(state, heroId, TAVERN_SOCIAL_SKILL),
    ejected: patron.ejected,
  }
}

/**
 * Публичная запись раунда: бросок соперника лежит на столе, и скрывать его
 * незачем. Скрывать нечего и сверх него — характер соперника в раунд не
 * пишется по построению.
 */
export function publicTavernRoundFor(round) {
  const safe = safeRound(round)
  if (!safe) return null
  return {
    id: safe.id,
    hero_id: safe.hero_id,
    npc_id: safe.npc_id,
    npc_name: safe.npc_name,
    stake_cp: safe.stake_cp,
    npc_total: safe.npc_total,
    target: safe.target,
  }
}

// ---------------------------------------------------------------------------
// Редьюсер
// ---------------------------------------------------------------------------

/**
 * Что событие меняет в счёте таверны. Счёт выводится из журнала целиком,
 * поэтому replay воспроизводит и открытый раунд, и число кружек.
 *
 * `GAME_STATE_PROJECTOR_VERSION` из-за этой ветки **не двигается**, и это
 * разобрано, а не забыто: снимок старой версии не содержит ни одного события
 * таверны просто потому, что таких событий тогда не существовало, — а всякий
 * снимок, в котором они есть, пишется уже новым кодом и несёт срез вместе с
 * ними. Летопись поступков и реестр закона бампа требовали по обратной
 * причине: их события в старых журналах уже лежали.
 */
export function applyTavernEvent(input, event, state = {}) {
  const type = String(event?.event_type ?? '')
  const normalized = input?.schema_version === TAVERN_LIFE_SCHEMA_VERSION && input?.patrons
    ? input
    : normalizeTavernState(input)
  const payload = event?.payload ?? {}
  // Новая сцена — новое заведение: счёт кружек, скандалов и запретов обнуляется
  // вместе с ним. Похмелье при этом остаётся: оно состояние героя, а не
  // заведения, и снимается отдыхом.
  if (type === 'SceneAdvanced') return normalizeTavernState({})
  if (type === 'TavernDiceRoundOpened') {
    const round = safeRound(payload.round)
    return round ? normalizeTavernState({ ...normalized, round }) : normalized
  }
  if (type === 'TavernDiceRoundResolved') {
    const heroId = text(payload.hero_id, 120)
    const caught = text(payload.outcome, 30) === 'caught'
    if (!heroId) return normalizeTavernState({ ...normalized, round: null })
    const patron = safePatron(normalized.patrons?.[heroId])
    return normalizeTavernState({
      ...normalized,
      round: null,
      patrons: { ...normalized.patrons, [heroId]: { ...patron, scandals: patron.scandals + (caught ? 1 : 0) } },
    })
  }
  if (type === 'TavernPatronEjected') {
    const heroId = text(payload.hero_id, 120)
    if (!heroId) return normalized
    const patron = safePatron(normalized.patrons?.[heroId])
    return normalizeTavernState({ ...normalized, patrons: { ...normalized.patrons, [heroId]: { ...patron, ejected: true } } })
  }
  if (type === 'TavernDrinkOrdered') {
    const heroId = text(payload.hero_id, 120)
    if (!heroId) return normalized
    const patron = safePatron(normalized.patrons?.[heroId])
    return normalizeTavernState({
      ...normalized,
      patrons: { ...normalized.patrons, [heroId]: { ...patron, drinks: patron.drinks + 1 } },
    })
  }
  return normalized
}
