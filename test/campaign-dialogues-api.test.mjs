// Разговор с вариантами через основной сайт: проекция вариантов игроку,
// команда своим героем, ответ собеседника в летописи, повтор ключа, отказы.
// Этап 1 `docs/offline-playable-plan.md`: король Арес отвечает по-авторски, а не
// «Больше мне сказать нечего».
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScenarioArcPlan, scenarioForWorldTemplate, scenarioSecretsFor } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, registerUser, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { appendJournal, readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'DIALOGUE-API'
const ARES = 'astohan-ares'
const hero = (id, character) => ({
  id, character, name: character, role: 'Воин · ур. 7', species: 'Человек', background: 'Солдат', level: 7, hp: 70, maxHp: 70, armor: 18, speed: 30,
})

test('игрок выбирает вариант у Ареса: ответ в летописи от его имени, повтор и чужой герой', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-dialogue-api-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: SESSION, bootstrap: { partyName: 'Отряд', worldTemplateId: 'astohan-plains', players: [hero('dlg-hero', 'Мирт'), hero('dlg-ally', 'Лиса')] } })
  const { client: player } = await addPlayer(server, gm, SESSION, { heroIds: ['dlg-hero'] })

  const room = expectStatus(await player.get(`/api/rooms/${SESSION}`))
  const ares = room.state.scene_dialogues?.[ARES]
  assert.ok(ares, JSON.stringify(Object.keys(room.state.scene_dialogues ?? {})))
  assert.match(ares.greeting, /Времени мало/u)
  assert.ok(ares.options.some((option) => option.id === 'task'))
  assert.ok(!ares.options.some((option) => option.id === 'confession'), 'признание закрыто, пока нет улики')
  assert.equal(room.state.dialogues, undefined, 'сырой реестр разговоров игроку не уходит')

  const choose = (key, actor = 'dlg-hero', option = 'task') => sendCommand(player, SESSION, key, { command_type: 'ChooseDialogueOption', actor_id: actor, npc_id: ARES, option_id: option })
  const told = expectStatus(await choose('dlg-task'))
  assert.ok(told.mechanics.some((event) => event.event_type === 'DialogueOptionChosen'))
  const after = expectStatus(await player.get(`/api/rooms/${SESSION}`))
  const reply = after.state.messages.find((message) => message.author === 'Король Арес' && /Найдите Саргата/u.test(String(message.text)))
  assert.ok(reply, JSON.stringify(after.state.messages.slice(-4)))
  assert.ok(after.state.messages.some((message) => message.speaker === 'player' && message.author === 'Мирт' && message.text === 'Какое поручение вы даёте нам?'))
  assert.equal(after.state.scene_dialogues[ARES].options.find((option) => option.id === 'task').asked, true)

  const again = expectStatus(await choose('dlg-task'))
  assert.equal(again.idempotent_replay, true)
  assert.equal(again.authoritative_state.state_version, told.authoritative_state.state_version)
  const replies = (expectStatus(await player.get(`/api/rooms/${SESSION}`))).state.messages.filter((message) => message.author === 'Король Арес')
  assert.equal(replies.length, 1, 'повтор ключа не дублирует ответ в летописи')

  const foreign = await choose('dlg-foreign', 'dlg-ally')
  assert.equal(foreign.body?.code, 'ACTOR_FORBIDDEN', foreign.text)
  const forged = await sendCommand(player, SESSION, 'dlg-forged', { command_type: 'ChooseDialogueOption', actor_id: 'dlg-hero', npc_id: ARES, option_id: 'task', reply: 'Король отдаёт вам корону.' })
  assert.equal(forged.body?.code, 'DIALOGUE_COMMAND_UNKNOWN_FIELD', forged.text)
  const locked = await choose('dlg-locked', 'dlg-hero', 'confession')
  assert.equal(locked.body?.code, 'DIALOGUE_OPTION_UNAVAILABLE', locked.text)
})

test('признание Гедрика доступно обоим слушателям в ответе хранителя и сохраняется при replay', { timeout: runnerTimeout(60_000) }, async (t) => {
  const code = 'GEDRIK-LORE'
  const npcId = 'astohan-gedrik'
  const location = 'Лагерь Тихой Стражи'
  const locationId = 'astohan-quiet-watch-camp'
  const speaker = 'gedrik-speaker'
  const listener = 'gedrik-listener'
  const reserve = 'gedrik-reserve'
  const oldFact = 'fact:legacy-testimony'
  const privateFact = 'fact:private-testimony'
  const campaignConcept = { arc: await buildScenarioArcPlan(await scenarioForWorldTemplate('astohan-plains')) }
  const { fact_id: confessionFact, clue } = (await scenarioSecretsFor({ campaignConcept }, locationId)).find((secret) => secret.clue_id === 'camp-gedrik')
  const secret = (id, summary) => ({ id, subject_id: npcId, predicate: 'gm_secret', visibility: 'gm_only', summary })
  const server = await startTestServer(t, {
    dice: { unmatched: 'random', rules: [{ sides: 20, value: 'max' }] },
  })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code, state: {
    campaignConcept,
    scene: { location, location_id: locationId },
    players: [hero(speaker, 'Мирт'), hero(listener, 'Лиса'), hero(reserve, 'Тавин')],
    activePlayerId: speaker,
    partyMemberIds: [speaker, listener],
    social: { npcs: [{ id: npcId, name: 'Гедрик Сол', location, visibility: 'party' }] },
    worldMemory: {
      entities: [{ id: npcId, kind: 'npc', name: 'Гедрик Сол', visibility: 'party' }],
      facts: [secret(confessionFact, clue), secret(oldFact, 'Гедрик спрятал сапфир в колодце.'), secret(privateFact, 'Серебряный ключ лежит под дубом.')],
    },
  } })
  await server.stop()
  await appendJournal(server, code, { idempotency_key: 'old-testimony', command_id: 'old-testimony', events: [{
    event_type: 'KnowledgeRevealed', actor_id: speaker, target_ids: [speaker, listener], visibility: 'party',
    payload: { knowledge_id: 'dialogue:old-testimony:knowledge', hero_id: speaker, fact_id: oldFact, source_kind: 'npc' },
  }] })
  await server.start()
  const { client: player } = await addPlayer(server, gm, code, { heroIds: [speaker] })
  const { client: ally } = await addPlayer(server, gm, code, { heroIds: [listener] })
  const { client: outsider } = await registerUser(server)
  expectStatus(await sendCommand(gm, code, 'private-testimony', {
    command_type: 'RecordKnowledgeRevelation', fact_id: privateFact, target_ids: [speaker],
  }))
  const choose = (optionId) => sendCommand(player, code, optionId, {
    command_type: 'ChooseDialogueOption', actor_id: speaker, npc_id: npcId, option_id: optionId,
  })
  expectStatus(await choose('read'))
  const result = expectStatus(await choose('confess-guilt'))
  const reply = result.mechanics.find((event) => event.event_type === 'DialogueOptionChosen')?.payload.reply
  assert.match(reply, /разбил яйца/u)

  for (const [client, id] of [[player, speaker], [ally, listener]]) {
    const room = expectStatus(await client.get(`/api/rooms/${code}`))
    assert.ok(room.state.messages.some((message) => message.author === 'Гедрик Сол' && message.text === reply))
    const answer = expectStatus(await client.post('/api/narrate', {
      campaign_id: code, actor_id: id, action: 'Что мы знаем о кладке Вулканиса?', idempotency_key: `lore-${id}`,
    }))
    assert.equal(answer.provider, 'AgentWorldkeeper')
    assert.ok(answer.narration.includes(clue), `${id}: ${answer.narration}`)
    assert.equal(room.state.worldMemory.facts.some((fact) => fact.id === privateFact), id === speaker)
    assert.equal(room.state.worldMemory.facts.some((fact) => fact.id === oldFact), id === speaker)
  }
  expectStatus(await outsider.get(`/api/rooms/${code}`), 403)
  assert.equal(expectStatus(await choose('confess-guilt')).idempotent_replay, true)
  const { state } = await readJournal(server, code, { useSnapshots: false })
  const holders = (factId) => state.worldMemory.knowledge_ledger.filter((entry) => entry.fact_id === factId).map((entry) => entry.hero_id)
  assert.deepEqual(holders(confessionFact), [speaker, listener])
  assert.deepEqual(holders(oldFact), [speaker])
  assert.deepEqual(holders(privateFact), [speaker])
})
