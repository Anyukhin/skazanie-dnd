// Strict JSON Schema JSON-ролей (`server/llm-json-schemas.mjs`) и её отправка
// в `RouterAIClient`. Схема — дополнительная гарантия провайдера, поэтому
// здесь сторожатся две вещи: схема не шире и не уже валидатора роли там, где
// это важно, и клиент шлёт её только моделям из `STRUCTURED_OUTPUT_MODELS`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DIRECTOR_INTENT_TYPES, normalizeDirectorIntent } from '../server/autonomous-campaign.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'
import { ENCOUNTER_DIFFICULTIES, ENCOUNTER_THEMES } from '../server/encounter-assembler.mjs'
import { FakeLLM, RouterAIClient, usableJsonSchema } from '../server/llm-client.mjs'
import {
  CAMPAIGN_CREATION_JSON_SCHEMA,
  DIRECTOR_INTENT_JSON_SCHEMA,
  DIRECTOR_SCENE_RESOLUTIONS,
  HERO_HOOKS_JSON_SCHEMA,
  NPC_PROMISE_DIRECTIONS,
  NPC_SOCIAL_RESPONSE_JSON_SCHEMA,
  NPC_SOCIAL_STANCES,
} from '../server/llm-json-schemas.mjs'
import { STRUCTURED_OUTPUT_MODELS, supportsJsonSchema } from '../server/model-style-profiles.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'

const ALL_SCHEMAS = [DIRECTOR_INTENT_JSON_SCHEMA, NPC_SOCIAL_RESPONSE_JSON_SCHEMA, CAMPAIGN_CREATION_JSON_SCHEMA, HERO_HOOKS_JSON_SCHEMA]

/** Минимальная проверка значения по подмножеству JSON Schema, которое используют схемы ролей. */
function conforms(schema, value) {
  const types = [schema.type].flat()
  const typeOf = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value
  if (!types.includes(typeOf) && !(typeOf === 'integer' && types.includes('number'))) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (typeOf === 'array') return value.every(item => conforms(schema.items, item))
  if (typeOf === 'object') {
    const keys = Object.keys(value)
    if (schema.additionalProperties === false && keys.some(key => !Object.hasOwn(schema.properties, key))) return false
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false
    return keys.every(key => conforms(schema.properties[key], value[key]))
  }
  return true
}

function* objectSchemas(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return
  if ([schema.type].flat().includes('object')) yield [path, schema]
  for (const [key, child] of Object.entries(schema.properties ?? {})) yield* objectSchemas(child, `${path}.${key}`)
  if (schema.items) yield* objectSchemas(schema.items, `${path}[]`)
}

function* schemaNodes(schema, path = '$') {
  yield [path, schema]
  for (const [key, child] of Object.entries(schema.properties ?? {})) yield* schemaNodes(child, `${path}.${key}`)
  if (schema.items) yield* schemaNodes(schema.items, `${path}[]`)
}

const directorSample = (overrides = {}) => ({
  type: 'continue_exploration', theme: null, difficulty: null, quest_id: null, npc_id: null,
  hook: null, destination: null, resolution: null, reason: null, ...overrides,
})

test('каждая схема соблюдает правила strict-режима: все свойства обязательны, лишние запрещены, корень — объект', () => {
  for (const entry of ALL_SCHEMAS) {
    assert.ok(usableJsonSchema(entry), entry.name)
    assert.equal(entry.strict, true)
    assert.equal(entry.schema.type, 'object')
    assert.ok(Object.isFrozen(entry.schema), `${entry.name} заморожена`)
    for (const [path, schema] of objectSchemas(entry.schema)) {
      assert.equal(schema.additionalProperties, false, `${entry.name} ${path}`)
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${entry.name} ${path}`)
    }
    // Возможности, поддержка которых у провайдеров разная, не используются.
    for (const [path, node] of schemaNodes(entry.schema)) {
      for (const keyword of ['pattern', 'anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', '$ref', 'format']) {
        assert.equal(Object.hasOwn(node, keyword), false, `${entry.name} ${path}: ${keyword}`)
      }
    }
  }
})

test('схема Директора перечисляет ровно разрешённые валидатором намерения, темы, сложности и исходы', () => {
  const { properties } = DIRECTOR_INTENT_JSON_SCHEMA.schema
  assert.deepEqual(properties.type.enum, [...DIRECTOR_INTENT_TYPES])
  assert.deepEqual(properties.theme.enum, [...ENCOUNTER_THEMES, null])
  assert.deepEqual(properties.difficulty.enum, [...ENCOUNTER_DIFFICULTIES, null])
  assert.deepEqual(properties.resolution.enum, [...DIRECTOR_SCENE_RESOLUTIONS, null])
  for (const theme of ENCOUNTER_THEMES) {
    for (const difficulty of ENCOUNTER_DIFFICULTIES) {
      assert.equal(normalizeDirectorIntent(directorSample({ type: 'request_encounter', theme, difficulty })).theme, theme)
    }
  }
  for (const resolution of DIRECTOR_SCENE_RESOLUTIONS) {
    assert.equal(normalizeDirectorIntent(directorSample({ type: 'resolve_scene', resolution })).resolution, resolution)
  }
  assert.throws(() => normalizeDirectorIntent(directorSample({ type: 'resolve_scene', resolution: 'victory' })), /allowlist/)
  assert.throws(() => normalizeDirectorIntent(directorSample({ type: 'request_encounter', theme: 'dragons', difficulty: 'easy' })), /allowlist/)
})

test('любой допускаемый схемой «пустой» ответ Директора с null-полями проходит валидатор, а механика в схему не проходит', () => {
  const filled = {
    continue_exploration: {},
    open_social_scene: { npc_id: 'guide' },
    advance_quest_clock: { quest_id: 'quest-road' },
    request_encounter: { theme: ENCOUNTER_THEMES[0], difficulty: 'medium' },
    resolve_scene: { resolution: 'objective' },
    end_scene: { destination: 'Старая мельница' },
    offer_next_hook: { hook: 'Следы ведут к мельнице' },
  }
  for (const type of DIRECTOR_INTENT_TYPES) {
    const sample = directorSample({ type, reason: 'по следу', ...filled[type] })
    assert.ok(conforms(DIRECTOR_INTENT_JSON_SCHEMA.schema, sample), type)
    assert.equal(normalizeDirectorIntent(sample).type, type)
  }
  // version разрешена валидатором, но модели её писать незачем; механических полей схема не знает.
  for (const key of ['version', 'hp', 'dc', 'x', 'loot']) {
    assert.equal(conforms(DIRECTOR_INTENT_JSON_SCHEMA.schema, directorSample({ [key]: 1 })), false, key)
  }
  // Каждое поле схемы — известное валидатору поле.
  for (const key of Object.keys(DIRECTOR_INTENT_JSON_SCHEMA.schema.properties)) {
    assert.doesNotThrow(() => normalizeDirectorIntent({ type: 'continue_exploration', [key]: key === 'type' ? 'continue_exploration' : null }), key)
  }
})

function socialState() {
  return {
    scene: { title: 'Ворота', location: 'Северные ворота', mood: 'настороженно', objective: 'Узнать, кто открыл заставу' },
    players: [{ id: 'hero:ada', character: 'Ада' }],
    worldMemory: {
      entities: [{ id: 'npc:mira', kind: 'npc', name: 'Мира', summary: 'Хозяйка трактира.', visibility: 'party' }],
      facts: [{ id: 'fact:watch', subject_id: 'npc:mira', predicate: 'witnessed', object: 'Ворота открыли ночью.', summary: 'Ворота открыли ночью.', visibility: 'party', status: 'active', source_event_ids: ['event:watch'], recorded_at_minutes: 0 }],
      relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [], knowledge_ledger: [],
    },
    social: {
      npcs: [{ id: 'npc:mira', name: 'Мира', role: 'хозяйка трактира', location: 'Северные ворота', known_fact_ids: ['fact:watch'], visibility: 'party', available: true, relationship: 'friendly' }],
      relationships: {}, promises: [], conversations: [],
    },
  }
}

const socialSample = (overrides = {}) => ({
  npc_id: 'npc:mira', reply: 'Ну-ка, слушай: ворота открыли ночью, я сама видела фонарь.', stance: 'friendly',
  disclosed_fact_ids: ['fact:watch'], disclosed_claim_ids: [], relationship_delta: 1, promise: null, confidence: 0.8, ...overrides,
})

async function socialRespond(response) {
  const llm = new FakeLLM([response])
  const result = await new NpcSocialController({ llmClient: llm }).respond({
    state: socialState(), playerId: 'hero:ada', npcId: 'npc:mira', message: 'Кто открыл ворота?', turnId: 'schema-test',
  })
  return { result, request: llm.requests[0] }
}

test('ответ NPC по схеме принимается контроллером, а контроллер прикладывает схему к запросу', async () => {
  assert.deepEqual(NPC_SOCIAL_RESPONSE_JSON_SCHEMA.schema.properties.stance.enum, [...NPC_SOCIAL_STANCES])
  assert.deepEqual(NPC_SOCIAL_RESPONSE_JSON_SCHEMA.schema.properties.promise.properties.direction.enum, [...NPC_PROMISE_DIRECTIONS])
  const samples = [
    ...NPC_SOCIAL_STANCES.map(stance => socialSample({ stance })),
    ...NPC_PROMISE_DIRECTIONS.map(direction => socialSample({ promise: { direction, text: 'Расскажу, кто дежурил', due_hint: 'завтра утром' } })),
  ]
  for (const sample of samples) {
    assert.ok(conforms(NPC_SOCIAL_RESPONSE_JSON_SCHEMA.schema, sample))
    const { result, request } = await socialRespond(sample)
    assert.notEqual(result.provider, 'deterministic-social-fallback', JSON.stringify(sample))
    assert.equal(request.jsonSchema, NPC_SOCIAL_RESPONSE_JSON_SCHEMA)
    assert.equal(request.role, 'npc')
  }
  // Схема не шире валидатора: отношение вне allowlist и лишнее поле отвергаются обоими.
  for (const bad of [socialSample({ stance: 'angry' }), { ...socialSample(), gold: 1000 }]) {
    assert.equal(conforms(NPC_SOCIAL_RESPONSE_JSON_SCHEMA.schema, bad), false)
    assert.equal((await socialRespond(bad)).result.provider, 'deterministic-social-fallback')
  }
})

test('Директор прикладывает схему к запросу и принимает ответ по ней', async () => {
  const llm = new FakeLLM([directorSample({ type: 'open_social_scene', npc_id: 'guide', reason: 'проводница знает дорогу' })])
  const result = await new DirectorAgent({ llmClient: llm }).choose({
    state: {
      scene: { title: 'Дорога', location: 'Старая дорога', objective: 'Найти караван', turn: 3 },
      players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12 }],
      mechanics: { combat: { active: false } },
      social: { npcs: [{ id: 'guide', name: 'Мира', location: 'Старая дорога', available: true }] },
    },
    playerAction: 'Спрашиваю проводницу о караване',
    improvMode: 'story',
  })
  assert.equal(result.trace.mode, 'model')
  assert.equal(result.intent.type, 'open_social_scene')
  assert.equal(llm.requests[0].jsonSchema, DIRECTOR_INTENT_JSON_SCHEMA)
  assert.equal(llm.requests[0].role, 'director')
})

function capturingClient(model) {
  const captured = []
  const client = new RouterAIClient({
    apiKey: 'test-key',
    model,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      captured.push(JSON.parse(options.body))
      return { ok: true, status: 200, text: async () => JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }] }) }
    },
  })
  return { client, captured }
}

const messages = [{ role: 'system', content: 'Система.' }, { role: 'user', content: 'Данные.' }]

test('RouterAIClient шлёт strict json_schema только моделям из таблицы возможностей', async () => {
  assert.ok(STRUCTURED_OUTPUT_MODELS.length > 0)
  for (const model of STRUCTURED_OUTPUT_MODELS) {
    assert.equal(supportsJsonSchema(model), true)
    const { client, captured } = capturingClient(model)
    assert.deepEqual(await client.completeJson({ messages, jsonSchema: DIRECTOR_INTENT_JSON_SCHEMA }), { ok: true })
    assert.deepEqual(captured[0].response_format, {
      type: 'json_schema',
      json_schema: { name: 'director_intent', strict: true, schema: DIRECTOR_INTENT_JSON_SCHEMA.schema },
    }, model)
    // Схема не добавляет директив в промпт: сообщения уходят как есть.
    assert.deepEqual(captured[0].messages, messages, model)
  }

  const unknown = capturingClient('vendor/unknown-model')
  assert.equal(supportsJsonSchema('vendor/unknown-model'), false)
  await unknown.client.completeJson({ messages, jsonSchema: DIRECTOR_INTENT_JSON_SCHEMA })
  assert.deepEqual(unknown.captured[0].response_format, { type: 'json_object' })

  // Схему исполняют, но по замеру 2026-10-01 она им вредит (хвост задержки):
  // DeepSeek остаётся на json_object, GLM-5.3 Flash — на директиве в промпте.
  const deepseek = capturingClient('deepseek/deepseek-v4-flash')
  await deepseek.client.completeJson({ messages, jsonSchema: DIRECTOR_INTENT_JSON_SCHEMA })
  assert.deepEqual(deepseek.captured[0].response_format, { type: 'json_object' })
  const glm = capturingClient('z-ai/glm-5.3-flash')
  await glm.client.completeJson({ messages, jsonSchema: DIRECTOR_INTENT_JSON_SCHEMA })
  assert.equal(glm.captured[0].response_format, undefined)
  assert.match(glm.captured[0].messages[0].content, /Верни только полное JSON-значение/)
})

test('RouterAIClient без схемы или с негодной схемой ведёт себя как прежде', async () => {
  const plain = capturingClient('openai/gpt-6-luna')
  await plain.client.completeJson({ messages })
  assert.deepEqual(plain.captured[0].response_format, { type: 'json_object' })

  // GLM без схемы — прежняя директива в системном промпте и без response_format.
  const glm = capturingClient('z-ai/glm-5.3-flash')
  await glm.client.completeJson({ messages })
  assert.equal(glm.captured[0].response_format, undefined)
  assert.match(glm.captured[0].messages[0].content, /Верни только полное JSON-значение/)

  const broken = capturingClient('openai/gpt-6-luna')
  for (const jsonSchema of [{ name: 'с пробелом', schema: { type: 'object' } }, { name: 'ok', schema: { type: 'array' } }, 'director_intent', []]) {
    await broken.client.completeJson({ messages, jsonSchema })
  }
  assert.ok(broken.captured.every(body => body.response_format?.type === 'json_object'))

  // Текстовый запрос схему игнорирует: response_format появляется только у JSON-ролей.
  const text = capturingClient('openai/gpt-6-luna')
  await text.client.complete({ messages, jsonSchema: DIRECTOR_INTENT_JSON_SCHEMA })
  assert.equal(text.captured[0].response_format, undefined)
})

test('OhMyLama за ROUTERAI_BASE_URL: имя модели без префикса, рассуждения — reasoning_effort, учёт — прежнее имя', async () => {
  // 2026-10-11: у RouterAI кончился баланс (HTTP 402), владелец подключил
  // OhMyLama. Её имена моделей — `gpt-6-luna`, а не `openai/gpt-6-luna`.
  const { RouterAIClient, llmProviderFor, providerRequestBody } = await import('../server/llm-client.mjs')
  assert.equal(llmProviderFor('https://ohmylama.ru/v1'), 'ohmylama')
  assert.equal(llmProviderFor('https://routerai.ru/api/v1'), 'routerai')
  assert.equal(llmProviderFor('http://127.0.0.1:9999/v1'), 'routerai')
  assert.deepEqual(providerRequestBody('ohmylama', { model: 'anthropic/claude-sonnet-5.5', temperature: 0, reasoning: { effort: 'low' }, messages: [] }),
    { model: 'claude-sonnet-5.5', reasoning_effort: 'low', messages: [] }, 'Claude у OhMyLama не принимает temperature')
  assert.deepEqual(providerRequestBody('ohmylama', { model: 'openai/gpt-6-luna', reasoning: { enabled: false }, messages: [] }),
    { model: 'gpt-6-luna', messages: [] })
  const routed = { model: 'openai/gpt-6-luna', reasoning: { enabled: false }, messages: [] }
  assert.equal(providerRequestBody('routerai', routed), routed)
  const sent = []
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ model: 'gpt-6-luna', choices: [{ message: { role: 'assistant', content: 'да' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const client = new RouterAIClient({ apiKey: 'test-key', baseUrl: 'https://ohmylama.ru/v1', model: 'openai/gpt-6-luna', reasoning: { enabled: false }, fetchImpl })
  const result = await client.complete({ messages: [{ role: 'user', content: 'да?' }] })
  assert.equal(sent[0].url, 'https://ohmylama.ru/v1/chat/completions')
  assert.equal(sent[0].body.model, 'gpt-6-luna')
  assert.equal(sent[0].body.reasoning, undefined)
  assert.equal(result.model, 'openai/gpt-6-luna', 'учёт расхода видит внутреннее имя')
  assert.equal(result.provider, 'OhMyLama')
})

test('длинный разовый вызов не обрезается лимитом горячего пути первой модели', async () => {
  // Замер 19 (2026-10-11): у OhMyLama Luna пишет мир за 20,4 с, лимит модели
  // 20 с срывал создание кампании (вызов просит 45 с), и мир становился
  // запасным шаблоном. Запас резервной модели — 60 % срока — сохраняется.
  const { FallbackLLMClient } = await import('../server/llm-client.mjs')
  const slow = { model: 'primary', timeoutMs: 20, async complete(_input, options) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 40)
      options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
    return { content: 'мир', model: 'primary' }
  } }
  const reserve = { model: 'reserve', timeoutMs: 20, async complete() { return { content: 'запас', model: 'reserve' } } }
  const client = new FallbackLLMClient({ clients: [slow, reserve] })
  const long = await client.complete({ messages: [{ role: 'user', content: 'мир' }] }, { timeoutMs: 400 })
  assert.equal(long.content, 'мир', 'длинный вызов дождался первой модели')
})

test('Gemini у OhMyLama: без штрафов повторов и с json_object вместо json_schema', async () => {
  // Проба 2026-10-11: presence_penalty — HTTP 400, strict json_schema — 503 на
  // каждом вызове. Самая быстрая резервная модель падала на рассказе и ролях.
  const { providerRequestBody } = await import('../server/llm-client.mjs')
  const schema = { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: { type: 'object' } } }
  assert.deepEqual(providerRequestBody('ohmylama', {
    model: 'google/gemini-2.5-flash', temperature: 0.4, frequency_penalty: 0.3, presence_penalty: 0.2, response_format: schema, messages: [],
  }), { model: 'gemini-2.5-flash', temperature: 0.4, response_format: { type: 'json_object' }, messages: [] })
  const luna = providerRequestBody('ohmylama', { model: 'openai/gpt-6-luna', presence_penalty: 0.2, response_format: schema, messages: [] })
  assert.equal(luna.presence_penalty, 0.2, 'Luna штрафы принимает')
  assert.deepEqual(luna.response_format, schema)
})

test('один тайм-аут после успеха не снимает основную модель на время остывания', async () => {
  // Замер 19 (2026-10-11): медленный ответ Luna на большой запрос отправлял
  // её в двухминутное остывание, и ходы этого окна уходили резервным моделям,
  // которые не успевали, — рассказ сыпался в шаблоны.
  const { FallbackLLMClient, LLMTimeoutError } = await import('../server/llm-client.mjs')
  const calls = []
  let slow = false
  const primary = { model: 'primary', async complete() {
    calls.push('primary')
    if (slow) throw new LLMTimeoutError(10)
    return { content: 'основная', model: 'primary' }
  } }
  const reserve = { model: 'reserve', async complete() { calls.push('reserve'); return { content: 'запас', model: 'reserve' } } }
  const client = new FallbackLLMClient({ clients: [primary, reserve], failureCooldownMs: 60_000, now: () => 1_000 })
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'раз' }] })).content, 'основная')
  slow = true
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'два' }] })).content, 'запас')
  assert.equal(client.health().find(entry => entry.model === 'primary')?.state, 'ready')
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'три' }] })).content, 'запас')
  assert.deepEqual(calls, ['primary', 'primary', 'reserve', 'primary', 'reserve'], 'после первого тайм-аута основную спрашивают снова')
  calls.length = 0
  await client.complete({ messages: [{ role: 'user', content: 'четыре' }] })
  assert.deepEqual(calls, ['reserve'], 'второй тайм-аут подряд — остывание')
})

test('негодный ответ не снимает модель: битый JSON уходит резервной, следующий запрос — снова первой', async () => {
  // Замер 20 (2026-10-11): обрезанный JSON при создании мира снял Luna на две
  // минуты, и первые ходы партии писали резервные модели.
  const { FallbackLLMClient, LLMError } = await import('../server/llm-client.mjs')
  const calls = []
  let broken = true
  const primary = { model: 'primary', async complete() {
    calls.push('primary')
    if (broken) throw new LLMError('broken json', 'LLM_JSON_INVALID')
    return { content: 'основная', model: 'primary' }
  } }
  const reserve = { model: 'reserve', async complete() { calls.push('reserve'); return { content: 'запас', model: 'reserve' } } }
  const client = new FallbackLLMClient({ clients: [primary, reserve], failureCooldownMs: 60_000, now: () => 1_000 })
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'мир' }] })).content, 'запас')
  broken = false
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'ход' }] })).content, 'основная')
  assert.deepEqual(calls, ['primary', 'reserve', 'primary'])
})

test('одиночная недоступность провайдера после успеха не снимает модель', async () => {
  // Замер 28 (2026-10-11): один обрыв Luna при создании мира отдал резервным
  // моделям весь первый акт партии.
  const { FallbackLLMClient, LLMError } = await import('../server/llm-client.mjs')
  const calls = []
  let down = false
  const primary = { model: 'primary', async complete() {
    calls.push('primary')
    if (down) throw new LLMError('reset', 'LLM_PROVIDER_UNAVAILABLE')
    return { content: 'основная', model: 'primary' }
  } }
  const reserve = { model: 'reserve', async complete() { calls.push('reserve'); return { content: 'запас', model: 'reserve' } } }
  const client = new FallbackLLMClient({ clients: [primary, reserve], failureCooldownMs: 60_000, now: () => 1_000 })
  await client.complete({ messages: [{ role: 'user', content: 'раз' }] })
  down = true
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'мир' }] })).content, 'запас')
  down = false
  assert.equal((await client.complete({ messages: [{ role: 'user', content: 'ход' }] })).content, 'основная')
  down = true
  await client.complete({ messages: [{ role: 'user', content: 'два' }] })
  await client.complete({ messages: [{ role: 'user', content: 'три' }] })
  calls.length = 0
  down = false
  await client.complete({ messages: [{ role: 'user', content: 'четыре' }] })
  assert.deepEqual(calls, ['reserve'], 'вторая недоступность подряд — остывание')
})
