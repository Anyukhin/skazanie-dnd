// Голос хранителя знаний: ответ «что мы знаем о…» звучит репликой ведущего,
// а материал по-прежнему отбирает сервер (`answerKnownLore`). Замеры
// 2026-10-10: «Из того, что вы нашли: … Вам говорили — …» судья читал как
// служебную сводку.
import assert from 'node:assert/strict'
import test from 'node:test'

import { LoreVoice, renderLorePlan, validateLorePlan, verifyLoreAnswer } from '../server/lore-voice.mjs'
import { answerKnownLore } from '../server/player-request-router.mjs'
import { scriptedLlm } from './kit/llm.mjs'

const material = {
  found: ['На корме выжжена чайка с перебитым крылом — знак артели Ворониных.'],
  heard: [{ who: 'Марен', line: 'Баркас «Чайка» видели у северной отмели в ночь грозы.' }],
  known: [],
  lead: [{ name: 'Борс', role: 'рыбак' }],
  hook: '',
  unknown: false,
}

test('план пересказа обязан ссылаться на весь серверный материал', () => {
  const plan = { plan: [{ kind: 'found', index: 0 }, { kind: 'heard', index: 0 }, { kind: 'lead', index: 0 }] }
  assert.equal(validateLorePlan(plan, material).valid, true)
  assert.match(validateLorePlan({ plan: [{ kind: 'heard', index: 0 }] }, material).reasons.join(), /missing_found:0/u)
  assert.match(validateLorePlan({ answer: 'Марен всё видела.' }, material).reasons.join(), /plan_required|extra_fields/u)
  assert.equal(verifyLoreAnswer('Марен всё видела.', material).valid, false)
  assert.match(renderLorePlan(plan.plan, material), /Марен: «Баркас «Чайка» видели/u)
})

test('временная реплика хранителя сохраняется серверной строкой', async () => {
  const testimony = 'Три месяца требует с поселений золото и сведения, десять дней назад сжёг Пепельную заставу.'
  const source = {
    found: [], heard: [{ who: 'Король Арес', line: testimony }], known: [], lead: [], hook: '', unknown: false,
  }
  const lie = { answer: 'Король Арес потребовал от поселений золото, а заставу сожгли три месяца назад.' }
  assert.equal(validateLorePlan(lie, source).valid, false)
  const voice = new LoreVoice({ llmClient: scriptedLlm([lie]) })
  assert.equal(await voice.retell({ question: 'Что мы знаем о Пепельной заставе?', material: source }), null)
  const quoted = renderLorePlan([{ kind: 'heard', index: 0 }], source)
  assert.equal(quoted, `Вам говорили — Король Арес: «${testimony}»`)
})

test('голос хранителя пересказывает материал, а не прошедший проверку ответ уступает серверному', async () => {
  const plan = { plan: [{ kind: 'found', index: 0 }, { kind: 'heard', index: 0 }, { kind: 'lead', index: 0 }] }
  const voice = new LoreVoice({ llmClient: scriptedLlm([plan]) })
  assert.equal((await voice.retell({ question: 'Что мы знаем о баркасе?', material })).narration, renderLorePlan(plan.plan, material))
  const inventing = new LoreVoice({ llmClient: scriptedLlm([{ plan: plan.plan, text: 'Грейвз' }]) })
  assert.equal(await inventing.retell({ question: 'Что мы знаем о баркасе?', material }), null)
  assert.equal(await new LoreVoice().retell({ question: 'Что мы знаем?', material }), null, 'без модели — серверный ответ')
})

test('серверный ответ несёт материал, отобранный тем же правилом, что и текст', () => {
  const state = {
    scene: { location: 'Старый маяк' },
    social: {
      npcs: [{ id: 'npc:maren', name: 'Марен', role: 'Смотритель маяка', location: 'Старый маяк', visibility: 'party' }],
      conversations: [{ id: 'conversation:maren-1', npc_id: 'npc:maren', hero_id: 'hero', visibility: 'party', npc_reply: 'Баркас «Чайка» видели у северной отмели в ночь грозы.' }],
    },
  }
  const answer = answerKnownLore('Что мы знаем о баркасе?', state, { viewer: { playerId: 'hero' } })
  assert.equal(answer.lore_material.heard[0].who, 'Марен')
  assert.match(answer.lore_material.heard[0].line, /северной отмели/u)
  assert.match(answer.narration, /северной отмели/u, 'текст и материал — из одного отбора')
})

test('оркестратор подставляет пересказ хранителя и не выпускает материал наружу', async () => {
  const { GameOrchestrator } = await import('../server/game-orchestrator.mjs')
  const { RulesEngine } = await import('../server/rules-engine.mjs')
  const plan = { plan: [{ kind: 'found', index: 0 }, { kind: 'heard', index: 0 }] }
  const game = new GameOrchestrator({ rulesEngine: new RulesEngine({ diceService: {} }), eventStore: { load: async () => ({}) }, loreVoice: new LoreVoice({ llmClient: scriptedLlm([plan]) }) })
  const served = { narration: 'Из того, что вы нашли: …', provider: 'AgentWorldkeeper', lore_material: material }
  const voiced = await game.voiceLore(served, { message: 'Что мы знаем о баркасе?', state: { scene: { location: 'Старый маяк' } }, playerId: 'hero' })
  assert.equal(voiced.narration, renderLorePlan(plan.plan, material))
  assert.equal(voiced.provider, 'AgentWorldkeeper', 'приватность ответа хранителя прежняя')
  assert.equal('lore_material' in voiced, false)
  const plain = await new GameOrchestrator({ rulesEngine: new RulesEngine({ diceService: {} }), eventStore: { load: async () => ({}) } }).voiceLore(served, { message: 'Что мы знаем?', state: {}, playerId: 'hero' })
  assert.equal(plain.narration, 'Из того, что вы нашли: …')
  assert.equal('lore_material' in plain, false)
})
