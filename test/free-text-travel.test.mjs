import assert from 'node:assert/strict'
import test from 'node:test'

import { detectPartyExitRequest } from '../server/party-exit-intent.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'

// Карта как у сгенерированной кампании: название с прямыми кавычками, а игрок
// пишет «ёлочки» и винительный падеж.
function harbourState() {
  return {
    worldMap: {
      version: 1, width: 1000, height: 640, currentLocationId: 'аквилон',
      regions: [{ id: 'центр', name: 'Центр', biome: 'coast', x: 500, y: 350, radius: 150 }],
      locations: [
        { id: 'аквилон', name: 'Аквилон', kind: 'city', x: 500, y: 350, regionId: 'центр', known: true, visited: true },
        { id: 'плавучий-рынок', name: 'Плавучий Рынок', kind: 'landmark', x: 470, y: 380, regionId: 'центр', known: true, visited: false },
        { id: 'таверна-морской-змей', name: 'Таверна "Морской Змей"', kind: 'landmark', x: 530, y: 480, regionId: 'центр', known: true, visited: false },
      ],
      routes: [
        { id: 'r1', from: 'аквилон', to: 'плавучий-рынок', kind: 'road', distance: 1, danger: 'низкая', discovered: true },
        { id: 'r2', from: 'аквилон', to: 'таверна-морской-змей', kind: 'road', distance: 2, danger: 'низкая', discovered: true },
      ],
    },
    scene: { title: 'Причал в тумане', location: 'Аквилон', location_id: 'аквилон', objective: 'Расследовать исчезновения' },
    adventure: { chapter: 1, visitedLocations: ['Аквилон'], history: [], currentHook: 'Пропадают рыбаки' },
  }
}

test('одиночный игрок «иду в …» объявляет переход, а хвост-цель не прилипает к названию', () => {
  assert.deepEqual(
    detectPartyExitRequest('Иду в таверну «Морской Змей» расспрашивать о сыне Финна'),
    { destination: 'таверну «Морской Змей»', source: 'text' },
  )
  assert.equal(detectPartyExitRequest('Отправляюсь в таверну "Морской Змей"')?.destination, 'таверну "Морской Змей"')
  assert.equal(detectPartyExitRequest('Пойду на рынок купить рыбы')?.destination, 'рынок')
})

test('шаг внутри сцены первым лицом не считается уходом из локации', () => {
  for (const phrase of [
    'Иду в угол таверны', 'Иду в зал таверны', 'Иду к стойке', 'Иду к двери', 'Иду в тень',
    'Возвращаюсь к разговору с торговцем', 'Иду на причал осмотреться',
  ]) {
    assert.equal(detectPartyExitRequest(phrase), null, phrase)
  }
})

test('название из фразы игрока находит точку карты несмотря на падеж и вид кавычек', async () => {
  const architect = new SceneArchitectAgent({ llmClient: null })
  const planned = await architect.plan({
    action: 'Иду в таверну «Морской Змей» расспрашивать о сыне Финна',
    decision: 'Иду в таверну «Морской Змей» расспрашивать о сыне Финна',
    destinationHint: 'таверну «Морской Змей»',
    state: harbourState(),
  })
  assert.equal(planned.sceneArgs.location_id, 'таверна-морской-змей')
  assert.equal(planned.sceneArgs.location, 'Таверна "Морской Змей"')
})

test('похожее начало названия — не то же место: «Норвин» не уводит в «Норвель»', async () => {
  const state = harbourState()
  state.worldMap.locations.push({ id: 'норвель', name: 'Норвель', kind: 'town', x: 600, y: 300, regionId: 'центр', known: true, visited: false })
  state.worldMap.routes.push({ id: 'r3', from: 'аквилон', to: 'норвель', kind: 'road', distance: 2, danger: 'низкая', discovered: true })
  const architect = new SceneArchitectAgent({ llmClient: null })
  const planned = await architect.plan({
    action: 'Идём в большой город Норвин', decision: 'Идём в большой город Норвин', destinationHint: 'большой город Норвин', state,
  })
  assert.notEqual(planned.sceneArgs.location_id, 'норвель')
  // Общее собственное имя при разном роде места — тоже другое место.
  state.worldMap.locations.push({ id: 'склеп-норвин', name: 'Склеп Норвин', kind: 'dungeon', x: 640, y: 320, regionId: 'центр', known: true, visited: false })
  state.worldMap.routes.push({ id: 'r4', from: 'аквилон', to: 'склеп-норвин', kind: 'road', distance: 1, danger: 'низкая', discovered: true })
  const city = await architect.plan({
    action: 'Идём в большой город Норвин', decision: 'Идём в большой город Норвин', destinationHint: 'большой город Норвин', state,
  })
  assert.notEqual(city.sceneArgs.location_id, 'склеп-норвин')
  // А падеж того же названия по-прежнему узнаётся.
  const genitive = await architect.plan({
    action: 'Идём до таверны «Морского Змея»', decision: 'Идём до таверны «Морского Змея»', destinationHint: 'таверны «Морского Змея»', state,
  })
  assert.equal(genitive.sceneArgs.location_id, 'таверна-морской-змей')
})

test('обобщённое «рынок» не угадывается в конкретную точку по одному слову', async () => {
  const architect = new SceneArchitectAgent({ llmClient: null })
  const planned = await architect.plan({
    action: 'Пойду на рынок', decision: 'Пойду на рынок', destinationHint: 'рынок', state: harbourState(),
  })
  assert.notEqual(planned.sceneArgs.location_id, 'плавучий-рынок')
})
