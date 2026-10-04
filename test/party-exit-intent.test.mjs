import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  WORLD_MAP_TRAVEL_MARKER, abandonableQuest, classifyPartyDecision, detectPartyExitRequest, isRouteContinuation,
  objectiveCallsTo, objectiveNamesDestination, objectiveRemainder, onwardRouteObjective, onwardRouteTarget,
  pendingOnwardTarget, unrecognizedDestination,
} from '../server/party-exit-intent.mjs'
import {
  PARTY_OPTION_LIMIT, partyOptionLabel, proposeAgentInteraction, proposeRoutedTravel, resolvePartyDecision,
  unknownDestinationReply,
} from '../server/player-request-router.mjs'

const caravanserai = {
  scene: { title: 'Глава 1', location: 'Заброшенный Караван-сарай', objective: 'Найти печать архивариуса' },
  adventure: { chapter: 1, currentHook: 'Печать открывает путь к забытому королю' },
  worldMemory: {
    quests: [
      { id: 'quest:chapter:1', title: 'Осмотреть караван-сарай', status: 'active' },
      { id: 'quest:main', title: 'Найти печать архивариуса', status: 'active' },
    ],
  },
}

test('уход опознаётся в формах, на которых прежний закрытый список молчал', () => {
  for (const phrase of [
    'Уходим отсюда',
    'Валим отсюда',
    'Я хочу уйти из таверны',
    'Предлагаю покинуть это подземелье',
    'Идём в город',
    'Возвращаемся в город',
    'Отправляемся на тракт',
    'Сваливаем из этого склепа',
  ]) {
    assert.ok(detectPartyExitRequest(phrase), phrase)
  }
})

test('тактическое действие не превращается в предложение сменить локацию', () => {
  // Свободный ввод один и тот же для «уходим отсюда» и «уходим в тень». Ошибка
  // в эту сторону дороже пропуска: она подменяет ход героя голосованием отряда.
  for (const phrase of [
    'Идём к двери',
    'Уходим в тень',
    'Отступаем в угол',
    'Открываю сундук',
    'Поднимаюсь по лестнице',
    'Осматриваю комнату',
    'Возвращаюсь к разговору с торговцем',
    'Что я знаю про печать архивариуса?',
  ]) {
    assert.equal(detectPartyExitRequest(phrase), null, phrase)
  }
})

test('предложение маршрута с карты мира разбирается по кавычкам, а не по прозе', () => {
  const request = detectPartyExitRequest('[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Заброшенный Караван-сарай» в «Каменный Град». Выбранный путь: Заброшенный Караван-сарай → Каменный Град.')
  assert.equal(request.source, 'world-map')
  assert.equal(request.destination, 'Каменный Град')
})

test('карта мира передаёт bounded ID назначения и сохраняет legacy-разбор при ошибке', () => {
  const encoded = encodeURIComponent('форт:Северные врата')
  assert.deepEqual(
    detectPartyExitRequest(`[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=${encoded}] Отряд предлагает отправиться из «Брод» в «Северный форт».`),
    { destination: 'Северный форт', source: 'world-map', destinationLocationId: 'форт:Северные врата' },
  )
  assert.deepEqual(
    detectPartyExitRequest('[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=%E0%A4%A] Отряд предлагает отправиться из «Брод» в «Северный форт».'),
    { destination: 'Северный форт', source: 'world-map' },
    'сломанный machine token не должен ломать совместимый маршрут по имени',
  )
  const tooLong = encodeURIComponent('я'.repeat(121))
  assert.equal(detectPartyExitRequest(`[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=${tooLong}] Идём из «Брод» в «Форт».`).destinationLocationId, undefined)
})

test('кнопка карты мира отправляет ровно тот формат, который читает сервер', async () => {
  // Договор был неявным и разошёлся: клиент слал текст, под шаблоны ухода не
  // подходивший, голосование не открывалось, и переход становился невозможен.
  // Шаблон один на глобальную карту и выбор пути с доски — `travelProposalText`
  // в `src/world-travel.ts`; обе кнопки обязаны звать его, а не писать строку.
  const client = await readFile(new URL('../src/world-travel.ts', import.meta.url), 'utf8')
  const emitted = client.match(/export function travelProposalText[^\n]*\n\s*return `([^`]+)`/u)
  assert.ok(emitted, 'кнопка перехода обязана отправлять шаблонную строку')
  for (const caller of ['../src/WorldMapView.tsx', '../src/SceneTransitionOverlay.tsx']) {
    const source = await readFile(new URL(caller, import.meta.url), 'utf8')
    assert.match(source, /travelProposalText\(/u, `${caller}: предложение пути обязано собираться общим шаблоном`)
    assert.doesNotMatch(source, /ГЛОБАЛЬНАЯ КАРТА\]/u, `${caller}: маркер карты мира пишется только в world-travel.ts`)
  }
  assert.ok(emitted[1].startsWith(WORLD_MAP_TRAVEL_MARKER), 'строка обязана начинаться с маркера карты мира')

  // Подставляем в шаблон правдоподобные значения и проверяем результат тем же
  // разбором, что стоит на сервере.
  const sample = emitted[1]
    .replace('${encodeURIComponent(selected.id)}', encodeURIComponent('city:Каменный Град'))
    .replace('${current.name}', 'Заброшенный Караван-сарай')
    .replace('${selected.name}', 'Каменный Град')
    .replace('${routeNames.join(\' → \')}', 'Заброшенный Караван-сарай → Каменный Град')
  assert.equal(sample.includes('$'), false, 'в шаблоне остались неподставленные поля')
  assert.deepEqual(detectPartyExitRequest(sample), {
    destination: 'Каменный Град', source: 'world-map', destinationLocationId: 'city:Каменный Град',
  })
})

test('отказ от задания опознаётся отдельно от самого ухода', () => {
  assert.deepEqual(
    classifyPartyDecision('Уходим в «Каменный Град» и бросаем задание «Найти печать архивариуса»'),
    { kind: 'move', destinationHint: 'Каменный Град', abandonsQuest: true },
  )
  assert.equal(classifyPartyDecision('Уходим из деревни').abandonsQuest, false)
  assert.equal(classifyPartyDecision('Забить на квест и свалить отсюда').abandonsQuest, true)
})

test('решение остаться перевешивает названное в той же фразе место', () => {
  assert.equal(classifyPartyDecision('Остаться и исследовать дальше').kind, 'stay')
  assert.equal(classifyPartyDecision('Остаться и не уходить из деревни').kind, 'stay')
})

test('отказ закрывает основную нить, а не служебный квест главы', () => {
  assert.deepEqual(abandonableQuest(caravanserai), { id: 'quest:main', title: 'Найти печать архивариуса' })
  assert.equal(abandonableQuest({ worldMemory: { quests: [{ id: 'quest:main', title: 'Закрыт', status: 'completed' }] } }), null)
  assert.equal(abandonableQuest({}), null)
})

test('скрытый от отряда квест не попадает в подпись варианта', () => {
  // Функция читает полное серверное состояние, а её результат видит весь стол:
  // название gm_only-нити в подписи голосования было бы утечкой.
  const state = {
    scene: { location: 'Серая чаща' },
    worldMemory: {
      quests: [
        { id: 'quest:secret', title: 'Тайный сговор гильдии', status: 'active', visibility: 'gm_only' },
        { id: 'quest:known', title: 'Найти пропавший обоз', status: 'active', visibility: 'party' },
      ],
    },
  }
  assert.deepEqual(abandonableQuest(state), { id: 'quest:known', title: 'Найти пропавший обоз' })

  const hiddenOnly = { worldMemory: { quests: [state.worldMemory.quests[0]] } }
  assert.equal(abandonableQuest(hiddenOnly), null)
  const card = proposeAgentInteraction('Уходим отсюда', { ...hiddenOnly, scene: { location: 'Серая чаща' } })
  assert.deepEqual(card.options, ['Покинуть «Серая чаща»', 'Остаться и исследовать дальше'])
})

test('каждый вариант предложенного голосования разбирается тем же словарём', () => {
  // Словарь предложения и словарь разбора были разными списками, и вариант, за
  // который отряд уже проголосовал, мог не опознаться как уход. Сторож проверяет
  // именно замкнутость круга, а не отдельные формулировки.
  const card = proposeAgentInteraction('[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=stone-city] Отряд предлагает отправиться из «Заброшенный Караван-сарай» в «Каменный Град». Выбранный путь: Заброшенный Караван-сарай → Каменный Град.', caravanserai)
  assert.equal(card.type, 'vote')
  assert.equal(card.destinationLocationId, 'stone-city')
  assert.equal(card.options.length, 3)
  for (const label of card.options) {
    assert.ok(label.length <= 100, `подпись варианта не помещается в лимит сервера: ${label}`)
  }

  const expected = [
    { kind: 'scene_request', destinationHint: 'Каменный Град', abandonsQuest: false },
    { kind: 'scene_request', destinationHint: 'Каменный Град', abandonsQuest: true },
    { kind: 'narration', destinationHint: undefined, abandonsQuest: undefined },
  ]
  card.options.forEach((label, index) => {
    const resolved = resolvePartyDecision(`[РЕШЕНИЕ ГРУППЫ] ${label}`, {
      ...caravanserai,
      agentInteraction: {
        id: 'decision-1', status: 'resolved', resolvedOptionId: `option-${index + 1}`,
        options: card.options.map((item, position) => ({ id: `option-${position + 1}`, label: item })),
        destinationLocationId: card.destinationLocationId,
      },
    })
    assert.equal(resolved.type === 'scene_request' ? 'scene_request' : 'narration', expected[index].kind, label)
    assert.equal(resolved.destinationHint, expected[index].destinationHint, label)
    assert.equal(resolved.abandonsQuest, expected[index].abandonsQuest, label)
    assert.equal(resolved.destinationLocationId, expected[index].kind === 'scene_request' ? 'stone-city' : undefined, label)
  })
})

test('длинные названия режутся до лимита подписи, не ломая разбор маршрута', () => {
  const card = proposeAgentInteraction('[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Заброшенный Караван-сарай» в «Приморская Крепость Восьми Ветров и Тихой Гавани». Выбранный путь: A → B.', {
    scene: { location: 'Заброшенный Караван-сарай' },
    worldMemory: { quests: [{ id: 'quest:main', title: 'Найти печать архивариуса, украденную из монастырской библиотеки прошлой зимой', status: 'active' }] },
  })
  const abandon = card.options[1]
  assert.ok(abandon.length <= 100, `подпись ${abandon.length} знаков не помещается в лимит`)
  // Резать нужно название задания, а не маршрут: маршрут решает, куда попадёт
  // отряд, и обрезанный до неузнаваемости он уводит группу не туда.
  const classified = classifyPartyDecision(abandon)
  assert.equal(classified.kind, 'move')
  assert.equal(classified.abandonsQuest, true)
  assert.equal(classified.destinationHint, 'Приморская Крепость Восьми Ветров и Тихой Гавани')
})

test('без активного задания третьего варианта в голосовании нет', () => {
  const card = proposeAgentInteraction('Уходим отсюда', { scene: { location: 'Серая чаща' } })
  assert.deepEqual(card.options, ['Покинуть «Серая чаща»', 'Остаться и исследовать дальше'])
})

test('подпись маршрута согласована по-русски: падеж игрока или имя точки карты в кавычках', async () => {
  const { nominativePlacePhrase, partyDestinationLabel } = await import('../server/party-exit-intent.mjs')
  const { proposeRoutedTravel } = await import('../server/player-request-router.mjs')
  // Живая сессия 2026-10-02: «идём в старому фамильному склепу за мельницей»,
  // «идём в водяная мельница у реки», «идём в Кленовка».
  assert.equal(nominativePlacePhrase('старому фамильному склепу за мельницей'), 'старый фамильный склеп за мельницей')
  assert.equal(nominativePlacePhrase('водяной мельнице у реки'), 'водяная мельница у реки')
  assert.equal(nominativePlacePhrase('заброшенную пещеру'), 'заброшенная пещера')
  // Беглая гласная и мягкая основа не угадываются — фраза остаётся как была.
  assert.equal(nominativePlacePhrase('старому замку'), 'старому замку')
  assert.equal(nominativePlacePhrase('старой часовне'), 'старой часовне')

  const known = { knownPlaces: ['Кленовка', 'Вельдбург'] }
  assert.deepEqual(partyDestinationLabel('Продолжаем путь в Кленовку.', 'Кленовку', known), { phrase: 'в «Кленовка»', place: 'Кленовка' })
  assert.equal(partyDestinationLabel('Идём к старому фамильному склепу за мельницей, следы ведут туда.', 'старому фамильному склепу за мельницей', known).phrase,
    'к старому фамильному склепу за мельницей')

  const state = {
    scene: { title: 'Глава 2', location: 'Водяная мельница', objective: 'Найти возницу' },
    worldMap: { locations: [{ id: 'veldburg', name: 'Вельдбург', known: true }, { id: 'klenovka', name: 'Кленовка', known: true }] },
    worldMemory: { quests: [{ id: 'quest:main', title: 'Пропажи в Вельдбурге', status: 'active' }] },
  }
  // Судья вернул назначение в дательном падеже; подпись берёт предлог игрока.
  const card = proposeRoutedTravel({ route: 'travel', destination: 'старому фамильному склепу за мельницей' }, state,
    'Идём к старому фамильному склепу за мельницей, следы ведут туда.')
  assert.ok(card, 'карточки нет')
  assert.equal(card.options[0], 'Уходим из «Водяная мельница» и идём к старому фамильному склепу за мельницей')
  assert.match(card.options[1], /^Уходим к старому фамильному склепу за мельницей и бросаем задание «Пропажи в Вельдбурге»$/u)
  for (const option of card.options.slice(0, 2)) {
    const decision = classifyPartyDecision(option)
    assert.equal(decision.kind, 'move', option)
    assert.match(decision.destinationHint, /склеп/u, option)
  }
  // Известная точка карты — именем с карты, а не падежом фразы.
  const village = proposeAgentInteraction('Уходим в Кленовку', state)
  assert.equal(village?.options[0], 'Уходим из «Водяная мельница» и идём в «Кленовка»')
  assert.equal(classifyPartyDecision(village.options[0]).destinationHint, 'Кленовка')
})

test('длинное покидаемое место сокращается, а маршрут доходит до решения целиком', () => {
  // Плейтест 2026-10-04, QP-05: «Уходим из «<70 знаков>» и идём в «Другой путь
  // к разгадке»» срезался на сотом знаке посреди кавычек, и отряд уходил в
  // новую локацию «Другой п».
  const from = 'Смотровая дамба по маршруту от Высокой пристани вдоль соляных складов'
  const state = { scene: { location: from }, worldMemory: { quests: [{ id: 'quest:main', title: 'Найти следы', status: 'active' }] } }
  for (const destination of ['Другой путь к разгадке', 'Старая арка у провала после соляных складов и разлома под маяком']) {
    const card = proposeAgentInteraction(`Отправляемся в «${destination}»`, state)
    assert.equal(card?.type, 'vote', destination)
    card.options.forEach((label, index) => {
      assert.ok(label.length <= PARTY_OPTION_LIMIT, `${label.length}: ${label}`)
      assert.equal(partyOptionLabel(label), label, 'подпись уже в лимите, сервер её не режет')
      assert.equal((label.match(/«/gu) ?? []).length, (label.match(/»/gu) ?? []).length, label)
      const resolved = resolvePartyDecision(`[РЕШЕНИЕ ГРУППЫ] ${label}`, {
        ...state,
        agentInteraction: {
          id: 'decision-long', status: 'resolved', resolvedOptionId: `option-${index + 1}`,
          options: card.options.map((item, position) => ({ id: `option-${position + 1}`, label: item })),
        },
      })
      if (resolved.type !== 'scene_request') return
      // Короткое название доходит дословно, слишком длинное — укороченным по
      // слову, но всегда началом настоящего названия, а не обрывком слова.
      assert.ok(destination.startsWith(resolved.destinationHint), `${resolved.destinationHint} ← ${destination}`)
      assert.match(resolved.destinationHint, /\p{L}$/u)
      if (destination.length <= 50) assert.equal(resolved.destinationHint, destination)
    })
  }
})

test('подпись, обрезанная посреди названия, не превращается в место', () => {
  // Так записаны карточки, открытые до исправления: заново открыть их нельзя,
  // а повторный разбор не должен выдумывать локацию из обрывка.
  const legacy = 'Уходим из «Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов» и идём в «Другой п'
  assert.deepEqual(classifyPartyDecision(legacy), { kind: 'move', destinationHint: '', abandonsQuest: false })
  // Длинную подпись от Режиссёра сервер режет по слову и без висящей кавычки.
  const cut = partyOptionLabel(`${legacy}уть к разгадке»`)
  assert.ok(cut.length <= PARTY_OPTION_LIMIT)
  assert.equal(cut.includes('«Другой'), false, cut)
  assert.deepEqual(classifyPartyDecision(cut), { kind: 'move', destinationHint: '', abandonsQuest: false })
  assert.equal(partyOptionLabel('  Остаться   и исследовать  '), 'Остаться и исследовать')
})

// Плейтест 2026-10-04, SE-11 и SE-14: следующий пункт составного маршрута
// живёт только в цели промежуточной точки, и формулу пишет и читает один код.
test('цель промежуточной точки: одна формула на запись и чтение, текущее место не зовёт', () => {
  const objective = onwardRouteObjective('Айрская башня', 'Дормар')
  assert.equal(objective, 'Продолжить путь из Айрская башня к «Дормар»')
  assert.equal(onwardRouteTarget(objective), 'Дормар')
  assert.equal(onwardRouteTarget('Найти пропавшего курьера'), '')
  assert.equal(onwardRouteTarget('Продолжить путь к Дормару и найти курьера'), '', 'произвольная цель со словом «путь» не узнаётся')
  assert.equal(pendingOnwardTarget({ location: 'Айрская башня', objective }), 'Дормар')
  // Цель, сохранённая до исправления SE-14: отряд уже в Дормаре.
  assert.equal(pendingOnwardTarget({ location: 'Дормар', objective }), '')
  assert.equal(pendingOnwardTarget(null), '')
})

test('«продолжим» и «идём дальше» — просьба о дороге, остальное ею не считается', () => {
  for (const text of ['продолжим', 'Продолжаем!', 'продолжаем путь', 'Продолжим маршрут.', 'идём дальше', 'Идем дальше', 'Ну, в путь!', 'давайте двигаемся дальше', 'дальше в путь']) {
    assert.equal(isRouteContinuation(text), true, text)
  }
  for (const text of ['продолжим приключение', 'продолжим разговор с Мирой', 'идём в таверну', 'продолжим?', 'дальше', '', null]) {
    assert.equal(isRouteContinuation(text), false, String(text))
  }
})

// ---------- плейтест 2026-10-04: разбор фраз о передвижении ----------

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
    routes: [{ from: 'veld', to: 'gates', distance: 1 }, { from: 'veld', to: 'koegs', distance: 2 }, { from: 'veld', to: 'secret', distance: 1 }],
  },
}

test('описание дороги не входит в название места, но уход по-прежнему узнаётся', () => {
  // Хроника плейтеста: локация «Смотровой дамбе по маршруту от Высокой пристани
  // вдоль соляных складов» и цель «Найти в Смотровой дамбе по маршруту … другой
  // путь». «Дамбы» нет в словаре мест; уход узнавался только по «пристани» в
  // хвосте — и должен узнаваться по-прежнему, иначе игрок упрётся в тупик.
  const text = 'Отправляюсь к смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов, чтобы проверить карту.'
  assert.deepEqual(detectPartyExitRequest(text), { destination: 'смотровой дамбе', source: 'text' })
  const card = proposeAgentInteraction(text, veldburg)
  assert.equal(card?.type, 'vote')
  assert.equal(card.options[0], 'Уходим из «Вельдбург» и идём к смотровой дамбе')
  assert.equal(classifyPartyDecision(card.options[0]).destinationHint, 'смотровой дамбе')

  for (const [phrase, destination] of [
    ['Идём в деревню вдоль реки', 'деревню'],
    ['Уходим в лес через болото, пока не стемнело', 'лес'],
    ['Направляемся в порт мимо старых складов', 'порт'],
    ['Идём в таверну по старой дороге', 'таверну'],
    // Дорога до предлога: «по следам», «через», «от … вдоль …».
    ['Идём через лес в деревню', 'деревню'],
    ['Иду по свежим следам в деревню', 'деревню'],
    // «По» без слова пути — часть названия, а не дорога.
    ['Идём в таверну по соседству', 'таверну по соседству'],
  ]) {
    assert.equal(detectPartyExitRequest(phrase)?.destination, destination, phrase)
  }
  // Дорога не делает уходом шаг внутри сцены.
  for (const phrase of ['Иду по коридору к двери', 'Иду через зал к стойке', 'Отступаем от двери к окну', 'Иду к двери через таверну']) {
    assert.equal(detectPartyExitRequest(phrase), null, phrase)
  }
})

test('переносное «другой путь» не называет места из цели сцены', () => {
  // Плейтест 2026-10-04: цель «Найти в … другой путь к разгадке», судья
  // свободных действий вернул назначение «другой путь к разгадке», и отряд ушёл
  // в локацию с таким именем. Слова совпадали с целью все до одного.
  const objective = 'Найти в Смотровой дамбе по маршруту от Высокой пристани вдоль соляных складов другой путь к разгадке: колокол звонит снизу'
  assert.equal(objectiveNamesDestination('Другой путь к разгадке', objective), false)
  assert.equal(objectiveNamesDestination('«Другой п', objective), false, 'обрывок старой подписи — тоже не место')
  assert.equal(objectiveNamesDestination('новый выход', 'Найти новый выход из подземелья'), false)
  assert.equal(objectiveRemainder(objective, 'Другой п'), null, 'приход в обрывок не продолжает цель')
  const dam = { scene: { location: 'Смотровая дамба', objective }, worldMemory: veldburg.worldMemory }
  assert.equal(proposeRoutedTravel({ route: 'travel', destination: 'другой путь к разгадке' }, dam,
    'Покидаю Смотровую дамбу через дверь, чтобы найти другой путь к разгадке.'), null)
  // Настоящее место из цели по-прежнему называется целью.
  assert.equal(objectiveNamesDestination('смотровая дамба', 'Добраться до смотровой дамбы и понять источник звона'), true)
  assert.equal(objectiveNamesDestination('Каменный Град', 'Вернуться в Каменный Град'), true)
  assert.equal(objectiveRemainder('Добраться до смотровой дамбы, понять источник звона', 'Смотровая дамба'), 'Понять источник звона')
})

test('место, куда словами о приходе зовёт цель, — уход, а не «К кому именно подойти?»', () => {
  // QP-02: без модели «Иду к смотровой дамбе» доходило до подхода к
  // собеседнику, хотя цель прямо называла дамбу.
  const state = { ...veldburg, scene: { ...veldburg.scene, objective: 'Добраться до смотровой дамбы, понять источник звона и не дать толпе открыть шлюзы.' } }
  const card = proposeAgentInteraction('Иду к смотровой дамбе, следуя по открытой площади и не мешая толпе.', state)
  assert.equal(card?.type, 'vote')
  assert.equal(card.options[0], 'Уходим из «Вельдбург» и идём к смотровой дамбе')
  assert.equal(card.options.some((option) => /бросаем задание/u.test(option)), false, 'идти туда, куда зовёт цель, — не отказ от задания')
  assert.equal(objectiveCallsTo('смотровой дамбе', state.scene.objective), true)

  // Цель называет шлюзы, но никуда к ним не зовёт; собеседник по роли — не
  // место; отряд, уже стоящий на дамбе, туда не уходит; цель без слов о
  // приходе тоже не зовёт.
  assert.equal(objectiveCallsTo('шлюзам', state.scene.objective), false)
  assert.equal(proposeAgentInteraction('Иду к шлюзам', state), null)
  assert.equal(proposeAgentInteraction('Иду к смотрительнице дамбы', state), null)
  assert.equal(proposeAgentInteraction('Иду к смотровой дамбе', { ...state, scene: { ...state.scene, location: 'Смотровая дамба' } }), null)
  assert.equal(proposeAgentInteraction('Иду к смотровой дамбе', { ...state, scene: { ...state.scene, objective: 'Понять, кто звонит на смотровой дамбе' } }), null)
  assert.equal(proposeAgentInteraction('Не иду к смотровой дамбе, остаюсь на площади', state), null)
})

test('движение к месту, которого нет ни на карте, ни в сцене, получает честный ответ', () => {
  // QP-06: после улики о «провале у старой арки» обе фразы получали «Я не понял
  // способ действия». Точку из текста сервер не создаёт — он объясняет, что
  // можно сделать, и называет известные направления, но не скрытые.
  for (const [text, asked] of [
    ['Иду по свежим следам к провалу у старой арки, чтобы найти телегу или следы груза.', 'К провалу у старой арки?'],
    ['Отправляюсь к старой арке по свежим следам телеги, чтобы осмотреть провал.', 'К старой арке?'],
  ]) {
    assert.equal(unrecognizedDestination(text), asked.slice(2, -1).toLocaleLowerCase('ru'), text)
    assert.equal(proposeAgentInteraction(text, veldburg), null, 'неизвестное место не открывает голосование')
    const reply = unknownDestinationReply(text, veldburg)
    assert.ok(reply.startsWith(`${asked} Такого места пока нет`), reply)
    assert.match(reply, /осмотритесь или идите по следам — это проверка навыка/u)
    assert.match(reply, /знакомое направление: Солёные Ворота, Три Кёга\./u)
    assert.doesNotMatch(reply, /Тайный грот|Отправляемся в/u)
  }

  const text = 'Отправляюсь к торговому лотку у фонтана'
  const withStall = { ...veldburg, scene: { ...veldburg.scene, map: { props: [{ id: 'stall', assetId: 'market_stall' }] } } }
  assert.equal(unknownDestinationReply(text, withStall), '', 'видимый предмет обстановки — не неизвестное место')
  assert.match(unknownDestinationReply(text, withStall, { isRevealed: () => false }), /^К торговому лотку у фонтана\?/u,
    'нераскрытый предмет не выдаётся отказом от ответа')
  // Собеседник по роли, место из цели, бой и известная точка карты — не этот случай.
  assert.equal(unknownDestinationReply('Отправляюсь к смотрительнице дамбы', veldburg), '')
  assert.equal(unknownDestinationReply('Отправляюсь к затопленной колокольне',
    { ...veldburg, scene: { ...veldburg.scene, objective: 'Осмотреть затопленную колокольню' } }), '')
  assert.equal(unknownDestinationReply('Отправляюсь к старой арке', { ...veldburg, mechanics: { combat: { active: true } } }), '')
  assert.equal(unknownDestinationReply('Отправляюсь в Солёные Ворота', veldburg), '')
  // Название на городском плане текущего места — не «нет такого места».
  const withPlan = structuredClone(veldburg)
  withPlan.worldMap.locations[0].cityOverview = { districts: [{ name: 'Линия дамб' }], places: [{ name: 'Арка Десятой Пошлины' }] }
  assert.equal(unknownDestinationReply('Отправляюсь к старой арке', withPlan), '')
  // Без известных соседей ответ это признаёт, а не перечисляет пустоту.
  assert.match(unknownDestinationReply('Отправляюсь к старой арке', { scene: veldburg.scene }), /Знакомых направлений отсюда на карте мира пока нет\./u)
})
