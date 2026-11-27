import '../../../fixtures-env.mjs'
// Эталоны `server/llm-client.mjs` для `sk-agents-base`: строгий JSON, вызовы
// инструментов, FakeLLM, тело запроса и разбор ответа RouterAIClient, поток
// SSE с разрывами, провайдер и схема ответа. Запуск из этого каталога:
//   node gen-llm-client.mjs   →   llm-client.json
// Сети нет: `fetchImpl` отвечает из сценария, ключ — выдуманная строка.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runWithCampaignAiSettings } from '../../../../server/campaign-ai-context.mjs'
import {
  FakeLLM,
  LLMError,
  RouterAIClient,
  llmProviderFor,
  parseRouterAIEventStream,
  providerRequestBody,
  strictJsonParse,
  usableJsonSchema,
  validateToolCalls,
} from '../../../../server/llm-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TEST_KEY = 'fixture-key-not-secret'

// Детерминированный ГПСЧ (mulberry32): одинаковые нарезки при каждом запуске.
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function errorJson(error) {
  const out = { name: error?.name ?? 'Error', message: String(error?.message ?? error) }
  if (error?.code !== undefined) out.code = error.code
  for (const key of Object.keys(error ?? {})) {
    if (['name', 'code', 'cause', 'providerUsage', 'message', 'stack'].includes(key)) continue
    out[key] = error[key]
  }
  if (error?.providerUsage !== undefined) out.providerUsage = error.providerUsage
  return out
}

function outcome(run) {
  try {
    return { ok: JSON.stringify(run()) }
  } catch (error) {
    return { error: errorJson(error) }
  }
}

async function outcomeAsync(run) {
  try {
    return { ok: JSON.stringify(await run()) }
  } catch (error) {
    return { error: errorJson(error) }
  }
}

// ---------------------------------------------------------------------------
// Ответы модели: корректные, обрезанные, с мусором вокруг, опасные.
// ---------------------------------------------------------------------------

const VALID = [
  '{"ok":true}',
  '{"intent":"look","confidence":1}',
  '{"narration":"Туман стелется над рекой, и где-то вдали кричит выпь.","mood":"тревога"}',
  '{"actions":[{"type":"move","to":[3,4]},{"type":"talk","npc":"mira","text":"Привет, Мира!"}],"notes":null}',
  '[1,2,3]',
  '[]',
  '{}',
  '[{"a":1},{"b":[true,false,null]}]',
  '{"b":1,"10":2,"a":3,"2":4,"01":5,"-1":6}',
  '{"a":1,"a":2,"b":{"c":1,"c":[3]}}',
  '{"n":[0,-0,1.5,1e21,1E-7,0.1,123456789012345678901234,12345678901234567890,-9007199254740993,5e-324,1.7976931348623157e308]}',
  '{"s":"\\u0041\\n\\t\\"\\\\\\/\\b\\f\\r\\ud83d\\ude00 😀 ё"}',
  '{"emoji":"🐉🗡️","mixed":"Dragon дракон 龍"}',
  '{"deep":{"a":{"b":{"c":{"d":{"e":{"f":[[[[["глубоко"]]]]]}}}}}}}',
  ' \n\t {"spaced" : [ 1 , 2 ] }\r\n ',
  '{"":"","  ":" "}',
  '{"line":"a b c"}',
  'null',
  'true',
  '42',
  '"просто строка"',
  '-0',
  '{"big":1e400}',
  '{"list":[1,-1e999]}',
  '{"b":{"__proto__":1},"1":[1e999]}',
  '{"a":[1e999],"__proto__":1}',
  '{"__proto__":{"admin":true}}',
  '{"a":{"constructor":{"prototype":1}}}',
  '[{"prototype":1}]',
  '{"ok":{"proto":1,"__proto":2,"constructor_":3}}',
  '{"toString":1,"valueOf":2,"hasOwnProperty":3}',
]

const INVALID = [
  '',
  '   ',
  '\n\t',
  'NaN',
  'Infinity',
  '-Infinity',
  'undefined',
  "{'a':1}",
  '{a:1}',
  '[1,2,]',
  '{"a":1,}',
  '{"a":1}}',
  '{"a" 1}',
  '{"a":01}',
  '{"a":+1}',
  '{"a":.5}',
  '{"a":5.}',
  '{"a":1e}',
  '{"a":0x10}',
  '// комментарий\n{"a":1}',
  '{"a":1} // хвост',
  '{"a":"\t"}',
  '{"a":"\\x41"}',
  '{"a":"\\u12"}',
  '{"a":tru}',
  '{"a":nul}',
  '[1 2]',
  '{"a":[}',
  '"незакрытая',
  ' {"nbsp":1} ',
  '﻿{"bom":1}',
  '　{"ideographic":1}',
]

const WRAPPERS = [
  (json) => json,
  (json) => '```json\n' + json + '\n```',
  (json) => '```' + json + '```',
  (json) => '  ```json\n' + json + '\n```',
  (json) => 'Ответ: ' + json,
  (json) => 'answer: ' + json,
  (json) => json + '\nГотово.',
  (json) => json + '\n\nПояснение: всё верно.',
  (json) => 'Вот JSON:\n```json\n' + json + '\n```\nНадеюсь, помог.',
  (json) => '<json>' + json + '</json>',
  (json) => json + ',',
  (json) => '[' + json,
  (json) => json + json,
]

function strictCases() {
  const cases = []
  const random = rng(20261014)
  for (const text of [...VALID, ...INVALID]) {
    for (const expected of [undefined, 'object', 'array', 'object-or-array', 'any']) {
      cases.push({ input: text, options: expected === undefined ? {} : { expected } })
    }
  }
  for (const text of VALID.slice(0, 16)) {
    for (const wrap of WRAPPERS) cases.push({ input: wrap(text), options: { expected: 'any' } })
    // Обрезанные ответы: модель упёрлась в max_tokens.
    for (let index = 0; index < 4; index += 1) {
      const cut = 1 + Math.floor(random() * Math.max(1, text.length - 1))
      cases.push({ input: text.slice(0, cut), options: { expected: 'any', label: 'JSON content' } })
    }
  }
  // Пределы размера: ровно на границе и на байт больше (кириллица — 2 байта).
  for (const text of ['{"a":"абв"}', '{"x":"y"}', '  {"x":"y"}  ', '[1,2,3]']) {
    const bytes = Buffer.byteLength(text.trim(), 'utf8')
    for (const maxBytes of [bytes - 1, bytes, bytes + 1, 1]) cases.push({ input: text, options: { maxBytes } })
  }
  // Ошибки вызова: неизвестный expected и негодный maxBytes.
  for (const expected of ['objects', '', null, 5, ['object'], { type: 'object' }, true]) cases.push({ input: '{"a":1}', options: { expected } })
  for (const maxBytes of [0, -1, 1.5, '5', null, true, 2 ** 53, 9007199254740991]) cases.push({ input: '{"a":1}', options: { maxBytes } })
  for (const label of ['ответ RouterAI', 'аргументы roll', 'RouterAI SSE event']) cases.push({ input: 'oops', options: { label } })
  // Готовые значения (не строка): проверка формы, ключей и размера.
  const values = [
    { ok: true }, [1, 2], {}, [], null, 5, true, 'строка уже разобрана',
    { a: { b: [1, { c: 2 }] } },
    JSON.parse('{"__proto__":{"x":1}}'),
    { nested: JSON.parse('[{"constructor":1}]') },
    { prototype: 1 },
    { '1': { constructor: 1 }, b: { prototype: 2 } },
    { content: '```json\n{"ok":true}\n```' },
    { text: 'абвгд'.repeat(10) },
  ]
  for (const value of values) {
    for (const expected of [undefined, 'object', 'any']) cases.push({ value, options: expected === undefined ? {} : { expected } })
  }
  cases.push({ value: { text: 'абвгд'.repeat(10) }, options: { maxBytes: 50 } })
  cases.push({ value: { text: 'абвгд'.repeat(10) }, options: { maxBytes: 200 } })
  return cases.map((entry) => ({
    ...entry,
    out: outcome(() => strictJsonParse('value' in entry ? entry.value : entry.input, entry.options)),
  }))
}

// ---------------------------------------------------------------------------
// Вызовы инструментов
// ---------------------------------------------------------------------------

function toolCases() {
  const call = (name, args = '{}', extra = {}) => ({ id: `id-${name}`, type: 'function', function: { name, arguments: args }, ...extra })
  const lists = [
    undefined,
    null,
    [],
    [call('roll')],
    [call('roll', '{"dice":"1d20"}'), call('move', '{"to":[1,2]}')],
    [call('roll', '{"dice":"1d20"}'), call('roll'), call('roll')],
    Array.from({ length: 9 }, () => call('roll')),
    'roll',
    { 0: call('roll') },
    [null],
    [5],
    ['roll'],
    [[]],
    [{ type: 'tool', function: { name: 'roll', arguments: '{}' } }],
    [{ type: '', function: { name: 'roll', arguments: '{}' } }],
    [{ type: 0, function: { name: 'roll' } }],
    [{ function: { name: 'roll' } }],
    [{ name: 'roll', arguments: { dice: '2d6' } }],
    [{ name: 'roll', arguments: '{"dice":' }],
    [{ name: 'roll', arguments: '[1,2]' }],
    [{ name: 'roll', arguments: '```json\n{}\n```' }],
    [{ name: 'roll', arguments: '{"__proto__":{}}' }],
    [{ name: 'roll', arguments: 7 }],
    [{ name: 'roll', arguments: null, function: { arguments: '{"a":1}' } }],
    [{ function: { name: null }, name: 'roll' }],
    [{ function: 'roll', name: 'move' }],
    [{ function: { name: 'shell' } }],
    [{ function: { name: '1roll' } }],
    [{ function: { name: 'roll call' } }],
    [{ function: { name: 'r'.repeat(80) } }],
    [{ function: { name: 'r'.repeat(81) } }],
    [{ function: { name: 'roll\n' } }],
    [{ function: { name: 'Roll_dice-2' } }],
    [{ function: { name: true } }],
    [{ function: { name: 123 } }],
    [{ id: 0, function: { name: 'roll' } }],
    [{ id: 42, function: { name: 'roll' } }],
    [{ id: { x: 1 }, function: { name: 'roll' } }],
    [{ id: '', function: { name: 'move' } }, { function: { name: 'roll' } }],
  ]
  const allowedSets = [['roll', 'move'], [], ['roll'], ['true', 'Roll_dice-2', 'r'.repeat(80)]]
  const maxima = [undefined, 1, 2, 0, -1, 1.5, '3', null, 100]
  const cases = []
  for (const toolCalls of lists) {
    for (const allowed of allowedSets) {
      cases.push({ toolCalls, allowed, max: undefined })
    }
  }
  for (const max of maxima) cases.push({ toolCalls: [call('roll'), call('move')], allowed: ['roll', 'move'], max })
  return cases.map((entry) => ({
    ...entry,
    out: outcome(() => validateToolCalls(entry.toolCalls, { allowedToolNames: entry.allowed, ...(entry.max !== undefined ? { maxToolCalls: entry.max } : {}) })),
  }))
}

// ---------------------------------------------------------------------------
// FakeLLM: нормализация запроса и сообщения ассистента
// ---------------------------------------------------------------------------

const MESSAGES = [{ role: 'system', content: 'Система.' }, { role: 'user', content: 'Иду к воротам.' }]

async function fakeCases() {
  const responses = [
    { intent: 'look', confidence: 1 },
    {},
    [],
    [1, 2],
    'Свободный текст ответа.',
    '   ',
    '',
    '{"ok":true}',
    '```json\n{"ok":true}\n```',
    'null',
    null,
    42,
    { content: '{"ok":true}' },
    { content: '' },
    { content: null, tool_calls: [{ function: { name: 'roll', arguments: '{"dice":"1d20"}' } }] },
    { content: '', tool_calls: [{ function: { name: 'shell', arguments: '{}' } }] },
    { content: '', toolCalls: [{ name: 'roll' }] },
    { role: 'user', content: 'не тот' },
    { role: 'assistant' },
    { role: 'assistant', content: { nested: true } },
    { role: 'assistant', content: 17 },
    { role: '', content: 'пустая роль' },
    { choices: [{ message: { role: 'assistant', content: '{"wrapped":1}' } }] },
    { choices: { 0: { message: { role: 'assistant', content: 'объект choices' } } } },
    { choices: [{ message: null }], content: 'запас' },
    { choices: [{ message: '' }] },
    { choices: [{ message: 'строка вместо объекта' }] },
    { choices: [] },
    { content: 'x', tool_calls: 'roll' },
    { content: '{"__proto__":1}' },
  ]
  const requests = [
    [{ messages: MESSAGES }, {}],
    [{ messages: MESSAGES }, { json: true }],
    [{ messages: MESSAGES, expectJson: true, jsonExpected: 'array' }, {}],
    [{ messages: MESSAGES, responseFormat: 'json' }, { jsonExpected: 'any' }],
    [{ messages: MESSAGES, responseFormat: 'json_object', jsonExpected: 'object-or-array' }, {}],
    [{ messages: MESSAGES, json: true, jsonExpected: 'bogus' }, {}],
    [{ messages: MESSAGES, json: true, jsonExpected: null }, {}],
    [{ messages: MESSAGES, tools: [{ type: 'function', function: { name: 'roll' } }] }, {}],
    [{ messages: MESSAGES, allowedToolNames: ['roll'], maxToolCalls: 1 }, {}],
    [MESSAGES, { json: 'yes' }],
    [MESSAGES, { messages: [{ role: 'user', content: 'перекрыто' }] }],
  ]
  const cases = []
  for (const response of responses) {
    for (const [input, options] of requests) cases.push({ response, input, options })
  }
  // Негодные запросы — TypeError до ответа.
  for (const input of [{}, { messages: [] }, { messages: 'привет' }, null, 'привет', [], [{}], [{ role: '' }], [{ role: '  ' }], [null], [['user']], [{ role: 0 }], [{ role: 5, content: 'число' }], [{ role: true }], [{ role: { x: 1 } }], [{ role: [] }]]) {
    cases.push({ response: { ok: true }, input, options: {} })
  }
  for (const entry of cases) {
    const fake = new FakeLLM([entry.response])
    entry.out = await outcomeAsync(() => fake.complete(entry.input, entry.options))
    entry.request = fake.requests.length ? JSON.stringify(fake.requests[0]) : null
  }
  return cases
}

// ---------------------------------------------------------------------------
// RouterAIClient: тело запроса и разбор ответа
// ---------------------------------------------------------------------------

const SCHEMA = { name: 'director_intent', strict: true, schema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: false } }

function envelope(content, extra = {}) {
  return JSON.stringify({ model: 'provider-model', choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, ...extra })
}

async function runRouter(entry) {
  let body = null
  let url = null
  const client = new RouterAIClient({
    apiKey: entry.config.apiKey ?? TEST_KEY,
    baseUrl: entry.config.baseUrl ?? 'http://127.0.0.1:9/api/v1',
    model: entry.config.model ?? 'test/model',
    ...(entry.config.maxTokens !== undefined ? { maxTokens: entry.config.maxTokens } : {}),
    ...(entry.config.reasoning !== undefined ? { reasoning: entry.config.reasoning } : {}),
    ...(entry.config.maxResponseBytes !== undefined ? { maxResponseBytes: entry.config.maxResponseBytes } : {}),
    ...(entry.config.maxToolCalls !== undefined ? { maxToolCalls: entry.config.maxToolCalls } : {}),
    timeoutMs: 5_000,
    fetchImpl: async (address, init) => {
      url = address
      body = init.body
      const status = entry.response?.status ?? 200
      if (entry.response?.chunks) {
        const chunks = entry.response.chunks.map((hex) => Buffer.from(hex, 'hex'))
        const fail = entry.response.fail
        return {
          ok: status >= 200 && status < 300,
          status,
          body: {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk
              if (fail) throw new TypeError('terminated')
            },
          },
        }
      }
      return { ok: status >= 200 && status < 300, status, text: async () => entry.response?.text ?? '' }
    },
  })
  const deltas = []
  const options = entry.stream ? { ...entry.options, onDelta: (delta) => { deltas.push(delta) } } : entry.options
  const call = () => client.complete(entry.input, options)
  const out = await outcomeAsync(() => (entry.campaign ? runWithCampaignAiSettings(entry.campaign, call) : call()))
  return { ...out, body, path: url ? new URL(url).pathname : null, ...(entry.stream ? { deltas } : {}) }
}

function routerCases() {
  const cases = []
  const contents = ['{"intent":"look"}', '{}', '[1]', 'Обычный текст.', '', '   ', '{"ok":', '```json\n{"ok":true}\n```', '{"__proto__":1}']
  const flags = [{}, { json: true }, { expectJson: true, jsonExpected: 'any' }, { json: true, jsonExpected: 'array' }]
  for (const content of contents) {
    for (const flag of flags) cases.push({ config: {}, input: { messages: MESSAGES }, options: flag, response: { text: envelope(content) } })
  }
  const bodies = [
    envelope('{"ok":true}'),
    '```json\n' + envelope('{"ok":true}') + '\n```',
    '```json' + envelope('{"ok":true}') + '```',
    '```application/json\n' + envelope('{"ok":true}') + '\n```',
    '  \n```\n' + envelope('{"ok":true}') + '\n```  \n',
    '```json\n' + envelope('{"ok":true}'),
    'Вот ответ: ' + envelope('{"ok":true}'),
    '﻿' + envelope('{"ok":true}'),
    envelope('{"ok":true}') + '\n',
    '',
    'null',
    '[]',
    '{"choices":[]}',
    '{"choices":{"0":{"message":{"role":"assistant","content":"{\\"ok\\":1}"}}}}',
    '{"choices":[{"message":{"role":"user","content":"{\\"ok\\":1}"}}]}',
    '{"choices":[{"message":{"content":{"ok":2}}}]}',
    '{"choices":[{"message":{"content":5}}]}',
    '{"choices":[{"message":"текст"}]}',
    '{"choices":[{"message":{"content":"{\\"ok\\":1}"}}],"usage":null,"model":null}',
    '{"choices":[{"message":{"content":"{\\"ok\\":1}"}}],"usage":{"total_tokens":3},"model":42}',
    '{"choices":[{"message":{"content":"{}"}}],"usage":{"total_tokens":3,"cost":0.01}}',
    '{"choices":[{"message":{"content":"not json"}}],"usage":{"total_tokens":100,"cost":0.25}}',
    '{"choices":[{"message":{"content":"not json"}}],"usage":[1]}',
    '{"choices":[{"message":{"content":"not json"}}],"usage":"много"}',
    '{"choices":[{"message":{"content":"","tool_calls":[{"function":{"name":"roll","arguments":"{}"}}]}}],"usage":{"total_tokens":9}}',
    '{"__proto__":{"choices":1}}',
    '{"choices":[{"message":{"content":"{\\"ok\\":1e999}"}}]}',
  ]
  for (const text of bodies) {
    for (const flag of [{}, { json: true }]) cases.push({ config: {}, input: { messages: MESSAGES }, options: flag, response: { text } })
  }
  for (const status of [400, 401, 402, 404, 429, 500, 502, 503]) cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, response: { status, text: '{"error":"x"}' } })
  for (const status of [201, 299]) cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, response: { status, text: envelope('Ответ.') } })
  cases.push({ config: { maxResponseBytes: 64 }, input: { messages: MESSAGES }, options: {}, response: { text: envelope('Длинный ответ, который не влезет в предел.') } })
  cases.push({ config: { maxToolCalls: 1 }, input: { messages: MESSAGES, allowedToolNames: ['roll'] }, options: {}, response: { text: '{"choices":[{"message":{"content":"","tool_calls":[{"function":{"name":"roll"}},{"function":{"name":"roll"}}]}}]}' } })
  // Тело запроса: модель, штрафы, инструменты, рассуждения, схема, директива GLM, OhMyLama.
  const requestShapes = [
    [{}, { messages: MESSAGES }, {}],
    [{}, { messages: MESSAGES, temperature: 0.8, frequencyPenalty: 0.35, presencePenalty: 0.2 }, { json: true }],
    [{}, { messages: MESSAGES, temperature: '0.5', frequency_penalty: -2, presence_penalty: 2 }, {}],
    [{}, { messages: MESSAGES, temperature: 'горячо', maxTokens: 300 }, {}],
    [{}, { messages: MESSAGES, temperature: null, maxTokens: 0 }, {}],
    [{}, { messages: MESSAGES, maxTokens: '64', model: 'openai/gpt-6-luna' }, {}],
    [{}, { messages: MESSAGES, frequencyPenalty: 2.01 }, {}],
    [{}, { messages: MESSAGES, presence_penalty: -2.01 }, {}],
    [{}, { messages: MESSAGES, frequencyPenalty: 'много' }, {}],
    [{}, { messages: MESSAGES, frequencyPenalty: null, frequency_penalty: 1 }, {}],
    [{}, { messages: MESSAGES, tools: [{ type: 'function', function: { name: 'roll', parameters: { type: 'object' } } }] }, {}],
    [{}, { messages: MESSAGES, tools: [{ name: 'roll' }], toolChoice: 'required' }, {}],
    [{}, { messages: MESSAGES, tools: [], tool_choice: 'none' }, {}],
    [{}, { messages: MESSAGES, tools: [{ name: 'roll' }], toolChoice: null, tool_choice: { type: 'function' } }, {}],
    [{ reasoning: { enabled: false } }, { messages: MESSAGES }, {}],
    [{ reasoning: [1, 2] }, { messages: MESSAGES }, {}],
    [{ reasoning: 'low' }, { messages: MESSAGES }, {}],
    [{ reasoning: { effort: 'low' } }, { messages: MESSAGES, reasoning: { effort: 'high' } }, {}],
    [{ reasoning: { effort: 'low' } }, { messages: MESSAGES, reasoning: ['x'] }, {}],
    [{ reasoning: { effort: 'low' } }, { messages: MESSAGES, reasoning: 'off' }, {}],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: SCHEMA }, { json: true }],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: { ...SCHEMA, strict: false } }, { json: true }],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: { name: 'с пробелом', schema: { type: 'object' } } }, { json: true }],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: { name: 'ok', schema: { type: 'array' } } }, { json: true }],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: 'director_intent' }, { json: true }],
    [{ model: 'openai/gpt-6-luna' }, { messages: MESSAGES, jsonSchema: SCHEMA }, {}],
    [{ model: 'vendor/unknown-model' }, { messages: MESSAGES, jsonSchema: SCHEMA }, { json: true }],
    [{ model: 'deepseek/deepseek-v4-flash' }, { messages: MESSAGES, jsonSchema: SCHEMA }, { json: true }],
    [{ model: 'z-ai/glm-5.3-flash' }, { messages: MESSAGES, jsonSchema: SCHEMA }, { json: true }],
    [{ model: 'z-ai/glm-5.3-flash' }, { messages: [{ role: 'user', content: 'Без системы.' }] }, { json: true }],
    [{ model: 'z-ai/glm-5.3-flash' }, { messages: [{ role: 'system', content: { parts: [] } }, { role: 'system', content: 'Вторая.' }] }, { json: true }],
    [{ model: 'z-ai/glm-5.3-flash' }, { messages: MESSAGES }, {}],
    [{ model: '' }, { messages: MESSAGES, model: 0 }, {}],
    [{ model: 'openai/gpt-6-luna' }, { messages: [{ role: 'user', content: 'x', name: 'hero', extra: { a: 1 } }] }, {}],
    [{ baseUrl: 'https://ohmylama.ru/v1', model: 'openai/gpt-6-luna', reasoning: { enabled: false } }, { messages: MESSAGES }, {}],
    [{ baseUrl: 'https://ohmylama.ru/v1/', model: 'openai/gpt-6-luna', reasoning: { effort: 'medium' } }, { messages: MESSAGES, frequencyPenalty: 0.3 }, {}],
    [{ baseUrl: 'https://OhMyLama.ru/v1', model: 'anthropic/claude-sonnet-5.5' }, { messages: MESSAGES, temperature: 0.4, frequencyPenalty: 0.3, presencePenalty: 0.1, reasoning: { effort: 'low' } }, {}],
    [{ baseUrl: 'https://api.ohmylama.ru/v1', model: 'google/gemini-2.5-flash-lite' }, { messages: MESSAGES, frequencyPenalty: 0.3, jsonSchema: SCHEMA }, { json: true }],
    [{ baseUrl: 'https://ohmylama.ru/v1', model: 'google/gemini-2.5-flash' }, { messages: MESSAGES, presencePenalty: 0.2 }, { json: true }],
    [{ baseUrl: 'https://ohmylama.ru/v1', model: 'meta/muse-spark-1.3', reasoning: { effort: 'minimal' } }, { messages: MESSAGES }, {}],
    [{ baseUrl: 'https://ohmylama.ru/v1', model: 'gpt-6-luna' }, { messages: MESSAGES, reasoning: { effort: 'high' } }, {}],
    [{ baseUrl: 'https://notohmylama.ru/v1', model: 'openai/gpt-6-luna' }, { messages: MESSAGES }, {}],
    [{ apiKey: '' }, { messages: MESSAGES }, {}],
    [{}, { messages: [] }, {}],
    [{}, [{ role: 'user', content: 'массив' }], { temperature: 1 }],
  ]
  for (const [config, input, options] of requestShapes) cases.push({ config, input, options, response: { text: envelope(options.json ? '{"ok":true}' : 'Ответ.') } })
  // Рассуждения кампании: только выбранная модель и помеченные роли.
  const deep = { model: 'openai/gpt-6-luna', reasoningLevel: 'deep' }
  for (const [campaign, model, role, reasoning] of [
    [deep, 'openai/gpt-6-luna', 'narrator', undefined],
    [deep, 'openai/gpt-6-luna', 'npc', { enabled: false }],
    [deep, 'openai/gpt-6-luna', undefined, { enabled: false }],
    [deep, 'z-ai/glm-5.3-flash', 'narrator', { effort: 'low' }],
    [{ model: 'openai/gpt-6-luna', reasoningLevel: 'thoughtful' }, 'openai/gpt-6-luna', 'director', undefined],
    [{ model: 'openai/gpt-6-luna', reasoningLevel: 'thoughtful' }, 'openai/gpt-6-luna', 'narrator', { enabled: false }],
    [{ model: 'openai/gpt-6-luna', reasoningLevel: 'auto' }, 'openai/gpt-6-luna', 'narrator', { enabled: false }],
  ]) {
    cases.push({ config: { model, ...(reasoning ? { reasoning } : {}) }, input: { messages: MESSAGES, ...(role ? { role } : {}) }, options: {}, campaign, response: { text: envelope('Ответ.') } })
  }
  return cases
}

// ---------------------------------------------------------------------------
// Поток SSE
// ---------------------------------------------------------------------------

const sse = (payload, separator = '\n\n') => `data: ${JSON.stringify(payload)}${separator}`

function streamTexts() {
  const delta = (content, extra = {}) => ({ choices: [{ delta: { content } }], ...extra })
  const done = 'data: [DONE]\n\n'
  return [
    sse(delta('Первая ', { model: 'stream-model' })) + sse(delta('фраза.')) + sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }) + done,
    sse(delta('Готово.')) + done,
    sse(delta('Без конца.')),
    sse(delta('A'), '\r\n\r\n') + sse(delta('B'), '\n\r\n') + sse(delta('C'), '\r\n\n') + 'data: [DONE]\r\n\r\n',
    ': комментарий\n' + sse(delta('после комментария')) + ':ping\n\n' + done,
    'event: message\nid: 7\nretry: 100\n' + sse(delta('с полями')) + done,
    'data:' + JSON.stringify(delta('без пробела')) + '\n\n' + done,
    'data:  ' + JSON.stringify(delta('два пробела')) + '\n\n' + done,
    'data: {"choices":[{"delta":\ndata: {"content":"многострочно"}}]}\n\n' + done,
    'data\ndata: {"choices":[]}\n\n' + done,
    'data: {"choices":[{"delta":{"content":"обрыв"}}\n\n' + done,
    sse(delta('x')) + 'data:  [DONE]  \n\n' + sse(delta('после DONE')),
    sse(delta('x')) + 'data: [DONE]',
    sse(delta('x')) + 'data: [DONE]\n',
    sse(delta('x')) + 'data: [done]\n\n',
    sse({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }) + done,
    sse({ error: 'строка ошибки' }) + done,
    sse({ error: { code: 'к'.repeat(100) } }) + done,
    sse({ error: { code: 12 } }) + done,
    sse({ error: 0 }) + sse(delta('ошибка 0 — не ошибка')) + done,
    sse({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] }) + done,
    sse({ choices: [{ delta: { toolCalls: 'x' } }] }) + done,
    sse({ choices: [{ delta: { tool_calls: [] , content: 'пустые инструменты' } }] }) + done,
    sse({ choices: [{ delta: { tool_calls: { length: 1 } } }] }) + done,
    sse({ choices: [{ delta: { content: { text: 'объект' } } }] }) + done,
    sse({ choices: [{ delta: { content: 5 } }] }) + done,
    sse({ choices: [{ delta: { content: null } }] }) + sse(delta('')) + sse(delta('после пустых')) + done,
    sse({ choices: { 0: { delta: { content: 'объект choices' } } } }) + done,
    sse({ choices: 'abc' }) + sse({ choices: [{ delta: 'строка' }] }) + done,
    sse({ model: 7, choices: [] }) + sse({ model: null, usage: null }) + sse(delta('модель-число')) + done,
    sse({ usage: { total_tokens: 1 } }) + sse({ usage: { total_tokens: 2 } }) + done,
    sse([1, 2]) + done,
    'data: "строка"\n\n' + done,
    'data: {"__proto__":{}}\n\n' + done,
    'data: {"choices":[{"delta":{"content":"\\ud83d\\ude00 эмодзи 😀"}}]}\n\n' + done,
    '﻿' + sse(delta('BOM в начале')) + done,
    sse(delta('BOM в середине')) + '﻿' + sse(delta('x')) + done,
    '\n\n\n\n' + sse(delta('пустые кадры')) + '\n\n' + done,
    sse(delta('Длинная дельта, ' + 'слово '.repeat(30))) + done,
    sse(delta('много')) + sse(delta(' дельт')) + sse(delta(' подряд')) + sse(delta(',')) + sse(delta(' одна')) + sse(delta(' за')) + sse(delta(' другой.')) + done,
    'data: [DONE]\n\n',
    '',
    '   \n',
    'garbage without frames',
    'id: 1\n\n' + done,
  ]
}

function hex(buffer) {
  return Buffer.from(buffer).toString('hex')
}

function splits(bytes, random, count) {
  const result = [[hex(bytes)]]
  if (bytes.length > 1) {
    // По байту, по два и случайные разрезы, в том числе внутри символов UTF-8.
    result.push(Array.from(bytes, (byte) => hex([byte])))
    for (let index = 0; index < count; index += 1) {
      const cuts = new Set()
      const pieces = 1 + Math.floor(random() * 6)
      for (let cut = 0; cut < pieces; cut += 1) cuts.add(1 + Math.floor(random() * (bytes.length - 1)))
      const ordered = [...cuts].sort((a, b) => a - b)
      const chunks = []
      let start = 0
      for (const cut of ordered) {
        chunks.push(hex(bytes.subarray(start, cut)))
        start = cut
      }
      chunks.push(hex(bytes.subarray(start)))
      result.push(chunks)
    }
  }
  return result
}

async function runStream(entry) {
  const deltas = []
  const body = entry.nullBody ? null : {
    async *[Symbol.asyncIterator]() {
      for (const chunk of entry.chunks) yield Buffer.from(chunk, 'hex')
      if (entry.fail) throw new TypeError('terminated')
    },
  }
  let seen = 0
  const onDelta = async (delta) => {
    seen += 1
    if (entry.failDelta === seen) {
      if (entry.failDeltaLlm) throw new LLMError('Получатель остановил поток', 'LLM_ABORTED')
      throw new Error('Получатель упал')
    }
    deltas.push(delta)
  }
  const out = await outcomeAsync(() => parseRouterAIEventStream(body, { onDelta, ...entry.options }))
  return { ...out, deltas }
}

async function streamCases() {
  const random = rng(77)
  const cases = []
  for (const text of streamTexts()) {
    const bytes = Buffer.from(text, 'utf8')
    for (const chunks of splits(bytes, random, 5)) cases.push({ chunks, options: {} })
  }
  const base = Buffer.from(sse({ choices: [{ delta: { content: 'Привет, мир.' } }] }) + sse({ choices: [{ delta: { content: ' Ещё.' } }] }) + 'data: [DONE]\n\n', 'utf8')
  // Битый UTF-8, неполный символ в конце, обрыв соединения.
  cases.push({ chunks: [hex(Buffer.concat([Buffer.from('data: {"choices":[{"delta":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}]}\n\n')]))], options: {} })
  cases.push({ chunks: [hex(Buffer.concat([base, Buffer.from([0xd0])]))], options: {} })
  cases.push({ chunks: [hex(Buffer.concat([Buffer.from(sse({ choices: [{ delta: { content: 'x' } }] })), Buffer.from([0xd0])]))], options: {} })
  cases.push({ chunks: [hex(Buffer.from([0xef, 0xbb])), hex(Buffer.concat([Buffer.from([0xbf]), base]))], options: {} })
  for (const chunks of splits(base, random, 3)) cases.push({ chunks: chunks.slice(0, Math.max(1, chunks.length - 1)), fail: true, options: {} })
  cases.push({ chunks: [], fail: true, options: {} })
  cases.push({ chunks: [], nullBody: true, options: {} })
  cases.push({ chunks: [], options: {} })
  // Пределы события и всего ответа.
  const long = Buffer.from(sse({ choices: [{ delta: { content: 'x'.repeat(200) } }] }) + 'data: [DONE]\n\n')
  for (const options of [{ maxEventBytes: 64, maxResponseBytes: 1000 }, { maxEventBytes: 512, maxResponseBytes: 100 }, { maxEventBytes: 512, maxResponseBytes: 230 }, { maxEventBytes: 230, maxResponseBytes: 10_000 }, { maxEventBytes: 0, maxResponseBytes: -5 }, { maxEventBytes: '512', maxResponseBytes: '250' }, { maxEventBytes: 1.5 }]) {
    for (const chunks of splits(long, random, 2)) cases.push({ chunks, options })
  }
  const noSeparator = Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(100) } }] }))
  for (const chunks of splits(noSeparator, random, 2)) cases.push({ chunks, options: { maxEventBytes: 64 } })
  const contentLimit = Buffer.from(sse({ choices: [{ delta: { content: 'абвгд' } }] }).repeat(3) + 'data: [DONE]\n\n')
  cases.push({ chunks: [hex(contentLimit)], options: { maxResponseBytes: 25 } })
  cases.push({ chunks: [hex(contentLimit)], options: { maxResponseBytes: 30 } })
  // Сбой получателя дельт: обычная ошибка — LLM_STREAM_INVALID, LLMError — как есть.
  cases.push({ chunks: [hex(base)], options: {}, failDelta: 1 })
  cases.push({ chunks: [hex(base)], options: {}, failDelta: 2 })
  cases.push({ chunks: [hex(base)], options: {}, failDelta: 2, failDeltaLlm: true })
  for (const entry of cases) Object.assign(entry, { out: await runStream(entry) })
  return cases
}

function routerStreamCases() {
  const random = rng(5)
  const cases = []
  const texts = streamTexts().slice(0, 12)
  for (const text of texts) {
    const bytes = Buffer.from(text, 'utf8')
    const chunked = splits(bytes, random, 1)
    cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: chunked[chunked.length - 1] } })
  }
  const base = Buffer.from(sse({ model: 'stream-model', choices: [{ delta: { content: 'Готово.' } }] }) + sse({ choices: [], usage: { total_tokens: 3 } }) + 'data: [DONE]\n\n')
  cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: { baseUrl: 'https://ohmylama.ru/v1', model: 'openai/gpt-6-luna' }, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: { maxEventBytes: 40 }, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: { maxResponseBytes: 50 }, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: { maxResponseBytes: 50, maxEventBytes: null }, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: [hex(base.subarray(0, 40))], fail: true } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, stream: true, response: { status: 503, chunks: [] } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: { json: true }, stream: true, response: { chunks: [hex(base)] } })
  cases.push({ config: {}, input: { messages: MESSAGES }, options: {}, stream: true, response: { chunks: [hex(Buffer.from(sse({ choices: [{ delta: { content: '   ' } }] }) + sse({ usage: { total_tokens: 4 } }) + 'data: [DONE]\n\n'))] } })
  return cases
}

// ---------------------------------------------------------------------------
// Провайдер и схема
// ---------------------------------------------------------------------------

function providerCases() {
  const urls = ['https://ohmylama.ru/v1', 'https://OHMYLAMA.RU/v1', 'https://api.ohmylama.ru/v1', 'https://ohmylama.ru:8443/v1', 'http://user:pass@ohmylama.ru/v1', 'https://ohmylama.ru./v1', 'https://notohmylama.ru/v1', 'https://ohmylama.ru.evil.com/v1', 'https://routerai.ru/api/v1', 'http://127.0.0.1:9999/v1', 'ohmylama.ru', '', 'not a url', 'foo://ohmylama.ru/x', 'https://xn--ohmylama-.ru/v1', 'https://[::1]:8787/v1']
  const bodies = [
    { model: 'anthropic/claude-sonnet-5.5', temperature: 0, reasoning: { effort: 'low' }, messages: [] },
    { model: 'openai/gpt-6-luna', reasoning: { enabled: false }, messages: [] },
    { model: 'google/gemini-2.5-flash', temperature: 0.4, frequency_penalty: 0.3, presence_penalty: 0.2, response_format: { type: 'json_schema', json_schema: { name: 'p', strict: true, schema: { type: 'object' } } }, messages: [] },
    { model: 'google/gemini-2.5-flash', response_format: 'json', messages: [] },
    { model: 'openai/gpt-6-luna', presence_penalty: 0.2, response_format: { type: 'json_schema' }, messages: [] },
    { messages: [], reasoning: { effort: 'high' } },
    { model: 'x-ai/grok/claude-x', reasoning: { effort: 'medium' } },
    { model: 'meta/muse-spark-1.3', reasoning: { effort: 'minimal' } },
    { model: 'qwen/qwen3', reasoning: ['high'] },
    { model: 'mistralai/claude-like', temperature: 1 },
    { model: 'claude-3', frequency_penalty: 1, stream: true, stream_options: { include_usage: true } },
    { model: 5, reasoning: { effort: 'low' } },
    { reasoning: null, model: 'openai/o' },
  ]
  return {
    provider: urls.map((url) => ({ url, out: llmProviderFor(url) })),
    body: bodies.flatMap((body) => ['ohmylama', 'routerai'].map((provider) => ({ provider, body, out: JSON.stringify(providerRequestBody(provider, body)) }))),
    schema: [
      SCHEMA, { ...SCHEMA, strict: false }, { ...SCHEMA, strict: 0 }, { name: 'a'.repeat(64), schema: { type: 'object' } }, { name: 'a'.repeat(65), schema: { type: 'object' } },
      { name: '', schema: { type: 'object' } }, { name: 'имя', schema: { type: 'object' } }, { name: 'ok', schema: [] }, { name: 'ok' }, { name: 'ok', schema: { type: 'array' } },
      { name: 5, schema: { type: 'object' } }, 'director_intent', [], null, { name: 'ok\n', schema: { type: 'object' } }, { name: 'a-b_c', schema: { type: 'object', extra: 1 }, other: true },
    ].map((value) => ({ value, out: JSON.stringify(usableJsonSchema(value)) })),
  }
}

const strict = strictCases()
const tools = toolCases()
const fake = await fakeCases()
const router = []
for (const entry of routerCases()) router.push({ ...entry, out: await runRouter(entry) })
const routerStream = []
for (const entry of routerStreamCases()) routerStream.push({ ...entry, out: await runRouter(entry) })
const stream = await streamCases()
const fixture = { key: TEST_KEY, strict, tools, fake, router, routerStream, stream, ...providerCases() }
writeFileSync(join(here, 'llm-client.json'), `${JSON.stringify(fixture, null, 1)}\n`, 'utf8')
const total = strict.length + tools.length + fake.length + router.length + routerStream.length + stream.length + fixture.provider.length + fixture.body.length + fixture.schema.length
console.log(`llm-client.json: ${total} случаев (strict ${strict.length}, tools ${tools.length}, fake ${fake.length}, router ${router.length}, routerStream ${routerStream.length}, stream ${stream.length})`)
