import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'AUTHORED-SPEECH'
const HERO = 'speech-hero'
const ALLY = 'speech-ally'
const ARES = 'astohan-ares'
const IVARA = 'astohan-ivara'
const TASK = 'Какое поручение вы даёте нам?'
const ALIAS = 'Что вы поручите нашему отряду?'
const CLOAK = 'Беру плащ защиты.'
const REPORT = 'Что произошло на Пепельной заставе?'
const legacyAddressed = (action) => `Обращаюсь к Король Арес (король Валедора и прославленный драконоборец): ${action}`
const hero = (id, character) => ({
  id, character, name: character, role: 'Воин · ур. 7', species: 'Человек', background: 'Солдат',
  level: 7, hp: 70, maxHp: 70, armor: 18, speed: 30,
})
const chosen = (result) => result.mechanics?.find((event) => event.event_type === 'DialogueOptionChosen')?.payload

test('свободная реплика NPC выбирает только однозначный доступный вариант и переживает повтор', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-authored-speech-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: CAMPAIGN, bootstrap: {
    partyName: 'Отряд', worldTemplateId: 'astohan-plains', players: [hero(HERO, 'Мирт'), hero(ALLY, 'Лиса')],
  } })
  const { client: player } = await addPlayer(server, gm, CAMPAIGN, { heroIds: [HERO] })
  const { client: otherPlayer } = await addPlayer(server, gm, CAMPAIGN, { heroIds: [ALLY] })
  const room = async (client = player) => expectStatus(await client.get(`/api/rooms/${CAMPAIGN}`)).state
  const narrate = (key, action, extra, client = player) => client.post('/api/narrate', {
    campaignId: CAMPAIGN, actor_id: HERO, npc_id: ARES, request_kind: 'action', idempotency_key: key, action, ...extra,
  })
  const button = (key, option, message = 'Ответ в разговоре') => sendCommand(player, CAMPAIGN, key,
    { command_type: 'ChooseDialogueOption', actor_id: HERO, npc_id: ARES, option_id: option }, { message })

  assert.equal((await room()).scene_dialogues[ARES].options.find((option) => option.id === 'task').asked, false)
  const exact = expectStatus(await narrate('exact', TASK))
  assert.match(exact.narration, /Найдите Саргата/u)
  assert.equal(exact.journal_author, 'Король Арес')
  assert.equal(exact.action_kind, 'social')
  assert.equal(exact.turn_consumed, false)
  assert.equal(chosen(exact).option_id, 'task')
  assert.ok((await room()).scene_dialogues[ARES].options.find((option) => option.id === 'task').asked)

  const alias = expectStatus(await narrate('alias', `«${ALIAS.toUpperCase()}»`))
  const polite = expectStatus(await narrate('polite', 'Ваше величество, скажите, пожалуйста, какое поручение вы даёте нам?', {
    npc_id: undefined, request_kind: undefined,
  }))
  const clicked = expectStatus(await button('button', 'task', TASK))
  assert.deepEqual(chosen(exact), chosen(clicked))
  assert.deepEqual(chosen(alias), chosen(clicked))
  assert.deepEqual(chosen(polite), chosen(clicked))
  assert.equal(alias.narration, exact.narration)
  assert.ok((await room()).messages.some((entry) => entry.author === 'Мирт' && entry.text === `«${ALIAS.toUpperCase()}»`))

  // Форма «Заговорить» → «Сказать» прежней сборки Chromium.
  const oldClient = (key, action, npcId = ARES) => player.post('/api/narrate', {
    action: legacyAddressed(action), campaign_id: CAMPAIGN, idempotency_key: key,
    actor_id: HERO, npc_id: npcId, request_kind: 'action', manual_roll: true,
  })
  for (const [key, action] of [['legacy-task', TASK], ['legacy-alias', ALIAS], ['legacy-vocative', `Ваше величество, ${TASK}`]]) {
    const result = expectStatus(await oldClient(key, action))
    assert.deepEqual(chosen(result), chosen(clicked))
    const repeated = expectStatus(await oldClient(key, action))
    assert.equal(repeated.idempotent_replay, true)
    assert.equal(repeated.narration, exact.narration)
  }
  const legacyMismatchedId = expectStatus(await oldClient('legacy-mismatched-id', TASK, IVARA))
  assert.equal(chosen(legacyMismatchedId), undefined)
  const legacyMismatchedVocative = expectStatus(await oldClient('legacy-mismatched-vocative', `Маршал Ивара Тейн, ${TASK}`))
  assert.equal(chosen(legacyMismatchedVocative), undefined)

  const wrongNpc = expectStatus(await narrate('wrong-npc', TASK, { npc_id: IVARA }))
  assert.equal(chosen(wrongNpc), undefined)
  assert.doesNotMatch(wrongNpc.narration, /Найдите Саргата/u)
  const mismatch = expectStatus(await narrate('mismatched-address', `Маршал Ивара Тейн, ${TASK}`))
  assert.equal(chosen(mismatch), undefined)
  const discussion = expectStatus(await narrate('discussion', TASK, { request_kind: 'discussion' }))
  assert.equal(chosen(discussion), undefined)
  assert.equal(discussion.turn_consumed, false)
  const privateQuestion = expectStatus(await narrate('question', TASK, { request_kind: 'question' }))
  assert.equal(chosen(privateQuestion), undefined)
  assert.doesNotMatch(privateQuestion.narration, /Найдите Саргата/u)
  assert.equal((await narrate('foreign', TASK, { actor_id: ALLY })).status, 403)

  const ambiguous = expectStatus(await narrate('ambiguous', `${TASK} Какова награда?`))
  assert.equal(chosen(ambiguous), undefined)
  assert.ok(ambiguous.mechanics.some((event) => event.event_type === 'NpcConversationRecorded'))
  const newTopic = expectStatus(await narrate('new-topic', 'Где в городе ночуют приезжие?'))
  assert.equal(chosen(newTopic), undefined)
  assert.ok(newTopic.mechanics.some((event) => event.event_type === 'NpcConversationRecorded'))

  const unavailable = expectStatus(await narrate('closed', CLOAK))
  assert.equal(chosen(unavailable), undefined)
  assert.ok(!unavailable.mechanics.some((event) => event.event_type === 'ItemGranted'))
  const lockedFact = expectStatus(await narrate('confession', 'Мы знаем, что случилось с кладкой Вулканиса.'))
  assert.equal(chosen(lockedFact), undefined)
  assert.ok(!lockedFact.mechanics.some((event) => event.event_type === 'KnowledgeRevealed'))
  const open = expectStatus(await narrate('open', 'Можно взглянуть на королевскую оружейную?'))
  assert.equal(chosen(open).option_id, 'armory')
  assert.ok((await room()).scene_dialogues[ARES].options.some((option) => option.id === 'armory-cloak'))
  for (const [key, speech] of [['item-question', 'Беру плащ защиты?'], ['item-negation', 'Не беру плащ защиты.']]) {
    const unrelated = expectStatus(await narrate(key, speech))
    assert.equal(chosen(unrelated), undefined)
    assert.ok(!unrelated.mechanics.some((event) => event.event_type === 'ItemGranted'))
  }
  const item = expectStatus(await narrate('cloak', CLOAK))
  assert.equal(chosen(item).option_id, 'armory-cloak')
  assert.ok(item.mechanics.some((event) => event.event_type === 'ItemGranted'))
  assert.ok(!(await room()).scene_dialogues[ARES].options.some((option) => option.id === 'armory-cloak'))
  assert.ok((await room(otherPlayer)).scene_dialogues[ARES].options.some((option) => option.id === 'armory-cloak'))

  const report = expectStatus(await narrate('report', REPORT, { npc_id: IVARA, request_kind: undefined }))
  assert.equal(chosen(report).option_id, 'ash-watch-report')
  assert.ok(report.mechanics.some((event) => event.event_type === 'KnowledgeRevealed'))
  assert.ok(!(await room()).scene_dialogues[IVARA].options.some((option) => option.id === 'ash-watch-report'))

  for (const result of [alias, item, clicked]) {
    unlinkSync(join(server.storageDir, 'turn-traces', CAMPAIGN, `${result.turn_id}.json`))
  }
  await server.restart()
  assert.equal((await narrate('button', TASK)).body?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await button('alias', 'task', `«${ALIAS.toUpperCase()}»`)).body?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await narrate('alias', TASK)).body?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await narrate('alias', `«${ALIAS.toUpperCase()}»`, { npc_id: IVARA })).body?.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await narrate('alias', `«${ALIAS.toUpperCase()}»`, { actor_id: ALLY }, otherPlayer)).body?.code, 'IDEMPOTENCY_CONFLICT')
  const replay = expectStatus(await narrate('cloak', CLOAK))
  assert.equal(replay.idempotent_replay, true)
  assert.equal(replay.narration, item.narration)
  assert.deepEqual(replay.mechanics, item.mechanics)
  const state = await room()
  assert.equal(state.messages.filter((entry) => entry.text === item.narration).length, 1)
  assert.equal(state.players.find((entry) => entry.id === HERO).inventory.filter((entry) => /плащ защиты/iu.test(entry.name)).length, 1)
  assert.ok(!state.scene_dialogues[IVARA].options.some((option) => option.id === 'ash-watch-report'))

  const ares = (await room(gm)).social.npcs.find((npc) => npc.id === ARES)
  expectStatus(await sendCommand(gm, CAMPAIGN, 'ares-departs', {
    command_type: 'UpsertNpcSocialProfile', actor_id: HERO, npc: { ...ares, available: false },
  }))
  assert.equal((await room()).scene_dialogues[ARES], undefined)
  for (const [key, action, extra] of [
    ['alias', `«${ALIAS.toUpperCase()}»`],
    ['polite', 'Ваше величество, скажите, пожалуйста, какое поручение вы даёте нам?', { npc_id: undefined, request_kind: undefined }],
  ]) {
    const departedReplay = expectStatus(await narrate(key, action, extra))
    assert.equal(departedReplay.idempotent_replay, true)
    assert.equal(departedReplay.narration, exact.narration)
    assert.deepEqual(chosen(departedReplay), chosen(exact))
  }
  const afterDeparture = await narrate('fresh-after-departure', TASK, { authoredDialogueReplay: true })
  assert.equal(afterDeparture.body?.code, 'NPC_UNAVAILABLE')
  assert.equal(chosen(afterDeparture.body), undefined)
  assert.equal((await room()).scene_dialogues[ARES], undefined)
})
