// Эталоны `server/party-exit-intent.mjs` для Rust-переноса (`sk-scenario`).
//
// Фразы: живые корпуса `eval/player-phrases.json`, `eval/playtest-dead-ends.json`,
// `eval/intent-routing-*.json`, строки из тестов маршрутизации ввода и
// сгенерированные вариации «глагол + предлог + место + хвост». Каждая фраза
// прогоняется через все функции разбора с одним из контекстов карты мира;
// выход JS пишется рядом — Rust-тест сравнивает его целиком.
//
// Запуск: node rust/crates/sk-scenario/fixtures/gen-party-exit-intent.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)
const intent = await import(new URL('server/party-exit-intent.mjs', root).href)
const { fixtureState } = await import(new URL('eval/intent-routing-eval-2026-10-01.mjs', root).href)
const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)

const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))

/** Детерминированный генератор: mulberry32. */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(20261013)
const pick = (list) => list[Math.floor(random() * list.length)]

// ---------- контексты карты мира ----------

const veldburg = {
  scene: { title: 'Кусок дерева на площади', location: 'Вельдбург', objective: 'Исследовать кусок дерева на площади и понять его значение' },
  social: { npcs: [{ id: 'npc:mara', name: 'Мара Трижды-Мерная', role: 'старшая смотрительница дамбы', location: 'Вельдбург', visibility: 'public' }] },
  worldMemory: { quests: [{ id: 'quest:main', title: 'Колокол под водой', status: 'active' }] },
  worldMap: {
    currentLocationId: 'veld',
    locations: [
      { id: 'veld', name: 'Вельдбург', known: true },
      { id: 'gates', name: 'Солёные Ворота', known: true },
      { id: 'koegs', name: 'Три Кёга', known: true },
      { id: 'secret', name: 'Тайный грот', known: false },
    ],
  },
}
const hero = { id: 'scenario-hero', character: 'Испытатель', name: 'Игрок', role: 'Воин · ур. 7', species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30 }
const astohan = await new CampaignBootstrapper().create({ code: 'FIXTURE-EXIT', worldTemplateId: 'astohan-plains', players: [hero] })
const tides = await new CampaignBootstrapper().create({ code: 'FIXTURE-TIDES', worldTemplateId: 'league-nine-tides', players: [hero] })

/** Только поля, которые читает `exitContextFromState`: состояние кампании велико. */
function project(state) {
  const pickActor = (actor) => (actor && typeof actor === 'object' ? Object.fromEntries(['name', 'location', 'alive', 'available'].filter((key) => key in actor).map((key) => [key, actor[key]])) : actor)
  const result = {}
  if (state.scene) result.scene = { location: state.scene.location }
  if (state.worldMap) result.worldMap = { locations: (state.worldMap.locations ?? []).map((entry) => (entry && typeof entry === 'object' ? Object.fromEntries(['id', 'name', 'known', 'hidden', 'visibility'].filter((key) => key in entry).map((key) => [key, entry[key]])) : entry)) }
  if (state.scene_npcs) result.scene_npcs = state.scene_npcs.map(pickActor)
  if (state.social) result.social = { npcs: (state.social.npcs ?? []).map(pickActor) }
  if (state.merchants) result.merchants = state.merchants.map(pickActor)
  return result
}
const rawStates = [
  {},
  fixtureState(),
  veldburg,
  { scene: { location: 'Серый Причал' }, scene_npcs: [{ name: 'Таррен Кель' }, { name: 'Эйра', alive: false }], merchants: [{ name: 'Оскар Лемм', available: false }, { name: 'Инга', location: 'Серый Причал' }, { name: 'Борин', location: 'Чужое место' }] },
  astohan,
  tides,
  { worldMap: { locations: [null, { name: '' }, { name: 5 }, { name: 'Скрытое', hidden: true }, { name: 'Тайное', visibility: 'gm_only' }, { name: '  Пепельный   Лес ' }] }, social: { npcs: [null, { name: '  Старый   Финн ' }, { name: 'Старый Финн' }] } },
]
const states = rawStates.map(project)
const stateContexts = states.map((state) => intent.exitContextFromState(state))
const contexts = [
  {},
  ...stateContexts.slice(1),
  { knownPlaces: ['Серый Причал', 'Маяк Серого Причала', 'Старый Маяк', 'Скальный маяк'], presentNames: ['Таррен Кель', 'Эйра', 'Инга', 'Борин', 'Товен Риск'] },
  { knownPlaces: ['Кленовка', 'Вельдбург', 'Каменный Град', 'Аквилон', 'Таверна «Ржавый Якорь»', 'Солеварня', 'Северный форт', 'Заречье'], presentNames: ['Старый Финн', 'Марта', 'Оскар Лемм'] },
  { knownPlaces: [null, 5, {}, '  Пепельный   Лес ', '', 'Ведьмина Падь'], presentNames: 'не массив' },
]

// ---------- фразы ----------

const phrases = new Set()
const add = (text) => {
  if (typeof text === 'string' && text.length) phrases.add(text)
}
for (const entry of readJson('eval/player-phrases.json').phrases) add(entry.text)
const deadEnds = readJson('eval/playtest-dead-ends.json').cases
for (const entry of deadEnds) {
  add(entry.text)
  add(entry.destination)
}
for (const file of ['eval/intent-routing-cases-2026-10-01.json', 'eval/intent-routing-holdout-2026-10-01.json']) {
  for (const entry of readJson(file).cases) add(entry.text)
}
// Строки тестов маршрутизации ввода — целиком; прочих тестов — выборкой.
const routingTests = new Set([
  'party-exit-intent.test.mjs', 'free-text-travel.test.mjs', 'intent-routing.test.mjs', 'objective-continues.test.mjs',
  'playtest-dead-ends.test.mjs', 'player-request-router.test.mjs', 'party-decision.test.mjs', 'solo-party-exit-api.test.mjs',
  'world-travel.test.mjs', 'world-travel-graph.test.mjs',
])
const otherStrings = []
const testDir = new URL('test/', root)
for (const file of readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).sort()) {
  const source = readFileSync(new URL(file, testDir), 'utf8')
  for (const match of source.matchAll(/'((?:[^'\\\n]){4,400})'/gu)) {
    if (!/[а-яё]/iu.test(match[1])) continue
    if (routingTests.has(file)) add(match[1])
    else otherStrings.push(match[1])
  }
}
const uniqueOther = [...new Set(otherStrings)].filter((text) => !phrases.has(text))
for (let index = 0; index < uniqueOther.length; index += 15) add(uniqueOther[index])

// Вариации: приставка, глагол, «откуда/как», предлог, место, хвост.
const prefixes = ['', 'Мы ', 'Давайте ', 'Ладно, ', 'Я ', 'Предлагаю ', 'Ну что ж, ', 'Эйра: ', 'Отряд ', 'Всё, ', 'Может, нам ', 'Ребята, ']
const verbs = [
  'покидаем', 'покинуть', 'покинем', 'уходим', 'уйдём', 'уйти', 'валим', 'сваливаем', 'выходим', 'выйдем', 'выдвигаемся', 'отступаем',
  'убираемся', 'выбираемся', 'сматываемся', 'идём', 'идем', 'иду', 'пойду', 'пойдём', 'пошли', 'направляемся', 'направлюсь',
  'отправляюсь', 'отправимся', 'отправляемся', 'возвращаемся', 'вернёмся', 'вернуться', 'едем', 'поехали', 'поедем', 'двигаемся',
  'двинемся', 'добираемся', 'доберёмся', 'держим путь', 'плывём', 'бежим', 'спешим', 'бредём', 'шагаю', 'крадусь', 'не идём',
  'не уходим', 'никуда не идём', 'остаёмся и', 'двигаю', 'Иду', 'УХОДИМ',
]
const fromParts = ['', '', '', 'отсюда ', 'из таверны ', 'из «Серый Причал» ', 'через лес ', 'вдоль реки ', 'по старой дороге ',
  'по свежим следам ', 'искать сына Финна ', 'расспросить стражу ', 'на север ', 'от пристани вдоль складов ', 'из этого места ']
const prepositions = ['в', 'во', 'на', 'к', 'ко', 'до', 'из', 'в', 'к']
const targets = [
  'город', 'деревню', 'лес', 'Пепельный Лес', 'таверну «Морской Змей»', '«Каменный Град»', '"Морской Змей"', '“Морской Змей”',
  '„Морской Змей“', 'старую крепость', 'старой мельнице', 'смотровой дамбе', 'угол таверны', 'дальний угол таверны', 'хозяйке таверны',
  'Марте', 'Таррену', 'тень', 'дверь', 'стойке', 'Кленовку', 'Солеварню', 'Северному форту', 'маяку на скале', 'Серый Причал',
  'Маяк Серого Причала', 'Маяку Серого Причала', 'руинам', 'пещеру у реки', 'кладбищу', 'рынок', 'старой лестнице', 'лесничему',
  'трактирщице', 'нему', 'туда', 'другой путь к разгадке', 'выход', 'поле', 'горы', 'постоялый двор', 'караван-сарай', 'Штормберг',
  'Пепельную заставу', 'Митглайд', 'Редстоуновку', 'Обсидиановый перевал', 'башню мага', 'логово дракона', 'склеп', 'старому склепу за мельницей',
  'деревню Кленовку', 'Заречье', 'провалу у старой арки', 'старой арке', 'торговому лотку у фонтана', 'смотрительнице дамбы', 'шлюзам',
  'Ведьмину Падь', 'Тайный грот', 'Солёные Ворота', 'Трём Кёгам', '«Другой п', 'своё место у стола', 'комнату', 'зал таверны',
  'Северные врата', 'старой часовне', 'водяной мельнице у реки', 'заброшенную пещеру', 'Таверне', 'причал', 'порт', 'гавань',
]
const tails = ['', '', '.', '!', '…', ' и бросаем задание', ' и бросаем задание «Найти печать архивариуса»', ' чтобы найти следы',
  ' расспрашивать о сыне Финна', ' по маршруту от Высокой пристани', ' вдоль соляных складов', ', пока не стемнело', ' через болото',
  ' купить рыбы', ' и ищем там следы', ' — там нас ждут', ' осмотреться', ' на скале', ' за мельницей', ' по соседству', ' сохранив отряд']
for (let index = 0; index < 1_600; index += 1) {
  add(`${pick(prefixes)}${pick(verbs)} ${pick(fromParts)}${pick(prepositions)} ${pick(targets)}${pick(tails)}`.replace(/\s+/gu, ' ').trim())
}
// Глагол с местом без предлога и голые реплики ухода.
for (let index = 0; index < 200; index += 1) add(`${pick(prefixes)}${pick(verbs)} ${pick(targets)}${pick(tails)}`.trim())
for (const word of ['Уходим', 'Уходим.', 'Всё, валим!', 'Ну, уйдём', 'Пора, выдвигаемся!', 'Мы уходим…', 'я ухожу', 'ладно, ладно, ладно, уходим',
  'Сматываемся', 'Покидаем', 'выходим!!!', 'Уходим отсюда', 'Уйти прочь', 'Пора уходить из этого города', 'Валим из этой деревни']) add(word)

// Прямая речь: зов в реплике и место в той же или соседней реплике.
const speakers = ['Мирель обращается к Борину', 'Мирель говорит Борину', 'Борин шепчет', 'Эйра закрывает тетрадь', 'Мирель сухо замечает Борину']
const calls = ['пойдём туда вместе', 'идём', 'пошли туда', 'отправимся туда', 'двинемся', 'поехали', 'не пойдём туда', 'подожди здесь']
const places = ['пора искать ответы у Старого Маяка', 'пора к маяку на скале', 'у Скального маяка найдутся следы', 'пора к Таррену',
  'следы ведут к Маяку Чёрной скалы', 'в таверне поговорим', 'к Инге подойдём позже', 'надо в Серый Причал', 'у старой мельницы тихо',
  'около кладбища видели огни', 'возле старой пещеры', 'Ивар молчит', 'путь до Кленовки долгий']
for (let index = 0; index < 300; index += 1) {
  const speaker = pick(speakers)
  const place = pick(places)
  const call = pick(calls)
  const shape = index % 3
  if (shape === 0) add(`${speaker}: «${place}; ${call}».`)
  else if (shape === 1) add(`${speaker}: «${place}». Она обращается к Борину: «${call[0].toUpperCase()}${call.slice(1)} вместе».`)
  else add(`${speaker}: "${call[0].toUpperCase()}${call.slice(1)}, ${place}."`)
}

// Карта мира: маркер, id назначения (в том числе битый) и кавычки.
const ids = [encodeURIComponent('форт:Северные врата'), encodeURIComponent('city:Каменный Град'), 'stone-city', '%E0%A4%A', '%ZZ', '%C3',
  '%ED%A0%80', '%F4%90%80%80', '%C0%80', encodeURIComponent('я'.repeat(121)), encodeURIComponent('я'.repeat(120)), '%01abc',
  encodeURIComponent('  пробелы  внутри '), '%5D', '%EF%BB%BF', encodeURIComponent('ｆｕｌｌ'), 'a'.repeat(1_600), '%25', '']
const routes = [['Брод', 'Северный форт'], ['Заброшенный Караван-сарай', 'Каменный Град'], ['Серый Причал', null], [null, null]]
for (const id of ids) {
  for (const [from, to] of routes) {
    const quoted = [from && `из «${from}»`, to && `в «${to}»`].filter(Boolean).join(' ')
    add(`[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=${id}] Отряд предлагает отправиться ${quoted}. Выбранный путь: ${from ?? '?'} → ${to ?? '?'}.`)
    add(`  [глобальная карта][destination_location_id=${id}] идём ${quoted}`)
  }
}
add('[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться в путь.')
add('[ГЛОБАЛЬНАЯ КАРТА] Идём в Пепельный Лес')

// Подписи вариантов голосования.
for (const label of [
  'Уходим в «Каменный Град» и бросаем задание «Найти печать архивариуса»', 'Уходим из деревни', 'Забить на квест и свалить отсюда',
  'Остаться и исследовать дальше', 'Остаться и не уходить из деревни', 'Покинуть «Серая чаща»',
  'Уходим из «Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов» и идём в «Другой п',
  'Уходим из «Серый Причал» и идём к старому маяку на скале', 'Уходим из «Водяная мельница» и идём к старому фамильному склепу за мельницей',
  'Уходим к старому фамильному склепу за мельницей и бросаем задание «Пропажи в Вельдбурге»', 'Уходим из «Вельдбург» и идём к смотровой дамбе',
  'Продолжаем исследовать', 'Отказываемся от задания', 'Без задания идём в город', 'Бросаем это дело', 'Никуда не идём', 'Не уходим',
  'Выходим из деревни и идём на север к руинам', 'Мы с Борином идём к «Маяк Серого Причала» на скале.',
]) add(label)

// Продолжение маршрута.
for (const text of ['продолжим', 'Продолжаем!', 'продолжаем путь', 'Продолжим маршрут.', 'идём дальше', 'Идем дальше', 'Ну, в путь!',
  'давайте двигаемся дальше', 'дальше в путь', 'продолжим приключение', 'продолжим разговор с Мирой', 'продолжим?', 'дальше', 'Что ж, едем дальше',
  'итак, ладно, продолжить поход', 'ну, ну, ну, продолжим', 'В ПУТЬ…', 'Поехали дальше!!!']) add(text)
add('   ')
add('')
// Длинные заявки: разбор режется на 2000 знаков, ленивые куски выражений
// перебирают много вариантов — проверка, что движок Rust не сдаётся раньше JS.
add(`Иду ${'очень '.repeat(300)}долго в город`)
add(`Уходим из ${'а'.repeat(1_990)}`)
add(`Идём в ${'Каменный '.repeat(40)}Град, ${'и '.repeat(200)}в лес`)
add(`${'Мы идём дальше и дальше, '.repeat(60)}идём в деревню`)
add(`Мирель говорит: «${'слово '.repeat(70)}пойдём туда к маяку»`)
add(`Мирель: «${'пора к маяку на скале; '.repeat(20)}идём».`)
add(`${'Иду по свежим следам '.repeat(40)}к провалу у старой арки`)
add(`Отправляюсь к ${'старой '.repeat(150)}арке ${'по маршруту '.repeat(30)}от пристани`)
add(`${'«Каменный Град» '.repeat(60)} идём в «Пепельный Лес»`)
add(`[ГЛОБАЛЬНАЯ КАРТА] ${'«А» '.repeat(300)}`)
add(`${'не идём, '.repeat(150)}уходим в лес`)
add(`Покидаем ${'старую '.repeat(200)}таверну`)

// ---------- цели сцен ----------

const objectives = new Set([
  'Добраться до смотровой дамбы, понять источник звона и не дать толпе открыть шлюзы.', 'Добраться до смотровой дамбы',
  'Понять источник звона', 'Найти в смотровой дамбе того, кто звонит', 'Проверить амбары, найти источник хора и решить, кому позволить открыть южные ворота.',
  'Найти в Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов другой путь к разгадке: колокол звонит снизу',
  'Найти новый выход из подземелья', 'Вернуться в Каменный Град', 'Добраться до смотровой дамбы и понять источник звона',
  'Понять, кто звонит на смотровой дамбе', 'Осмотреть затопленную колокольню', 'Продолжить путь из Айрская башня к «Дормар»',
  'Дойти до старой мельницы; расспросить мельника и вернуться в деревню!', 'Попасть в храм, пока жрецы спят…', 'Прибыть в Кленовку, где ждёт староста',
  'Пробраться в архив и найти печать, чтобы успеть до рассвета', '', '   ',
])
for (const scenario of readJson('data/campaign-scenarios-v1.json').scenarios) {
  for (const location of scenario.locations) objectives.add(location.objective)
}
const worlds = JSON.stringify(readJson('data/campaign-worlds-v1.json'))
for (const match of worlds.matchAll(/"objective":"((?:[^"\\]|\\.)*)"/gu)) objectives.add(JSON.parse(`"${match[1]}"`))
const destinations = new Set(['Смотровая дамба', 'смотровой дамбе', 'смотровая дамба', 'Южные ворота', 'Другой путь к разгадке', 'Другой п', '«Другой п',
  'новый выход', 'Каменный Град', 'шлюзам', 'Дормар', 'старой мельнице', 'храм', 'Кленовку', 'архив', '', 'выход', 'путь', 'правильную дорогу',
  'Пепельная застава', 'Обсидиановый перевал', 'Редстоуновка', 'башня Ломара', 'Сердце Эльдрина'])

// ---------- прогон ----------

const safe = (fn) => {
  try {
    return fn()
  } catch (error) {
    return { throws: String(error?.message ?? error) }
  }
}

// Выход по умолчанию в эталон не пишется: Rust-тест подставляет его сам.
// `detect` — null, `unrecognized` и `onward_target` — '', флаги — false,
// `classify` — { kind: 'other', destinationHint: '', abandonsQuest: false },
// `nominative` — сама фраза.
const allPhrases = [...phrases]
const cases = []
const found = new Set()
allPhrases.forEach((text, index) => {
  // Каждая фраза — с пустым контекстом и с одним из непустых по кругу.
  const runs = []
  for (const ctx of [0, 1 + (index % (contexts.length - 1))]) {
    const options = contexts[ctx]
    const detected = safe(() => intent.detectPartyExitRequest(text, options))
    const unrecognized = safe(() => intent.unrecognizedDestination(text, options))
    const run = { ctx }
    if (detected !== null) run.detect = detected
    if (unrecognized !== '') run.unrecognized = unrecognized
    if (safe(() => intent.travelDestinationIsPlace(text, options)) !== false) run.travel_is_place = true
    if (detected?.destination) {
      run.label = safe(() => intent.partyDestinationLabel(text, detected.destination, options))
      found.add(detected.destination)
    }
    if (unrecognized && typeof unrecognized === 'string') {
      run.label_unrecognized = safe(() => intent.partyDestinationLabel(text, unrecognized, options))
      found.add(unrecognized)
    }
    runs.push(run)
  }
  const entry = { text, runs }
  if (safe(() => intent.announcesMovement(text)) !== false) entry.announces = true
  const classified = safe(() => intent.classifyPartyDecision(text))
  if (classified.kind !== 'other' || classified.destinationHint !== '' || classified.abandonsQuest !== false) entry.classify = classified
  if (safe(() => intent.isRouteContinuation(text)) !== false) entry.route_continuation = true
  const nominative = safe(() => intent.nominativePlacePhrase(text))
  if (nominative !== text) entry.nominative = nominative
  if (safe(() => intent.destinationIsNotPlace(text)) !== false) entry.not_place = true
  const onward = safe(() => intent.onwardRouteTarget(text))
  if (onward !== '') entry.onward_target = onward
  cases.push(entry)
})

// Именительный падеж и «не место» для всех найденных назначений.
const names = new Set(found)
for (const text of targets) names.add(text)
for (const text of ['старому фамильному склепу за мельницей', 'водяной мельнице у реки', 'заброшенную пещеру', 'старому замку', 'старой часовне',
  'маяку на скале', 'Таверне', 'пещеру у реки', 'Мыс Сломанного Зуба', 'Кленовку', 'маяк', 'Маяка Чёрной скалы', 'Старому Тёмному Утёсу',
  'дальнему озеру', 'Озеру', 'утёсу', 'новой кузнице у реки', 'старую деревню', 'большого города', 'Высокой Гавани', 'синей скале',
  'тёмному углу', 'Сторожке лесника', 'святилищу', 'лагерю', 'старом лагере', 'красному мосту', 'Красной площади', 'боковой улице']) names.add(text)
const nameCases = [...names].map((text) => ({
  text,
  nominative: safe(() => intent.nominativePlacePhrase(text)),
  not_place: safe(() => intent.destinationIsNotPlace(text)),
  travel_is_place: safe(() => intent.travelDestinationIsPlace(text, {})),
}))

const objectiveCases = []
const destinationList = [...destinations, ...[...names].filter((_, index) => index % 7 === 0)]
for (const objective of objectives) {
  const words = (objective.match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 4)
  const local = new Set([...destinationList.filter(() => random() < 0.08)])
  for (let index = 0; index < 4 && words.length; index += 1) {
    const start = Math.floor(random() * words.length)
    local.add(words.slice(start, start + 1 + Math.floor(random() * 2)).join(' '))
  }
  for (const destination of local) {
    objectiveCases.push({
      objective,
      destination,
      names: safe(() => intent.objectiveNamesDestination(destination, objective)),
      calls: safe(() => intent.objectiveCallsTo(destination, objective)),
      remainder: safe(() => intent.objectiveRemainder(objective, destination)),
    })
  }
}

const routeStates = [
  { scene: { location: 'Айрская башня', objective: intent.onwardRouteObjective('Айрская башня', 'Дормар') }, worldMap: { locations: [{ id: 'dormar', name: 'Дормар' }] } },
  { scene: { location: 'Дормар', objective: intent.onwardRouteObjective('Айрская башня', 'Дормар') }, worldMap: { locations: [{ id: 'dormar', name: 'Дормар' }] } },
  { scene: { location: 'Айрская башня', objective: intent.onwardRouteObjective('Айрская башня', 'Дормар') }, worldMap: { locations: [{ id: 'd1', name: 'Дормар' }, { id: 'd2', name: 'Дормар' }] } },
  { scene: { location: 'Айрская башня', objective: intent.onwardRouteObjective('Айрская башня', 'Дормар') }, worldMap: { locations: [{ id: 'd1', name: 'Дормар', known: false }, { id: 'd2', name: 'Дормар', hidden: true }, { name: 'Дормар' }] } },
  { scene: { location: 'Айрская башня', objective: intent.onwardRouteObjective('Айрская башня', 'Дормар') }, worldMap: { locations: [{ id: 5, name: ' Дормар ' }, { id: 'x', name: 'Дормар', visibility: 'gm_only' }] } },
  { scene: { location: 'Айрская башня', objective: 'Найти пропавшего курьера' }, worldMap: { locations: [{ id: 'dormar', name: 'Дормар' }] } },
  { scene: { location: 'ДОРМАР', objective: 'Продолжить путь из X к «дормар»' }, worldMap: { locations: [{ id: 'dormar', name: 'дормар' }] } },
  {},
]
const routeActions = ['продолжим', 'идём дальше', 'Продолжаем путь.', 'продолжим приключение', 'в путь', 'стоим']
const routeCases = []
routeStates.forEach((state, index) => {
  for (const action of routeActions) {
    routeCases.push({ state: index, action, request: safe(() => intent.onwardRouteExitRequest(action, state)) })
  }
})
const sceneCases = [
  ...routeStates.map((state) => state.scene ?? null),
  null,
  { objective: 5, location: null },
  { objective: '  Продолжить   путь из  A  к  «B»  ', location: 'b' },
  { objective: 'Продолжить путь из A к «B»', location: ' B ' },
  { objective: 'Продолжить путь из A к «»' },
  { objective: 'Продолжить путь к «B»' },
].map((scene) => ({ scene, target: safe(() => intent.pendingOnwardTarget(scene)) }))
const objectiveFormulas = [['Айрская башня', 'Дормар'], ['  A  B ', ' C\nD '], ['', ''], ['Ｆｕｌｌ', 'х'.repeat(130)]]
  .map(([from, to]) => ({ from, to, objective: intent.onwardRouteObjective(from, to) }))

const questStates = [
  { worldMemory: { quests: [{ id: 'quest:chapter:1', title: 'Осмотреть караван-сарай', status: 'active' }, { id: 'quest:main', title: 'Найти печать архивариуса', status: 'active' }] } },
  { worldMemory: { quests: [{ id: 'quest:main', title: 'Закрыт', status: 'completed' }] } },
  {},
  { worldMemory: { quests: [{ id: 'quest:secret', title: 'Тайный сговор гильдии', status: 'active', visibility: 'gm_only' }, { id: 'quest:known', title: 'Найти пропавший обоз', status: 'active', visibility: 'party' }] } },
  { worldMemory: { quests: [{ id: 'quest:secret', title: 'Тайный сговор', status: 'active', visibility: 'gm_only' }] } },
  { worldMemory: { quests: [{ id: 'quest:chapter:2', title: '  Глава   два ', status: 'active' }] } },
  { worldMemory: { quests: [{ id: '', title: 'Без id', status: 'active' }, { id: 7, title: '', status: 'active' }] } },
  { worldMemory: { quests: [null, { id: 'quest:x', status: 'active' }] } },
  { worldMemory: { quests: 'нет' } },
].map((state) => ({ state, quest: safe(() => intent.abandonableQuest(state)) }))

const fixture = {
  generated_by: 'rust/crates/sk-scenario/fixtures/gen-party-exit-intent.mjs',
  world_map_travel_marker: intent.WORLD_MAP_TRAVEL_MARKER,
  contexts,
  context_states: stateContexts.map((context, index) => ({ state: states[index], context })),
  cases,
  names: nameCases,
  objectives: objectiveCases,
  route_states: routeStates,
  routes: routeCases,
  scenes: sceneCases,
  formulas: objectiveFormulas,
  quests: questStates,
}
writeFileSync(new URL('party-exit-intent.json', import.meta.url), `${JSON.stringify(fixture)}\n`)
const throws = JSON.stringify(fixture).split('"throws"').length - 1
console.log(`фраз ${allPhrases.length}, прогонов ${cases.length * 2}, имён ${nameCases.length}, целей ${objectiveCases.length}, исключений JS ${throws}`)
