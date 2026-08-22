import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { WORLD_MAP_TRAVEL_MARKER, abandonableQuest, classifyPartyDecision, detectPartyExitRequest } from '../server/party-exit-intent.mjs'
import { proposeAgentInteraction, resolvePartyDecision } from '../server/player-request-router.mjs'

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
    .replace('${current.name}', 'Заброшенный Караван-сарай')
    .replace('${selected.name}', 'Каменный Град')
    .replace('${routeNames.join(\' → \')}', 'Заброшенный Караван-сарай → Каменный Град')
  assert.equal(sample.includes('$'), false, 'в шаблоне остались неподставленные поля')
  assert.deepEqual(detectPartyExitRequest(sample), { destination: 'Каменный Град', source: 'world-map' })
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
  const card = proposeAgentInteraction('[ГЛОБАЛЬНАЯ КАРТА] Отряд предлагает отправиться из «Заброшенный Караван-сарай» в «Каменный Град». Выбранный путь: Заброшенный Караван-сарай → Каменный Град.', caravanserai)
  assert.equal(card.type, 'vote')
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
      },
    })
    assert.equal(resolved.type === 'scene_request' ? 'scene_request' : 'narration', expected[index].kind, label)
    assert.equal(resolved.destinationHint, expected[index].destinationHint, label)
    assert.equal(resolved.abandonsQuest, expected[index].abandonsQuest, label)
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
