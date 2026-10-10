// Подключение зацепок из предысторий к серверу: стадия `hero-hooks`
// координатора после сохранения комнаты зовёт модель (локальная заглушка
// провайдера), пишет зацепки через общий исполнитель и больше не повторяет
// плетение — ни следующими сохранениями, ни после перезапуска.
import assert from 'node:assert/strict'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'
import { createCampaign, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'

const CODE = 'HOOKS-API'
const SISTER_CLUE = 'Ила ушла в море на баркасе «Чайка», и баркас видели у маяка в ночь её исчезновения.'

function campaignState() {
  return {
    sessionCode: CODE,
    activePlayerId: 'wizard',
    partyMemberIds: ['wizard'],
    scene: { title: 'Таверна «Сеть»', location: 'Таверна «Сеть»', objective: 'Узнать, чей баркас прибило к пирсу', cells: [] },
    players: [{
      id: 'wizard', character: 'Тарвин', role: 'Волшебник · ур. 1', characterClass: 'wizard', background: 'Мудрец', hp: 8, maxHp: 8,
      backstory: 'Три месяца назад моя сестра Ила ушла в море и не вернулась.', bonds: 'Найду Илу, чего бы это ни стоило.',
      characterSetupRequired: false, inventory: [],
    }],
    worldMemory: {
      entities: [{ id: 'loc:tavern', kind: 'location', name: 'Таверна «Сеть»', summary: '', aliases: [], visibility: 'party', tags: [] }],
      facts: [],
    },
    social: {
      npcs: [{ id: 'npc:bors', name: 'Борс', role: 'трактирщик', location: 'Таверна «Сеть»', public_summary: 'Держит таверну.', voice: 'Басит.', visibility: 'party', available: true, known_fact_ids: [] }],
      relationships: {}, conversations: [], promises: [],
    },
  }
}

const isHeroHooksRequest = (request) => (request.body?.messages ?? [])
  .some((message) => String(message?.content ?? '').includes('PROMPT_ID: hero_hooks/v1'))

test('после сохранения комнаты зацепки героя вплетаются один раз и переживают перезапуск', { timeout: runnerTimeout(60_000) }, async (t) => {
  const provider = await startFakeProvider(t, (request) => {
    if (request.path !== '/chat/completions') return null
    if (!isHeroHooksRequest(request)) return chatCompletion({ ok: true })
    return chatCompletion({ heroes: [{
      hero_id: 'wizard', motive: 'Найти сестру Илу',
      hooks: [{ topic: 'пропавшая сестра Ила', clue: SISTER_CLUE, skills: ['investigation'], holder: 'Борс' }],
    }] })
  })
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-hero-hooks-api-',
    env: { ...provider.env, DND_AI_MODEL: 'test/text-model', DND_AI_FALLBACK_MODELS: '' },
  })
  const { client: admin } = await setupAdmin(server, { name: 'Ведущий', email: 'gm@hero-hooks.test', password: 'hero-hooks-password' })
  await createCampaign(admin, { code: CODE, name: 'Серый Причал', state: campaignState() })

  let room = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    room = (await admin.get(`/api/rooms/${CODE}`)).body
    if ((room?.state?.worldMemory?.threads ?? []).some((thread) => thread.id === 'thread:hero-hook:wizard')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const thread = (room?.state?.worldMemory?.threads ?? []).find((entry) => entry.id === 'thread:hero-hook:wizard')
  assert.ok(thread, `личная нить героя не появилась\n${server.output().slice(-2_000)}`)
  assert.equal(thread.title, 'Найти сестру Илу')
  const bors = room.state.social.npcs.find((npc) => npc.id === 'npc:bors')
  assert.equal(bors.known_fact_ids.length, 1, 'хранитель получил зацепку')
  assert.equal(provider.requests.filter(isHeroHooksRequest).length, 1)

  // Ещё одно сохранение комнаты и перезапуск: плетение не повторяется.
  await admin.get(`/api/rooms/${CODE}`)
  await server.restart()
  const restored = (await admin.get(`/api/rooms/${CODE}`)).body
  assert.ok(restored.state.worldMemory.threads.some((entry) => entry.id === 'thread:hero-hook:wizard'))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(provider.requests.filter(isHeroHooksRequest).length, 1, 'одно плетение на героя')
})
