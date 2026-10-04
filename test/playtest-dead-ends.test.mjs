// Корпус живых тупиков (eval/playtest-dead-ends.json) — сторож критерия 1 цели
// «Первый вечер без ведущего» (docs/playable-goal.md). Каждая строка — фраза,
// на которой живая игра упиралась в тупик, и то, что детерминированный слой
// обязан с ней сделать теперь. Состояние — свежая кампания авторского мира без
// модели: так прогон повторяем и не стоит денег.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { classifyPartyDecision, objectiveRemainder } from '../server/party-exit-intent.mjs'
import { proposeAgentInteraction, proposeRoutedTravel, unknownDestinationReply } from '../server/player-request-router.mjs'
import { actorPosition } from '../server/rules-engine.mjs'
import { nearestSceneObjectCommand } from '../server/scene-interactions.mjs'
import { freeActionDiscoveryCommands } from '../server/world-memory.mjs'

const corpus = JSON.parse(readFileSync(new URL('../eval/playtest-dead-ends.json', import.meta.url), 'utf8'))

const hero = {
  id: 'hero', character: 'Брам', name: 'Игрок', role: 'Жрец · ур. 1',
  characterClass: 'cleric', level: 1, hp: 11, maxHp: 11, armor: 18, speed: 25,
  proficiency: 2, abilities: { str: 10, dex: 14, con: 15, int: 12, wis: 16, cha: 8 },
  inventory: [], x: 3, y: 2,
}

const campaign = () => new CampaignBootstrapper().create({ code: 'DEAD-ENDS', worldTemplateId: corpus.world_template_id, players: [hero] })

const checks = {
  async social_target(state, entry) {
    const intent = await new IntentParser().parse({ message: entry.text, playerId: 'hero', visibleState: state })
    const npc = state.social.npcs.find((candidate) => candidate.name === entry.expect_npc)
    assert.ok(npc, `в мире нет NPC «${entry.expect_npc}»`)
    assert.equal(intent.intent, 'social')
    assert.deepEqual(intent.targets, [npc.id])
    assert.equal(intent.requires_clarification, false)
  },
  async no_scene_object(state, entry) {
    const command = nearestSceneObjectCommand({ props: state.scene.map?.props ?? [], actorPosition: actorPosition(state, 'hero'), text: entry.text })
    assert.equal(command, null, `фраза ушла пропсу ${command?.prop_id}`)
  },
  async travel_vote(state, entry) {
    const card = proposeRoutedTravel({ route: 'travel', destination: entry.destination }, state, entry.text)
    assert.equal(card?.type, 'vote', 'вместо голосования — подсказка «напишите…»')
    assert.equal(card.options.some((option) => /бросаем задание/u.test(option)), false)
  },
  // Фраза игрока без модели: карточка ухода с названием места без описания дороги.
  async exit_vote(state, entry) {
    const card = proposeAgentInteraction(entry.text, state)
    assert.equal(card?.type, 'vote', 'вместо голосования — подход к собеседнику или «не понял»')
    assert.equal(card.options.some((option) => /бросаем задание/u.test(option)), false)
    assert.equal(classifyPartyDecision(card.options[0]).destinationHint, entry.expect_destination)
  },
  // Место, которого нет ни на карте мира, ни в сцене: честный ответ, а не
  // голосование и не выдуманная точка. Отряд стоит в `at_location_id`.
  async unknown_place(state, entry) {
    const location = state.worldMap.locations.find((candidate) => candidate.id === entry.at_location_id)
    assert.ok(location, `в мире нет точки «${entry.at_location_id}»`)
    const here = { ...state, scene: { ...state.scene, location: location.name }, worldMap: { ...state.worldMap, currentLocationId: location.id } }
    assert.equal(proposeAgentInteraction(entry.text, here), null)
    const reply = unknownDestinationReply(entry.text, here)
    assert.ok(reply.startsWith(entry.expect_reply_start), reply)
    assert.doesNotMatch(reply, /Отправляемся в/u)
  },
  async objective_remainder(state, entry) {
    assert.equal(objectiveRemainder(state.scene.objective, entry.destination), entry.expect)
  },
  async discovery(state, entry) {
    const commands = freeActionDiscoveryCommands(state, {
      checkEvent: { event_id: `check:${entry.id}`, event_type: 'AbilityCheckResolved', payload: { success: true, skill: entry.skill } },
      skill: entry.skill,
      actionText: entry.text,
    })
    assert.ok(commands.length, 'удачная проверка не дала находки')
    assert.ok(commands.some((command) => command.fact.summary.includes(entry.expect_contains)), commands.map((command) => command.fact.summary).join(' | '))
  },
}

test('корпус живых тупиков: у каждой строки известный вид проверки и происхождение', () => {
  assert.ok(corpus.cases.length >= 10)
  const ids = new Set()
  for (const entry of corpus.cases) {
    assert.ok(checks[entry.kind], `${entry.id}: неизвестный вид «${entry.kind}»`)
    assert.ok(entry.source, `${entry.id}: без происхождения`)
    assert.equal(ids.has(entry.id), false, `${entry.id}: повтор`)
    ids.add(entry.id)
  }
})

for (const entry of corpus.cases) {
  test(`${entry.id}: ${entry.text ?? entry.destination}`, async () => {
    await checks[entry.kind](await campaign(), entry)
  })
}
