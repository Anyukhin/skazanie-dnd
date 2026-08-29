import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition, generateSceneCells, generateSceneMap } from '../server/adventure-director.mjs'
import { SCENE_THEMES, isLiveTheme } from '../server/scene-themes.mjs'

/** Заявка на карту в том виде, в каком её всегда присылает картограф. */
function mapRequest(extra = {}) {
  return { layout: 'rooms', scale: 'room', pattern: 'small-room', material: 'wood', width: 9, height: 7, openness: 0.82, water: 0, featureCount: 9, ...extra }
}

/**
 * Признак тематической карты: тематические генераторы заполняют прямоугольник
 * целиком и не мельче 16×16, а прежний процедурный отдаёт разреженный список —
 * клеток вне контура в нём нет вовсе, поэтому по их числу пути и различаются.
 */
const THEMED_MIN_CELLS = 16 * 16
function looksThemed(cells) {
  return cells.length >= THEMED_MIN_CELLS && cells.some((cell) => cell.type === 'door')
}

test('карта новой сцены детерминирована, связна по центральному проходу и имеет вход', () => {
  const first = generateSceneMap({ seed: 'campaign:2', theme: 'подземные руины', danger: 'средняя' })
  const retry = generateSceneMap({ seed: 'campaign:2', theme: 'подземные руины', danger: 'средняя' })
  assert.deepEqual(first, retry)
  assert.equal(first.length, 13 * 9)
  assert.equal(first.find((cell) => cell.x === 1 && cell.y === 4)?.type, 'floor')
  assert.ok(first.some((cell) => cell.feature === 'stairs'))
  assert.ok(first.filter((cell) => cell.revealed).every((cell) => cell.x <= 2))
})

test('переход архивирует сцену и не повторяет метаданные при создании новой главы', () => {
  const state = {
    sessionCode: 'RUNE-1',
    scene: { title: 'Склеп', location: 'Склеп Норвин', objective: 'Вернуть печать', turn: 7, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Склеп Норвин'], history: [] },
  }
  const result = createSceneTransition({
    title: 'Голоса на тракте', location: 'Северный тракт', mood: 'Холодный рассвет',
    objective: 'Найти исчезнувший обоз', transition: 'За дверью склепа тропа выводит героев к тракту.',
    arrival: 'В колеях лежит свежий иней.', hook: 'Печать совпадает со знаком на колесе.', theme: 'дорога',
    danger: 'низкая', outcome: 'Печать архивариуса возвращена.',
  }, state)

  assert.equal(result.adventure.chapter, 2)
  assert.equal(result.adventure.history[0].location, 'Склеп Норвин')
  assert.equal(result.scene.location, 'Северный тракт')
  assert.equal(result.scene.turn, 8)
  assert.deepEqual(result.entrance, { x: 1, y: 4 })
  assert.equal(Object.hasOwn(result, 'suggestions'), false)
})

test('переход безопасно ограничивает объём генерируемых моделью полей', () => {
  const huge = 'я'.repeat(1000)
  const result = createSceneTransition({ title: huge, location: huge, objective: huge, transition: huge, arrival: huge }, { scene: {} })
  assert.equal(result.scene.title.length, 80)
  assert.equal(result.scene.location.length, 120)
  assert.equal(result.scene.objective.length, 160)
  assert.equal(result.transition.length, 500)
  assert.equal(result.arrival.length, 500)
})

test('публичный переход не переносит private memory и секреты старых клеток', () => {
  const state = {
    sessionCode: 'PRIVATE-RUNE',
    scene: {
      title: 'Закрытый архив', location: 'Архив', objective: 'Найти выход', turn: 4,
      gm_only: { map: 'SCENE-GM-SECRET' },
      cells: [{ x: 1, y: 1, type: 'floor', revealed: false, hidden_information: 'CELL-HIDDEN-SECRET', secret: 'CELL-SECRET' }],
    },
    adventure: {
      chapter: 2,
      currentHook: 'Публичная нить печати',
      visitedLocations: ['Архив'],
      unresolvedThreads: ['Найти владельца печати'],
      history: [{
        chapter: 1, title: 'Вход', location: 'Башня', objective: 'Войти', outcome: 'Герои вошли', status: 'unresolved',
        gm_only: 'HISTORY-GM-SECRET', hidden_information: 'HISTORY-HIDDEN-SECRET',
      }],
      gm_only: { villain: 'ADVENTURE-GM-SECRET' },
      hidden_information: { door: 'ADVENTURE-HIDDEN-SECRET' },
      npc_private: { archivist: 'NPC-PRIVATE-SECRET' },
      specific_player: { hero: 'PLAYER-PRIVATE-SECRET' },
      custom_private_memory: 'CUSTOM-PRIVATE-SECRET',
    },
  }
  const result = createSceneTransition({
    title: 'Городские ворота', location: 'Город Норвин', objective: 'Найти рынок',
    hook: 'Публичная нить печати продолжается', theme: 'городские улицы',
  }, state)

  assert.deepEqual(Object.keys(result.adventure).sort(), [
    'chapter', 'currentHook', 'history', 'lastTransition', 'unresolvedThreads', 'visitedLocationIds', 'visitedLocations',
  ])
  assert.equal(result.adventure.history[0].status, 'unresolved')
  const publicPayload = JSON.stringify(result)
  for (const secret of [
    'SCENE-GM-SECRET', 'CELL-HIDDEN-SECRET', 'CELL-SECRET', 'HISTORY-GM-SECRET',
    'HISTORY-HIDDEN-SECRET', 'ADVENTURE-GM-SECRET', 'ADVENTURE-HIDDEN-SECRET',
    'NPC-PRIVATE-SECRET', 'PLAYER-PRIVATE-SECRET', 'CUSTOM-PRIVATE-SECRET',
  ]) assert.doesNotMatch(publicPayload, new RegExp(secret, 'u'))
})

test('переход в известную деревню рисует улицы и дома, а не поле с полосой земли', () => {
  // Тот же сценарий, что и в живой кампании: отряд в «Тихом Броде» (деревня на
  // карте мира) уходит в соседний «Эствуд» (тоже деревня). Ни одно из двух
  // названий о поселении не говорит — об этом знает только карта мира.
  const worldMap = {
    seed: 'brod', name: 'Край', width: 1000, height: 640, currentLocationId: 'tihiy-brod',
    regions: [{ id: 'r', name: 'Долина', x: 500, y: 320, radius: 300, biome: 'лес' }],
    locations: [
      { id: 'tihiy-brod', name: 'Тихий Брод', kind: 'village', x: 500, y: 360, regionId: 'r', summary: '', known: true, visited: true },
      { id: 'estwood', name: 'Эствуд', kind: 'village', x: 300, y: 280, regionId: 'r', summary: '', known: true, visited: false },
    ],
    routes: [{ id: 'route-1', from: 'tihiy-brod', to: 'estwood', kind: 'road', distance: 2, danger: 'низкая', discovered: true }],
  }
  const state = {
    sessionCode: 'BROD', worldMap,
    scene: { title: 'Камень у брода', location: 'Тихий Брод', location_id: 'tihiy-brod', objective: 'x', turn: 3, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Тихий Брод'], history: [] },
  }
  const transition = createSceneTransition({
    title: 'Эствуд', location: 'Эствуд', theme: 'новая местность',
    map: mapRequest({ layout: 'open', pattern: 'natural', material: 'earth', width: 15, height: 11 }),
  }, state)
  assert.equal(transition.scene.location_id, 'estwood')
  assert.ok(transition.scene.cells.filter((cell) => cell.type === 'door').length >= 4, 'у домов деревни нет дверей — нарисовано поле')
  assert.ok(transition.scene.cells.filter((cell) => cell.type === 'wall' && cell.material === 'wood').length >= 40, 'в деревне нет стен домов')
  // Место, которого на карте ещё не было, вид с карты не получает: запасная
  // карта ставит «город» вслепую, и по нему рисовать улицы нельзя.
  const unknown = createSceneTransition({
    title: 'Безымянная низина', location: 'Безымянная низина', theme: 'новая местность',
    map: mapRequest({ layout: 'open', pattern: 'natural', material: 'earth', width: 15, height: 11 }),
  }, { ...state, worldMap: undefined })
  assert.equal(unknown.scene.cells.some((cell) => cell.type === 'door'), false, 'неизвестная низина стала поселением')
})

test('заявка картографа на планировку больше не отменяет тему сцены', () => {
  // Регресс, который жил в игре: тема применялась только когда картограф не
  // назвал `layout`/`pattern`, а промпт `map_architect` требует оба поля в
  // каждом ответе и детерминированный fallback проставляет их сам. Признак был
  // истинен всегда, и тематический генератор не работал ни разу.
  const cells = generateSceneCells({
    theme: 'уютная таверна', location: 'Таверна «Сломанное колесо»',
    seed: 'gate:tavern', locationId: 'tavern', map: mapRequest(),
  })
  assert.ok(looksThemed(cells), `таверна собрана прежним генератором: ${cells.length} клеток`)
})

test('неопознанная локация получает связный тематический fallback', () => {
  const input = {
    theme: 'новая местность', location: 'Безымянная низина',
    seed: 'gate:plain', locationId: 'plain', map: mapRequest({ layout: 'open', pattern: 'natural', width: 15, height: 11 }),
  }
  const cells = generateSceneCells(input)
  assert.equal(cells.length, 16 * 16, 'fallback обязан идти через полноразмерную тематическую карту')
  assert.ok(cells.some((cell) => cell.type === 'wall'), 'fallback не обозначил границу игровой области')
  assert.ok(cells.some((cell) => cell.feature), 'fallback оставил карту пустой')
  assert.deepEqual(cells, generateSceneCells(input), 'fallback недетерминирован')
})

test('fallback сохраняет явно запрошенный маршрут даже для неопознанной дикой местности', () => {
  const cells = generateSceneCells({
    theme: 'неизвестная окраина', location: 'Безымянный рубеж', sceneKind: 'wilderness',
    seed: 'fallback:route', locationId: 'route',
    map: mapRequest({ layout: 'winding', pattern: 'bridge', material: 'earth', width: 20, height: 16 }),
  })
  const earthColumns = new Set(cells.filter((cell) => cell.material === 'earth').map((cell) => cell.x))
  assert.equal(earthColumns.size, 20, 'дорога fallback обязана пройти от края до края')
})

test('органическая пещера и поселение с домами доходят до живой сцены', () => {
  const cave = generateSceneCells({
    theme: 'подземные пещеры', location: 'Пещера у водопада',
    seed: 'live:cave', locationId: 'cave',
    map: mapRequest({ layout: 'cavern', pattern: 'cave-cluster', width: 20, height: 18 }),
  })
  assert.equal(cave.length, 20 * 18, 'пещера обязана прийти из полноразмерной тематической карты')
  assert.ok(cave.some((cell) => cell.feature === 'stalagmite'), 'в пещере нет пещерного реквизита')

  const settlement = generateSceneCells({
    theme: 'городские улицы', location: 'Деревня Заречье',
    seed: 'live:settlement', locationId: 'settlement',
    map: mapRequest({ layout: 'streets', pattern: 'village', width: 15, height: 11 }),
  })
  assert.equal(settlement.length, 20 * 20, 'поселению нужен размер, в котором помещаются дома и улица')
  assert.ok(settlement.filter((cell) => cell.type === 'door').length >= 4, 'в legacy-карте не читаются двери домов')
  assert.ok(settlement.filter((cell) => cell.type === 'wall' && cell.material === 'wood').length >= 40,
    'в legacy-карте не читаются стены домов')
})

test('узор crypt ведёт к склепу, даже когда название о нём молчит', () => {
  const cells = generateSceneCells({
    theme: 'каменные залы', location: 'Нижний ярус',
    seed: 'gate:crypt', locationId: 'crypt-by-pattern', map: mapRequest({ layout: 'cavern', pattern: 'crypt', material: 'stone', width: 15, height: 11 }),
  })
  assert.ok(looksThemed(cells), `узор crypt не довёл до темы: ${cells.length} клеток`)
})

test('каждая живая тема доходит до карты через выбор генератора', () => {
  const named = {
    building: 'Таверна «Три бочки»', temple: 'Храм Утренней Звезды',
    crypt: 'Склеп Норвин', cave: 'Пещера у водопада',
    forest: 'Тёмный лес', road: 'Северный тракт', settlement: 'Деревня Заречье',
  }
  for (const theme of SCENE_THEMES.filter(isLiveTheme)) {
    const cells = generateSceneCells({
      theme: theme.label, location: named[theme.id], seed: `live:${theme.id}`, locationId: theme.id, map: mapRequest(),
    })
    assert.ok(cells.length >= 16 * 16, `${theme.id}: сцена собрана прежним генератором`)
    assert.ok(cells.some((cell) => cell.feature), `${theme.id}: на карте нет реквизита`)
  }
})

test('выбор генератора детерминирован от seed', () => {
  const build = () => generateSceneCells({
    theme: 'уютная таверна', location: 'Таверна «Сломанное колесо»',
    seed: 'stable:tavern', locationId: 'tavern', map: mapRequest(),
  })
  assert.deepEqual(build(), build())
})
