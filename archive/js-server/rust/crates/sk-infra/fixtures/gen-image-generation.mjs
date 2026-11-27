// Эталон `server/image-generation.mjs` для `tests/image_generation_fixture.rs`:
// сигнатуры webp/png на случайных байтах и ответы поставщика картинок через
// подменённый `fetchImpl` (запрос записывается, ответ — из сценария).
//
// Запуск из корня репозитория:
//   node rust/crates/sk-infra/fixtures/gen-image-generation.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMAGE_GENERATION_MAX_BYTES, createRouterImageGenerator, isPng, isWebp } from '../../../../server/image-generation.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (random, list) => list[Math.floor(random() * list.length)]
const WEBP = Buffer.from('524946460400000057454250', 'hex')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

function signatures(random) {
  const cases = []
  for (let index = 0; index < 400; index += 1) {
    const base = pick(random, ['webp', 'png', 'random', 'webp_high', 'png_high', 'short'])
    let bytes
    if (base === 'webp' || base === 'webp_high') bytes = Buffer.concat([WEBP, Buffer.from(Array.from({ length: Math.floor(random() * 6) }, () => Math.floor(random() * 256)))])
    else if (base === 'png' || base === 'png_high') bytes = Buffer.concat([PNG, Buffer.from(Array.from({ length: Math.floor(random() * 6) }, () => Math.floor(random() * 256)))])
    else if (base === 'short') bytes = (random() < 0.5 ? WEBP : PNG).subarray(0, Math.floor(random() * 12))
    else bytes = Buffer.from(Array.from({ length: Math.floor(random() * 16) }, () => Math.floor(random() * 256)))
    bytes = Buffer.from(bytes)
    if (base.endsWith('_high')) {
      // Старший бит в сигнатуре: `toString('ascii')` Node его снимает.
      const position = Math.floor(random() * Math.min(bytes.length, 12))
      bytes[position] |= 0x80
    }
    if (random() < 0.1 && bytes.length) bytes[Math.floor(random() * bytes.length)] ^= 0x01
    cases.push({ bytes: bytes.toString('base64'), is_webp: isWebp(bytes), is_png: isPng(bytes) })
  }
  return cases
}

async function generators(random) {
  const cases = []
  for (let index = 0; index < 500; index += 1) {
    const options = {
      baseUrl: pick(random, ['https://images.example/v1', 'https://images.example/v1///', '', 'http://127.0.0.1:9/api']),
      apiKey: pick(random, ['fake-key', '']),
      outputFormat: pick(random, ['webp', 'webp', 'webp', 'png', 'png', 'gif']),
      aspectRatio: pick(random, ['1:1', '16:9']),
      resolution: pick(random, ['1K', '2K']),
      quality: pick(random, ['low', 'medium']),
      maxBytes: pick(random, [IMAGE_GENERATION_MAX_BYTES, IMAGE_GENERATION_MAX_BYTES, 64, 20]),
      timeoutMs: pick(random, [120_000, 5_000]),
    }
    const image = pick(random, ['webp', 'png', 'html', 'big_webp'])
    const imageBytes = image === 'webp' ? WEBP : image === 'png' ? PNG : image === 'big_webp' ? Buffer.concat([WEBP, Buffer.alloc(60)]) : Buffer.from('<html>не картинка</html>', 'utf8')
    const encoded = pick(random, ['standard', 'standard', 'standard', 'url', 'spaces', 'none', 'number', 'long'])
    const b64 = encoded === 'url' ? imageBytes.toString('base64url')
      : encoded === 'spaces' ? imageBytes.toString('base64').replace(/(.{4})/gu, '$1 ')
        : encoded === 'none' ? ''
          : encoded === 'number' ? 12
            : encoded === 'long' ? 'A'.repeat(200)
              : imageBytes.toString('base64')
    const container = pick(random, ['array', 'array', 'array', 'object', 'missing', 'string'])
    const item = { b64_json: b64 }
    const payload = {}
    if (container === 'array') payload.data = [item]
    else if (container === 'object') payload.data = { 0: item }
    else if (container === 'string') payload.data = 'abc'
    const usage = pick(random, ['none', 'tokens', 'cost', 'array', 'total_cost'])
    if (usage === 'tokens') payload.usage = { total_tokens: 12 }
    else if (usage === 'cost') payload.usage = { total_tokens: 12, cost: 0.4 }
    else if (usage === 'array') payload.usage = [1, 2]
    else if (usage === 'total_cost') payload.usage = { total_cost: 0.2 }
    const topCost = pick(random, [undefined, undefined, 0.5, null, 0])
    if (topCost !== undefined) payload.cost = topCost
    const status = pick(random, [200, 200, 200, 200, 200, 200, 500, 404, 201])
    const body = pick(random, ['json', 'json', 'json', 'json', 'garbage', 'bom'])
    const text = body === 'garbage' ? '<html>' : body === 'bom' ? `﻿${JSON.stringify(payload)}` : JSON.stringify(payload)
    const prompt = pick(random, ['портрет', 'p', 'Fantasy "portrait"\n'])
    const model = pick(random, ['m', 'openai/gpt-image-1'])
    const entry = { options, response: { status, body: text }, prompt, model }
    const requests = []
    try {
      const generator = createRouterImageGenerator({
        ...options,
        fetchImpl: async (url, init) => {
          requests.push({ url, headers: Object.entries(init.headers), body: init.body, method: init.method })
          return new Response(text, { status, headers: { 'Content-Type': 'application/json' } })
        },
      })
      const result = await generator({ prompt, model })
      entry.result = { bytes: result.bytes.toString('base64'), usage: result.usage }
    } catch (error) {
      entry.error = { name: error?.name, message: error?.message }
    }
    entry.requests = requests
    cases.push(entry)
  }
  return cases
}

const random = mulberry32(31337)
const fixture = { max_bytes: IMAGE_GENERATION_MAX_BYTES, signatures: signatures(random), generators: await generators(random) }
writeFileSync(join(here, 'image-generation.json'), `${JSON.stringify(fixture)}\n`, 'utf8')
console.log(`image-generation: ${fixture.signatures.length} сигнатур, ${fixture.generators.length} ответов (${fixture.generators.filter((entry) => entry.result).length} успешных)`)
