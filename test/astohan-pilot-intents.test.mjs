import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { scenarioTreatyActionFromText } from '../server/scenario-attention.mjs'
import { detectPartyExitRequest, onwardRouteExitRequest, onwardRouteObjective } from '../server/party-exit-intent.mjs'
import { sceneObjectOperationFromText } from '../server/scene-interactions.mjs'
import { proposeAgentInteraction } from '../server/player-request-router.mjs'

const HERO = { id: 'pilot-hero', character: 'Испытатель', level: 7, hp: 60, maxHp: 60, armor: 18, speed: 30 }

async function astohan() {
  return normalizeCampaignState(await new CampaignBootstrapper().create({
    code: 'PILOT-INTENTS',
    worldTemplateId: 'astohan-plains',
    players: [HERO],
  }))
}

function visibleNpc(state, id, name) {
  return {
    ...state,
    scene_npcs: [{ id, name, location: state.scene.location, available: true, alive: true, public_summary: `${name} здесь.` }],
    social: { ...state.social, npcs: [{ id, name, location: state.scene.location, available: true, alive: true, public_summary: `${name} здесь.` }] },
  }
}

test('Асстохан: 15 живых формулировок держатся шести маршрутов пилота', async () => {
  const parser = new IntentParser()
  let state = await astohan()
  const ares = visibleNpc(state, 'astohan-ares', 'Король Арес')
  const gedrik = visibleNpc(state, 'astohan-gedrik', 'Гедрик Сол')
  const oren = visibleNpc(state, 'astohan-oren', 'Орен Фаль')

  const royalAudience = await parser.parse({
    message: 'Расспросить короля Ареса о поручении и Пепельной заставе.',
    playerId: HERO.id,
    visibleState: state,
  })
  assert.equal(royalAudience.intent, 'social')
  assert.deepEqual(royalAudience.targets, ['astohan-ares'])

  const conversation = [
    ['Расспросить Гедрика, почему дракон ищет именно его', gedrik, 'social'],
    ['Спросить Орена о походе на Вулканиса', oren, 'social'],
  ]
  for (const [message, visibleState, expected] of conversation) {
    const parsed = await parser.parse({ message, playerId: HERO.id, visibleState })
    assert.equal(parsed.intent, expected, message)
  }

  for (const message of [
    'Осмотреть обгоревший журнал на заставе',
    'Искать следы когтей у открытых ворот',
  ]) {
    const parsed = await parser.parse({ message, playerId: HERO.id, visibleState: state })
    assert.equal(parsed.intent, 'ability_check', message)
    assert.ok(['perception', 'investigation', 'survival'].includes(parsed.approach), `${message}: ${parsed.approach}`)
  }

  for (const message of [
    'Показать Аресу страницу журнала похода',
    'Предъявить Саргату признание короля',
  ]) {
    const parsed = await parser.parse({ message, playerId: HERO.id, visibleState: ares })
    assert.equal(parsed.intent, 'social', message)
  }

  const travelPhrases = [
    'Пойдём к Лагерю Тихой Стражи',
    'Выдвигаемся в Митглайд по тракту',
    'Отправляемся к Обсидиановому перевалу',
  ]
  for (const message of travelPhrases) {
    const exit = detectPartyExitRequest(message, { knownPlaces: ['Лагерь Тихой Стражи', 'Митглайд', 'Обсидиановый перевал'], presentNames: [] })
    assert.equal(exit?.source, 'text', message)
    assert.ok(exit?.destination, message)
  }

  state = {
    ...state,
    scene: { ...state.scene, location: 'Озеро Двух Отражений', objective: onwardRouteObjective('Озеро Двух Отражений', 'Редстоуновка') },
    worldMap: { ...state.worldMap, locations: state.worldMap.locations.map((location) => location.name === 'Редстоуновка' ? { ...location, known: true } : location) },
  }
  for (const message of ['Продолжим', 'Пойдём дальше']) {
    const exit = onwardRouteExitRequest(message, state)
    assert.equal(exit?.source, 'route', message)
    assert.equal(exit?.destination, 'Редстоуновка', message)
  }

  const passage = sceneObjectOperationFromText('Открыть проход к Жаровне Вулканиса')
  assert.equal(passage?.intent, 'open')
  assert.equal(passage?.namesOtherTarget, true, 'проход не выбирает соседний контейнер')

  const finalState = normalizeCampaignState({ ...state, scene: { ...state.scene, location_id: 'astohan-vulkanis-brazier', location: 'Жаровня Вулканиса' } })
  for (const message of ['Предлагаю Саргату договор', 'Давайте договоримся с драконом', 'Покажем Саргату признание и попросим мира']) {
    assert.deepEqual(scenarioTreatyActionFromText(message, finalState), { action: 'treaty' }, message)
  }
})

test('Открытие уже найденного прохода с перевала предлагает голосование по ID', () => {
  const state = {
    scene: { location_id: 'astohan-obsidian-pass', location: 'Обсидиановый перевал' },
    worldMap: { locations: [{ id: 'astohan-vulkanis-brazier', name: 'Жаровня Вулканиса', known: true }] },
  }
  const phrase = 'Открыть проход к Жаровне Вулканиса.'
  const interaction = proposeAgentInteraction(phrase, state)
  assert.equal(interaction?.type, 'vote')
  assert.equal(interaction?.destinationLocationId, 'astohan-vulkanis-brazier')
  state.worldMap.locations[0].known = false
  assert.equal(proposeAgentInteraction(phrase, state), null)
})
