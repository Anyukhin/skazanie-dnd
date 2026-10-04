import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { WORLD_MAP_TRAVEL_MARKER, abandonableQuest, classifyPartyDecision, detectPartyExitRequest, isRouteContinuation, onwardRouteObjective, onwardRouteTarget, pendingOnwardTarget } from '../server/party-exit-intent.mjs'
import { PARTY_OPTION_LIMIT, partyOptionLabel, proposeAgentInteraction, resolvePartyDecision } from '../server/player-request-router.mjs'

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
