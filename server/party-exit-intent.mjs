// @ts-check

/**
 * Один словарь ухода на оба берега решения группы.
 *
 * Словарей было два. `EXIT_REQUEST` в `server/player-request-router.mjs` решал,
 * предлагать ли карточку голосования, а `interpretResolvedPartyDecision` в
 * `server/scene-architect.mjs` решал, считать ли уже принятое решение уходом.
 * Списки разошлись, и формулировка «Отправиться в Пепельный Лес» проходила
 * первый и не проходила второй: карточка появлялась, отряд голосовал, а локация
 * оставалась прежней. Здесь на оба вопроса отвечает один набор правил, и разойтись
 * им больше негде.
 *
 * Отдельная забота — не перехватить тактическое действие. Свободный ввод один и
 * тот же и для «уходим отсюда», и для «уходим в тень», поэтому просьба уйти
 * опознаётся только по связке «глагол ухода + место», а не по глаголу.
 */

/** Маркер, которым клиент карты мира помечает предложение маршрута. */
export const WORLD_MAP_TRAVEL_MARKER = '[ГЛОБАЛЬНАЯ КАРТА]'

const WORLD_MAP_MARKER = /^\s*\[ГЛОБАЛЬНАЯ КАРТА\]/iu

/**
 * Места, из которых и в которые уходят целиком. Комнаты, залы и коридоры сюда
 * намеренно не входят: перемещение внутри локации — дело тактической доски и
 * `UseLevelTransition`, а не перехода сцены.
 */
const PLACE = String.raw`подземель\w*|локац\w*|мест(?:о|а|е|ност\w*)|город\w*|деревн\w*|сел[оа]|пос[ёе]лк\w*|поселени\w*|лес\w*|чащ\w*|рощ\w*|болот\w*|топ[ия]\w*|пустош\w*|пустын\w*|порт\w*|гаван\w*|пристан\w*|замок|замка|крепост\w*|цитадел\w*|форт\w*|застав\w*|лагер\w*|стоянк\w*|храм\w*|святилищ\w*|монастыр\w*|пещер\w*|руин\w*|развалин\w*|архив\w*|склеп\w*|катакомб\w*|шахт\w*|рудник\w*|башн\w*|таверн\w*|трактир\w*|корчм\w*|постоял\w*\s+двор\w*|караван-?сара\w*|усадьб\w*|поместь\w*|особняк\w*|здани\w*|район\w*|улиц\w*|площад\w*|рынок|рынка|тракт\w*|дорог[ауеи]|перевал\w*|ущель\w*|долин\w*|остров\w*|берег\w*|станци\w*|пол[еяю]`

/** Глаголы, которыми объявляют уход всей группы. */
const LEAVE = String.raw`покин(?:уть|ем|ём|ут|ь)|уход(?:им|ить|ят|ите)|уйти|уйд(?:ем|ём|ут)|свал(?:им|ить|иваем)|валим|убира(?:емся|ться)|выбра(?:ться|вшись)|выбираемся|выходим|выдвигаемся|отступ(?:аем|ить|им)|сматываемся`

/** Глаголы движения, у которых уход опознаётся только по названному месту. */
const HEAD_TO = String.raw`ид(?:ём|ем|ти)|направля(?:емся|ться)|отправ(?:ляемся|иться|имся)|возвраща(?:емся|ться)|верн(?:ёмся|емся)`

/** «Уйти отсюда» — место не названо, но названа сама локация как целое. */
const EXIT_SCOPE = /(?:отсюда|прочь|из\s+эт(?:ого|ой)\s+(?:мест|локац|город|деревн|подземель))/iu

/** «Покинуть подземелье», «уходим из деревни», «покинуть «Караван-сарай»». */
const LEAVE_TARGET = new RegExp(
  String.raw`(?:${LEAVE})\s+(?:(?:из|с|от)\s+)?(?:эт(?:о|ого|у|ой|от|им)\s+)?(?:«[^»]{1,120}»|(?:${PLACE}))`,
  'iu',
)

const LEAVE_VERB = new RegExp(String.raw`(?:${LEAVE})`, 'iu')

/**
 * Куда собрались: глагол ухода или движения, предлог и название до ближайшей
 * границы. Сама по себе эта связка уходом ещё не является — «уходим в тень» ей
 * тоже удовлетворяет.
 *
 * Название берётся нежадно и обрывается на сочинительном союзе. Жадный вариант
 * на подписи «Уходим в Каменный Град и бросаем задание «Печать архивариуса»»
 * забирал в пункт назначения всю вторую половину фразы вместе с названием
 * задания.
 */
const DESTINATION = new RegExp(
  String.raw`(?:${LEAVE}|${HEAD_TO})\s+(?:отсюда\s+|из\s+[^,.;!?]{1,80}\s+)?(?:в|на|к|ко)\s+(?:«([^»]{1,120})»|([^,.;!?—]{1,120}?)(?=\s+(?:и|а|но|чтобы|затем|потом|сохранив|бросив|отказавшись|оставив)\s|[,.;!?—]|$))`,
  'iu',
)

/**
 * Место, названное где угодно внутри пункта назначения. Проверяется именно
 * вхождение, а не начало: «в Пепельный Лес» — уход, «в тень» — нет, и по первому
 * слову их не различить.
 */
const PLACE_WORD = new RegExp(String.raw`(?:^|\s|-)(?:${PLACE})`, 'iu')

/** Отказ от задания. Держится рядом с уходом: голосуют за это одной карточкой. */
const ABANDON = /(?:брос(?:аем|ить|им)\s+(?:это\s+)?(?:задани|квест|поручени|дело)|отказ(?:ываемся|аться|ываюсь)\s+от\s+(?:задани|квест|поручени)|заби(?:ваем|вать|ть|л[иа]?)\s+на\s+(?:задани|квест|поручени)|без\s+задани)/iu

/** Решение остаться. */
const STAY = /(?:оста(?:ться|ёмся|емся|немся|нусь|нься)|не\s+уход|продолж(?:ить|аем|им)\s+(?:исслед|поиск|осмотр)|исследовать\s+дальше|никуда\s+не\s+ид)/iu

/**
 * Отказ от ухода перевешивает названное в той же фразе место: «остаться и не
 * уходить из деревни» — это решение остаться, хотя деревня в нём названа.
 */
const STAY_OVERRIDES_EXIT = /(?:не\s+уход|не\s+покида|никуда\s+не\s+ид)/iu

/**
 * @param {unknown} value
 * @param {number} [maximum]
 * @returns {string}
 */
function compact(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

/**
 * Кавычки «ёлочки» из предложения карты мира: первая пара — откуда, вторая —
 * куда. Разбирать прозу маркера не нужно, у него есть структура.
 *
 * @param {string} text
 * @returns {string[]}
 */
function quotedPlaces(text) {
  return [...text.matchAll(/«([^»]{1,120})»/gu)].map((match) => compact(match[1], 120)).filter(Boolean)
}

/**
 * Пункт назначения и признак того, что назван именно он, а не цель внутри сцены.
 *
 * @param {string} text
 * @returns {{destination: string, isPlace: boolean}}
 */
function destinationIn(text) {
  const match = DESTINATION.exec(text)
  if (!match) return { destination: '', isPlace: false }
  const quoted = compact(match[1] ?? '', 120)
  const phrase = compact(match[2] ?? '', 120)
  // Название в кавычках после «в» — всегда место: кавычки ставит либо клиент
  // карты мира, либо сам сервер, собирая вариант голосования.
  return { destination: quoted || phrase, isPlace: Boolean(quoted) || PLACE_WORD.test(phrase) }
}

/**
 * Просьба увести отряд из текущей локации. Возвращает `null`, когда фраза
 * говорит о чём угодно другом.
 *
 * @param {unknown} action
 * @returns {{destination: string, source: 'world-map'|'text'}|null}
 */
export function detectPartyExitRequest(action) {
  const text = compact(action, 2_000)
  if (!text) return null
  const heading = destinationIn(text)
  if (WORLD_MAP_MARKER.test(text)) {
    const places = quotedPlaces(text)
    // Первая кавычка — откуда, вторая — куда. Если названо одно место, это и есть
    // пункт назначения: маршрут строил клиент, и «откуда» он знает сам.
    return { destination: places.length > 1 ? places[1] : places[0] ?? heading.destination, source: 'world-map' }
  }
  const leaves = LEAVE_TARGET.test(text)
    || heading.isPlace
    || (LEAVE_VERB.test(text) && EXIT_SCOPE.test(text))
  if (!leaves) return null
  return { destination: heading.destination, source: 'text' }
}

/**
 * Разбор уже выбранного варианта голосования. `abandonsQuest` независим от вида
 * решения: бросить задание можно и уходя, и оставаясь.
 *
 * @param {unknown} decision
 * @returns {{kind: 'move'|'stay'|'other', destinationHint: string, abandonsQuest: boolean}}
 */
export function classifyPartyDecision(decision) {
  const text = compact(decision, 500)
  const abandonsQuest = ABANDON.test(text)
  const exit = detectPartyExitRequest(text)
  if (exit && !STAY_OVERRIDES_EXIT.test(text)) return { kind: 'move', destinationHint: exit.destination, abandonsQuest }
  return { kind: STAY.test(text) ? 'stay' : 'other', destinationHint: '', abandonsQuest }
}

/**
 * Задание, от которого отряд отказывается. Правило то же, которым автономный
 * контур отличает кампанийную нить от сценической (`docs/known-limitations.md`,
 * раздел «Путешествия по карте мира»): служебный префикс `quest:chapter:` —
 * признак нити главы, а не основной.
 *
 * Функция одна и та же и когда строится вариант голосования, и когда решение
 * исполняется: подпись варианта остаётся текстом, а задание выбирается кодом.
 *
 * @param {Record<string, any>} [state]
 * @returns {{id: string, title: string}|null}
 */
export function abandonableQuest(state = {}) {
  const quests = Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : []
  // Функция вызывается на полном серверном состоянии, а её результат попадает в
  // подпись варианта голосования — то есть на глаза всему столу. Отказаться от
  // задания, о котором отряд не знает, нельзя: `gm_only` отсеивается здесь, а не
  // проекцией, потому что проекции на этом пути нет.
  const active = quests.filter((quest) => quest?.status === 'active' && quest?.visibility !== 'gm_only')
  const quest = active.find((item) => !String(item?.id ?? '').startsWith('quest:chapter:')) ?? active[0] ?? null
  if (!quest?.id) return null
  return { id: String(quest.id), title: compact(quest.title, 160) || String(quest.id) }
}
