// Свободные заявки, которые сервер читал не тем путём (план Асстохана, 1.7):
// просьба к маршалу о страже уходила команде проклятого рыцаря, вопрос без
// открытого уточнения подставлял прошлую, не связанную с ним заявку, а реплика
// со словом «потом» внутри прямой речи дробилась на два хода.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaignState } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const HERO = 'boren'

async function setup(t, code) {
  const server = await startTestServer(t)
  const { client: admin } = await setupAdmin(server)
  const state = await createCampaignState({
    code, worldTemplateId: 'astohan-plains', rulesetId: 'dnd_5e_2014', campaignMode: 'adventure',
    players: [{ id: HERO, character: 'Борен', name: 'Борен', hp: 40, maxHp: 40, armor: 16, abilities: { str: 16, cha: 12 }, inventory: [] }],
  })
  await createCampaign(admin, { code, state })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: [HERO] })
  return { player }
}

const say = (client, code, action, key, extra = {}) =>
  client.post('/api/narrate', { campaign_id: code, actor_id: HERO, action, idempotency_key: key, ...extra })

test('просьба к маршалу о страже не становится упокоением рыцаря', { timeout: runnerTimeout(120_000) }, async (t) => {
  const code = 'KNIGHT-MISS'
  const { player } = await setup(t, code)
  const response = await say(player, code, 'Убеждаю маршала Ивару дать нам отряд стражи в сопровождение', 'ask-guards', { npc_id: 'astohan-ivara' })
  const body = response.body ?? {}
  assert.notEqual(body.code, 'SCENARIO_KNIGHT_NOT_PRESENT', JSON.stringify(body).slice(0, 300))
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300))
  assert.doesNotMatch(String(body.narration ?? ''), /рыцар\p{L}* сейчас здесь нет/iu)
})

test('та же просьба без названного собеседника тоже не уходит рыцарю', { timeout: runnerTimeout(120_000) }, async (t) => {
  const code = 'KNIGHT-FREE'
  const { player } = await setup(t, code)
  const response = await say(player, code, 'Убеждаю маршала дать нам стражу в сопровождение', 'ask-guards-free')
  const body = response.body ?? {}
  assert.notEqual(body.code, 'SCENARIO_KNIGHT_NOT_PRESENT', JSON.stringify(body).slice(0, 300))
  assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300))
})

test('вопрос без открытого уточнения не цитирует прошлую заявку', { timeout: runnerTimeout(120_000) }, async (t) => {
  const code = 'STALE-QUESTION'
  const { player } = await setup(t, code)
  const ask = async (action, key) =>
    String(expectStatus(await say(player, code, action, key, { request_kind: 'question' })).narration ?? '')
  const first = await ask('Могу ли я поджечь факелом занавес у дальней стены?', 'question-1')
  assert.ok(first.length > 0, 'первый вопрос получил ответ')
  const second = await ask('Могу ли я вылечить раненого своим вторым дыханием?', 'question-2')
  assert.doesNotMatch(second, /Сохраняю исходную заявку/u, second)
  assert.doesNotMatch(second, /занавес/iu, second)
})

test('«потом» в прямой речи не дробит реплику на два хода', { timeout: runnerTimeout(120_000) }, async (t) => {
  const code = 'SPEECH-SPLIT'
  const { player } = await setup(t, code)
  const action = 'Кладу перед Мирой пять золотых: «Это тебе за память. Кто расспрашивает о проезжающих отрядах и кому потом передаёт?»'
  const body = expectStatus(await say(player, code, action, 'bribe'))
  assert.equal(body.plan_turn_ids, undefined, 'заявка — один ход, а не план из шагов')
  assert.notEqual(body.clarification?.action, 'передаёт?»', JSON.stringify(body.clarification ?? null))
  assert.doesNotMatch(String(body.narration ?? ''), /хочет добиться: «передаёт/u)
})
