// Разговор с вариантами через основной сайт: проекция вариантов игроку,
// команда своим героем, ответ собеседника в летописи, повтор ключа, отказы.
// Этап 1 `docs/offline-playable-plan.md`: король Арес отвечает по-авторски, а не
// «Больше мне сказать нечего».
import assert from 'node:assert/strict'
import test from 'node:test'

import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
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
