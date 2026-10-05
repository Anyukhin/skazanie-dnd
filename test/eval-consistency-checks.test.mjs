// Сторож проверок согласованности сквозного прогона (`eval/consistency-checks.mjs`):
// рассказчик против карты, броска, механики и часов; карта сцены против
// аудита и собственного текста. Проверки обязаны ловить явное и молчать на
// честном тексте — иначе отчёт прогона тонет в ложных тревогах.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  narrationConsistency,
  narrationVersusCheck,
  narrationVersusClock,
  narrationVersusMap,
  narrationVersusState,
  sceneContinuity,
  sceneMapConsistency,
  truncatedText,
  undeclinedPlaceNames,
} from '../eval/consistency-checks.mjs'
import { serializeTacticalMap, tacticalMapFromLegacyCells } from '../server/tactical-map.mjs'

function field(width = 14, height = 14) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
}

function stateWith({ props = [], scene = {}, minutes = 600 } = {}) {
  const map = tacticalMapFromLegacyCells(field())
  map.props.push(...props)
  return {
    scene: { location: 'Пепельная застава', title: 'Застава', objective: 'Осмотреть ворота', map: serializeTacticalMap(map), ...scene },
    players: [{ id: 'hero-1', character: 'Торвальд Камнелом', hp: 30, maxHp: 40 }],
    mechanics: { death: { heroes: {} }, world_time: { elapsed_minutes: minutes } },
    social: { npcs: [
      { id: 'ares', name: 'Король Арес', location: 'Штормберг' },
      { id: 'ivara', name: 'Маршал Ивара Тейн', location: 'Пепельная застава' },
    ] },
    worldMap: { currentLocationId: 'ash', locations: [{ id: 'ash', name: 'Пепельная застава' }, { id: 'storm', name: 'Штормберг' }] },
  }
}

const well = { id: 'well-1', assetId: 'well', x: 3.5, y: 3.5, blocksMove: true, footprint: [{ x: 3, y: 3 }] }

test('рассказчик против карты: названный колодец без колодца на карте — расхождение, с колодцем — нет', () => {
  const text = 'У колодца в центре двора темнеет пятно копоти.'
  assert.deepEqual(narrationVersusMap(text, stateWith()).map((issue) => issue.code), ['NARRATION_OBJECT_NOT_ON_MAP'])
  assert.deepEqual(narrationVersusMap(text, stateWith({ props: [well] })), [])
  assert.deepEqual(narrationVersusMap('Ветер гонит пепел по пустому двору.', stateWith()), [], 'текст без объектов словаря не проверяется')
})

test('рассказчик против броска: провал, описанный как удача, и успех, описанный как неудача', () => {
  const failed = { success: false, total: 9, difficulty: 15, label: 'Восприятие' }
  const passed = { success: true, total: 18, difficulty: 15, label: 'Восприятие' }
  assert.equal(narrationVersusCheck('Вам удаётся разглядеть следы когтей у ворот.', failed)[0]?.code, 'NARRATION_CONTRADICTS_FAILED_CHECK')
  assert.equal(narrationVersusCheck('Вы ничего не находите: пепел скрыл всё.', passed)[0]?.code, 'NARRATION_CONTRADICTS_PASSED_CHECK')
  assert.deepEqual(narrationVersusCheck('Вы ничего не находите: пепел скрыл всё.', failed), [])
  assert.deepEqual(narrationVersusCheck('Вам удаётся разглядеть следы когтей у ворот.', passed), [])
  assert.deepEqual(narrationVersusCheck('Что-то шевелится в пепле.', null), [], 'без броска проверять нечего')
})

test('рассказчик против механики: живой герой «погиб», а NPC из другого места отвечает репликой', () => {
  const state = stateWith()
  assert.equal(narrationVersusState('Торвальд падает и погибает под ударом медведя.', state)[0]?.code, 'NARRATION_DECLARES_DEATH')
  assert.deepEqual(narrationVersusState('Торвальд едва не погибает под ударом медведя.', state), [], '«едва не» — не смерть')
  const dead = { ...state, mechanics: { ...state.mechanics, death: { heroes: { 'hero-1': { status: 'dead' } } } } }
  assert.deepEqual(narrationVersusState('Торвальд погибает под ударом медведя.', dead), [], 'механика подтвердила смерть')
  assert.equal(narrationVersusState('Король Арес отвечает: «Ворота открыли изнутри».', state)[0]?.code, 'ABSENT_NPC_SPEAKS')
  assert.deepEqual(narrationVersusState('Маршал Ивара Тейн отвечает: «Ворота открыли изнутри».', state), [], 'маршал здесь, в заставе')
})

test('рассказчик против часов: ночь в тексте днём, кроме сцены под крышей', () => {
  // Часы мира начинаются с 08:00: +4 ч — полдень, +15 ч — 23:00.
  assert.equal(narrationVersusClock('Луна освещает пепелище.', stateWith({ minutes: 4 * 60 }))[0]?.code, 'NARRATION_WRONG_TIME_OF_DAY')
  assert.deepEqual(narrationVersusClock('Луна освещает пепелище.', stateWith({ minutes: 15 * 60 })), [])
})

test('склонение места и обрыв на полуслове', () => {
  const state = stateWith()
  assert.equal(undeclinedPlaceNames('Найти в Пепельная застава другой путь к разгадке.', state)[0]?.code, 'PLACE_NAME_NOT_DECLINED')
  assert.deepEqual(undeclinedPlaceNames('Найти в Пепельной заставе другой путь к разгадке.', state), [])
  assert.equal(truncatedText('Три свежих донесения связывают его охоту с забытым походом самого короля и пох')[0]?.code, 'TEXT_TRUNCATED')
  assert.deepEqual(truncatedText('Три свежих донесения связывают его охоту с забытым походом самого короля.'), [])
})

test('карта сцены: текст сцены обещает объект, которого нет; пустая карта; заглушка в имени', () => {
  const promised = sceneMapConsistency(stateWith({ scene: { objective: 'Осмотреть колодец у ворот' } }))
  assert.ok(promised.some((issue) => issue.code === 'SCENE_TEXT_OBJECT_NOT_ON_MAP'))
  assert.ok(promised.some((issue) => issue.code === 'MAP_EMPTY'))
  assert.ok(!sceneMapConsistency(stateWith({ props: [well], scene: { objective: 'Осмотреть колодец у ворот' } })).some((issue) => issue.code === 'SCENE_TEXT_OBJECT_NOT_ON_MAP'))
  assert.equal(sceneMapConsistency({ scene: { location: 'Пустошь' } })[0]?.code, 'SCENE_WITHOUT_MAP')
  assert.equal(sceneContinuity(stateWith({ scene: { location: 'След 3', title: 'След 3' } }))[0]?.code, 'PLACEHOLDER_SCENE_NAME')
  assert.deepEqual(sceneContinuity(stateWith()), [])
})

test('честный ответ проходит все проверки разом', () => {
  const text = 'Маршал Ивара Тейн отвечает: «Ворота открыли изнутри — смотри, засов срезан». Ветер гонит пепел по двору.'
  assert.deepEqual(narrationConsistency(text, stateWith(), { check: { success: true, total: 17, difficulty: 15 } }), [])
})
