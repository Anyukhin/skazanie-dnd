import assert from 'node:assert/strict'
import test from 'node:test'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('пересказ известных сведений не переносит срок и действие с дракона на рассказавшего о нём короля', { timeout: runnerTimeout(90_000) }, async (t) => {
  const code = 'LORE-ASH-WATCH', heroId = 'ilyva'
  const source = 'Саргат три месяца требует с поселений золото и сведения, десять дней назад сжёг Пепельную заставу.'
  const privateLine = 'На Пепельной заставе под печью спрятан ларец.'
  const fabrication = 'Вы знаете, что Пепельная застава была сожжена три месяца назад, и это произошло после того, как Король Арес потребовал от поселений золото и сведения.'
  const requests = []
  const provider = await startFakeProvider(t, (request) => {
    const prompt = request.body?.messages?.find(message => message.role === 'system')?.content ?? ''
    if (request.path === '/chat/completions' && prompt.includes('PROMPT_ID: lore_keeper/')) {
      requests.push(request.body.messages)
      if (requests.length === 3) return chatCompletion({ plan: [{ kind: 'heard', index: 0 }] })
      return chatCompletion({ answer: requests.length === 1 ? fabrication : `Король Арес сказал: «${source}» ${fabrication}` })
    }
    return chatCompletion({ ok: true })
  })
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-lore-testimony-',
    env: { ...provider.env, DND_AI_MODEL: 'test/text-model', DND_AI_FALLBACK_MODELS: '' },
  })
  const { client: admin } = await setupAdmin(server)
  await createCampaign(admin, { code, state: {
    sessionCode: code, scene: { location: 'Штормберг' }, activePlayerId: heroId,
    players: [{ id: heroId, character: 'Ильва', role: 'Воин', hp: 12, maxHp: 12, inventory: [], characterSetupRequired: false }],
    social: {
      npcs: [{ id: 'ares', name: 'Король Арес', role: 'король', location: 'Штормберг', visibility: 'party' }],
      conversations: [
        { id: 'king-party', hero_id: heroId, npc_id: 'ares', visibility: 'party', npc_reply: source },
        { id: 'king-private', hero_id: 'other-hero', npc_id: 'ares', visibility: 'specific_player', npc_reply: privateLine },
      ],
    },
  } })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: [heroId] })
  for (const key of ['changed-testimony', 'false-claim-after-quote', 'valid-source-order']) {
    const answer = expectStatus(await player.post('/api/narrate', {
      campaign_id: code, actor_id: heroId, action: 'Что мы уже знаем о Пепельной заставе?', idempotency_key: key,
    }))
    assert.equal(answer.provider, 'AgentWorldkeeper')
    assert.equal(answer.lore_voiced === true, key === 'valid-source-order')
    if (key === 'valid-source-order') assert.equal(answer.prompt_version, 'lore_keeper/v2')
    assert.match(answer.narration, /Король Арес/u)
    assert.ok(answer.narration.includes(source.slice(0, -1)), 'игрок видит показания с исходным субъектом и обоими сроками')
    assert.ok(!answer.narration.includes(fabrication) && !JSON.stringify(answer).includes(privateLine))
  }
  assert.equal(requests.length, 3, 'проверены подмена, приписка к цитате и корректный план')
  assert.ok(!JSON.stringify(requests).includes(privateLine))
})
