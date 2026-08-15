import { createHash } from 'node:crypto'

import { normalizeNpcWorldState, presentSceneNpcs } from './npc-positioning.mjs'
import {
  campaignElapsedMinutes,
  ensureNpcSocialState,
  npcProfileAtWorldTime,
  npcRelationshipEventDrafts,
  promiseDueOffsetMinutes,
} from './npc-social.mjs'
import { worldLocationById } from './world-map.mjs'

/**
 * Письма и курьеры: слово отряда доходит туда, где отряда нет.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, D7) держал строку в
 * «частично», и половинчатость была буквальной: у стартового торговца заведена
 * услуга `starter-courier` — «Доставка письма», 50 медяков
 * (`server/merchant-economy.mjs`), покупка списывает деньги, но письмо никуда не
 * приходит. Ни адресата, ни срока, ни ответа: игрок платит за строку в чеке.
 *
 * Модуль закрывает всю дугу — написать, заплатить, дождаться, получить ответ — и
 * устроен так:
 *
 * 1. **Своих часов у писем нет.** Курьер едет теми же мировыми минутами, что и
 *    всё остальное: доставка, возврат и ответ считаются внутри
 *    `appendWorldTimeConsequences` (`server/rules-engine.mjs`) рядом с
 *    обещаниями NPC, рассветом предметов и ходом мира «Пока вас не было…».
 *    Второй счётчик разошёлся бы с первым на первом же длинном отдыхе.
 *
 *    Отсюда и главное следствие для стола: письмо доходит **во сне отряда**, а
 *    не по кнопке. Час привала его не двигает, ночёвка двигает, сутки под
 *    замком доводят до ответа.
 * 2. **Дальность считается по дорогам, а не по прямой.** Цена и срок выводятся
 *    из числа переходов по маршрутам карты мира (`server/world-map.mjs`):
 *    у каждого маршрута есть своя `distance`, и кратчайший путь ищется по ним.
 *    Прямая остаётся только там, где дороги нет вовсе, — иначе письмо через
 *    горный кряж стоило бы как письмо вдоль тракта.
 * 3. **Ответ детерминирован по отношению, а полировка — необязательна.**
 *    Основу ответа собирает таблица тона: союзник отвечает тепло, чужой —
 *    сухо, врагу сказать нечего, и он не отвечает вовсе. Модель может эту
 *    основу переписать красивее (`server/index.mjs` зовёт социальный движок в
 *    момент отправки, пока запрос игрока ещё живой), но **только если модель
 *    есть**: без ключа и при ошибке провайдера в письмо ложится детерминированная
 *    основа, и стол разницы в механике не замечает.
 *
 *    Полировка запечатывается в письмо при отправке вместе с тоном, для
 *    которого её писали. Если к моменту доставки отношение перешло в другой
 *    тон — черновик выбрасывается и звучит основа: модель писала ответ друга, а
 *    письмо застало врага, и подсовывать столу тёплые слова от того, кто их уже
 *    не сказал бы, — враньё.
 * 4. **Письмо — социальное действие, а не почтовая квитанция.** Дошедшее письмо
 *    двигает отношение NPC (или славу фракции) и ложится в память мира. Обещание,
 *    данное в письме, — обещание: оно заводится штатной записью
 *    (`NpcPromiseRecorded`, `server/npc-social.mjs`) со сроком из самого текста,
 *    и просроченным его признают те же мировые минуты, что и обещание,
 *    сказанное вслух.
 * 5. **Доброе слово стоит денег и времени, а не повторов.** Прибавка к
 *    отношению даётся не чаще раза в игровую неделю на одного адресата
 *    (`COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES`). Без этого правила почта стала
 *    бы насосом: шестьдесят медяков за +2 к отношению, и любой кошелёк
 *    покупал бы дружбу пачкой писем. Курьер по-прежнему берёт плату за каждое
 *    письмо — платит отряд всегда, а помнит адресат не всё.
 * 6. **Недоставка честная.** Адресат мёртв или уведён — курьер возвращается с
 *    вестью и нераспечатанным письмом. Плата не возвращается: дорогу он проехал.
 *    Вести об этом отряд узнаёт карточкой летописи, а не молчанием.
 *
 * Детерминизм держится теми же приёмами, что у погоды, закона и хода мира:
 * никаких костей (`DiceService` — общий поток случайности, и выпавшее из него
 * зависит от числа бросков раньше), никаких часов реального мира, выбор
 * формулировки — sha256 от подписи и остаток от деления. Одинаковое состояние и
 * одинаковый скачок дают одну и ту же почту, поэтому replay воспроизводит её по
 * построению.
 *
 * Текст письма — **творческий ввод игрока** и недоверенное поле наравне с
 * репликой в разговоре: он нормализуется, режется по длине и уезжает в модель
 * только внутри `buildDataOnlyContext` (`server/security.mjs`). Ни одна строка
 * из него не становится инструкцией.
 *
 * Осознанные границы (решено, а не забыто):
 * - **письмо тому, кто стоит перед отрядом, не принимается**: это не почта, а
 *   разговор, и стоит он слова, а не пятидесяти медяков и восьми часов;
 * - **у фракции нет адреса на карте.** Сущность фракции в памяти мира хранит имя,
 *   сводку и теги — координат у неё нет. Курьер поэтому едет к её людям
 *   ближайшей известной дорогой, а дальность берётся ступенью
 *   (`COURIER_LETTER_FACTION_LEAGUES`). Выдумывать фракции столицу ради
 *   красивого числа модуль не станет;
 * - **своего реестра бросков здесь нет**: письмо не бросок. Курьера не грабят,
 *   письмо не перехватывают — это была бы встреча, а встречи ставит Режиссёр.
 */

export const COURIER_LETTERS_SCHEMA_VERSION = 1
export const COURIER_LETTERS_POLICY_ID = 'skazanie:courier-letters-v1'

/** Команда одна, и она игрока: письмо пишет герой, а не сервер. */
export const COURIER_LETTER_COMMAND_TYPES = Object.freeze(new Set(['SendLetter']))

/** События почты. Список закрытый: проекция и летопись сверяются с ним. */
export const COURIER_LETTER_EVENT_TYPES = Object.freeze({
  sent: 'CourierLetterSent',
  delivered: 'CourierLetterDelivered',
  returned: 'CourierLetterReturned',
  answered: 'CourierLetterAnswered',
})

/** Кому пишут: известному NPC или фракции из памяти мира. Третьего адреса нет. */
export const COURIER_LETTER_ADDRESSEE_KINDS = Object.freeze(['npc', 'faction'])

/** Сколько знаков влезает в письмо. Свиток — не роман. */
export const COURIER_LETTER_BODY_LIMIT = 1_200

/** Сколько писем героя едут одновременно. Почта — не пулемёт. */
export const COURIER_LETTER_OPEN_LIMIT = 3

/**
 * Цена курьера. База — та же полтина, что стоит услуга `starter-courier` у
 * стартового торговца (`server/merchant-economy.mjs`): двух цен на одну работу
 * в мире быть не должно. Дальше — по десять медяков за переход.
 */
export const COURIER_LETTER_BASE_FEE_CP = 50
export const COURIER_LETTER_FEE_PER_LEAGUE_CP = 10

/** Сколько минут занимает один переход и сколько занимает самая близкая дорога. */
export const COURIER_LETTER_MINUTES_PER_LEAGUE = 240
export const COURIER_LETTER_MINIMUM_MINUTES = 480

/**
 * Сколько минут кампании уходит на само письмо. Полчаса — столько же, сколько
 * стоит кружка эля и раунд костей (`server/tavern-life.mjs`): за столом это
 * занятие того же порядка, и заводить ему свою цену времени незачем.
 */
export const COURIER_LETTER_WRITING_MINUTES = 30

/**
 * Сколько адресат думает над ответом, прежде чем сесть писать. Полсуток —
 * это «получил вечером, ответил утром», и ровно столько нужно, чтобы ответ не
 * приходил тем же ходом мира, что и доставка.
 */
export const COURIER_LETTER_REPLY_DELAY_MINUTES = 720

/**
 * Дальность до фракции. Координат у фракции нет (`worldMemory.entities` знает
 * имя, сводку и теги), и выдумывать ей столицу модуль не станет: курьер везёт
 * письмо её людям, а это шесть переходов по любым дорогам.
 */
export const COURIER_LETTER_FACTION_LEAGUES = 6

/** Дальность до NPC, чьё место отряду неизвестно. Та же ступень, что у фракции. */
export const COURIER_LETTER_UNKNOWN_LEAGUES = 6

/** Дальше этого курьеры не ездят: цена и срок обязаны иметь потолок. */
export const COURIER_LETTER_MAX_LEAGUES = 30

/** Насколько дошедшее письмо греет отношение и сколько добавляет обещание в нём. */
export const COURIER_LETTER_RELATIONSHIP_DELTA = 2
export const COURIER_LETTER_PROMISE_BONUS = 1

/**
 * Как часто одному адресату вообще приятно получать письма.
 *
 * Игровая неделя — это не вкусовщина, а цена дыры: без порога письмо становится
 * покупкой отношения (шестьдесят медяков за +2), и кошелёк отряда обменивался
 * бы на дружбу пачками. Плата при этом берётся за каждое письмо: курьер
 * проезжает дорогу независимо от того, тронуло адресата очередное послание или
 * нет.
 */
export const COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES = 10_080

/** Русские подписи состояний. Таблица одна и живёт на сервере. */
export const COURIER_LETTER_STATUS_LABELS = Object.freeze({
  in_transit: 'В пути',
  delivered: 'Доставлено',
  answered: 'Получен ответ',
  returned: 'Не доставлено',
})

/** Заголовок карточки летописи. Один на письмо, ответ и возврат. */
export const COURIER_LETTER_CARD_TITLE = 'Почта отряда'

const MAX_LETTERS = 40
const VISIBLE_TO_PARTY = new Set(['party', 'public'])

const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)
const key = (value) => text(value, 180).toLocaleLowerCase('ru')

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

const visibleToParty = (value) => VISIBLE_TO_PARTY.has(text(value, 30) || 'gm_only')

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

const STATUSES = new Set(['in_transit', 'delivered', 'answered', 'returned'])
const RETURN_REASONS = new Set(['dead', 'gone'])
/**
 * Тон ответа. Пороги те же, что у отношения NPC (`relationshipTier`,
 * `server/npc-social.mjs`) и у славы фракции (`reputationTier`,
 * `server/reputation-policy.mjs`): третьей шкалы «насколько нас тут любят» в
 * проекте быть не должно.
 */
const TONES = new Set(['warm', 'friendly', 'plain', 'cold', 'silent'])

function safeLetter(value = {}) {
  const id = text(value.id, 140)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/u.test(id)) return null
  const heroId = text(value.hero_id, 120)
  const addresseeId = text(value.addressee_id, 120)
  if (!heroId || !addresseeId) return null
  const sentAt = Math.max(0, integer(value.sent_at_minutes, 0))
  const deliveryDue = Math.max(sentAt, integer(value.delivery_due_minutes, sentAt))
  return {
    id,
    hero_id: heroId,
    hero_name: text(value.hero_name, 120),
    addressee_kind: COURIER_LETTER_ADDRESSEE_KINDS.includes(text(value.addressee_kind, 20)) ? text(value.addressee_kind, 20) : 'npc',
    addressee_id: addresseeId,
    addressee_name: text(value.addressee_name, 180),
    place_name: text(value.place_name, 180),
    leagues: Math.max(1, Math.min(COURIER_LETTER_MAX_LEAGUES, integer(value.leagues, 1))),
    fee_cp: Math.max(0, integer(value.fee_cp, 0)),
    body: text(value.body, COURIER_LETTER_BODY_LIMIT),
    promise_text: text(value.promise_text, 500),
    promise_due_hint: text(value.promise_due_hint, 240),
    status: STATUSES.has(text(value.status, 20)) ? text(value.status, 20) : 'in_transit',
    sent_at_minutes: sentAt,
    delivery_due_minutes: deliveryDue,
    reply_due_minutes: Math.max(deliveryDue, integer(value.reply_due_minutes, deliveryDue)),
    delivered_at_minutes: value.delivered_at_minutes == null ? null : Math.max(0, integer(value.delivered_at_minutes, 0)),
    answered_at_minutes: value.answered_at_minutes == null ? null : Math.max(0, integer(value.answered_at_minutes, 0)),
    returned_at_minutes: value.returned_at_minutes == null ? null : Math.max(0, integer(value.returned_at_minutes, 0)),
    return_reason: RETURN_REASONS.has(text(value.return_reason, 20)) ? text(value.return_reason, 20) : '',
    tone: TONES.has(text(value.tone, 20)) ? text(value.tone, 20) : 'plain',
    reply_draft: text(value.reply_draft, 1_000),
    reply_draft_tone: TONES.has(text(value.reply_draft_tone, 20)) ? text(value.reply_draft_tone, 20) : '',
    reply_text: text(value.reply_text, 1_000),
    reply_provider: text(value.reply_provider, 80),
  }
}

export function normalizeCourierLetterState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const letters = []
  const seen = new Set()
  for (const raw of Array.isArray(source.letters) ? source.letters : []) {
    const letter = safeLetter(raw)
    if (!letter || seen.has(letter.id)) continue
    seen.add(letter.id)
    letters.push(letter)
  }
  return {
    schema_version: COURIER_LETTERS_SCHEMA_VERSION,
    letters: letters.slice(-MAX_LETTERS),
  }
}

/**
 * Редьюсер. Письмо заводится отправкой, а дальше только меняет состояние: у
 * доставки, возврата и ответа своего тела записи нет — они называют письмо
 * идентификатором и минутой, поэтому replay восстанавливает почту из журнала без
 * отдельного снимка.
 */
export function applyCourierLetterEvent(input, event) {
  const normalized = input?.schema_version === COURIER_LETTERS_SCHEMA_VERSION && Array.isArray(input.letters)
    ? input
    : normalizeCourierLetterState(input)
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  if (type === COURIER_LETTER_EVENT_TYPES.sent) {
    const letter = safeLetter(payload.letter)
    if (!letter || normalized.letters.some((entry) => entry.id === letter.id)) return normalized
    return normalizeCourierLetterState({ ...normalized, letters: [...normalized.letters, letter] })
  }
  const letterId = text(payload.letter_id, 140)
  if (!letterId || !normalized.letters.some((entry) => entry.id === letterId)) return normalized
  // Тон закрепляется доставкой, а не пересчитывается на минуту ответа: между
  // ними отряд успевает прожить неделю, и пересчёт означал бы, что объявленное
  // доставкой «ответ будет» — враньё.
  const patch = type === COURIER_LETTER_EVENT_TYPES.delivered
    ? { status: 'delivered', delivered_at_minutes: integer(payload.at_minutes, 0), tone: payload.tone }
    : type === COURIER_LETTER_EVENT_TYPES.returned
      ? { status: 'returned', returned_at_minutes: integer(payload.at_minutes, 0), return_reason: payload.reason }
      : type === COURIER_LETTER_EVENT_TYPES.answered
        ? {
            status: 'answered',
            answered_at_minutes: integer(payload.at_minutes, 0),
            reply_text: payload.reply,
            reply_provider: payload.provider,
          }
        : null
  if (!patch) return normalized
  return normalizeCourierLetterState({
    ...normalized,
    letters: normalized.letters.map((entry) => (entry.id === letterId ? { ...entry, ...patch } : entry)),
  })
}

// ---------------------------------------------------------------------------
// Дальность, цена и срок
// ---------------------------------------------------------------------------

/**
 * Кратчайший путь по дорогам карты мира в переходах.
 *
 * Дейкстра по `routes` с их собственной `distance`, и только по разведанным:
 * маршрут, о котором отряд ещё не знает, курьеру он назвать не может. Дороги
 * нет вовсе — считается прямая по тому же делителю, что и у генератора карты
 * (`server/world-map.mjs`), иначе письмо через кряж стоило бы как письмо вдоль
 * тракта.
 */
export function worldLeaguesBetween(map, fromId, toId) {
  const from = text(fromId, 120)
  const to = text(toId, 120)
  if (!from || !to) return null
  if (from === to) return 0
  const locations = Array.isArray(map?.locations) ? map.locations : []
  if (!locations.some((location) => location.id === from) || !locations.some((location) => location.id === to)) return null
  const neighbours = new Map()
  for (const route of Array.isArray(map?.routes) ? map.routes : []) {
    if (route?.discovered === false) continue
    const distance = Math.max(1, integer(route?.distance, 1))
    for (const [left, right] of [[route?.from, route?.to], [route?.to, route?.from]]) {
      const start = text(left, 120)
      const end = text(right, 120)
      if (!start || !end) continue
      if (!neighbours.has(start)) neighbours.set(start, [])
      neighbours.get(start).push({ id: end, distance })
    }
  }
  const best = new Map([[from, 0]])
  const visited = new Set()
  // Узлов на карте не больше пятидесяти, поэтому очередь берётся перебором:
  // куча здесь была бы сложнее самого поиска, а порядок обхода обязан быть
  // детерминированным — при равной стоимости выигрывает меньший идентификатор.
  for (let step = 0; step < locations.length; step += 1) {
    let current = ''
    let currentCost = Infinity
    for (const [id, cost] of best) {
      if (visited.has(id)) continue
      if (cost < currentCost || (cost === currentCost && id.localeCompare(current) < 0)) {
        current = id
        currentCost = cost
      }
    }
    if (!current) break
    if (current === to) return currentCost
    visited.add(current)
    for (const edge of neighbours.get(current) ?? []) {
      const candidate = currentCost + edge.distance
      if (candidate < (best.has(edge.id) ? best.get(edge.id) : Infinity)) best.set(edge.id, candidate)
    }
  }
  if (best.has(to)) return best.get(to)
  const start = locations.find((location) => location.id === from)
  const end = locations.find((location) => location.id === to)
  if (!start || !end) return null
  return Math.max(1, Math.round(Math.hypot(start.x - end.x, start.y - end.y) / 48))
}

/** Где стоит отряд: узел карты мира, от которого курьер начинает дорогу. */
function partyLocationId(state) {
  return text(state?.scene?.location_id ?? state?.scene?.locationId ?? state?.worldMap?.currentLocationId, 120)
}

/** Узел карты по названию места из профиля NPC. */
function locationIdByName(map, name) {
  const expected = key(name)
  if (!expected) return ''
  return (Array.isArray(map?.locations) ? map.locations : [])
    .find((location) => key(location.name) === expected)?.id ?? ''
}

export const courierFeeFor = (leagues) => COURIER_LETTER_BASE_FEE_CP
  + COURIER_LETTER_FEE_PER_LEAGUE_CP * Math.max(0, Math.min(COURIER_LETTER_MAX_LEAGUES, integer(leagues, 0)))

export const courierTravelMinutes = (leagues) => Math.max(
  COURIER_LETTER_MINIMUM_MINUTES,
  COURIER_LETTER_MINUTES_PER_LEAGUE * Math.max(1, Math.min(COURIER_LETTER_MAX_LEAGUES, integer(leagues, 1))),
)

// ---------------------------------------------------------------------------
// Кому вообще можно писать
// ---------------------------------------------------------------------------

/**
 * Тон ответа по числу отношения. Пороги общие с отношением NPC и славой
 * фракции — см. комментарий у `TONES`.
 */
export function courierToneFor(score) {
  const value = Math.max(-100, Math.min(100, integer(score, 0)))
  if (value <= -50) return 'silent'
  if (value <= -20) return 'cold'
  if (value >= 50) return 'warm'
  if (value >= 20) return 'friendly'
  return 'plain'
}

/** Отношение адресата к герою: у NPC — своё, у фракции — слава отряда. */
function addresseeScore(state, { kind, id }, heroId) {
  if (kind === 'faction') {
    const reputations = state?.autonomy?.reputations && typeof state.autonomy.reputations === 'object'
      ? state.autonomy.reputations
      : {}
    return integer(reputations[text(id, 120)], 0)
  }
  const social = ensureNpcSocialState(state?.social, state)
  return integer(social.relationships[text(id, 120)]?.[text(heroId, 120)], 0)
}

/**
 * Один адресат с посчитанной дорогой, ценой и сроком, либо `null`, если писать
 * ему нельзя. Функция одна на все каналы: список для панели, санитайзер команды
 * и правило движка спрашивают её же — вторая форма ответа на вопрос «сколько
 * стоит письмо» разошлась бы с первой при первой же правке цены.
 *
 * @returns {{
 *   kind: string, id: string, name: string, role: string, place_name: string,
 *   leagues: number, fee_cp: number, travel_minutes: number, unreachable: boolean,
 * } | null}
 */
export function courierAddresseeFor(state = {}, kind, id) {
  const wantedKind = COURIER_LETTER_ADDRESSEE_KINDS.includes(text(kind, 20)) ? text(kind, 20) : ''
  const wantedId = text(id, 120)
  if (!wantedKind || !wantedId) return null
  const map = state?.worldMap
  const originId = partyLocationId(state)
  if (wantedKind === 'faction') {
    const faction = (Array.isArray(state?.worldMemory?.entities) ? state.worldMemory.entities : [])
      .find((entity) => entity?.id === wantedId && entity.kind === 'faction' && visibleToParty(entity.visibility))
    if (!faction) return null
    const leagues = COURIER_LETTER_FACTION_LEAGUES
    return {
      kind: 'faction',
      id: wantedId,
      name: text(faction.name, 180),
      role: 'фракция',
      place_name: '',
      leagues,
      fee_cp: courierFeeFor(leagues),
      travel_minutes: courierTravelMinutes(leagues),
      unreachable: false,
    }
  }
  const social = ensureNpcSocialState(state?.social, state)
  const persisted = social.npcs.find((npc) => npc.id === wantedId)
  if (!persisted || !visibleToParty(persisted.visibility)) return null
  const profile = npcProfileAtWorldTime(persisted, state)
  const vitals = normalizeNpcWorldState(state?.npc_world).vitals
  if (vitals[wantedId]?.alive === false) return null
  const present = presentSceneNpcs(state).some((npc) => String(npc.id) === wantedId)
  const targetId = locationIdByName(map, profile.location)
  const leagues = Math.max(1, Math.min(
    COURIER_LETTER_MAX_LEAGUES,
    integer(targetId && originId ? worldLeaguesBetween(map, originId, targetId) : null, COURIER_LETTER_UNKNOWN_LEAGUES)
      || COURIER_LETTER_UNKNOWN_LEAGUES,
  ))
  return {
    kind: 'npc',
    id: wantedId,
    name: text(profile.name, 180),
    role: text(profile.role, 160),
    place_name: text(worldLocationById(map, targetId)?.name ?? profile.location, 180),
    leagues,
    fee_cp: courierFeeFor(leagues),
    travel_minutes: courierTravelMinutes(leagues),
    // Тот, кто стоит перед отрядом, письма не получает: это разговор, а не
    // почта. Признак считается здесь, чтобы панель гасила строку заранее, а не
    // ловила отказ движка после клика.
    unreachable: present,
  }
}

/**
 * Все, кому отряд может написать: известные живые NPC и party-видимые фракции.
 * Порядок детерминирован — ближние вперёд, дальше по имени и идентификатору.
 */
export function courierLetterAddressees(state = {}) {
  const social = ensureNpcSocialState(state?.social, state)
  const rows = []
  for (const npc of social.npcs) {
    const addressee = courierAddresseeFor(state, 'npc', npc.id)
    if (addressee) rows.push(addressee)
  }
  for (const entity of Array.isArray(state?.worldMemory?.entities) ? state.worldMemory.entities : []) {
    if (entity?.kind !== 'faction') continue
    const addressee = courierAddresseeFor(state, 'faction', entity.id)
    if (addressee) rows.push(addressee)
  }
  return rows.sort((left, right) => left.leagues - right.leagues
    || left.name.localeCompare(right.name, 'ru')
    || left.id.localeCompare(right.id))
}

/** Письма одного героя, свежие в конце. */
export function courierLettersFor(state = {}, heroId) {
  const hero = text(heroId, 120)
  return normalizeCourierLetterState(state?.courier_letters).letters.filter((letter) => letter.hero_id === hero)
}

/** Письма героя, которые ещё едут: их число и ограничивает `COURIER_LETTER_OPEN_LIMIT`. */
export function openCourierLettersFor(state = {}, heroId) {
  return courierLettersFor(state, heroId).filter((letter) => letter.status === 'in_transit')
}

// ---------------------------------------------------------------------------
// Обещание в письме
// ---------------------------------------------------------------------------

/**
 * Слова, которыми в письме дают слово. Список закрытый и серверный: обещание
 * обязано опознаваться одинаково у стола, в памяти и в мировых минутах, а
 * «пусть модель решит» здесь означало бы, что одно и то же письмо считается
 * обещанием через раз.
 *
 * Границы слова просят лукбэков, а не `\b`: для `\b` кириллица — не буква
 * вовсе, и `\bобещаю` не совпало бы никогда (та же грабля закреплена в
 * `server/tavern-life.mjs`).
 */
const PROMISE_MARKER = /(?<![а-яё])(обеща(?:ю|ем)|кляну(?:сь|тся)|клянёмся|да(?:ю|ём) слово|руча(?:юсь|емся)|заплач(?:у|ем)|верн(?:у|ём)|привез(?:у|ём)|прид(?:у|ём)|помог(?:у|ем))(?![а-яё])/iu

/**
 * Обещание из письма: предложение, в котором прозвучало слово. Срок берётся из
 * того же предложения тем же разбором, что и у обещания, сказанного вслух
 * (`promiseDueOffsetMinutes`, `server/npc-social.mjs`), — двух пониманий
 * «завтра» в проекте быть не должно.
 *
 * @returns {{ text: string, due_hint: string } | null}
 */
export function courierLetterPromiseFrom(body) {
  const flat = text(body, COURIER_LETTER_BODY_LIMIT)
  if (!flat) return null
  const sentences = flat.split(/(?<=[.!?…])\s+/u).map((sentence) => sentence.trim()).filter(Boolean)
  const sentence = (sentences.length ? sentences : [flat]).find((candidate) => PROMISE_MARKER.test(candidate))
  if (!sentence) return null
  return {
    text: text(sentence, 500),
    due_hint: promiseDueOffsetMinutes(sentence) == null ? '' : text(sentence, 240),
  }
}

// ---------------------------------------------------------------------------
// Ответ
// ---------------------------------------------------------------------------

/**
 * Детерминированная основа ответа. Вариантов на тон несколько намеренно: почта
 * на длинной кампании — регулярное занятие, и дословный повтор читается как
 * залипший движок. Выбор идёт **по кругу** от точки, заданной подписью письма, а
 * не остатком от очередного sha256: остаток честно случаен, а значит два письма
 * подряд с одной фразой выпадают регулярно.
 */
const REPLY_TEMPLATES = Object.freeze({
  warm: Object.freeze([
    ({ addressee, hero }) => `${addressee} отвечает тепло: письмо ${hero} прочли не один раз, и в конце приписано — «зови, приду».`,
    ({ addressee, hero }) => `Ответ от ${addressee} написан своей рукой: ${hero} здесь ждут, и помощь обещана без условий.`,
    ({ addressee, hero }) => `${addressee} пишет коротко и ясно: за ${hero} тут стоят, что бы ни случилось.`,
  ]),
  friendly: Object.freeze([
    ({ addressee, hero }) => `${addressee} отвечает доброжелательно: письмо ${hero} получено, и просьбу обещают не забыть.`,
    ({ addressee, hero }) => `Ответ от ${addressee} сдержанный, но тёплый: ${hero} благодарят за весть и зовут заходить.`,
    ({ addressee }) => `${addressee} отвечает: рады слышать, помочь постараются — насколько хватит сил.`,
  ]),
  plain: Object.freeze([
    ({ addressee, hero }) => `${addressee} отвечает сухо и по делу: письмо ${hero} прочитано, ответ уместился в три строки.`,
    ({ addressee }) => `${addressee} отвечает вежливо и ни к чему себя не обязывает.`,
    ({ addressee, hero }) => `Ответ от ${addressee} деловой: ${hero} обещано ровно то, что не стоит хлопот.`,
  ]),
  cold: Object.freeze([
    ({ addressee, hero }) => `${addressee} отвечает холодно: письмо ${hero} прочли, и просьба осталась просьбой.`,
    ({ addressee }) => `Ответ от ${addressee} короток и недобр: помощи в нём нет, есть только «более не пишите».`,
  ]),
})

/**
 * Основа ответа на письмо. Тон читается по отношению **на момент доставки**:
 * прибавка за само письмо в него не входит, потому что письмо ещё не прочитано.
 *
 * @returns {string}
 */
export function courierLetterReplyBase(letter = {}, tone = 'plain') {
  const variants = REPLY_TEMPLATES[tone]
  if (!variants) return ''
  const addressee = text(letter.addressee_name, 180) || 'адресат'
  const hero = text(letter.hero_name, 120) || 'отряд'
  const start = Number.parseInt(digest(letter.id, letter.addressee_id, tone).slice(0, 8), 16) % variants.length
  const base = variants[start]({ addressee, hero })
  if (!letter.promise_text || tone === 'cold') return base
  return `${base} Данное в письме слово помнят: «${text(letter.promise_text, 240)}».`
}

/**
 * Итоговый текст ответа. Полировка модели берётся только тогда, когда она
 * писалась под тот же тон: черновик, написанный для друга, к моменту доставки
 * мог застать врага — и подсовывать столу тёплые слова от того, кто их уже не
 * сказал бы, нельзя.
 *
 * @returns {{ reply: string, provider: string } | null}
 */
export function courierLetterReplyFor(letter = {}, tone = 'plain') {
  if (tone === 'silent') return null
  const base = courierLetterReplyBase(letter, tone)
  if (!base) return null
  const draft = text(letter.reply_draft, 1_000)
  if (draft && text(letter.reply_draft_tone, 20) === tone) {
    return { reply: draft, provider: text(letter.reply_provider, 80) || 'llm' }
  }
  return { reply: base, provider: 'deterministic-courier-reply' }
}

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

/**
 * Запись письма в том виде, в каком её несёт `CourierLetterSent`. Собрана в
 * одном месте намеренно: срок ответа выводится из срока доставки, и посчитать
 * их врозь значило бы завести две даты для одной дороги.
 */
export function planCourierLetter(state = {}, {
  heroId = '',
  heroName = '',
  addressee = null,
  body = '',
  commandId = '',
  atMinutes = null,
  replyDraft = '',
  replyDraftTone = '',
  replyProvider = '',
} = {}) {
  if (!addressee) return null
  const sentAt = atMinutes == null ? campaignElapsedMinutes(state) : Math.max(0, integer(atMinutes, 0))
  const travel = courierTravelMinutes(addressee.leagues)
  const promise = courierLetterPromiseFrom(body)
  const tone = courierToneFor(addresseeScore(state, addressee, heroId))
  return safeLetter({
    id: `letter:${digest(commandId || `${heroId}:${sentAt}`, addressee.id, text(body, 200)).slice(0, 24)}`,
    hero_id: heroId,
    hero_name: heroName,
    addressee_kind: addressee.kind,
    addressee_id: addressee.id,
    addressee_name: addressee.name,
    place_name: addressee.place_name,
    leagues: addressee.leagues,
    fee_cp: courierFeeFor(addressee.leagues),
    body,
    promise_text: promise?.text ?? '',
    promise_due_hint: promise?.due_hint ?? '',
    status: 'in_transit',
    sent_at_minutes: sentAt,
    delivery_due_minutes: sentAt + travel,
    reply_due_minutes: sentAt + travel + COURIER_LETTER_REPLY_DELAY_MINUTES + travel,
    tone,
    reply_draft: replyDraft,
    reply_draft_tone: TONES.has(text(replyDraftTone, 20)) ? text(replyDraftTone, 20) : '',
    reply_provider: replyProvider,
  })
}

// ---------------------------------------------------------------------------
// Ход почты на мировых минутах
// ---------------------------------------------------------------------------

/**
 * Почему письмо не дошло, либо пустая строка. Мёртвый адресат — `dead`,
 * недоступный (уведён ходом мира, ушёл из мира отряда) — `gone`. Фракцию не
 * убивают и не уводят: у неё нет ни ОЗ, ни доступности.
 */
function deliveryFailureFor(state, letter) {
  if (letter.addressee_kind === 'faction') return ''
  const vitals = normalizeNpcWorldState(state?.npc_world).vitals
  if (vitals[letter.addressee_id]?.alive === false) return 'dead'
  const social = ensureNpcSocialState(state?.social, state)
  const profile = social.npcs.find((npc) => npc.id === letter.addressee_id)
  if (!profile) return 'gone'
  return npcProfileAtWorldTime(profile, state).available === false ? 'gone' : ''
}

const RETURN_SUMMARY = Object.freeze({
  dead: (letter) => `Курьер вернул письмо к ${letter.addressee_name}: адресата больше нет в живых.`,
  gone: (letter) => `Курьер вернул письмо к ${letter.addressee_name}: адресата не нашли — к людям он больше не выходит.`,
})

/**
 * Сколько прибавки к отношению даёт это письмо. Ноль — либо адресат считает
 * отряд врагом (`silent`), либо письмо от того же героя ему уже приходило на
 * этой игровой неделе. Плату курьеру это не отменяет: она взята при отправке.
 */
function goodwillDeltaFor(state, letter, tone, atMinutes) {
  if (tone === 'silent') return 0
  const recent = normalizeCourierLetterState(state?.courier_letters).letters
    .filter((entry) => entry.id !== letter.id
      && entry.hero_id === letter.hero_id
      && entry.addressee_id === letter.addressee_id
      && entry.delivered_at_minutes != null
      && atMinutes - entry.delivered_at_minutes < COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES)
  if (recent.length) return 0
  return COURIER_LETTER_RELATIONSHIP_DELTA + (letter.promise_text ? COURIER_LETTER_PROMISE_BONUS : 0)
}

/**
 * Черновик факта памяти мира в форме, которую ждёт редьюсер (`safeFact`,
 * `server/world-memory.mjs`). Собран в одном месте по той же причине, что и у
 * хода мира: забытое `recorded_at_minutes` тихо ставит факт в нулевую минуту и
 * выносит его за горизонт выдачи.
 */
function letterFactDraft({ id, subjectId, predicate, object, summary, atMinutes }) {
  return {
    event_type: 'WorldFactRecorded',
    visibility: 'party',
    payload: {
      fact: {
        id,
        subject_id: subjectId,
        predicate,
        object: JSON.stringify(object).slice(0, 1_000),
        summary,
        visibility: 'party',
        source_event_ids: [],
        source_command_id: '',
        supersedes_fact_id: '',
        status: 'active',
        recorded_at_minutes: atMinutes,
      },
    },
    target_ids: [],
  }
}

/**
 * Черновик сущности памяти мира для адресата письма.
 *
 * Нужен потому, что факт без сущности молча пропадает: нормализатор памяти мира
 * выбрасывает факты, чей `subject_id` не назван ни одной сущностью
 * (`normalizeWorldMemory`, `server/world-memory.mjs`). Профиль NPC при этом
 * заводится и без записи в памяти — например, из торговца, — и переписка с таким
 * человеком исчезала бы из памяти вместе с фактом.
 *
 * Уже известная сущность не переписывается: черновик выдаётся только на того,
 * кого в памяти мира ещё нет. Иначе почта затирала бы сводку, написанную автором
 * кампании.
 */
function addresseeEntityDraft(state, letter) {
  if (letter.addressee_kind !== 'npc') return []
  const known = (Array.isArray(state?.worldMemory?.entities) ? state.worldMemory.entities : [])
    .some((entity) => text(entity?.id, 120) === letter.addressee_id)
  if (known) return []
  return [{
    event_type: 'WorldEntityUpserted',
    visibility: 'party',
    payload: {
      entity: {
        id: letter.addressee_id,
        kind: 'npc',
        name: letter.addressee_name,
        summary: letter.place_name ? `Адресат писем отряда. Место: «${letter.place_name}».` : 'Адресат писем отряда.',
        aliases: [],
        visibility: 'party',
        tags: ['courier-letters'],
      },
    },
    target_ids: [],
  }]
}

/**
 * Ход почты за один скачок времени. Чистая функция: одинаковое состояние и
 * одинаковый скачок дают одинаковую почту, поэтому replay воспроизводит её без
 * отдельного счётчика и без обращения к модели.
 *
 * Доставка и ответ могут уместиться в один скачок — неделя под замком доводит
 * письмо до ответа целиком, — и считаются они оба от **дособытийного**
 * состояния: срок ответа выведен из срока доставки при отправке, а не из того,
 * что случилось внутри этого же скачка.
 *
 * @returns {any[]} черновики событий в порядке, в котором их писать
 */
export function planCourierLetterTicks(state = {}, { elapsedMinutes = 0 } = {}) {
  const jump = Math.max(0, integer(elapsedMinutes, 0))
  if (jump <= 0) return []
  const start = campaignElapsedMinutes(state)
  const end = start + jump
  const drafts = []
  const goodwill = new Map()
  for (const letter of normalizeCourierLetterState(state?.courier_letters).letters) {
    if (letter.status === 'returned' || letter.status === 'answered') continue
    let deliveredAt = letter.delivered_at_minutes == null ? start : letter.delivered_at_minutes
    let tone = letter.tone
    if (letter.status === 'in_transit') {
      if (letter.delivery_due_minutes > end) continue
      deliveredAt = Math.max(start, letter.delivery_due_minutes)
      const failure = deliveryFailureFor(state, letter)
      if (failure) {
        drafts.push({
          event_type: COURIER_LETTER_EVENT_TYPES.returned,
          visibility: 'party',
          payload: {
            letter_id: letter.id,
            hero_id: letter.hero_id,
            // Имя героя едет в каждом событии почты, а не только в отправке:
            // карточка летописи собирается из **того события, что пришло**, и
            // без имени конверт возврата и ответа был бы адресован «отряду» —
            // хотя писал его конкретный человек, и ответ пришёл ему.
            hero_name: letter.hero_name,
            addressee_kind: letter.addressee_kind,
            addressee_id: letter.addressee_id,
            addressee_name: letter.addressee_name,
            reason: failure,
            summary: RETURN_SUMMARY[failure](letter),
            at_minutes: deliveredAt,
            policy_id: COURIER_LETTERS_POLICY_ID,
          },
          target_ids: [letter.hero_id],
        })
        continue
      }
      tone = courierToneFor(addresseeScore(state, { kind: letter.addressee_kind, id: letter.addressee_id }, letter.hero_id))
      const summary = `Письмо ${letter.hero_name || 'отряда'} дошло: ${letter.addressee_name} держит его в руках.`
      drafts.push({
        event_type: COURIER_LETTER_EVENT_TYPES.delivered,
        visibility: 'party',
        payload: {
          letter_id: letter.id,
          hero_id: letter.hero_id,
          hero_name: letter.hero_name,
          addressee_kind: letter.addressee_kind,
          addressee_id: letter.addressee_id,
          addressee_name: letter.addressee_name,
          tone,
          answer_expected: tone !== 'silent',
          summary,
          at_minutes: deliveredAt,
          policy_id: COURIER_LETTERS_POLICY_ID,
        },
        target_ids: [letter.hero_id, letter.addressee_id],
      })
      // Дошедшее письмо — социальное действие. Прибавка идёт по кругу «раз в
      // неделю на адресата», и счёт этих кругов ведётся здесь же: два письма
      // одному человеку в одном скачке греют его один раз.
      const goodwillKey = `${letter.hero_id} ${letter.addressee_id}`
      const delta = goodwill.has(goodwillKey) ? 0 : goodwillDeltaFor(state, letter, tone, deliveredAt)
      if (delta > 0) {
        goodwill.set(goodwillKey, true)
        // Арифметика отношения не своя: и число до, и порог смены ступени берёт
        // тот же социальный движок, что считает разговор и просроченное обещание
        // (`npcRelationshipEventDrafts`, `server/npc-social.mjs`). Вторая копия
        // этих правил разошлась бы с первой на первой же правке порогов.
        drafts.push(...(letter.addressee_kind === 'faction'
          ? [{
              event_type: 'FactionReputationAdjusted',
              visibility: 'party',
              payload: {
                faction_id: letter.addressee_id,
                delta,
                letter_id: letter.id,
                provenance: { source: 'server-courier-policy', policy: COURIER_LETTERS_POLICY_ID },
              },
              target_ids: [],
            }]
          : npcRelationshipEventDrafts(state, {
              npcId: letter.addressee_id,
              heroId: letter.hero_id,
              delta,
              reason: 'courier-letter',
            })))
      }
      // Обещание, данное в письме, — обещание. Заводится оно штатной записью
      // социального движка, и просроченным его признают те же мировые минуты,
      // что и обещание, сказанное вслух.
      if (letter.promise_text && letter.addressee_kind === 'npc') {
        const dueOffset = promiseDueOffsetMinutes(letter.promise_due_hint)
        drafts.push({
          event_type: 'NpcPromiseRecorded',
          visibility: 'party',
          payload: {
            promise: {
              id: `promise:${digest(letter.id, 'letter-promise').slice(0, 24)}`,
              npc_id: letter.addressee_id,
              hero_id: letter.hero_id,
              direction: 'party_to_npc',
              text: letter.promise_text,
              due_hint: letter.promise_due_hint,
              status: 'open',
              visibility: 'party',
              source_conversation_id: '',
              created_at_minutes: deliveredAt,
              ...(dueOffset == null ? {} : { deadline_minutes: deliveredAt + dueOffset }),
            },
          },
          target_ids: [letter.hero_id],
        })
      }
      drafts.push(...addresseeEntityDraft(state, letter))
      drafts.push(letterFactDraft({
        id: `fact:courier-letter-delivered:${digest(letter.id, String(deliveredAt)).slice(0, 20)}`,
        subjectId: letter.addressee_id,
        predicate: 'courier_letter_delivered',
        object: { letter_id: letter.id, hero_id: letter.hero_id, at_minutes: deliveredAt },
        summary,
        atMinutes: deliveredAt,
      }))
    }
    // Ответ приходит и через несколько скачков после доставки — ради этого
    // письмо и лежит в состоянии `delivered`, а не закрывается ею.
    if (letter.reply_due_minutes > end) continue
    const reply = courierLetterReplyFor(letter, tone)
    if (!reply) continue
    const answeredAt = Math.max(deliveredAt, letter.reply_due_minutes)
    drafts.push({
      event_type: COURIER_LETTER_EVENT_TYPES.answered,
      visibility: 'party',
      payload: {
        letter_id: letter.id,
        hero_id: letter.hero_id,
        hero_name: letter.hero_name,
        addressee_kind: letter.addressee_kind,
        addressee_id: letter.addressee_id,
        addressee_name: letter.addressee_name,
        tone,
        reply: reply.reply,
        provider: reply.provider,
        at_minutes: answeredAt,
        policy_id: COURIER_LETTERS_POLICY_ID,
      },
      target_ids: [letter.hero_id],
    })
    drafts.push(...addresseeEntityDraft(state, letter))
    drafts.push(letterFactDraft({
      id: `fact:courier-letter-answered:${digest(letter.id, String(answeredAt)).slice(0, 20)}`,
      subjectId: letter.addressee_id,
      predicate: 'courier_letter_answered',
      object: { letter_id: letter.id, hero_id: letter.hero_id, tone, at_minutes: answeredAt },
      summary: reply.reply,
      atMinutes: answeredAt,
    }))
  }
  return drafts
}

// ---------------------------------------------------------------------------
// Проекция и летопись
// ---------------------------------------------------------------------------

/**
 * Публичная форма письма — **одна** на все каналы: её читает и проекция
 * состояния, и канал событий (`eventForViewer`, `server/viewer-projection.mjs`).
 * `CourierLetterSent` несёт ту же запись, и вторая форма отбора разошлась бы с
 * первой молча.
 *
 * Прячется ровно одно: запечатанный ответ. Пока письмо в пути, ни черновик
 * модели, ни тон адресата столу не принадлежат — иначе игрок читал бы ответ
 * раньше, чем его написали, и вся дуга ожидания исчезла бы вместе с ним.
 */
export function courierLetterForViewer(letter = {}, { isAdmin = false } = {}) {
  const safe = safeLetter(letter)
  if (!safe) return null
  const answered = safe.status === 'answered'
  return {
    id: safe.id,
    hero_id: safe.hero_id,
    hero_name: safe.hero_name,
    addressee_kind: safe.addressee_kind,
    addressee_id: safe.addressee_id,
    addressee_name: safe.addressee_name,
    place_name: safe.place_name,
    leagues: safe.leagues,
    fee_cp: safe.fee_cp,
    body: safe.body,
    promise_text: safe.promise_text,
    status: safe.status,
    status_label: COURIER_LETTER_STATUS_LABELS[safe.status] ?? safe.status,
    sent_at_minutes: safe.sent_at_minutes,
    delivery_due_minutes: safe.delivery_due_minutes,
    reply_due_minutes: safe.reply_due_minutes,
    delivered_at_minutes: safe.delivered_at_minutes,
    answered_at_minutes: safe.answered_at_minutes,
    returned_at_minutes: safe.returned_at_minutes,
    return_reason: safe.return_reason,
    ...(answered || isAdmin ? { tone: safe.tone } : {}),
    ...(answered ? { reply: safe.reply_text } : {}),
  }
}

/**
 * Почта для зрителя. Игрок видит письма отряда целиком — кроме запечатанных
 * ответов; ведущий видит то же самое плюс тон, по которому ответ соберётся.
 */
export function courierLettersForViewer(state = {}, { isAdmin = false, limit = 20 } = {}) {
  const letters = normalizeCourierLetterState(state?.courier_letters).letters
    .slice()
    .sort((left, right) => right.sent_at_minutes - left.sent_at_minutes || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(MAX_LETTERS, integer(limit, 20))))
    .map((letter) => courierLetterForViewer(letter, { isAdmin }))
    .filter(Boolean)
  return {
    schema_version: COURIER_LETTERS_SCHEMA_VERSION,
    letters,
    // Цена и срок приходят готовыми: считать их клиенту нечем, а вторая
    // арифметика дальности разошлась бы с серверной при первой же правке.
    addressees: courierLetterAddressees(state),
    base_fee_cp: COURIER_LETTER_BASE_FEE_CP,
    fee_per_league_cp: COURIER_LETTER_FEE_PER_LEAGUE_CP,
    body_limit: COURIER_LETTER_BODY_LIMIT,
    open_limit: COURIER_LETTER_OPEN_LIMIT,
  }
}

/**
 * Карточка летописи из уже подтверждённого события — конверт с «от кого» и
 * «кому». Строится на сервере, потому что подписи и порядок строк обязаны быть
 * одни и те же у ведущего и у стола.
 */
export function courierLetterChronicleEntry(event = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  const letter = type === COURIER_LETTER_EVENT_TYPES.sent ? safeLetter(payload.letter) : null
  const addressee = text(letter?.addressee_name ?? payload.addressee_name, 180) || 'адресат'
  const hero = text(letter?.hero_name ?? payload.hero_name, 120)
  const letterId = text(letter?.id ?? payload.letter_id, 140)
  if (!letterId) return null
  const card = type === COURIER_LETTER_EVENT_TYPES.sent
    ? {
        kind: 'sent',
        title: 'Письмо отправлено',
        text: `Курьер увёз письмо к ${addressee}${letter.place_name ? ` в «${letter.place_name}»` : ''}. Дорога — ${letter.leagues} перех. и ${letter.fee_cp} мм из кошелька.`,
      }
    : type === COURIER_LETTER_EVENT_TYPES.delivered
      ? { kind: 'delivered', title: 'Письмо доставлено', text: text(payload.summary, 400) }
      : type === COURIER_LETTER_EVENT_TYPES.returned
        ? { kind: 'returned', title: 'Письмо вернулось', text: text(payload.summary, 400) }
        : type === COURIER_LETTER_EVENT_TYPES.answered
          ? { kind: 'answered', title: 'Пришёл ответ', text: text(payload.reply, 800) }
          : null
  if (!card || !card.text) return null
  return {
    id: `chronicle:${letterId}:${card.kind}`,
    speaker: 'system',
    author: COURIER_LETTER_CARD_TITLE,
    text: card.text,
    letter: {
      kind: card.kind,
      title: card.title,
      from: card.kind === 'answered' ? addressee : hero || 'отряд',
      to: card.kind === 'answered' ? (hero || 'отряд') : addressee,
      text: card.text,
    },
  }
}
