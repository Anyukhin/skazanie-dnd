import assert from 'node:assert/strict'
import test from 'node:test'
import { openRouterFreeModels, RouterAIClient } from '../server/llm-client.mjs'

// Бесплатный маршрут OpenRouter в JS-библиотеке: разбор списка моделей и отказ
// платной конфигурации. HTTP-путь — openrouter-free-api.test.mjs.

const freeModels = ['test/primary:free', 'openrouter/free']

test('OpenRouter отклоняет платную конфигурацию и сохраняет порядок бесплатных моделей', () => {
  assert.deepEqual(openRouterFreeModels(), ['openrouter/free'])
  assert.deepEqual(openRouterFreeModels(' test/primary:free , test/primary:free,openrouter/free'), freeModels)
  assert.deepEqual(openRouterFreeModels('openrouter/free,test/paid'), ['openrouter/free'])
  assert.deepEqual(openRouterFreeModels('test/paid,invalid:free'), ['openrouter/free'])
  assert.throws(() => new RouterAIClient({ openRouterFree: true, model: 'test/paid' }), /бесплатной/u)
})
