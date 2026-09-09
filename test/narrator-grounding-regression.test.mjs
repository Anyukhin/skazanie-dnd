import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeLLM, FallbackLLMClient, RouterAIClient } from '../server/llm-client.mjs'
import { Narrator } from '../server/narrator.mjs'
import { buildNarrationBrief } from '../server/security.mjs'

function brief(overrides = {}) {
  return buildNarrationBrief({
    visible_events: [{ event_type: 'AbilityCheckResolved', actor_id: 'hero:ada', payload: { ability: 'int', success: true }, visibility: 'public' }],
    known_environment: {
      scene: { title: 'Трактир', location: 'Трактир', mood: 'Тусклый свет над стойкой.', objective: 'Забрать обещанную карту' },
      story_context: {
        heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }],
        present_npcs: [{ id: 'npc:mira', name: 'Мира' }],
        open_promises: [{ id: 'promise:map', npc: 'Мира', text: 'Мира обещала оставить карту старых троп под медной кружкой.' }],
      },
    },
    ...overrides,
  })
}

async function render(text, input = brief()) {
  const shown = []
  const narrator = new Narrator({ llmClient: { complete: async ({ onDelta }) => {
    onDelta?.(text)
    return { content: text }
  } } })
  const result = await narrator.render(input, { onProgress: value => shown.push(value) })
  return { result, shown }
}

for (const text of [
  'Ада замечает под медной кружкой обещанную карту.',
  'Под медной кружкой видна обещанная карта.',
  'Обещанная карта уже готова к получению.',
  'Ада нащупала свёрнутый пергамент под медной кружкой.',
  'Обещанная карта обнаружена под кружкой.',
  'Под кружкой замечена обещанная карта.',
  'Обещанная карта оказалась под кружкой.',
]) test(`обещание не становится находкой: ${text}`, async () => {
  const { result, shown } = await render(text)
  assert.equal(result.provider, 'deterministic-fallback')
  assert.ok(result.verification.repaired_from.some(entry => entry.code === 'PROMISE_RESOLUTION_NOT_IN_BRIEF'))
  assert.ok(!shown.includes(text), 'неподтверждённый результат нельзя показать даже потоковым префиксом')
})

for (const text of [
  'Мира обещала оставить карту старых троп под медной кружкой.',
  'Мира говорила: «Карта будет лежать под медной кружкой». Обещание пока остаётся открытым.',
  'Под медной кружкой карты пока не видно.',
  'Обещанная карта пока не найдена.',
  'Обещанная карта не была найдена.',
]) test(`память и отсутствие результата разрешены: ${text}`, async () => {
  const { result } = await render(text)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

test('постороннее разрешённое обещание не разрешает получение этой карты', async () => {
  const input = brief({ visible_events: [{ event_type: 'NpcPromiseResolved', visibility: 'public', payload: { promise_id: 'promise:other' } }] })
  const { result } = await render('Под медной кружкой видна обещанная карта.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})

test('получение карты разрешено собственным подтверждённым событием обещания', async () => {
  const input = brief({ visible_events: [{ event_type: 'NpcPromiseResolved', visibility: 'public', payload: { promise_id: 'promise:map', resolution: 'fulfilled' } }] })
  const { result } = await render('Под медной кружкой лежит обещанная карта.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

test('голая проверка не делает довод принятым собеседником', async () => {
  const input = brief({ visible_events: [{ event_type: 'AbilityCheckResolved', visibility: 'public', payload: { ability: 'cha', success: true } }] })
  const { result } = await render('Довод принят.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})

test('допустимый социальный исход остаётся разрешённым', async () => {
  const input = brief({ permitted_npc_reactions: [{ name: 'Мира', reaction: 'persuaded', description: 'принимает довод' }] })
  const { result } = await render('Довод принят.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

test('отсутствие согласия не объявляет принятый довод', async () => {
  for (const text of ['Довод не был принят.', 'Довод принят не был.']) {
    const { result } = await render(text)
    assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
  }
})

test('нахождение другой вещи не закрывает открытое обещание', async () => {
  const input = brief({ visible_events: [{ event_type: 'ItemGranted', visibility: 'public', payload: { item: { name: 'ключ от шкафа' } } }] })
  const { result } = await render('Обещанная карта не найдена, но на месте найден ключ от шкафа.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

test('разрешение чужого обещания не подтверждает обещание без id', async () => {
  const input = brief({ visible_events: [{ event_type: 'NpcPromiseResolved', visibility: 'public', payload: { promise_id: 'other' } }] })
  delete input.known_environment.story_context.open_promises[0].id
  const { result } = await render('Обещанная карта лежит под кружкой.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})

for (const text of ['Мира держится приветливо.', 'Мира держится настороженно.', 'Мира держится холодно.', 'Мира встревожена.']) {
  test(`кириллический суффикс не скрывает новую реакцию: ${text}`, async () => {
    const { result } = await render(text)
    assert.equal(result.provider, 'deterministic-fallback')
  })
}

test('проверка не подтверждает убедительно прозвучавшие слова', async () => {
  const { result } = await render('Слова прозвучали убедительно — но проверка осталась лишь проверкой.')
  assert.equal(result.provider, 'deterministic-fallback')
})

test('высказанное намерение не считается завершённым разговором', async () => {
  const input = brief({ visible_events: [{ event_type: 'ActionDeclared', visibility: 'public' }] })
  input.known_environment.player_intent = { action: 'Расспросить Миру', constraints: ['Не покидая укрытия'] }
  const { result } = await render('Намерение расспросить Миру высказано, но укрытие пока не покидается, и подтверждённого ответа ещё нет.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

test('прошлое социальное событие в памяти не подтверждает новое согласие', async () => {
  const input = brief()
  input.known_environment.story_context.previous_event = { event_type: 'NpcConversationRecorded', payload: {} }
  const { result } = await render('Довод принят.', input)
  assert.equal(result.provider, 'deterministic-fallback')
})

test('голая проверка не получает примеры с открытым засовом', async () => {
  let system = ''
  await new Narrator({ llmClient: { complete: async request => {
    system = request.messages[0].content
    return { content: 'В трактире ничего не меняется.' }
  } } }).render(brief())
  assert.doesNotMatch(system, /Засов поддаётся|Верёвка натягивается|Клинок срывает/u)
})

test('модель получает русскую сводку отдельной проверки без отвлекающей памяти', async () => {
  const input = brief()
  input.known_environment.scene.objective = 'Забрать карту старых троп'
  input.known_environment.story_context.recent_summaries = [{ title: 'Причал', summary: 'Рыбак потерял зелёное весло.' }]
  let data = ''
  await new Narrator({ llmClient: { complete: async request => {
    data = request.messages[1].content
    return { content: 'Мира обещала оставить карту старых троп под медной кружкой.' }
  } } }).render(input)
  assert.match(data, /confirmed_event_summaries/u)
  assert.match(data, /Проверка.*Интеллект.*успехом/u)
  assert.doesNotMatch(data, /оставить карту старых троп|"memory_focus"/u)
  assert.doesNotMatch(data, /зелёное весло/u)
  assert.equal(input.known_environment.story_context.recent_summaries.length, 1, 'Исходную память кампании не меняем')
})

for (const event of [null, { event_type: 'DoorLockpicked', payload: { door_id: 'door', success: false } }]) {
  test(`пример стиля не открывает дверь: ${event?.event_type ?? 'обычная проверка'}`, async () => {
    const input = event ? brief({ visible_events: [{ ...event, visibility: 'public' }] }) : brief()
    const { result, shown } = await render('Засов поддаётся с сухим щелчком, и створка отходит, открывая тёмный проход.', input)
    assert.equal(result.provider, 'deterministic-fallback')
    assert.deepEqual(shown, [result.narration])
  })
}

test('событие открывания позволяет описать открывание двери', async () => {
  const input = brief({ visible_events: [{ event_type: 'DoorStateChanged', visibility: 'public', payload: { door_id: 'door', previous_state: 'closed', state: 'open' } }] })
  const { result } = await render('Дверь открывается.', input)
  assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
})

for (const text of ['Дверь не открылась.', 'Створка не распахнулась.', 'Засов так и не поддаётся.']) {
  test(`отрицание не открывает дверь: ${text}`, async () => {
    const { result } = await render(text)
    assert.equal(result.provider, 'Object', JSON.stringify(result.verification))
  })
}

for (const text of ['Засов поддался с сухим щелчком.', 'Створка поддалась.', 'Дверь была открыта.']) {
  test(`прошедшее время не разрешает открывание: ${text}`, async () => {
    const { result } = await render(text)
    assert.equal(result.provider, 'deterministic-fallback')
  })
}

test('неудачная попытка и закрывание не получают пример открытого засова', async () => {
  for (const event of [
    { event_type: 'DoorLockpicked', payload: { success: false } },
    { event_type: 'DoorForced', payload: { success: false } },
    { event_type: 'DoorStateChanged', payload: { state: 'closed' } },
  ]) {
    let messages
    await new Narrator({ llmClient: { complete: async request => {
      messages = request.messages
      return { content: 'Дверь остаётся запертой.' }
    } } }).render(brief({ visible_events: [{ ...event, visibility: 'public' }] }))
    assert.doesNotMatch(messages[0].content, /Засов поддаётся/u)
    assert.match(messages[1].content, /дверь|Дверь/u)
    assert.doesNotMatch(messages[1].content, /"text":"Door/u)
  }
})

test('GLM получает JSON инструкцией без проблемного response_format, parser остаётся строгим', async () => {
  let body
  let content = '{"ok":true}'
  const client = new RouterAIClient({ model: 'z-ai/glm-5.3-flash', apiKey: 'test', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body)
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) }
  } })
  const request = { messages: [{ role: 'user', content: 'Верни JSON с ok=true.' }] }
  assert.deepEqual(await client.completeJson(request), { ok: true })
  assert.equal(Object.hasOwn(body, 'response_format'), false)
  assert.match(body.messages[0].content, /Без Markdown/u)
  assert.equal(request.messages.length, 1, 'инструкцию формата добавляем только в копию запроса')
  content = '```json\n{"ok":true}\n```'
  await assert.rejects(client.completeJson(request), error => error.code === 'LLM_RESPONSE_INVALID')
  content = '{}'
  await assert.rejects(client.completeJson(request), error => error.code === 'LLM_RESPONSE_INVALID')
})

test('пустой JSON от GLM передаёт запрос резервной модели', async () => {
  const primary = Object.assign(new FakeLLM([{ content: '{}' }]), { model: 'glm' })
  const secondary = Object.assign(new FakeLLM([{ content: '{"action":"none"}' }]), { model: 'backup' })
  const chain = new FallbackLLMClient({ clients: [primary, secondary] })
  const result = await chain.complete({ messages: [{ role: 'user', content: 'Верни JSON результата.' }], json: true })
  assert.deepEqual(result.json, { action: 'none' })
  assert.deepEqual(result.fallback_attempts, [{ model: 'glm', code: 'LLM_RESPONSE_INVALID' }])
  assert.equal(secondary.calls.length, 1)
})

test('Narrator оставляет время резервной модели внутри собственного deadline', async () => {
  let fallbackCalls = 0
  const chain = new FallbackLLMClient({ clients: [
    { model: 'slow', timeoutMs: 200, complete: ({ signal }) => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) },
    { model: 'fast', timeoutMs: 200, complete: async () => {
      fallbackCalls += 1
      return { content: 'В трактире ничего не меняется.' }
    } },
  ] })
  const result = await new Narrator({ llmClient: chain }).render(brief(), { timeoutMs: 120 })
  assert.equal(fallbackCalls, 1)
  assert.equal(result.provider, 'FallbackLLMClient')
})
