import '../../../fixtures-env.mjs'
// Эталон локального поставщика картинок (`createLocalImageGenerator`,
// `localImageServerHealth`, `imageProviderFromEnv` из
// `server/image-generation.mjs`): сценарии ответа сервера → запрос и итог.
//
//   node rust/crates/sk-infra/fixtures/gen-local-image.mjs
//
// Пока ветка с локальным поставщиком не влита в эту, путь к серверу JS можно
// задать: SKAZANIE_SERVER_DIR=<каталог server/ другой рабочей копии>.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = process.env.SKAZANIE_SERVER_DIR ? resolve(process.env.SKAZANIE_SERVER_DIR) : join(here, '../../../../server')
const { createLocalImageGenerator, imageProviderFromEnv, localImageServerHealth } = await import(pathToFileURL(join(serverDir, 'image-generation.mjs')).href)

const WEBP = Buffer.from('524946460400000057454250', 'hex')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** Подставной fetch: записывает запрос, отвечает сценарием. */
function scripted(reply) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: Object.entries(init.headers ?? {}), body: init.body ?? '' })
    if (reply.transport) throw Object.assign(new Error('сбой'), { name: reply.transport })
    return new Response(reply.body, { status: reply.status })
  }
  return { impl, calls }
}

const replies = [
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64'), elapsed_ms: 8421.6 }) },
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64'), elapsed_ms: null }) },
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64'), elapsed_ms: '12' }) },
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64'), elapsed_ms: -3 }) },
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64') }) },
  { status: 200, body: JSON.stringify({ b64_json: PNG.toString('base64') }) },
  { status: 200, body: JSON.stringify({ b64_json: Buffer.from('<html>').toString('base64') }) },
  { status: 200, body: JSON.stringify({ b64_json: '' }) },
  { status: 200, body: JSON.stringify({ b64_json: 42 }) },
  { status: 200, body: JSON.stringify({ b64_json: WEBP.toString('base64') + 'A'.repeat(64) }) },
  { status: 200, body: 'не json' },
  { status: 200, body: '[]' },
  { status: 503, body: JSON.stringify({ error: 'занято', code: 'IMAGE_SERVER_BUSY' }) },
  { status: 503, body: JSON.stringify({ error: 'грузится', code: 'IMAGE_MODEL_LOADING' }) },
  { status: 400, body: JSON.stringify({ code: 'не код' }) },
  { status: 400, body: JSON.stringify({ code: 'AB' }) },
  { status: 500, body: '' },
  { status: 401, body: JSON.stringify({ code: 'UNAUTHORIZED' }) },
  { transport: 'TypeError' },
  { transport: 'TimeoutError' },
  { transport: 'AbortError' },
]

const optionSets = [
  { baseUrl: 'http://127.0.0.1:8790', aspectRatio: '1:1' },
  { baseUrl: 'http://host.docker.internal:8790///', aspectRatio: '16:9', token: 'local-test-token', steps: 12 },
  { baseUrl: 'http://127.0.0.1:8790', outputFormat: 'png', maxBytes: 16 },
  { baseUrl: 'http://127.0.0.1:8790', aspectRatio: '16:9', steps: 2.5 },
]
const seeds = [undefined, 0, 42, -1, 1.5, 2 ** 53]

const generate = []
for (const options of optionSets) {
  for (const reply of replies) {
    for (const seed of seeds) {
      const { impl, calls } = scripted(reply)
      const generator = createLocalImageGenerator({ ...options, fetchImpl: impl })
      let result
      try {
        const image = await generator({ prompt: 'Трактир «Пьяный гусь» вечером', model: 'ignored', seed })
        result = { bytes: image.bytes.toString('hex'), usage: image.usage }
      } catch (error) {
        result = { error: { name: error.name, code: error.code ?? null, message: error.message } }
      }
      generate.push({ options, reply, seed: seed ?? null, request: calls[0] ?? null, result })
    }
  }
}

const configErrors = []
for (const options of [{ baseUrl: 'x', outputFormat: 'gif' }, { baseUrl: 'x', aspectRatio: '4:3' }]) {
  try {
    createLocalImageGenerator(options)
    configErrors.push({ options, error: null })
  } catch (error) {
    configErrors.push({ options, error: error.message })
  }
}

const healthReplies = [
  { status: 200, body: JSON.stringify({ status: 'ready', model: 'x', device: 'NVIDIA GeForce RTX 5080', vram_total_mb: 16303, queue: 0, last_elapsed_ms: 8400, prompt: 'секрет', loaded_in_ms: 'много' }) },
  { status: 200, body: JSON.stringify({ status: 'loading', queue: 1, queue_limit: 4, generated: 0 }) },
  { status: 200, body: JSON.stringify({ status: 'error', error: 'CUDA недоступна: ' + 'x'.repeat(400) }) },
  { status: 200, body: JSON.stringify({ status: 'weird', device: 'Д'.repeat(100) }) },
  { status: 200, body: '[]' },
  { status: 200, body: 'не json' },
  { status: 200, body: 'null' },
  { status: 500, body: JSON.stringify({ status: 'ready' }) },
  { status: 401, body: '{}' },
  { transport: 'TypeError' },
  { transport: 'TimeoutError' },
]
const health = []
for (const token of ['', 'local-test-token']) {
  for (const reply of healthReplies) {
    const { impl, calls } = scripted(reply)
    const result = await localImageServerHealth({ fetchImpl: impl, baseUrl: 'http://127.0.0.1:8790/', token })
    health.push({ token, reply, request: calls[0] ?? null, result })
  }
}

const envCases = [
  {},
  { DND_RUNTIME_IMAGE_GENERATION: 'on' },
  { DND_RUNTIME_IMAGE_GENERATION: ' YES ' },
  { DND_IMAGE_PROVIDER: 'routerai', DND_RUNTIME_IMAGE_GENERATION: 'off' },
  { DND_IMAGE_PROVIDER: ' Local ' },
  { DND_IMAGE_PROVIDER: 'local', DND_RUNTIME_IMAGE_GENERATION: 'off' },
  { DND_IMAGE_PROVIDER: 'local', DND_RUNTIME_IMAGE_GENERATION: 'No' },
  { DND_IMAGE_PROVIDER: 'local', DND_RUNTIME_IMAGE_GENERATION: 'maybe' },
  { DND_IMAGE_PROVIDER: 'local', DND_LOCAL_IMAGE_URL: ' http://host.docker.internal:8790 ', DND_LOCAL_IMAGE_TOKEN: ' t ', DND_LOCAL_IMAGE_STEPS: ' 12 ' },
  { DND_IMAGE_PROVIDER: 'local', DND_LOCAL_IMAGE_STEPS: '2.5' },
  { DND_IMAGE_PROVIDER: 'local', DND_LOCAL_IMAGE_STEPS: '-4' },
  { DND_IMAGE_PROVIDER: 'local', DND_LOCAL_IMAGE_STEPS: 'много' },
  { DND_IMAGE_PROVIDER: 'flux' },
]
const providers = []
for (const env of envCases) {
  for (const routerai of [{ apiKey: 'k', imageModel: 'openai/gpt-image-1' }, { apiKey: '', imageModel: 'openai/gpt-image-1' }, { apiKey: 'k', imageModel: '' }]) {
    try {
      const provider = imageProviderFromEnv(env, routerai)
      const calls = []
      const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), headers: Object.entries(init.headers ?? {}) })
        return new Response(JSON.stringify({ b64_json: WEBP.toString('base64') }))
      }
      let local = null
      if (provider.provider === 'local') {
        const withFetch = imageProviderFromEnv(env, { ...routerai, fetchImpl })
        await withFetch.generatorFor({ aspectRatio: '16:9', outputFormat: 'webp', maxBytes: 1024 })({ prompt: 'Мост', model: provider.model })
        local = calls[0]
      }
      providers.push({ env, routerai, result: { provider: provider.provider, model: provider.model, configured: provider.configured, runtimeGeneration: provider.runtimeGeneration, local } })
    } catch (error) {
      providers.push({ env, routerai, result: { error: error.message } })
    }
  }
}

const text = JSON.stringify({ generate, configErrors, health, providers }, null, 1)
writeFileSync(join(here, 'local-image.json'), text)
console.log(`генерации: ${generate.length}, состояния: ${health.length}, окружения: ${providers.length}, ${(text.length / 1024).toFixed(0)} КБ`)
