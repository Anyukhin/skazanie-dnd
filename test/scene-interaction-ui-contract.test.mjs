import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appTsxSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const appSource = [appTsxSource, ...await Promise.all(['../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')))].join('\n')
const boardSource = await readFile(new URL('../src/TacticalBoard.tsx', import.meta.url), 'utf8')
const sessionSource = await readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const mapClientSource = await readFile(new URL('../src/tactical-map-client.ts', import.meta.url), 'utf8')
const typesSource = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')
const narratorPrompt = await readFile(new URL('../prompts/narrator/v6.txt', import.meta.url), 'utf8')

test('клиент отправляет типизированную команду объекта сцены через общий путь тактических команд', () => {
  assert.match(sessionSource, /command_type: 'OperateSceneObject'; actor_id: string; prop_id: string; intent: SceneObjectIntent/)
  assert.match(sessionSource, /executeTacticalCommand\(\{\s*command_type: 'OperateSceneObject',\s*actor_id: actorId,\s*prop_id: propId,\s*intent,/u)
})

test('доска предлагает только спроецированные сервером глаголы и русские подписи', () => {
  assert.match(typesSource, /interaction\?: \{\s*kind: string\s*verbs: SceneObjectIntent\[\]\s*pointOfInterest: boolean/u)
  assert.match(appSource, /prop\.interaction\?\.verbs \?\? prop\.interactionVerbs \?\? \[\]/u)
  for (const [intent, label] of [
    ['inspect', 'Осмотреть'],
    ['open', 'Открыть'],
    // Взлом: сервер объявляет этот глагол у всякого контейнера — запертость он
    // не выдаёт, — и доска обязана нарисовать его той же кнопкой.
    ['lockpick', 'Взломать'],
    ['take', 'Взять'],
    ['use', 'Использовать'],
    // Обстановка как оружие: сервер объявляет эти два глагола у тяжёлого и
    // горючего реквизита, и доска обязана нарисовать их той же кнопкой.
    ['topple', 'Опрокинуть'],
    ['ignite', 'Поджечь'],
    // Молитва: сервер объявляет этот глагол только у святыни, и доска обязана
    // нарисовать его той же кнопкой, что и остальные операции пропса.
    ['pray', 'Помолиться'],
  ]) {
    assert.match(appSource, new RegExp(`${intent}: '${label}'`, 'u'))
  }
  assert.match(appSource, /verb === 'topple' \|\| verb === 'ignite' \|\| verb === 'pray'/u)
})

test('декодер карты сохраняет только публичный контракт взаимодействия', () => {
  const decodePropSource = mapClientSource.slice(
    mapClientSource.indexOf('function decodeProp'),
    mapClientSource.indexOf('function decodeZone'),
  )
  assert.match(mapClientSource, /SCENE_OBJECT_INTENTS: readonly SceneObjectIntent\[\] = \['inspect', 'open', 'lockpick', 'take', 'use', 'topple', 'ignite', 'pray'\]/u)
  assert.match(decodePropSource, /pointOfInterest: rawInteraction\.pointOfInterest === true/u)
  assert.doesNotMatch(decodePropSource, /detailKey|rewardKey/u)
})

test('клик выбирает интерактивный prop, а его кнопки блокируются вдали, не в свой ход и во время команды', () => {
  assert.match(appSource, /const sceneObject = sceneObjectByCell\.get\(cellKey\)/u)
  assert.match(appSource, /setSelectedSceneObjectId\(\(current\) => current === sceneObject\.id \? null : sceneObject\.id\)/u)
  // Молитва добавляет к общим условиям свои: суточный слот героя уже мог быть
  // закрыт, полученное благословение — ещё не израсходовано, а в бою обращение
  // к богам движок не принимает вовсе. Кнопка обязана погаснуть до клика, а не
  // после отказа.
  // Взлом добавляет к общим условиям своё: без владения воровскими
  // инструментами движок откажет, и кнопка обязана погаснуть до клика.
  assert.match(appSource, /disabled=\{!canAct \|\| tacticalBusy \|\| unavailable \|\| \(intent === 'pray' && \(blessingHeld \|\| !blessingAvailable \|\| combatActive\)\) \|\| \(intent === 'lockpick' && !lockpickAllowed\)\}/u)
  assert.match(appSource, /sceneObjectsAtHand\.find/u)
  assert.match(appSource, /boardOverlay\.push\(\{ \.\.\.cell, kind: 'command-range' \}\)/u)
  assert.match(boardSource, /hotspot\?: React\.ReactNode/u)
  assert.match(boardSource, /className="board-hotspots"/u)
  assert.match(appSource, /hotspot: sceneObject \? <span/u)
  assert.match(appSource, /tabIndex=\{0\}/u)
  assert.doesNotMatch(appSource, /tabIndex=\{cellIsInteractive \? -1 : 0\}/u)
  assert.doesNotMatch(appSource, /style=\{\{\s*position: 'absolute',\s*inset: '12%'/u)
})

test('адрес иллюстрации локации строится и у игрока: id берётся из карты мира, когда сцена его не несёт', () => {
  // В старой сцене канонического id может не быть. Для неё сохраняется
  // запасной источник worldMap.currentLocationId.
  assert.match(appTsxSource, /const locationArtId = state\.scene\.location_id \?\? state\.worldMap\?\.currentLocationId \?\? ''/u)
  assert.match(appTsxSource, /\/api\/campaigns\/\$\{state\.sessionCode\}\/locations\/\$\{encodeURIComponent\(locationArtId\)\}\/illustration/u)
})

test('свободное действие не подменяется готовыми подсказками рассказчика', () => {
  assert.doesNotMatch(appSource, /visibleSuggestions|action-suggestions|Подсказки рассказчика/u)
  assert.doesNotMatch(sessionSource, /suggestions/u)
  assert.doesNotMatch(typesSource, /suggestions/u)
  assert.doesNotMatch(narratorPrompt, /"suggestions"/u)
  assert.match(appSource, /aria-label="Действие своими словами"/u)
})
