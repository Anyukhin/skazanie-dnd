// Голос хранителя знаний: ответ «что мы знаем о…» звучит репликой ведущего,
// а материал по-прежнему отбирает сервер (`answerKnownLore`). Замеры
// 2026-10-10: «Из того, что вы нашли: … Вам говорили — …» судья читал как
// служебную сводку.
import assert from 'node:assert/strict'
import test from 'node:test'

import { LoreVoice, verifyLoreAnswer } from '../server/lore-voice.mjs'
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

test('проверка пересказа: без новых имён, чисел и служебных слов, находки и показания на месте', () => {
  const good = 'Вы сами видели на корме выжженную чайку с перебитым крылом — так метит лодки артель Ворониных. А Марен рассказывала, что баркас видели у северной отмели в ночь грозы. Кто им правил — пока загадка; Борс, рыбак, может знать больше.'
  assert.equal(verifyLoreAnswer(good, material, { location: 'Старый маяк', hero: 'Мирель' }).valid, true, JSON.stringify(verifyLoreAnswer(good, material).reasons))
  assert.match(verifyLoreAnswer(`${good} Капитан Грейвз тоже что-то скрывает.`, material).reasons.join(), /invented_names/u)
  assert.match(verifyLoreAnswer(`${good} Это было 3 дня назад.`, material).reasons.join(), /digits/u)
  assert.match(verifyLoreAnswer('Марен рассказывала про отмель и грозу, а больше вы ничего не знаете о баркасе.', material).reasons.join(), /lost_finding/u)
})

test('голос хранителя пересказывает материал, а не прошедший проверку ответ уступает серверному', async () => {
  const told = 'Вы сами видели на корме выжженную чайку с перебитым крылом — знак артели Ворониных. Марен говорила, что баркас видели у северной отмели в ночь грозы.'
  const voice = new LoreVoice({ llmClient: scriptedLlm([{ answer: told }]) })
  assert.equal((await voice.retell({ question: 'Что мы знаем о баркасе?', material })).narration, told)
  const inventing = new LoreVoice({ llmClient: scriptedLlm([{ answer: `${told} Его хозяин — Грейвз из Нижнего города.` }]) })
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
  const told = 'Вы сами видели на корме выжженную чайку с перебитым крылом — знак артели Ворониных. Марен говорила, что баркас видели у северной отмели в ночь грозы.'
  const game = new GameOrchestrator({ rulesEngine: new RulesEngine({ diceService: {} }), eventStore: { load: async () => ({}) }, loreVoice: new LoreVoice({ llmClient: scriptedLlm([{ answer: told }]) }) })
  const served = { narration: 'Из того, что вы нашли: …', provider: 'AgentWorldkeeper', lore_material: material }
  const voiced = await game.voiceLore(served, { message: 'Что мы знаем о баркасе?', state: { scene: { location: 'Старый маяк' } }, playerId: 'hero' })
  assert.equal(voiced.narration, told)
  assert.equal(voiced.provider, 'AgentWorldkeeper', 'приватность ответа хранителя прежняя')
  assert.equal('lore_material' in voiced, false)
  const plain = await new GameOrchestrator({ rulesEngine: new RulesEngine({ diceService: {} }), eventStore: { load: async () => ({}) } }).voiceLore(served, { message: 'Что мы знаем?', state: {}, playerId: 'hero' })
  assert.equal(plain.narration, 'Из того, что вы нашли: …')
  assert.equal('lore_material' in plain, false)
})
