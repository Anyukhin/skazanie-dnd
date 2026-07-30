import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const sessionSource = await readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const mapClientSource = await readFile(new URL('../src/tactical-map-client.ts', import.meta.url), 'utf8')
const typesSource = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')

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
    ['take', 'Взять'],
    ['use', 'Использовать'],
  ]) {
    assert.match(appSource, new RegExp(`${intent}: '${label}'`, 'u'))
  }
})

test('декодер карты сохраняет только публичный контракт взаимодействия', () => {
  const decodePropSource = mapClientSource.slice(
    mapClientSource.indexOf('function decodeProp'),
    mapClientSource.indexOf('function decodeZone'),
  )
  assert.match(mapClientSource, /SCENE_OBJECT_INTENTS: readonly SceneObjectIntent\[\] = \['inspect', 'open', 'take', 'use'\]/u)
  assert.match(decodePropSource, /pointOfInterest: rawInteraction\.pointOfInterest === true/u)
  assert.doesNotMatch(decodePropSource, /detailKey|rewardKey/u)
})

test('клик выбирает интерактивный prop, а его кнопки блокируются вдали, не в свой ход и во время команды', () => {
  assert.match(appSource, /const sceneObject = sceneObjectByCell\.get\(cellKey\)/u)
  assert.match(appSource, /setSelectedSceneObjectId\(\(current\) => current === sceneObject\.id \? null : sceneObject\.id\)/u)
  assert.match(appSource, /disabled=\{!canAct \|\| tacticalBusy \|\| unavailable\}/u)
  assert.match(appSource, /sceneObjectsAtHand\.find/u)
  assert.match(appSource, /boardOverlay\.push\(\{ \.\.\.cell, kind: 'command-range' \}\)/u)
  assert.match(appSource, /const cellIsInteractive = Boolean\(\(canMoveHere \|\| canAimHere\) && !occupied\)/u)
  assert.match(appSource, /canMoveHere && !canAimHere && previewMoveKey === cellKey \? 'move-target'/u)
  assert.match(appSource, /!stateClasses\.length && !cellFeedback\.length && !cellIsInteractive/u)
  assert.doesNotMatch(appSource, /style=\{\{\s*position: 'absolute',\s*inset: '12%'/u)
})

test('свободное действие не подменяется готовыми подсказками рассказчика', () => {
  assert.doesNotMatch(appSource, /visibleSuggestions|action-suggestions|Подсказки рассказчика/u)
  assert.match(appSource, /aria-label="Действие своими словами"/u)
})
