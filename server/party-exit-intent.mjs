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
 * Machine-readable цель карты мира. Значение кодирует клиент через
 * `encodeURIComponent`, поэтому оно не может преждевременно закрыть квадратную
 * скобку. Маркер необязателен: старые клиенты продолжают работать по имени.
 */
const WORLD_MAP_DESTINATION_ID = /^\s*\[ГЛОБАЛЬНАЯ КАРТА\]\s*\[destination_location_id=([^\]\s]{1,1500})\]/iu

/**
 * Места, из которых и в которые уходят целиком. Комнаты, залы и коридоры сюда
 * намеренно не входят: перемещение внутри локации — дело тактической доски и
 * `UseLevelTransition`, а не перехода сцены.
 */
//
// Слово места — целое слово с падежным окончанием, а не префикс. Раньше здесь
// стояло `лес\w*`, а `\w` в JS понимает только латиницу, так что шаблон
// означал «начинается с „лес“»: «иду к старой лестнице» и «иду к лесничему»
// становились уходом в лес, а «иду к трактирщице» — уходом в трактир.
const NOUN_END = String.raw`(?:а|я|о|е|ё|у|ю|ы|и|ь|ой|ей|ою|ею|ом|ем|ём|ам|ям|ами|ями|ах|ях|ов|ев)?`
const PLACE_STEMS = String.raw`подземель|локаци|местност|мест|город|городк|град|деревн|деревушк|сел|пос[ёе]лк|поселени|лес|чащ|рощ|болот|топ|пустош|пустын|порт|гаван|пристан|замк|крепост|цитадел|форт|застав|лагер|стоянк|храм|святилищ|монастыр|пещер|руин|развалин|архив|склеп|катакомб|шахт|рудник|башн|таверн|трактир|корчм|гостиниц|усадьб|поместь|особняк|здани|район|улиц|площад|рынк|тракт|дорог|перевал|ущель|долин|остров|берег|станци|маяк|мельниц|кладбищ|погост|холм`
const PLACE_FULL = String.raw`замок|рынок|городок|пос[ёе]лок|постоял(?:ый|ого|ому|ом)\s+двор(?:а|у|е|ом)?|караван-?сара(?:й|я|ю|е|ем)|пол(?:е|я|ю|ям|ях)|гор(?:ы|ам|ах)`
const PLACE = String.raw`(?<![\p{L}\p{M}])(?:${PLACE_FULL}|(?:${PLACE_STEMS})${NOUN_END})(?![\p{L}\p{M}])`

/** Глаголы, которыми объявляют уход всей группы. */
const LEAVE = String.raw`покин(?:уть|ем|ём|ут|у|ь)|покида(?:ем|ю|ть|ете)|уход(?:им|ить|ят|ите)|уйти|уйд(?:ем|ём|ут|у)|свал(?:им|ить|иваем)|валим|убира(?:емся|ться)|выбра(?:ться|вшись)|выбираемся|выходим|выхожу|вый(?:ти|дем|дём|ду)|выдвигаемся|выдвигаюсь|отступ(?:аем|ить|им)|сматываемся`

/**
 * Реплика из одного глагола ухода: «Уходим.», «Всё, валим!». Места в ней нет, но
 * и спутать её не с чем — шаг по доске всегда называет, куда.
 */
const BARE_LEAVE = /^(?:(?:всё|все|ну|ладно|итак|так|мы|пора|давайте|ребята|я)[,!.]?\s+){0,3}(?:уходим|уйд[её]м|уходить|уйти|валим|сваливаем|сматываемся|выдвигаемся|выходим|покидаем)[.!…]*$/iu

/**
 * Глаголы движения, у которых уход опознаётся только по названному месту.
 * Первое лицо единственного числа («иду», «отправляюсь») — то, как обычно
 * пишет одиночный игрок; без этих форм «Иду в таверну «Морской Змей»» уходила
 * мимо перехода прямо к судье свободных действий и превращалась в проверку.
 */
// «Идём», «едем», «добираемся до…», «держим путь» — тоже движение отряда. Формы
// перечислены явно: префикс «двига…» поймал бы «двигаю стол».
const HEAD_TO = String.raw`ид(?:ём|ем|ти|у)|пойти|пойд(?:у|ём|ем)|пошли|направ(?:ля(?:емся|ться|юсь)|имся|люсь|иться)|отправ(?:ляемся|иться|имся|ляюсь|люсь)|возвраща(?:емся|ться|юсь)|верн(?:ёмся|емся|усь|уться)|едем|еду|ехать|по(?:еду|едем|ехали|ехать)|двига(?:емся|юсь|ться)|двин(?:емся|улись|усь|уться)|добира(?:емся|юсь|ться)|добер(?:ёмся|емся|усь)|добраться|держ(?:им|у)\s+путь|плыв(?:ём|ем)|поплыв(?:ём|ем)|бежим|бегу|спеш(?:им|у)`

/** «Уйти отсюда» — место не названо, но названа сама локация как целое. */
const EXIT_SCOPE = /(?:отсюда|прочь|из\s+эт(?:ого|ой)\s+(?:мест|локац|город|деревн|подземель))/iu

/** «Покинуть подземелье», «уходим из деревни», «покинуть «Караван-сарай»». */
// До двух определений перед местом: «покидаем старую таверну».
const LEAVE_TARGET = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:${LEAVE})\s+(?:(?:из|с|от)\s+)?(?:эт(?:о|ого|у|ой|от|им)\s+)?(?:«[^»]{1,120}»|(?:[\p{L}-]+\s+){0,2}?(?:${PLACE}))`,
  'iu',
)

/** Что покидают, когда предлога нет или место не родовое: «покидаем Аквилон». */
const LEAVE_OBJECT = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:${LEAVE})\s+(?:(?:из|с|от)\s+)?([^,.;!?—]{1,80}?)(?=\s+(?:и|а|но|чтобы|затем|потом)\s|\s+(?:в|на|к|ко|до)\s|[,.;!?—]|$)`,
  'iu',
)

const LEAVE_VERB = new RegExp(String.raw`(?:${LEAVE})`, 'iu')

/**
 * Цель поездки после названия: «в таверну «Морской Змей» расспрашивать…».
 * Инфинитив обрывает название так же, как союз, — иначе хвост фразы попадал в
 * пункт назначения и мешал узнать место на карте.
 *
 * Существительные на «-ть» инфинитивом не считаются: «в старую крепость»
 * обрывалось на «старую», и место терялось.
 */
const PURPOSE_INFINITIVE = String.raw`(?!(?:${PLACE})|(?:часть|область|волость|пропасть|пасть|сеть|степь|смерть|опасность|радость|ярость|скорость)(?![\p{L}\p{M}]))[\p{L}-]{2,}(?:ть|ться|тись|чь)(?![\p{L}\p{M}])`

/**
 * Место внутри текущей сцены: «иду в угол таверны» — это шаг по доске, а не
 * уход из локации, хотя таверна в фразе названа.
 */
// Формы перечислены явно, а не префиксом: «стол…» поймал бы «столицу», «зал…» — «залив».
//
// Проверяется не только первое слово: «в дальний угол таверны» и «к старой
// лестнице в подвал» начинаются с определения. Достаточно, чтобы такое слово
// стояло раньше названного места.
const INSIDE_SCENE = /(?<![\p{L}\p{M}])(?:угол|угл(?:а|у|ом|е)|сторон(?:а|у|е|ы)|центр(?:а|у|е)?|середин(?:а|у|е|ы)|конец|конц(?:а|у|е)|дверь|двер(?:и|ью)|комнат(?:а|у|е|ы)|зал(?:а|у|е|ом|ы)?|подвал(?:а|у|е)?|погреб(?:а|у|е)?|кухн(?:я|и|ю|е)|стойк(?:а|и|у|е)|стол(?:а|у|е|ом|ы)?|окн(?:а|у|е)|окно|лестниц(?:а|у|е|ы)|коридор(?:а|у|е)?|тень|тен(?:и|ью)|укрыти(?:е|я|ю)|глубь|глубин(?:а|у|е|ы)|камин(?:а|у|е)?|очаг(?:а|у|е)?|этаж(?:а|у|е)?|сво(?:ё|е|ему|ем)\s+мест(?:о|у|е))(?![\p{L}\p{M}])/iu

/**
 * Человек, к которому идут: «иду к хозяйке таверны» — шаг к собеседнику, а не
 * уход в таверну. Имена присутствующих NPC добавляет вызывающий.
 */
const PERSON_WORD = /(?<![\p{L}\p{M}])(?:хозя(?:ин|ина|ину|ином|йк(?:а|и|е|у|ой))|трактирщи(?:к|ка|ку|ком|ц(?:а|е|у|ей))|корчмар(?:я|ю|ем|ь)?|стражник(?:а|у|ом|ам)?|страж(?:е|у|ам)|торгов(?:ец|ца|цу|цем|к(?:а|е|у|ой))|кузнец(?:а|у|ом)?|жрец(?:а|у|ом)?|жриц(?:а|е|у|ей)|бармен(?:а|у|ом)?|служанк(?:а|е|у|ой)|лесничи(?:й|его|ему|м)|старост(?:а|е|у|ой)|капитан(?:а|у|ом)?|рыбак(?:а|у|ом|ам)?|завсегдата(?:й|ю|ям|ям))(?![\p{L}\p{M}])/iu

/** Кавычки, которыми игрок обрамляет название: «ёлочки», "прямые", “английские”, „немецкие“. */
const QUOTED = String.raw`«([^»]{1,120})»|"([^"]{1,120})"|“([^”]{1,120})”|„([^“”]{1,120})[“”]`

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
//
// Между глаголом и предлогом допускается цель: «иду искать сына Финна в
// Пепельный Лес». Не больше трёх слов после инфинитива — дальше это уже другое
// предложение. «До» — для «добираемся до Каменного Града».
const DESTINATION = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:${LEAVE}|${HEAD_TO})\s+(?:отсюда\s+|из\s+[^,.;!?]{1,80}\s+)?(?:${PURPOSE_INFINITIVE}(?:\s+[^\s,.;!?—]+){0,3}?\s+)?(?:в|во|на|к|ко|до)\s+(?:(?:${QUOTED})|([^,.;!?—]{1,120}?)(?=\s+(?:и|а|но|чтобы|затем|потом|сохранив|бросив|отказавшись|оставив)\s|\s+${PURPOSE_INFINITIVE}|[,.;!?—]|$))`,
  'iu',
)

/**
 * Место, названное где угодно внутри пункта назначения. Проверяется именно
 * вхождение, а не начало: «в Пепельный Лес» — уход, «в тень» — нет, и по первому
 * слову их не различить.
 */
const PLACE_WORD = new RegExp(PLACE, 'iu')
const PLACE_WORD_EXACT = new RegExp(String.raw`^(?:${PLACE})$`, 'iu')

/** Хвост, которым русское слово меняется по падежам: «-у/-а», «-ой/-ого», «-й/-я». */
const CASE_ENDING = /^[аеёиоуыэюяйьмхвг]{0,3}$/u

/**
 * Одно слово в разных падежах: общая основа и короткие падежные хвосты.
 * «Норвин» и «Норвель» начинаются одинаково, но хвосты «ин»/«ель» не падежные.
 * Тот же критерий, что у `scene-architect.mjs` при поиске точки карты: уход
 * опознаётся по тому же совпадению, по которому потом выбирается место.
 *
 * @param {string} left
 * @param {string} right
 */
function sameWordInflected(left, right) {
  if (left === right) return true
  let common = 0
  while (common < left.length && common < right.length && left[common] === right[common]) common += 1
  if (common < 3 || common < Math.max(left.length, right.length) - 3) return false
  return CASE_ENDING.test(left.slice(common)) && CASE_ENDING.test(right.slice(common))
}

/**
 * Слова названия длиной от трёх букв, без кавычек; `generic` — родовые слова
 * («таверна», «лес»), которые сами по себе места не называют.
 *
 * @param {string} value
 */
function nameWords(value) {
  const words = (compact(value, 160).toLocaleLowerCase('ru').replace(/["'«»„“”`]/gu, ' ').match(/[\p{L}\p{N}-]+/gu) ?? [])
    .filter((word) => word.length >= 3)
  return {
    distinctive: words.filter((word) => !PLACE_WORD_EXACT.test(word)),
    generic: words.filter((word) => PLACE_WORD_EXACT.test(word)),
  }
}

/**
 * Называет ли фраза одну из известных отряду точек карты: все отличительные
 * слова названия встретились во фразе в любом падеже, лишних слов не больше
 * двух, а названный род места («форт», «таверна») не противоречит карте.
 *
 * @param {string} phrase
 * @param {string[]} knownPlaces
 */
function namesKnownPlace(phrase, knownPlaces) {
  return Boolean(knownPlaceName(phrase, knownPlaces))
}

/**
 * Название известной точки карты, которое называет фраза в любом падеже:
 * «к Кленовке» — «Кленовка». Пустая строка, если такой точки нет.
 *
 * @param {string} phrase
 * @param {string[]} knownPlaces
 * @returns {string}
 */
function knownPlaceName(phrase, knownPlaces) {
  if (!phrase || !knownPlaces.length) return ''
  const spoken = nameWords(phrase)
  if (!spoken.distinctive.length) return ''
  return knownPlaces.find((name) => {
    const place = nameWords(name)
    if (!place.distinctive.length || spoken.distinctive.length > place.distinctive.length + 2) return false
    if (!place.distinctive.every((stem) => spoken.distinctive.some((word) => sameWordInflected(word, stem)))) return false
    return !spoken.generic.length || !place.generic.length
      || place.generic.some((kind) => spoken.generic.some((word) => sameWordInflected(word, kind)))
  }) ?? ''
}

/**
 * Позиция первого совпадения или `-1`.
 *
 * @param {RegExp} pattern
 * @param {string} text
 */
function firstIndex(pattern, text) {
  const match = pattern.exec(text)
  return match ? match.index : -1
}

/**
 * Упоминает ли фраза присутствующего собеседника. Сравнение — по словам имени в
 * любом падеже: «к Марте», «к Старому Финну».
 *
 * @param {string} phrase
 * @param {string[]} presentNames
 */
function namesPresentPerson(phrase, presentNames) {
  // Сравнивается последнее слово имени — собственное: у «Старого Финна» слово
  // «старый» совпало бы со «старой крепостью».
  const proper = presentNames
    .map((name) => (compact(name, 80).toLocaleLowerCase('ru').match(/[\p{L}-]{3,}/gu) ?? []).at(-1))
    .filter((name) => typeof name === 'string')
  if (!proper.length) return -1
  const lower = compact(phrase, 160).toLocaleLowerCase('ru')
  for (const word of lower.matchAll(/[\p{L}-]{3,}/gu)) {
    if (proper.some((name) => sameWordInflected(word[0], name))) return word.index ?? -1
  }
  return -1
}

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
 * @param {string} text
 * @returns {string}
 */
function worldMapDestinationLocationId(text) {
  const encoded = WORLD_MAP_DESTINATION_ID.exec(text)?.[1]
  if (!encoded) return ''
  try {
    const decoded = decodeURIComponent(encoded).normalize('NFKC').replace(/\s+/gu, ' ').trim()
    if (!decoded || decoded.length > 120 || /[\u0000-\u001f\u007f]/u.test(decoded)) return ''
    return decoded
  } catch {
    // Неверное percent-encoding не отменяет legacy-разбор видимого названия.
    return ''
  }
}

/**
 * Пункт назначения и признак того, что назван именно он, а не цель внутри сцены.
 *
 * Место узнаётся тремя способами: кавычки сразу после предлога, родовое слово
 * места («лес», «таверна») или известная отряду точка карты по имени. Шаг к
 * углу или к человеку перевешивает место, если назван раньше него: «в дальний
 * угол таверны», «к хозяйке таверны».
 *
 * @param {string} text
 * @param {ExitContext} context
 * @returns {{destination: string, isPlace: boolean}}
 */
function destinationIn(text, context) {
  const match = DESTINATION.exec(text)
  if (!match) return { destination: '', isPlace: false }
  const quoted = compact(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '', 120)
  const phrase = compact(match[5] ?? '', 120)
  // Название в кавычках после «в» — всегда место: кавычки ставит либо клиент
  // карты мира, либо сам сервер, собирая вариант голосования.
  if (quoted) return { destination: quoted, isPlace: true }
  const placeAt = firstIndex(PLACE_WORD, phrase)
  const known = namesKnownPlace(phrase, context.knownPlaces)
  if (placeAt < 0 && !known) return { destination: phrase, isPlace: false }
  const anchor = placeAt < 0 ? phrase.length : placeAt
  const inScene = [
    firstIndex(INSIDE_SCENE, phrase),
    firstIndex(PERSON_WORD, phrase),
    namesPresentPerson(phrase, context.presentNames),
  ].some((index) => index >= 0 && index < anchor)
  return { destination: phrase, isPlace: !inScene }
}

/**
 * @typedef {{ knownPlaces: string[], presentNames: string[] }} ExitContext
 */

/**
 * @param {{ knownPlaces?: unknown, presentNames?: unknown }} [options]
 * @returns {ExitContext}
 */
function exitContext(options = {}) {
  const names = (/** @type {unknown} */ value) => (Array.isArray(value) ? value : [])
    .map((entry) => compact(entry, 120)).filter(Boolean).slice(0, 200)
  return { knownPlaces: names(options.knownPlaces), presentNames: names(options.presentNames) }
}

/**
 * Названия точек карты мира, которые отряд знает, и имена тех, кто стоит рядом.
 * Вызывающий передаёт их в `detectPartyExitRequest`, чтобы «Иду в Каменный
 * Град» узнавалось без родового слова, а «иду к Марте» не уводило из сцены.
 * Скрытые и неизвестные точки не попадают: иначе фраза игрока работала бы
 * оракулом по карте.
 *
 * @param {Record<string, any>} [state]
 * @returns {{ knownPlaces: string[], presentNames: string[] }}
 */
export function exitContextFromState(state = {}) {
  /** @type {Array<Record<string, any>>} */
  const locations = Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
  const knownPlaces = locations
    .filter((entry) => entry?.name && entry.known !== false && entry.hidden !== true && entry.visibility !== 'gm_only')
    .map((entry) => compact(entry.name, 120))
  const location = compact(state?.scene?.location, 160).toLocaleLowerCase('ru')
  const actors = [
    ...(Array.isArray(state?.scene_npcs) ? state.scene_npcs : []),
    ...(Array.isArray(state?.social?.npcs) ? state.social.npcs : []),
    ...(Array.isArray(state?.merchants) ? state.merchants : []),
  ].filter((actor) => actor?.alive !== false && actor?.available !== false
    && (!location || !actor?.location || compact(actor.location, 160).toLocaleLowerCase('ru') === location))
  const presentNames = [...new Set(actors.map((actor) => compact(actor?.name, 80)).filter(Boolean))]
  return { knownPlaces, presentNames }
}

/**
 * Просьба увести отряд из текущей локации. Возвращает `null`, когда фраза
 * говорит о чём угодно другом.
 *
 * @param {unknown} action
 * @param {{ knownPlaces?: unknown, presentNames?: unknown }} [options] названия
 *   известных точек карты и имена присутствующих — см. `exitContextFromState`
 * @returns {{destination: string, source: 'world-map'|'text', destinationLocationId?: string}|null}
 */
export function detectPartyExitRequest(action, options = {}) {
  const text = compact(action, 2_000)
  if (!text) return null
  const context = exitContext(options)
  const heading = destinationIn(text, context)
  if (WORLD_MAP_MARKER.test(text)) {
    const places = quotedPlaces(text)
    const destinationLocationId = worldMapDestinationLocationId(text)
    // Первая кавычка — откуда, вторая — куда. Если названо одно место, это и есть
    // пункт назначения: маршрут строил клиент, и «откуда» он знает сам.
    return {
      destination: places.length > 1 ? places[1] : places[0] ?? heading.destination,
      source: 'world-map',
      ...(destinationLocationId ? { destinationLocationId } : {}),
    }
  }
  const leftPlace = LEAVE_OBJECT.exec(text)?.[1] ?? ''
  const leaves = LEAVE_TARGET.test(text)
    || heading.isPlace
    || (LEAVE_VERB.test(text) && EXIT_SCOPE.test(text))
    || BARE_LEAVE.test(text)
    || namesKnownPlace(leftPlace, context.knownPlaces)
  if (!leaves) return null
  return { destination: heading.destination, source: 'text' }
}

/**
 * Годится ли пункт назначения, названный судьёй свободных действий
 * (`route: travel`), в карточку ухода. Решает тот же словарь, что и для фразы
 * игрока: родовое слово места или известная точка карты, и не угол, не стойка,
 * не собеседник. Пустое назначение — «уйти отсюда» без названия — допустимо.
 *
 * @param {unknown} destination
 * @param {{ knownPlaces?: unknown, presentNames?: unknown }} [options]
 * @returns {boolean}
 */
export function travelDestinationIsPlace(destination, options = {}) {
  const text = compact(destination, 120).replace(/[«»]/gu, '')
  if (!text) return true
  return destinationIn(`Отправляемся в ${text}`, exitContext(options)).isPlace
}

/** Окончания прилагательного в косвенном падеже → именительный; род — для существительного. */
const OBLIQUE_ADJECTIVE = /** @type {Array<[RegExp, string, 'm'|'f']>} */ ([
  [/ому$/u, 'ый', 'm'], [/ему$/u, 'ий', 'm'], [/ого$/u, 'ый', 'm'], [/его$/u, 'ий', 'm'],
  [/ом$/u, 'ый', 'm'], [/ем$/u, 'ий', 'm'],
  [/ой$/u, 'ая', 'f'], [/ей$/u, 'яя', 'f'], [/ую$/u, 'ая', 'f'], [/юю$/u, 'яя', 'f'],
])

/**
 * Именительный падеж для названия вида «прилагательное + существительное»:
 * «старому фамильному склепу за мельницей» — «старый фамильный склеп за
 * мельницей», «к водяной мельнице у реки» — «водяная мельница у реки». Хвост
 * после существительного («за мельницей») не трогается. Если существительное
 * меняется не по правилу — беглая гласная «замку → замок», мягкий знак, — фраза
 * остаётся как была: лучше косвенный падеж в кавычках, чем выдуманное слово.
 *
 * @param {string} phrase
 * @returns {string}
 */
export function nominativePlacePhrase(phrase) {
  const words = compact(phrase, 120).split(' ').filter(Boolean)
  /** @type {'m'|'f'|''} */
  let gender = ''
  let index = 0
  const result = [...words]
  for (; index < words.length; index += 1) {
    const lower = words[index].toLocaleLowerCase('ru')
    const rule = lower.length > 4 ? OBLIQUE_ADJECTIVE.find(([ending]) => ending.test(lower)) : null
    if (!rule) break
    if (gender && gender !== rule[2]) return compact(phrase, 120)
    gender = rule[2]
    result[index] = keepCase(words[index], lower.replace(rule[0], rule[1]))
  }
  if (!gender || index >= words.length) return compact(phrase, 120)
  const noun = words[index].toLocaleLowerCase('ru')
  let nominative = ''
  if (gender === 'f') {
    // Однозначно только после шипящих, «ц» и заднеязычных: мельнице, лавке,
    // реке → -а. «Часовне» и «пещере» по одной букве не различить (часовня,
    // пещера), поэтому мягкая основа не угадывается. Винительный: пещеру → -а,
    // деревню → -я.
    if (/[цкгхжшщч]е$/u.test(noun)) nominative = noun.replace(/е$/u, 'а')
    else if (/у$/u.test(noun)) nominative = noun.replace(/у$/u, 'а')
    else if (/ю$/u.test(noun)) nominative = noun.replace(/ю$/u, 'я')
  } else {
    // Склепу, склепа, склепе → склеп; беглая гласная (замку, углу) не угадывается.
    const stem = noun.replace(/[уае]$/u, '')
    const fleeting = /[бвгджзклмнпрстфхцчшщ][кгцлн]$/u.test(stem) && /[кгцлн]$/u.test(stem) && !/[аеёиоуыэюя][кгцлн]$/u.test(stem)
    if (stem !== noun && /[бвгджзклмнпрстфхцчшщ]$/u.test(stem) && !fleeting) nominative = stem
  }
  if (!nominative) return compact(phrase, 120)
  result[index] = keepCase(words[index], nominative)
  return result.join(' ')
}

/**
 * Регистр первой буквы исходного слова переносится на новое.
 * @param {string} original
 * @param {string} replaced
 */
function keepCase(original, replaced) {
  return original.charAt(0) !== original.charAt(0).toLocaleLowerCase('ru')
    ? replaced.charAt(0).toLocaleUpperCase('ru') + replaced.slice(1)
    : replaced
}

/**
 * Пункт назначения для подписи варианта «уходим … и идём …».
 *
 * Прежде подпись подставляла кусок фразы как есть после «в»: «идём в
 * старому фамильному склепу за мельницей», «идём в Кленовка» (живая сессия
 * 2026-10-02). Теперь:
 * - известная точка карты мира — её имя в кавычках: «в «Кленовка»»;
 * - место, названное игроком своими словами, — с его же предлогом и в его
 *   падеже: «к старому фамильному склепу», «в деревню Кленовку»;
 * - иначе — имя в именительном падеже в кавычках.
 * `place` — то же место в именительном падеже, для «бросаем задание».
 * Подпись остаётся разбираемой `classifyPartyDecision`: кавычки и предлоги
 * те же, что понимает `DESTINATION`.
 *
 * @param {string} text исходная фраза игрока или синтезированная заявка
 * @param {string} destination пункт назначения из разбора
 * @param {{ knownPlaces?: unknown, presentNames?: unknown }} [options]
 * @returns {{ phrase: string, place: string }}
 */
export function partyDestinationLabel(text, destination, options = {}) {
  const place = compact(destination, 120).replace(/[«»"]/gu, '').trim()
  if (!place) return { phrase: '', place: '' }
  const known = knownPlaceName(place, exitContext(options).knownPlaces)
  if (known) return { phrase: `в «${known}»`, place: known }
  const nominative = nominativePlacePhrase(place)
  const display = nominative.charAt(0).toLocaleUpperCase('ru') + nominative.slice(1)
  const source = compact(text, 2_000)
  const at = source.toLocaleLowerCase('ru').indexOf(place.toLocaleLowerCase('ru'))
  // Предлог игрока прямо перед названием, без кавычек: фраза уже согласована.
  const preposition = at > 0 ? /(?:^|\s)(в|во|на|к|ко|до)\s+$/iu.exec(source.slice(Math.max(0, at - 6), at))?.[1] : ''
  if (preposition && source.charAt(at - 1) !== '«') return { phrase: `${preposition.toLocaleLowerCase('ru')} ${source.slice(at, at + place.length)}`, place: display }
  return { phrase: `в «${display}»`, place: display }
}

/**
 * Объявляет ли фраза движение отряда куда-либо — без решения, уход ли это.
 * Нужна разбору вида реплики: «Давайте пойдём в порт» и «Может, нам вернуться
 * в Аквилон?» — это заявка, которую дальше рассудит `detectPartyExitRequest` с
 * картой мира, а не обсуждение за столом. Карты на том шаге ещё нет, поэтому
 * спрашивается только форма: глагол ухода или движения с предлогом.
 *
 * @param {unknown} action
 * @returns {boolean}
 */
export function announcesMovement(action) {
  const text = compact(action, 2_000)
  if (!text) return false
  return DESTINATION.test(text) || LEAVE_TARGET.test(text) || BARE_LEAVE.test(text)
    || (LEAVE_VERB.test(text) && EXIT_SCOPE.test(text))
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
