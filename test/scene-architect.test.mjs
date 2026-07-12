import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition } from '../server/adventure-director.mjs'
import { generateDynamicSceneMap } from '../server/dynamic-map.mjs'
import { SceneArchitectAgent, interpretResolvedPartyDecision } from '../server/scene-architect.mjs'
import { SCENE_COMMERCE_PLAN_VERSION, defaultSceneShopIntent } from '../server/scene-commerce.mjs'

const archiveState = {
  sessionCode: 'LAB-ARCHIVE',
  scene: { title: 'Затопленный архив', location: 'Подземный архив Норвина', objective: 'Раскрыть тайну печати архивариуса', turn: 8, cells: [] },
  adventure: { chapter: 2, currentHook: 'Печать архивариуса указывает на скрытый зал', visitedLocations: ['Подземный архив Норвина'], history: [] },
  agentInteraction: {
    status: 'resolved', resolvedOptionId: 'city',
    options: [{ id: 'city', label: 'Уходим в город — отступаем и ищем другой путь' }, { id: 'stay', label: 'Остаёмся в архиве' }],
  },
}

test('формулировка «Уходим в город» распознаётся по выбранной опции, а не по тексту инструкции', () => {
  const action = '[РЕШЕНИЕ ГРУППЫ] Уйти из архива в город?: Уходим в город. Если решила остаться — продолжи архив.'
  const result = interpretResolvedPartyDecision(action, archiveState)
  assert.equal(result.kind, 'move')
  assert.equal(result.destinationHint, 'город')
})

test('картограф без модели строит городскую карту и сохраняет печать как незавершённую нить', async () => {
  const decision = 'Уходим в город — отступаем и ищем другой путь, сохранив нить с печатью архивариуса'
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({ action: `[РЕШЕНИЕ ГРУППЫ] ${decision}`, state: archiveState, decision, destinationHint: 'город' })
  const transition = createSceneTransition(planned.sceneArgs, archiveState)

  assert.equal(planned.trace.agent, 'AgentCartographer')
  assert.equal(planned.sceneArgs.map.layout, 'streets')
  assert.deepEqual(planned.shopIntent, defaultSceneShopIntent(planned.sceneArgs))
  assert.equal(planned.shopIntent.action, 'create')
  assert.equal(planned.shopIntent.settlement_type, 'city')
  assert.equal(transition.scene.location, 'Город')
  assert.equal(transition.scene.cells.length, 17 * 11)
  assert.match(transition.adventure.currentHook, /Печать архивариуса/u)
  assert.ok(transition.adventure.unresolvedThreads.includes(archiveState.adventure.currentHook))
  assert.equal(transition.adventure.history.at(-1).status, 'unresolved')
})

test('детерминированный fallback не создаёт стационарную лавку в дикой местности', async () => {
  const architect = new SceneArchitectAgent()
  const planned = await architect.plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Уходим в лес',
    state: archiveState,
    decision: 'Уходим в лес',
    destinationHint: 'лес',
  })

  assert.equal(planned.sceneArgs.map.layout, 'winding')
  assert.equal(planned.shopIntent.action, 'none')
  assert.equal(planned.shopIntent.settlement_type, 'traveling')
  assert.equal(planned.shopIntent.theme, 'provisions')
})

test('модель может предложить только ограниченный commerce intent для нормализованной сцены', async () => {
  const llmClient = {
    model: 'fake-cartographer',
    async completeJson() {
      return {
        title: 'Ремесленный квартал',
        location: 'Большой город Норвин',
        theme: 'городские улицы и кузницы',
        map: { layout: 'streets', width: 19, height: 13 },
        shop_intent: {
          action: 'create',
          settlement_type: 'city',
          theme: 'arms',
          budget_cp: 75_000,
          reason: 'В квартале действует оружейный рынок.',
        },
      }
    },
  }
  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: archiveState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.equal(planned.trace.mode, 'model')
  assert.equal(planned.sceneArgs.location, 'Большой город Норвин')
  assert.deepEqual(planned.shopIntent, {
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: 'create',
    settlement_type: 'city',
    theme: 'arms',
    budget_cp: 75_000,
    reason: 'В квартале действует оружейный рынок.',
  })
})

test('опасные поля commerce proposal целиком откатываются к policy фактической сцены', async () => {
  const llmClient = {
    async completeJson() {
      return {
        title: 'Городская площадь',
        location: 'Город Норвин',
        theme: 'городские улицы',
        map: { layout: 'streets' },
        shop_intent: {
          action: 'none',
          settlement_type: 'village',
          theme: 'healing',
          budget_cp: 900_000,
          reason: 'Попытка подменить торговую policy.',
          stock: [{ catalog_id: 'custom:artifact', base_price_cp: 1 }],
        },
      }
    },
  }
  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: archiveState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.deepEqual(planned.shopIntent, defaultSceneShopIntent(planned.sceneArgs))
})

test('Scene Architect получает только public planning brief без клеток и private memory', async () => {
  let capturedRequest = null
  const llmClient = {
    async completeJson(request) {
      capturedRequest = request
      return {}
    },
  }
  const privateState = structuredClone(archiveState)
  privateState.scene.cells = [{
    x: 7, y: 4, type: 'floor', revealed: false,
    hidden_information: 'CELL-HIDDEN-SECRET', gm_only: 'CELL-GM-SECRET', label: 'SECRET-CELL-LABEL',
  }]
  privateState.scene.gm_only = { trap: 'SCENE-GM-SECRET' }
  privateState.scene.hidden_information = { exit: 'SCENE-HIDDEN-SECRET' }
  privateState.adventure.history = [{
    chapter: 1, title: 'Публичная глава', location: 'Башня', objective: 'Войти', outcome: 'Вход найден',
    gm_only: 'HISTORY-GM-SECRET', hidden_information: 'HISTORY-HIDDEN-SECRET',
  }]
  privateState.adventure.gm_only = { villain: 'ADVENTURE-GM-SECRET' }
  privateState.adventure.hidden_information = { route: 'ADVENTURE-HIDDEN-SECRET' }
  privateState.adventure.npc_private = { archivist: 'NPC-PRIVATE-SECRET' }
  privateState.adventure.private_notes = 'PRIVATE-NOTES-SECRET'

  const planned = await new SceneArchitectAgent({ llmClient }).plan({
    action: '[РЕШЕНИЕ ГРУППЫ] Идём в город',
    state: privateState,
    decision: 'Идём в город',
    destinationHint: 'город',
  })

  assert.ok(capturedRequest)
  const context = JSON.parse(capturedRequest.messages[1].content)
  assert.equal(Object.hasOwn(context.current_scene, 'cells'), false)
  assert.equal(Object.hasOwn(context.current_scene, 'gm_only'), false)
  assert.equal(Object.hasOwn(context.adventure_memory, 'gm_only'), false)
  assert.deepEqual(Object.keys(context.adventure_memory).sort(), [
    'chapter', 'currentHook', 'history', 'unresolvedThreads', 'visitedLocations',
  ])
  const externalPayload = JSON.stringify(context)
  for (const secret of [
    'CELL-HIDDEN-SECRET', 'CELL-GM-SECRET', 'SECRET-CELL-LABEL', 'SCENE-GM-SECRET',
    'SCENE-HIDDEN-SECRET', 'HISTORY-GM-SECRET', 'HISTORY-HIDDEN-SECRET',
    'ADVENTURE-GM-SECRET', 'ADVENTURE-HIDDEN-SECRET', 'NPC-PRIVATE-SECRET', 'PRIVATE-NOTES-SECRET',
  ]) assert.doesNotMatch(externalPayload, new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(planned.sceneArgs), /SECRET/u)
})

test('параметры картографа дают детерминированные карты разных размеров', () => {
  const input = { seed: 'city:free-choice', theme: 'городские улицы', layout: 'streets', width: 19, height: 13, openness: 0.7, featureCount: 8 }
  const first = generateDynamicSceneMap(input)
  assert.deepEqual(first, generateDynamicSceneMap(input))
  assert.equal(first.length, 19 * 13)
  assert.equal(first.find((cell) => cell.x === 1 && cell.y === 6)?.type, 'floor')
  assert.equal(first.filter((cell) => cell.feature).length, 8)
})
