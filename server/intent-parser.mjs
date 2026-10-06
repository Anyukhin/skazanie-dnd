import { affirmativeActionText, classifyNpcSocialCheck } from './npc-social-check.mjs'
import { scenarioKnightActionFromText } from './scenario-knight.mjs'
import { announcesMovement } from './party-exit-intent.mjs'

const CORPSE_SEARCH_VERB = '(?<![\\p{L}\\p{M}])(?:обыск\\p{L}*|провер\\p{L}*|осматр\\p{L}*|ищ\\p{L}*)'
const CORPSE_SEARCH_NOUN = '(?<![\\p{L}\\p{M}])(?:труп(?:а|у|ом|е|ы|ов|ам|ами|ах)?|тел(?:о|а|у|ом|е|ам|ами|ах)?|остан(?:ки|ков|кам|ками|ках)|карман(?:а|у|ом|е|ы|ов|ам|ами|ах)?)(?![\\p{L}\\p{M}])'
const CORPSE_SEARCH_PATTERN = new RegExp(`(?:${CORPSE_SEARCH_VERB})[^.!?]{0,80}(?:${CORPSE_SEARCH_NOUN})|(?:${CORPSE_SEARCH_NOUN})[^.!?]{0,80}(?:${CORPSE_SEARCH_VERB})`, 'iu')

const FREE_ACTION_PATTERNS = Object.freeze([
  ['physically_impossible', /(взлет\w*|взлета\w*|парю\w*|телепорт\w*|останавлива\w*\s+время|дыш\w*\s+под\s+водой|становлюсь\s+невидим\w*|путешеств\w*\s+во\s+времени|fly\b|teleport\w*|stop\s+time|breathe\s+underwater)/iu],
  ['bounded_scene_action', /(подпира\w*|баррикад\w*|поджига\w*|зажига\w*|зову\w*\s+страж|крич\w*\s+страж|связыва\w*|прячу\w*\s+след\w*|заслоня\w*)/iu],
  ['corpse_search', CORPSE_SEARCH_PATTERN],
])

export const REQUEST_KINDS = Object.freeze(['action', 'question', 'discussion'])

/**
 * Ввод игрока приходит из недоверенного клиента. Режим заявки — это только
 * маршрутизация: он не даёт права выполнить команду и не меняет механику.
 */
export function normalizeRequestKind(value) {
  const kind = String(value ?? '').trim().toLocaleLowerCase('en')
  return REQUEST_KINDS.includes(kind) ? kind : 'action'
}

// Хвост `\p{L}*` после основ: прежний шаблон требовал пробел сразу после
// «где наход», и «Где находится таверна?» вопросом не считалось никогда.
const DIRECT_QUESTION_PATTERN = /^(?:а\s+если|если\s+(?:я|мы)(?=[^?]*\?\s*$)|что\s+если|можно\s+ли|могу\s+ли|есть\s+ли|как\s+далеко|что\s+будет|почему|зачем|где\s+(?:наход|стоит|леж)\p{L}*|кто\s+так|сколько|как\s+(?:это|мне|нам))(?:\s|$)/iu
/**
 * Вопрос к ведущему по форме: вопросительное слово в начале и знак вопроса в
 * конце. Обращение на «ты/вы» — реплика собеседнику, а не ведущему, поэтому
 * такие фразы остаются заявкой и уходят в разговор с NPC.
 */
const INTERROGATIVE_QUESTION_PATTERN = /^(?:какой|какая|какое|какие|каков\p{L}*|который|которая|которое|когда|сколько|кто|что|где|куда|откуда|почему|зачем|чей|чья|чьё|чьи|как)(?![\p{L}\p{M}])[^?]{0,200}\?+\s*$/iu
// Вопрос о знаниях героя («что я знаю про…») по-прежнему идёт заявкой: на него
// без вызова модели отвечает Хранитель мира (`answerKnownLore`) прямо в ходе.
/**
 * Просьба к ведущему объяснить мир или обстановку: «Поясни, что это за мир»,
 * «Напомни, где мы». Без шаблона такая фраза считалась действием героя, и
 * сервер «выполнял» её — игрок получал «Вышло.» (реальная фраза из партии,
 * сквозной прогон Асстохана 2026-10-05). Шаблон узкий: просьба «расскажи» к
 * собеседнику в сцене остаётся репликой.
 */
const GM_EXPLAIN_PATTERN = /^(?:поясни|поясните|объясни|объясните|расскажи|расскажите|напомни|напомните|подскажи|подскажите)(?:\s+(?:мне|нам))?[,\s]+(?:что\s+(?:это\s+)?за\s+мир|что\s+это\s+за\s+(?:место|мир)|где\s+(?:мы|я)(?:\s|$|[?.!])|что\s+(?:здесь|тут|сейчас)\s+происходит|что\s+(?:нам|мне)\s+(?:делать|нужно\s+делать)|какая\s+(?:у\s+нас\s+)?цель|как\s+(?:тут\s+)?играть)/iu
const KNOWN_LORE_QUESTION_PATTERN =/(?:что\s+(?:я|мы)\s+(?:уже\s+|вообще\s+)?зна|кто\s+так|что\s+так|помню\s+ли|помним\s+ли)/iu
const SECOND_PERSON_PATTERN =/(?<![\p{L}\p{M}])(?:ты|вы|тебя|вас|тебе|вам|твой|твоя|твоё|ваш|ваша|ваше)(?![\p{L}\p{M}])/iu
/** Реплика вне игры: «(ooc) …», «((…))», «// вне игры». */
const OUT_OF_CHARACTER_PATTERN = /^(?:\(\(|\(\s*(?:ooc|оос|офф|офтоп|вне\s+игры)\s*\)|\/\/|(?:ooc|оос|офф)[:\s]|вне\s+игры[:,\s])/iu
/**
 * Обращение к своему отряду: «Ребята, …», «Ты со мной?». Имя героя-соседа без
 * состояния не отличить от имени NPC, поэтому узнаётся только форма «ты со
 * мной / вы с нами».
 */
const PARTY_ADDRESS_PATTERN = /^(?:ребята|народ|друзья|парни|братцы|команда|отряд)[,!]\s/iu
const PARTY_COMPANY_QUESTION_PATTERN = /^(?:[\p{L}-]+,\s*)?(?:ты|вы)\s+(?:(?:идёшь|идешь|идёте|идете|пойдёшь|пойдешь|пойдёте|пойдете)\s+)?(?:со\s+мной|с\s+нами)(?:\s+[^?]{0,80})?\?\s*$/iu
const SCENE_OBSERVATION_PATTERN = /^(?:где\s+(?:я|мы)(?:\s+сейчас)?(?:\s+наход(?:имся|юсь))?(?:\s+сейчас)?|что\s+(?:я\s+)?вижу(?:\s+(?:здесь|вокруг|перед\s+собой))?|что\s+(?:здесь|вокруг)\s+есть|что\s+находится\s+(?:здесь|вокруг|перед\s+собой)|что\s+вокруг\s+(?:меня|нас)|кто\s+(?:здесь|рядом)|опиши\s+(?:сцену|место|обстановку))\s*[?!]?$/iu
// «Предлагаю» — предложение отряду, только если дальше идёт «нам/всем» или
// инфинитив: «Предлагаю переночевать здесь». «Предлагаю Кларе монету» — это
// подкуп собеседника, заявка, а не болтовня за столом.
const PARTY_PROPOSAL_PATTERN = /^(?:давайте|предлагаю(?=[\s,]*$|[\s,]+(?:нам|всем|вам|ребят\p{L}*|отряду|\p{L}+(?:ть|ться|ти|чь)(?![\p{L}\p{M}])))|может,?\s+(?:нам|мы)|стоит\s+(?:ли\s+)?нам)(?:[\s,]|$)/iu
/** «А какая погода?», «Ну и который час?» — частица в начале не меняет вопроса. */
const LEADING_PARTICLE_PATTERN = /^(?:а|и|ну|так|слушай|скажи|подскажи(?:те)?)(?:\s+и)?[\s,]+/iu
const EXPLICIT_NPC_SPEECH_PATTERN = /^(?:спрашиваю|спрашиваем|говорю|говорим|обращаюсь|обращаемся|прошу|просим)(?:\s|$)/iu
/**
 * Глаголы разговора в начале реплики: «Разговариваю с Борисом…», «Узнаю у
 * Марты…», «Здороваюсь с Финном». Без них такие фразы уходили к судье свободных
 * действий и превращались в проверку Убеждения вместо разговора. Торговля
 * текстом — тоже разговор с торговцем: механическая покупка идёт карточкой
 * торговца, а не проверкой навыка.
 */
const SPOKEN_OPENING_PATTERN = /^(?:я\s+)?(?:расспрашиваю|расспрашиваем|разговариваю|разговариваем|беседую|беседуем|заговариваю|заговариваем|болтаю|болтаем|узна(?:ю|ём|ем)\s+у|интересу(?:юсь|емся)\s+у|здорова(?:юсь|емся)|приветствую|приветствуем|благодарю|благодарим|рассказываю|рассказываем|торгу(?:юсь|емся)|покупа(?:ю|ем)|прода(?:ю|ём|ем)|куплю|хочу\s+купить)(?![\p{L}\p{M}])/iu
/**
 * Удар по неживому — жест, а не атака: «бью кулаком по столу», «рублю верёвку
 * люстры». Цели для атаки в них нет, и прежде такие фразы упирались в вопрос
 * «кого атаковать?».
 */
const INANIMATE_STRIKE_PATTERN = /(?<![\p{L}\p{M}])(?:бью|ударяю|стучу|колочу)\s+(?:\p{L}+\s+)?по\s+(?:стол\p{L}*|стен\p{L}*|двер\p{L}*|пол[уе]|стойк\p{L}*|бочк\p{L}*|сундук\p{L}*)|(?<![\p{L}\p{M}])(?:рублю|перерубаю|разрубаю)\s+(?:\p{L}+\s+)?(?:верёвк|веревк|канат|цеп|трос)\p{L}*/iu
/**
 * Слова обмана и уговора с границами. `classifyNpcSocialCheck` сравнивает
 * подстроки, и «вручаю» находило в себе «вру», а «долгую» — «лгу»: передача
 * письма и долгая передышка становились проверкой Обмана.
 */
const DECEPTION_WORD_PATTERN = /(?<![\p{L}\p{M}])(?:обман\p{L}*|лгу|лж[её]\p{L}*|солг\p{L}*|вру|врать|навр\p{L}*|совр\p{L}*|блеф\p{L}*|выдаю\s+себя|deceiv\p{L}*|lie|bluff\p{L}*)(?![\p{L}\p{M}])/iu
const PERSUASION_FALSE_FRIEND_PATTERN = /(?<![\p{L}\p{M}])склоня(?:юсь|емся)(?![\p{L}\p{M}])/iu
const ACTION_LIKE_GROUP_PATTERN = /(?:покида|покин|уходим|уйти|маршрут|голосован|переговор|перемир|сдавайт)/iu
const EXPLICIT_CHECK_PATTERN = /(?<![\p{L}\p{M}])(?:проверк[ауи]|спасброс\p{L}*|check|save)(?![\p{L}\p{M}])|проверяю\s+(?:сил|ловк|мудр|интел|харизм|телослож|скрыт|атлет|акробат)/iu

/** Безопасный fallback для клиентов, которые ещё не передают request_kind. */
export function inferRequestKind(value) {
  const raw = normalizedText(value)
  const text = LEADING_PARTICLE_PATTERN.test(raw) && raw.replace(LEADING_PARTICLE_PATTERN, '').length >= 3
    ? raw.replace(LEADING_PARTICLE_PATTERN, '')
    : raw
  if (!text || EXPLICIT_NPC_SPEECH_PATTERN.test(text) || SPOKEN_OPENING_PATTERN.test(text)) return 'action'
  if (OUT_OF_CHARACTER_PATTERN.test(text) || PARTY_COMPANY_QUESTION_PATTERN.test(text)) return 'discussion'
  if (DIRECT_QUESTION_PATTERN.test(text) || DIRECT_QUESTION_PATTERN.test(raw) || SCENE_OBSERVATION_PATTERN.test(text) || GM_EXPLAIN_PATTERN.test(text) || GM_EXPLAIN_PATTERN.test(raw)) return 'question'
  if (INTERROGATIVE_QUESTION_PATTERN.test(text) && !SECOND_PERSON_PATTERN.test(text)
    && !KNOWN_LORE_QUESTION_PATTERN.test(text)) return 'question'
  // Предложение отряду куда-то пойти — заявка: дальше её рассудит карточка ухода
  // по карте мира. «Давайте пойдём в порт» раньше оставалось болтовнёй за столом.
  if ((PARTY_PROPOSAL_PATTERN.test(text) || PARTY_ADDRESS_PATTERN.test(text))
    && !ACTION_LIKE_GROUP_PATTERN.test(text) && !announcesMovement(text)) return 'discussion'
  return 'action'
}

/** Явный вопрос о видимой части текущей сцены, без проверки или траты хода. */
export function isSceneObservationRequest(value) {
  return SCENE_OBSERVATION_PATTERN.test(normalizedText(value))
}

// Шаблоны намерений тоже привязаны к началу слова: без границы `долг` ловил
// «долго», `тон` — «стоном», а `rest` — любое английское слово с этой
// подстрокой, и обычная фраза уезжала в отдых или в проверку Силы.
const W = '(?<![\\p{L}\\p{M}])'
/**
 * Ожидание до часа суток: «ждём до полуночи», «дожидаемся рассвета». Цель —
 * минута суток по часам мира (`server/weather.mjs`), подпись — родительный
 * падеж для ответа «Отряд ждёт до полуночи».
 */
const WAIT_TARGETS = Object.freeze([
  Object.freeze({ id: 'midnight', minute: 0, label: 'полуночи', pattern: /полуноч/iu }),
  Object.freeze({ id: 'dawn', minute: 300, label: 'рассвета', pattern: /рассвет|утр[аео]|зар[иеюя]/iu }),
  Object.freeze({ id: 'noon', minute: 720, label: 'полудня', pattern: /полудн|полден/iu }),
  Object.freeze({ id: 'dusk', minute: 1_020, label: 'вечера', pattern: /закат|вечер|сумер/iu }),
  Object.freeze({ id: 'night', minute: 1_320, label: 'ночи', pattern: /ноч[иь]|темнот|стемне/iu }),
])
const WAIT_PATTERN = /(?<![\p{L}\p{M}])(?:жд(?:ём|ем|у|ать|ёт|ут)|подожд\p{L}*|дожида\p{L}*|дождать\p{L}*|дождём\p{L}*|дождемся|выжида\p{L}*|пережида\p{L}*|переждать|караул\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,30}(?:полуноч|рассвет|утр[аео]|зар[иеюя]|полудн|полден|закат|вечер|сумер|ноч[иь]|темнот|стемне)/iu

/** Цель ожидания в тексте игрока или `null`: «ждём до полуночи» → полночь. */
export function waitTargetFromText(value) {
  const text = normalizedText(value)
  if (!WAIT_PATTERN.test(text)) return null
  const target = WAIT_TARGETS.find((entry) => entry.pattern.test(text))
  return target ? { id: target.id, minute: target.minute, label: target.label } : null
}

const INTENT_PATTERNS = [
  ['why', /^\s*\/why\b/i],
  ['wait', WAIT_PATTERN],
  ['attack', new RegExp(`${W}(атак|удар|бью|стреля|выстрел|рублю|колю|attack|shoot|strike)`, 'iu')],
  ['saving_throw', new RegExp(`${W}(спасброс|saving\\s*throw|save)`, 'iu')],
  ['improvised_action', FREE_ACTION_PATTERNS[0][1]],
  ['improvised_action', FREE_ACTION_PATTERNS[1][1]],
  ['improvised_action', FREE_ACTION_PATTERNS[2][1]],
  // Внимательность и поиск названы прямо: «прислушиваюсь», «рассматриваю»,
  // «изучаю руны», «ищу следы». Без них фраза уходила к судье свободных
  // действий, и ту же проверку назначала модель. Только личные формы:
  // инфинитив «обыскать/изучить сундук» — команда пропса сцены
  // (`sceneObjectOperationFromText`), и её ветка стоит на пути свободного
  // действия; перехватывать её проверкой навыка нельзя. По той же причине
  // «отдохнуть» не стало отдыхом: «отдохнуть на кровати» — пропс.
  ['ability_check', new RegExp(`${W}(провер|пытаюсь|исслед|осматр|осмотр|рассматр|разгляд|высматр|прислуш|изуча|обыскива(?:ю|ем)|крадусь|взлом|убежд|выбираюсь|выплыв|плыву|тону|утоп|ищу\\s+(?:\\p{L}+\\s+)?(?:след|улик|тайник|ловушк|подсказ|зацепк)|check|swim|drown)`, 'iu')],
  // Заклинание — раньше лечения: «накладываю заклинание Лечение ран» — это
  // заклинание со своим обработчиком, а не лечение без источника.
  ['cast_spell', new RegExp(`${W}(каст|заклин|сотвор|колду|spell)`, 'iu')],
  ['healing', new RegExp(`${W}(леч|исцел|восстанов\\p{L}*\\s+хит|heal)`, 'iu')],
  ['damage', /(получает?\s+урон|нанести\s+урон|damage)/iu],
  ['start_combat', /(начать\s+бой|инициатив|start\s+combat)/iu],
  ['end_combat', /((законч|заверш|прекрат)\p{L}*\s+бой|бой\s+(окончен|заверш[её]н)|end\s+combat)/iu],
  ['end_turn', /^\s*(заканчиваю\s+ход|конец\s+хода|end\s+turn)\s*[.!]?\s*$/iu],
  ['rest', new RegExp(`${W}(коротк\\p{L}*\\s+отдых|долг\\p{L}*\\s+отдых|привал|отдых|отдыха|отдохн(?:ём|ем|у)(?![\\p{L}\\p{M}])|передохн|передышк|rest)`, 'iu')],
  ['social', new RegExp(`${W}(говор|убежд|обман|запуг|спраш|расспраш|переговор|разговарива|беседу|заговарива|здорова|приветству|благодар|рассказыва|узна\\p{L}*\\s+у|интересу\\p{L}*\\s+у|торгу(?:юсь|емся|ться)|флирт|кокетнича|очаровыва|подкуп|предлага\\p{L}*\\s+[^.!?]{0,60}(?:монет|деньг|серебр|золот|взятк)|купить\\s+у|куплю\\s+у|покупа\\p{L}*\\s+у|прода(?:ю|ём|ем|ть))`, 'iu')],
  ['explore', new RegExp(`${W}(осматр|исслед|иду|двига|открыва|ищу|слуша)`, 'iu')],
]

export function classifyFreeActionKind(value) {
  const text = normalizedText(value)
  // Удар после прыжка нельзя молча сократить до обычной атаки: заявка
  // содержит перемещение, которого одиночный эффект импровизации не исполняет.
  const leap = /(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|спрыг|перескоч)/iu
  const strike = /(?<![\p{L}\p{M}])(?:атак|удар|бью|бить|стреля|выстрел|рублю|колю|попасть\s+по|attack|shoot|strike)/iu
  if (leap.test(text) && strike.test(text)) return 'compound_maneuver'
  if (/(?<![\p{L}\p{M}])(?:подхож|подой|подбег|подбеж|приближа|приближусь|добег|добеж|иду\s+к)/iu.test(text) && strike.test(text)) {
    return /(?<![\p{L}\p{M}])(?:стреля|выстрел|shoot)/iu.test(text) ? 'compound_ranged_attack' : 'approach_attack'
  }
  return FREE_ACTION_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, 2000)
}

/** Явный порядок шагов сохраняется до подтверждения; результат шага нельзя угадать. */
export function actionSequence(value) {
  const text = normalizedText(value)
  const parts = text.split(/\s*(?:[;.]\s*|,?\s+)(?:затем|потом|после\s+этого)\s+/iu)
    .map(part => part.replace(/^сначала\s+/iu, '').trim())
    .flatMap(part => /^(?:подхожу|иду|приближаюсь)\s+к\s+/iu.test(part)
      ? part.split(/\s+и\s+(?=(?:спрашиваю|прошу|расспрашиваю|открываю|закрываю|передаю|сверяю)\s)/iu) : [part])
    .filter(Boolean)
  return parts.length > 1 && parts.length <= 6 ? parts : []
}

function uniqueActorsById(candidates) {
  const actors = new Map()
  for (const actor of candidates) {
    const id = String(actor?.id ?? '')
    if (id && !actors.has(id)) actors.set(id, actor)
  }
  return [...actors.values()]
}

function visibleActors(visibleState) {
  const candidates = [
    ...(Array.isArray(visibleState?.players) ? visibleState.players : []),
    ...(Array.isArray(visibleState?.actors) ? visibleState.actors : []),
    ...(Array.isArray(visibleState?.enemies) ? visibleState.enemies : []),
    ...(Array.isArray(visibleState?.social?.npcs) ? visibleState.social.npcs : []),
    ...(Array.isArray(visibleState?.merchants) ? visibleState.merchants : []),
  ]
  return uniqueActorsById(candidates)
}

function namesFor(actor) {
  const names = [
    actor?.id,
    actor?.name,
    actor?.character,
    actor?.label,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
  // Для составного имени вроде «Король Арес» последняя часть — обычное имя,
  // а не новый рольовой alias. Добавляем её в общий индекс упоминаний, чтобы
  // «Ареса» и «Аресу» находили того же NPC; неоднозначные совпадения по-прежнему
  // возвращаются всеми кандидатами и требуют уточнения выше по стеку.
  const humanNames = [
    actor?.name,
    actor?.character,
    actor?.label,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
  const trailingNameTokens = humanNames.flatMap((value) => {
    const tokens = wordTokens(value)
    const last = tokens.at(-1)
    return tokens.length > 1 && last && !/^\d+$/u.test(last) ? [last] : []
  })
  return [...new Set([...names, ...trailingNameTokens].filter(Boolean))]
}

function wordTokens(value) {
  return String(value ?? '').toLocaleLowerCase('ru').match(/\p{L}[\p{L}\p{M}]*|\d+/gu) ?? []
}

function sameNameToken(left, right) {
  if (left === right) return true
  if (/^\d+$/u.test(left) || /^\d+$/u.test(right)) return false
  if (!/^[а-яё]{3,}$/u.test(left) || !/^[а-яё]{3,}$/u.test(right)) return false
  const stem = (value) => {
    if (value.endsWith('ь') && value.length > 3) return value.slice(0, -1)
    for (const suffix of ['иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ах', 'ях', 'ой', 'ей', 'ом', 'ем', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и']) {
      if (value.endsWith(suffix) && value.length - suffix.length >= 3) return value.slice(0, -suffix.length)
    }
    return value
  }
  return stem(left) === stem(right)
}

function mentionsName(message, name) {
  const normalized = String(name ?? '').toLocaleLowerCase('ru')
  // Имя — целым словом: подстрокой короткое «Ив» сидит в «спрашиваю», «Ян» —
  // в «янтаре», и реплика уходила не тому собеседнику.
  if (normalized.length >= 2 && new RegExp(`(?<![\\p{L}\\p{M}])${normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{M}])`, 'u').test(message)) return true
  const messageWords = wordTokens(message)
  const nameWords = wordTokens(normalized)
  return nameWords.length > 0 && nameWords.every((word) => messageWords.some((candidate) => sameNameToken(word, candidate)))
}

function mentionedActors(message, state) {
  const lower = message.toLocaleLowerCase('ru')
  return visibleActors(state).filter((actor) => namesFor(actor).some((name) => mentionsName(lower, name)))
}

const ROLE_ALIASES = Object.freeze({
  merchant: ['торговец', 'торговц', 'лавочник', 'продавец', 'продавц'],
  innkeeper: ['трактирщик', 'хозяин трактира', 'хозяйка трактира'],
  guard: ['стражник', 'страж', 'охранник'],
  healer: ['лекарь', 'целитель'],
  blacksmith: ['кузнец'],
})

function socialAliasesFor(actor) {
  const role = String(actor?.role ?? '').trim()
  const tags = (Array.isArray(actor?.tags) ? actor.tags : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && !value.includes(':'))
  const translated = [...new Set([role, ...tags].flatMap((value) => (
    ROLE_ALIASES[value.toLocaleLowerCase('ru')] ?? []
  )))]
  return [...new Set([
    ...namesFor(actor),
    role,
    ...tags,
    ...translated,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function presentSocialActors(visibleState) {
  const location = String(visibleState?.scene?.location ?? '').trim().toLocaleLowerCase('ru')
  const candidates = [
    ...(Array.isArray(visibleState?.social?.npcs) ? visibleState.social.npcs : []),
    ...(Array.isArray(visibleState?.merchants) ? visibleState.merchants : []),
  ]
  return uniqueActorsById(candidates)
    .filter((actor) => actor?.available !== false)
    .filter((actor) => {
      const actorLocation = String(actor?.location ?? '').trim().toLocaleLowerCase('ru')
      return !location || !actorLocation || actorLocation === location
    })
}

/**
 * Сопоставление собеседника ограничено видимой текущей сценой. Точное имя или
 * явный alias имеют приоритет над ролью; одинаковая роль у двух NPC остаётся
 * неоднозначной и не превращается в молчаливый выбор первого.
 */
export function resolvePresentSocialActors(message, visibleState) {
  const lower = normalizedText(message).toLocaleLowerCase('ru')
  const scored = presentSocialActors(visibleState).map((actor) => {
    const properNames = namesFor(actor)
    const roleAliases = socialAliasesFor(actor).filter((alias) => !properNames.includes(alias))
    const fullNames = [actor.name, actor.character, actor.label].filter(Boolean)
    const firstNames = fullNames.map(name => wordTokens(name)).filter(words => words.length > 1).map(words => words[0])
    const score = fullNames.some(name => mentionsName(lower, name))
      ? 3
      : properNames.some((name) => mentionsName(lower, name))
        ? 2
        : firstNames.some(name => mentionsName(lower, name)) ? 1.5
      : roleAliases.some((alias) => mentionsName(lower, alias))
        ? 1
        : Math.max(0, ...roleAliases.map((alias) => roleHeadScore(lower, alias)))
    return { actor, score }
  }).filter((entry) => entry.score > 0)
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  return scored.filter((entry) => entry.score === best).map((entry) => entry.actor)
}

const ROLE_ADJECTIVE = /(?:ая|яя|ый|ий|ой|ое|ее|ые|ие)$/u

/**
 * Одно слово роли в другой форме: «смотрителю» и «смотрительница», «посреднику»
 * и «посредник». Падежная `sameNameToken` род не сводит, поэтому здесь —
 * общий корень длиной почти во всё короткое слово.
 */
function sameRoleWord(left, right) {
  if (sameNameToken(left, right)) return true
  if (left.length < 5 || right.length < 5) return false
  let common = 0
  while (common < left.length && common < right.length && left[common] === right[common]) common += 1
  return common >= 6 && common >= Math.min(left.length, right.length) - 3
}

/**
 * Роль целиком игрок называет редко: в сцене «старшая смотрительница дамбы»,
 * а в реплике — «подхожу к смотрителю дамбы». Главное слово роли — первое
 * существительное после прилагательных; совпало оно — собеседник найден,
 * совпало ещё и уточнение («дамбы») — найден увереннее. Двое с тем же главным
 * словом остаются неоднозначными, как и прежде. Живой прогон 2026-10-02.
 *
 * @param {string} lowerMessage
 * @param {string} alias
 */
function roleHeadScore(lowerMessage, alias) {
  const roleWords = wordTokens(alias).filter((word) => /^[а-яё]+$/u.test(word))
  const headIndex = roleWords.findIndex((word) => word.length >= 4 && !ROLE_ADJECTIVE.test(word))
  if (headIndex < 0) return 0
  const messageWords = wordTokens(lowerMessage)
  if (!messageWords.some((word) => sameRoleWord(roleWords[headIndex], word))) return 0
  const qualifiers = roleWords.slice(headIndex + 1).filter((word) => word.length >= 4)
  return qualifiers.some((word) => messageWords.some((candidate) => sameRoleWord(word, candidate))) ? 0.8 : 0.6
}

/**
 * Обращение по титулу вместо имени: «Ваше величество, какое поручение…» —
 * реплика королю, хотя ни имени, ни роли в ней нет. Без этого фраза уходила в
 * импровизацию, а целью становился тот, о ком спрашивают (прогон Асстохана
 * 2026-10-04: «…что известно о Саргате?» — цель Саргат).
 */
const HONORIFIC_ADDRESSES = Object.freeze([
  [/^ваш[ае]\s+(?:королевское\s+)?величеств/iu, /(?<![\p{L}\p{M}])(?:корол|королев|цар|импер|monarch|king|queen)/iu],
  [/^ваш[ае]\s+высочеств/iu, /(?<![\p{L}\p{M}])(?:принц|принцесс|княж|наследни|prince|princess)/iu],
  [/^ваш[ае]\s+(?:светлость|сиятельство)/iu, /(?<![\p{L}\p{M}])(?:герцог|граф|князь|княгин|лорд|леди|duke|count|lord|lady)/iu],
])

function honorificAddressedActors(address, visibleState) {
  const role = HONORIFIC_ADDRESSES.find(([pattern]) => pattern.test(address.trim()))?.[1]
  if (!role) return []
  return presentSocialActors(visibleState).filter((actor) => [actor.name, actor.character, actor.role, ...(Array.isArray(actor.tags) ? actor.tags : [])]
    .some((value) => role.test(String(value ?? ''))))
}

function directlyAddressedActors(message, visibleState) {
  const address = /^([\p{L}\p{M} -]{2,80})[:,]\s*\S/iu.exec(message)?.[1]
  if (!address) return []
  const honorific = honorificAddressedActors(address, visibleState)
  if (honorific.length) return honorific
  const words = wordTokens(address)
  return presentSocialActors(visibleState).filter(actor => {
    const names = [...socialAliasesFor(actor), wordTokens(actor.name)[0]].filter(Boolean)
    return names.some(name => {
      const tokens = wordTokens(name)
      return tokens.length === words.length && tokens.every((token, index) => sameNameToken(token, words[index]))
    })
  })
}

/**
 * Подходы распознаются по началу слова. Раньше шаблоны были подстроками без
 * границы, и «сломанные вёсла» попадали в `лома` → проверка Силы, а «дверь со
 * стоном» — в `тон`. Осмотр и поиск проверяются раньше силовых глаголов:
 * «осматриваю сломанные вёсла» — это Внимательность, а не попытка что-то
 * сдвинуть.
 */
const APPROACH_PATTERNS = Object.freeze([
  // Разобрать бумагу, карту, печать или механизм — Расследование (Инт), а не
  // зоркость: ведущий спросит «что ты ищешь в записи?», а не «что ты видишь».
  ['investigation', /(?<![\p{L}\p{M}])(?:осматр|осмотр|разгляд|рассматр|изуча|исслед|ищу|сверя|читаю|вчитыва)\p{L}*[^.!?]{0,40}(?<![\p{L}\p{M}])(?:карт|запис|журнал|документ|письм|надпис|печат|бумаг|свит|книг|накладн|механизм|замок|замк|шифр)/iu],
  // Чей-то след на местности — человека, зверя, телеги — читает Выживание
  // (Мдр). «Ищу следы» без хозяина следа остаётся Внимательностью.
  ['survival', /(?<![\p{L}\p{M}])(?:иду\s+по\s+след\p{L}*|след\p{L}*\s+(?:\p{L}+\s+){0,2}(?:пропавш|человек|люд|зверя|звер|лошад|коня|отряд|беглец|повозк|телег|колёс|колес|сапог|ног)|след\p{L}*\s+(?:у|возле|около|под|вокруг|на\s+(?:земл|дорог|снег|грязи|траве|тропе|берегу))(?![\p{L}\p{M}]))/iu],
  ['perception', /(?<![\p{L}\p{M}])(осматр|осмотр|разгляд|рассматр|высматр|замеч|заметить|ищу|искать|поиск|обыск|прислуш|слуша|следы?|улик)/iu],
  ['arcana', /(?<![\p{L}\p{M}])(маги|магич|рун|заклинан|чароде|arcan)/iu],
  ['stealth', /(?<![\p{L}\p{M}])(крад|тихо|тихонь|скрыт|прячу|прятать|незамет|stealth|sneak)/iu],
  ['persuasion', /(?<![\p{L}\p{M}])(убежд|уговар|угово|диплом|persuad)/iu],
  ['intimidation', /(?<![\p{L}\p{M}])(запуг|угрож|припуг|intimidat)/iu],
  ['strength', /(?<![\p{L}\p{M}])(плыв|плава|тону|утоп|выламыв|ломаю|сломать|взлома|толка|толкаю|поднима|подним|тащ|оттаск|силой|swim|drown|shove|lift)/iu],
])

/**
 * Социальный навык из `classifyNpcSocialCheck`, перепроверенный по целым
 * словам там, где подстрока ложно срабатывает.
 *
 * @param {string|null} skill
 * @param {string} text
 */
function boundedSocialSkill(skill, text) {
  if (skill === 'deception' && !DECEPTION_WORD_PATTERN.test(text)) return null
  if (skill === 'persuasion' && PERSUASION_FALSE_FRIEND_PATTERN.test(text)
    && !/(?:убежд|уговар|диплом|persuad|convinc|negotiate)/iu.test(text)) return null
  return skill
}

/**
 * Наблюдение за человеком в сцене — чтение его реакции, то есть
 * Проницательность к собеседнику, а не свободная импровизация: «Наблюдаю за
 * королём Аресом, когда маршал произносит имя Вулканиса» дважды подряд
 * получало «я не понял способ действия» (прогон Асстохана 2026-10-04).
 * Человек должен стоять сразу за глаголом: «наблюдаю за воротами, пока
 * стражник отвернулся» — это Внимательность к воротам, а не к стражнику.
 */
const WATCH_PERSON_PATTERN = /(?<![\p{L}\p{M}])(?:наблюда\p{L}*|присматрива\p{L}*|приглядыва\p{L}*|всматрива\p{L}*|вглядыва\p{L}*|слежу|следим|следить)(?:\s+(?:внимательно|пристально|молча|украдкой|исподтишка))?\s+(?:за|к|в)\s+([^,.!?;:]{2,60})/iu

function watchedSocialActors(text, visibleState) {
  const watched = WATCH_PERSON_PATTERN.exec(text)?.[1]
  return watched ? resolvePresentSocialActors(watched, visibleState) : []
}

function inferApproach(message) {
  return APPROACH_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unspecified'
}

export class IntentParser {
  async parse({ message, playerId, visibleState }) {
    const text = normalizedText(message)
    if (!text) return {
      actor_id: String(playerId ?? ''), intent: 'unknown', approach: 'unspecified', targets: [],
      mentioned_entities: [], missing_information: ['message'], requires_clarification: true, confidence: 0,
      free_action_kind: null,
    }
    const operativeText = affirmativeActionText(text)
    const watchedActors = watchedSocialActors(operativeText, visibleState)
    const socialSkill = boundedSocialSkill(classifyNpcSocialCheck(text), text) ?? (watchedActors.length ? 'insight' : null)
    const freeActionKind = classifyFreeActionKind(operativeText)
    const addressedActors = directlyAddressedActors(text, visibleState)
    const spoken = addressedActors.length > 0 || EXPLICIT_NPC_SPEECH_PATTERN.test(text) || SPOKEN_OPENING_PATTERN.test(text)
    // Цель в придаточном («…, чтобы осмотреть двор сверху») — не само
    // действие: «забираюсь на крышу, чтобы осмотреться» — это лазание, и
    // судить его должна Атлетика, а не Внимательность.
    const mainClause = operativeText.split(/,?\s+(?:чтобы|дабы)\s+/u)[0]
    const rawPatternIntent = INTENT_PATTERNS.find(([, pattern]) => pattern.test(operativeText))?.[0] ?? 'improvised_action'
    const checkPattern = INTENT_PATTERNS.find(([name]) => name === 'ability_check')?.[1]
    const patternIntent = rawPatternIntent === 'ability_check' && mainClause !== operativeText && checkPattern && !checkPattern.test(mainClause)
      ? 'improvised_action'
      : rawPatternIntent
    // Действие с проклятым рыцарем сценария («ставлю голову перед рыцарем»,
    // «молюсь об упокоении Каэлана») — своя серверная команда, а не реплика:
    // иначе фраза с именем уходила бы в разговор, и голова оставалась у героя.
    const knightAction = scenarioKnightActionFromText(operativeText)
    const detectedIntent = knightAction ? 'scenario_knight'
      : spoken ? 'social'
      : freeActionKind === 'compound_maneuver' ? 'compound_maneuver'
      : freeActionKind === 'compound_ranged_attack' ? 'improvised_action'
      : freeActionKind === 'approach_attack' ? 'approach_attack'
      : socialSkill ? 'social'
      : patternIntent === 'attack' && INANIMATE_STRIKE_PATTERN.test(operativeText) ? 'improvised_action'
      : patternIntent
    // «Проверяю, не следят ли за нами»: отрицание в придаточном снимается
    // вместе с тем словом, по которому узнаётся Внимательность. Для уже
    // опознанной проверки подход ищется и в полном тексте.
    const operativeApproach = inferApproach(mainClause)
    const approach = socialSkill ?? (operativeApproach === 'unspecified' && detectedIntent === 'ability_check'
      ? inferApproach(text)
      : operativeApproach)
    // Свободная задумка вроде «пытаюсь поймать шишку ртом» не должна
    // превращаться в проверку Мудрости только из-за глагола «пытаюсь».
    // Явно запрошенная проверка сохраняет обычный маршрут арбитра.
    const intent = detectedIntent === 'ability_check'
      && approach === 'unspecified'
      && !EXPLICIT_CHECK_PATTERN.test(text)
      ? 'improvised_action'
      : detectedIntent
    const socialTargets = intent === 'social'
      ? addressedActors.length ? addressedActors : watchedActors.length ? watchedActors : resolvePresentSocialActors(text, visibleState)
      : []
    const mentioned = intent === 'social' && socialTargets.length ? socialTargets : mentionedActors(text, visibleState)
    const targets = mentioned.map((actor) => String(actor.id)).filter((id) => id !== String(playerId ?? ''))
    const requiresTarget = intent === 'attack' || intent === 'damage' || intent === 'approach_attack' || intent === 'compound_maneuver'
    const ambiguousSocialTarget = intent === 'social' && socialTargets.length > 1
    const missing = [
      ...(requiresTarget && !targets.length ? ['target_id'] : []),
      ...(ambiguousSocialTarget ? ['ambiguous_npc'] : []),
      ...(['approach_attack', 'compound_maneuver'].includes(intent) && targets.length > 1 ? ['target_id'] : []),
    ]
    const number = /(?:^|\s)(\d{1,3})(?:\s|$)/.exec(text)?.[1]
    return {
      actor_id: String(playerId ?? ''),
      intent,
      approach,
      targets,
      mentioned_entities: mentioned.map((actor) => String(actor.id)),
      numeric_value: number ? Number(number) : null,
      raw_message: text,
      missing_information: missing,
      requires_clarification: missing.length > 0,
      confidence: intent === 'improvised_action' ? 0.45 : missing.length ? 0.55 : 0.86,
      free_action_kind: freeActionKind,
      ...(knightAction ? { scenario_knight: knightAction } : {}),
      ...( /нелеталь|не\s+убив|не\s+убива|без\s+убийств/iu.test(text) || /оглуш|нокаут/iu.test(operativeText) ? { knock_out: true } : {}),
      ...(ambiguousSocialTarget ? {
        target_candidates: socialTargets.map((actor) => ({
          id: String(actor.id),
          name: String(actor.name ?? actor.id),
          role: String(actor.role ?? ''),
        })),
      } : {}),
    }
  }
}

export function buildRuleQueries(intent, state) {
  const queries = [intent?.raw_message, intent?.intent, intent?.approach]
  if (intent?.intent === 'attack') queries.push('attack roll armor class damage advantage disadvantage')
  if (intent?.intent === 'saving_throw') queries.push('saving throw')
  if (intent?.intent === 'healing') queries.push('healing hit points zero hit points')
  if (intent?.intent === 'cast_spell') queries.push('spellcasting concentration resource')
  if (intent?.intent === 'end_combat') queries.push('combat initiative turn order end combat')
  if (/плыв|вод|тон\w*|удуш|swim|drown|suffocat/iu.test(intent?.raw_message ?? '')) queries.push('swimming rough water suffocation hazard exhaustion')
  if (state?.mechanics?.combat?.active) queries.push('combat turn action bonus action reaction')
  return [...new Set(queries.map(normalizedText).filter(Boolean))]
}
