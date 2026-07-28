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
    danger: 'низкая', outcome: 'Печать архивариуса возвращена.', suggestions: ['Осмотреть колеи', 'Искать свидетелей'],
  }, state)

  assert.equal(result.adventure.chapter, 2)
  assert.equal(result.adventure.history[0].location, 'Склеп Норвин')
  assert.equal(result.scene.location, 'Северный тракт')
  assert.equal(result.scene.turn, 8)
  assert.deepEqual(result.entrance, { x: 1, y: 4 })
  assert.deepEqual(result.suggestions, ['Осмотреть колеи', 'Искать свидетелей'])
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

test('неопознанная локация остаётся на прежнем процедурном генераторе', () => {
  const cells = generateSceneCells({
    theme: 'новая местность', location: 'Безымянная низина',
    seed: 'gate:plain', locationId: 'plain', map: mapRequest({ layout: 'open', pattern: 'natural', width: 15, height: 11 }),
  })
  assert.ok(cells.length <= 15 * 11, `запрошено 15×11, отдано ${cells.length} клеток`)
  assert.ok(cells.length < THEMED_MIN_CELLS)
})

test('тема с неготовой геометрией к игроку не попадает', () => {
  // Пещера опознаётся по названию, но её палаты по сетке хуже органической
  // полости процедурного генератора — сцена обязана остаться на нём.
  for (const [location, theme] of [['Пещера у водопада', 'подземные пещеры'], ['Деревня Заречье', 'городские улицы']]) {
    const cells = generateSceneCells({
      theme, location, seed: `hold:${location}`, locationId: location,
      map: mapRequest({ layout: 'cavern', pattern: 'cave-cluster', width: 15, height: 11 }),
    })
    assert.ok(cells.length < THEMED_MIN_CELLS, `«${location}» отдан неготовой теме: ${cells.length} клеток`)
  }
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
    crypt: 'Склеп Норвин', forest: 'Тёмный лес', road: 'Северный тракт',
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
