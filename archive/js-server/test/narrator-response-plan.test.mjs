import assert from 'node:assert/strict'
import test from 'node:test'

import { Narrator, deterministicNarration, narratorResponsePlan, verifyNarratorFeedback } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

function brief(events = []) {
  return buildNarrationBrief({
    visible_events: events.map(event => ({ actor_id: 'ada', visibility: 'public', ...event })),
    known_environment: {
      scene: {
        id: 'narrator-plan-test', title: 'Зал', objective: 'Найти карту старых троп',
        sensory_anchors: { smell: 'Запах воска', sound: 'Шум дождя', light: 'Тусклый свет' },
      },
      story_context: {
        heroes: [{ id: 'ada', name: 'Ада', is_viewer: true }, { id: 'borin', name: 'Борин' }],
        open_promises: [{ id: 'map', npc: 'Мира', text: 'Мира обещала принести карту старых троп.' }],
      },
    },
  })
}

test('короткий результат отвечает об исходе без обязательной атмосферы и памяти', async () => {
  const input = brief([{ event_type: 'AbilityCheckResolved', payload: { skill: 'acrobatics', ability: 'dex', success: false } }])
  const saved = structuredClone(input)
  const fallback = deterministicNarration(input).narration
  assert.equal(fallback, 'Проверка «Акробатика» завершилась неудачей.')
  assert.deepEqual(input, saved)
  const feedback = verifyNarratorFeedback(fallback, input)
  assert.ok(!feedback.violations.some(entry => ['SENSORY_ANCHOR_OMITTED', 'LINKED_MEMORY_OMITTED'].includes(entry.code)))
  const result = await new Narrator({ asyncFeedback: false }).render(input)
  assert.equal(result.verification.response_plan.speech_act, 'report_result')
  assert.equal(result.verification.origin.source, 'template')
  assert.equal(result.verification.origin.reason, 'no_provider')
  assert.ok(Number.isFinite(result.verification.origin.elapsed_ms))
})

test('декларация с ruling не превращается в действие и не зачитывает внутренние события', () => {
  const input = brief(['ActionDeclared', 'RulingRecorded', 'ObjectiveUpdated'].map(event_type => ({ event_type, payload: {} })))
  assert.equal(narratorResponsePlan(input).speech_act, 'acknowledge_intent')
  assert.equal(deterministicNarration(input).narration, 'Действие ещё не выполнено.')
})

test('травма после неудачного трюка остаётся кратким исходом без атмосферной вставки', () => {
  const input = brief([
    { event_type: 'AbilityCheckResolved', payload: { skill: 'acrobatics', success: false } },
    { event_type: 'RulingRecorded', payload: {} },
    { event_type: 'DieRolled', payload: { expression: '1d4', total: 3 } },
    { event_type: 'DamageApplied', target_ids: ['ada'], payload: { applied_amount: 3, hp_before: 40, hp_after: 37 } },
  ])
  const plan = narratorResponsePlan(input)
  assert.equal(plan.include_scene_detail, false)
  assert.equal(plan.include_memory, false)
  const text = deterministicNarration(input).narration
  assert.match(text, /неудачей.*Ада получает урон/u)
  assert.doesNotMatch(text, /воска|дождя|Мира|карт/iu)
})

test('краткий модельный вход содержит исход и тип травмы, а verifier сохраняет точные числа', async () => {
  const input = brief([
    { event_type: 'AbilityCheckResolved', payload: { skill: 'acrobatics', success: false, total: 13, difficulty: 20 } },
    { event_type: 'DamageApplied', target_ids: ['ada'], payload: { damage_type: 'bludgeoning', applied_amount: 4, hp_before: 40, hp_after: 36 } },
  ])
  input.visible_state_changes = [{ hp_before: 40, hp_after: 36 }]
  let data = ''
  const result = await new Narrator({ llmClient: { complete: async request => {
    data = request.messages[1].content
    return { content: 'Трюк не удался и обернулся ушибом.' }
  } }, asyncFeedback: false }).render(input)
  assert.equal(result.provider, 'Object')
  assert.match(data, /bludgeoning|получает урон/u)
  assert.match(data, /неудачей/u)
  assert.doesNotMatch(data, /"(?:hp_before|hp_after|applied_amount|difficulty|total)"/u)
  assert.equal(input.visible_events[1].payload.applied_amount, 4)
  assert.deepEqual(input.visible_state_changes, [{ hp_before: 40, hp_after: 36 }])
})

test('результат не теряется за служебными событиями в начале commit', () => {
  const input = brief([
    ...['ActionDeclared', 'RulingRecorded', 'ObjectiveUpdated', 'ObjectiveUpdated'].map(event_type => ({ event_type, payload: {} })),
    { event_type: 'DoorStateChanged', payload: { state: 'closed' } },
  ])
  assert.equal(deterministicNarration(input).narration, 'Дверь закрыта.')
})

test('неизвестный исход проверки не объявляется успехом при null числах', () => {
  const input = brief([{ event_type: 'AbilityCheckResolved', payload: { total: null, difficulty: null } }])
  assert.equal(deterministicNarration(input).narration, 'Проверка завершена; её исход пока неизвестен.')
})

for (const [state, text, actor, accepted] of [
  ['open', 'Ада открывает дверь.', 'ada', true],
  ['closed', 'Ада закрывает дверь.', 'ada', true],
  ['closed', 'Ада открывает дверь.', 'ada', false],
  ['open', 'Ада открывает дверь.', 'borin', false],
  ['open', 'Ада открывает сундук.', 'ada', false],
  ['open', 'Ада открывает дверь и решает войти.', 'ada', false],
  ['open', 'Ада открывает дверь. Ада входит в зал.', 'ada', false],
]) test(`agency учитывает героя и событие: ${state}, ${actor}, ${text}`, async () => {
  const input = brief([{ event_type: 'DoorStateChanged', actor_id: actor, payload: { state } }])
  const result = await new Narrator({ llmClient: { complete: async () => ({ content: text }) }, asyncFeedback: false }).render(input)
  assert.equal(result.provider === 'Object', accepted, JSON.stringify(result.verification))
  if (!accepted) assert.ok(result.verification.repaired_from.some(entry => entry.code === 'HERO_AGENCY_NOT_IN_BRIEF'))
})

test('вход, исполненный сервером этим ходом, — не новое решение за героя', async () => {
  // Замер 23 (2026-10-11): дверь открыта Борином и шаг внутрь сделан, а
  // «Борин первым входит в маяк» отбраковывалось в «Вышло: войти первым…».
  const entered = brief([
    { event_type: 'DoorStateChanged', actor_id: 'ada', payload: { state: 'open' } },
    { event_type: 'ActorMoved', actor_id: 'ada', payload: { from: { x: 1, y: 1 }, to: { x: 1, y: 0 } } },
  ])
  const accepted = await new Narrator({ llmClient: { complete: async () => ({ content: 'Ада толкает дверь и первой входит в зал.' }) }, asyncFeedback: false }).render(entered)
  assert.equal(accepted.provider, 'Object', JSON.stringify(accepted.verification))
  const notMoved = brief([{ event_type: 'DoorStateChanged', actor_id: 'ada', payload: { state: 'open' } }])
  const rejected = await new Narrator({ llmClient: { complete: async () => ({ content: 'Ада толкает дверь и первой входит в зал.' }) }, asyncFeedback: false }).render(notMoved)
  assert.notEqual(rejected.provider, 'Object', 'без шага внутрь вход не подтверждён')
})

test('голая проверка не разрешает открыть дверь даже тому же герою', async () => {
  const input = brief([{ event_type: 'AbilityCheckResolved', payload: { success: true } }])
  const result = await new Narrator({ llmClient: { complete: async () => ({ content: 'Ада открывает дверь.' }) }, asyncFeedback: false }).render(input)
  assert.equal(result.provider, 'deterministic-fallback')
  assert.equal(result.verification.origin.reason, 'verification_rejected')
})

test('короткий ответ проверяется целиком: поздняя выдумка не оставляет показанного префикса', async () => {
  const input = brief([{ event_type: 'AbilityCheckResolved', payload: { success: true } }])
  const shown = []
  let calls = 0
  let request
  const result = await new Narrator({ llmClient: { complete: async (value) => {
    calls += 1
    request = value
    value.onDelta('Проверка завершилась успехом.')
    assert.deepEqual(shown, [])
    value.onDelta(' Ада открывает дверь.')
    return { content: 'Проверка завершилась успехом. Ада открывает дверь.' }
  } }, asyncFeedback: false }).render(input, { onProgress: text => shown.push(text) })
  assert.deepEqual(shown, [result.narration])
  assert.ok(calls <= 2, 'не больше одной правки')
  assert.equal(result.provider, 'deterministic-fallback')
  assert.match(request.messages[1].content, /UNTRUSTED_DATA:response_plan/u)
  assert.match(request.messages[1].content, /after_validation/u)
  assert.doesNotMatch(request.messages[1].content, /"memory_focus"|Мира обещала|Шум дождя/u)
})

test('лишний вопрос оценивается после ответа без второй генерации и замены фактов', async () => {
  const input = brief([{ event_type: 'DoorStateChanged', payload: { state: 'open' } }])
  let calls = 0
  const narrator = new Narrator({ llmClient: { complete: async () => {
    calls += 1
    return { content: 'Дверь открыта. Что будете делать?' }
  } } })
  const result = await narrator.render(input)
  assert.equal(result.provider, 'Object')
  assert.equal(calls, 1)
  const feedback = await narrator.awaitFeedback(result.narration)
  assert.ok(feedback.violations.some(entry => entry.code === 'UNNECESSARY_FOLLOWUP_QUESTION'))
})

test('закрывание двери публикуется единственным проверенным финалом', async () => {
  const input = brief([{ event_type: 'DoorStateChanged', payload: { state: 'closed' } }])
  const shown = []
  const narrator = new Narrator({ llmClient: { complete: async ({ onDelta }) => {
    onDelta('Дверь закрыта.')
    assert.deepEqual(shown, [])
    return { content: 'Дверь закрыта.' }
  } }, asyncFeedback: false })
  const result = await narrator.render(input, { onProgress: text => shown.push(text) })
  assert.deepEqual(shown, ['Дверь закрыта.'])
  assert.equal(result.verification.valid, true)
})

test('причины замены различают пустой ответ, ошибку провайдера и принятое повествование', async () => {
  for (const [content, reason, source] of [
    ['', 'empty_response', 'template'],
    [null, 'provider_error', 'template'],
    ['Дверь закрыта.', 'generated', 'llm'],
  ]) {
    const input = brief([{ event_type: 'DoorStateChanged', payload: { state: 'closed' } }])
    const result = await new Narrator({ llmClient: { complete: async () => {
      if (content === null) throw Object.assign(new Error('не публиковать текст ошибки'), { code: 'LLM_TIMEOUT' })
      return { content }
    } }, asyncFeedback: false }).render(input)
    assert.equal(result.verification.origin.reason, reason)
    assert.equal(result.verification.origin.source, source)
    assert.doesNotMatch(result.narration, /не публиковать|LLM_TIMEOUT/u)
  }
})

test('план строится после проекции: личное событие другого игрока его не меняет', () => {
  const projected = buildNarrationBrief({
    viewer: { playerId: 'one', isPartyMember: true },
    visible_events: [{ event_type: 'DoorStateChanged', visibility: 'specific_player', player_id: 'two', payload: { state: 'open' } }],
  })
  assert.deepEqual(narratorResponsePlan(projected), narratorResponsePlan(buildNarrationBrief()))
})

test('реплика героя: план несёт одну новую деталь места, которой не было в последних ответах', async () => {
  // Замер 32 (2026-10-12): «Мара задерживает сухой взгляд» трижды подряд —
  // план сам велел «и взгляд кого-то из реакций».
  const { freshSceneElement } = await import('../server/narrator.mjs')
  const input = buildNarrationBrief({
    visible_events: [],
    known_environment: {
      player_intent: { action: 'Мирель негромко говорит Борину: «Я не уйду, пока не узнаю правду»', roleplay_speech: true },
      scene: {
        title: 'Причал', location: 'Серый Причал',
        landmarks: [{ kind: 'barrels', label: 'бочки', count: 2, where: 'рядом' }, { kind: 'mooring', label: 'причал', count: 1, where: 'к западу' }],
      },
      story_context: { heroes: [{ id: 'mirel', name: 'Мирель', is_viewer: true }, { id: 'borin', name: 'Борин' }] },
    },
  })
  assert.equal(freshSceneElement(input, ['Мокрые бочки поскрипывают у стены.']), 'причал — к западу', 'бочки уже звучали')
  assert.equal(freshSceneElement(input, ['Бочки скрипят.', 'Причал пустеет.']), '')
  const requests = []
  await new Narrator({ asyncFeedback: false, llmClient: { complete: async (value) => { requests.push(value); return { content: 'Со стороны причала доносится плеск — кто-то отвязывает лодку.' } } } }).render(input)
  const content = String(requests[0].messages[1].content)
  assert.match(content, /"new_element":"бочки — рядом"/u)
  assert.doesNotMatch(content, /и взгляд кого-то из permitted_npc_reactions/u)
})
