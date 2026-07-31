import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test from 'node:test'
import {
  NPC_PORTRAIT_ROLE_ASSETS,
  NpcPortraitService,
  buildNpcPortraitPrompt,
  createRouterNpcPortraitGenerator,
  npcPortraitCacheLocation,
  npcPortraitRole,
  npcPortraitSignificance,
  publicNpcPortraitProfile,
  visibleNpcPortraitProfile,
} from '../server/npc-portraits.mjs'
import { DurableUsageLedger } from '../server/usage-ledger.mjs'

const WEBP = Buffer.from('524946460400000057454250', 'hex')

function profile(overrides = {}) {
  return publicNpcPortraitProfile({
    id: 'npc:marta',
    name: 'Марта',
    role: 'merchant',
    public_summary: 'Осторожная торговка со старым шрамом.',
    tags: [],
    goals: ['PRIVATE_GOAL'],
    beliefs: ['PRIVATE_BELIEF'],
    gm_notes: 'GM_ONLY_NOTE',
    ...overrides,
  })
}

function projected(npc, overrides = {}) {
  return {
    social: {
      npcs: [npc],
      conversations: [],
      promises: [],
      relationships: { [npc.id]: { 'hero:ada': 0 } },
      ...overrides.social,
    },
    merchants: overrides.merchants ?? [],
  }
}

test('портрет принимает только публичные поля и строит bounded prompt без private/GM данных', () => {
  const safe = profile()
  assert.ok(safe)
  assert.deepEqual(Object.keys(safe).sort(), ['id', 'name', 'public_summary', 'role', 'tags'])
  const prompt = buildNpcPortraitPrompt(safe)
  assert.match(prompt, /Марта|merchant|Осторожная торговка/u)
  assert.doesNotMatch(prompt, /PRIVATE_GOAL|PRIVATE_BELIEF|GM_ONLY_NOTE|goals|beliefs|gm_notes/u)
  assert.ok(prompt.length < 1_400)
})

test('видимость и значимость выводятся только из готовой viewer projection', () => {
  const minor = profile({ role: 'baker' })
  assert.ok(minor)
  const state = projected(minor)
  assert.equal(visibleNpcPortraitProfile(state, minor.id)?.name, 'Марта')
  assert.equal(visibleNpcPortraitProfile(state, 'npc:hidden'), null)
  assert.deepEqual(npcPortraitSignificance(state, minor), { significant: false, reasons: [] })

  const cases = [
    [projected(minor, { merchants: [{ id: minor.id }] }), 'merchant'],
    [projected(minor, { social: { conversations: [{ npc_id: minor.id }] } }), 'conversation'],
    [projected(minor, { social: { promises: [{ npc_id: minor.id, status: 'open' }] } }), 'open_promise'],
    [projected(minor, { social: { relationships: { [minor.id]: { 'hero:ada': -1 } } } }), 'relationship'],
  ]
  for (const [candidate, reason] of cases) {
    assert.equal(npcPortraitSignificance(candidate, minor).significant, true)
    assert.ok(npcPortraitSignificance(candidate, minor).reasons.includes(reason))
  }
  const tagged = profile({ role: 'baker', tags: ['key_npc'] })
  assert.ok(tagged)
  assert.deepEqual(npcPortraitSignificance(projected(tagged), tagged), {
    significant: true,
    reasons: ['important_tag'],
  })
})

test('второстепенный NPC получает детерминированную роль без вызова генератора', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'npc-portrait-static-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  let calls = 0
  const service = new NpcPortraitService({
    storageDir: storage,
    imageModel: 'test/image',
    apiKey: 'configured',
    generator: async () => { calls += 1; return { bytes: WEBP } },
  })
  const minor = profile({ role: 'village baker' })
  assert.ok(minor)
  const result = await service.resolve({
    campaignId: 'CAMP',
    profile: minor,
    projectedState: projected(minor),
  })
  assert.deepEqual(result, {
    kind: 'static',
    source: 'static',
    role: 'artisan',
    url: NPC_PORTRAIT_ROLE_ASSETS.artisan,
    reason: 'secondary_npc',
  })
  assert.equal(calls, 0)
  assert.equal(npcPortraitRole(profile({ role: 'captain of the guard' })), 'guard')
  assert.equal(npcPortraitRole(profile({ role: 'court scholar' })), 'scholar')
})

test('значимый NPC генерируется один раз и читается из campaign+npc cache после рестарта', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'npc-portrait-cache-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const important = profile({ tags: ['important'] })
  assert.ok(important)
  const state = projected(important)
  let calls = 0
  let received = null
  const firstService = new NpcPortraitService({
    storageDir: storage,
    imageModel: 'test/image-v1',
    apiKey: 'configured',
    generator: async (input) => {
      calls += 1
      received = input
      return { bytes: WEBP }
    },
  })
  const first = await firstService.resolve({ campaignId: 'CAMP-ONE', profile: important, projectedState: state })
  const second = await firstService.resolve({ campaignId: 'CAMP-ONE', profile: important, projectedState: state })
  assert.equal(first.kind, 'generated')
  assert.equal(first.cacheHit, false)
  assert.equal(second.kind, 'generated')
  assert.equal(second.cacheHit, true)
  assert.equal(calls, 1)
  assert.equal(received.model, 'test/image-v1')
  assert.doesNotMatch(received.prompt, /PRIVATE_|GM_ONLY/u)

  const location = npcPortraitCacheLocation(join(storage, 'generated', 'npcs'), 'CAMP-ONE', important.id)
  assert.equal(readFileSync(location.filePath).equals(WEBP), true)
  assert.equal(isAbsolute(location.filePath), true)
  assert.equal(relative(location.root, location.filePath).startsWith('..'), false)
  assert.doesNotMatch(location.filePath, /CAMP-ONE|npc:marta/u)

  const restarted = new NpcPortraitService({
    storageDir: storage,
    imageModel: 'test/image-v1',
    apiKey: 'configured',
    generator: async () => { throw new Error('cache should prevent generation') },
  })
  const afterRestart = await restarted.resolve({ campaignId: 'CAMP-ONE', profile: important, projectedState: state })
  assert.equal(afterRestart.kind, 'generated')
  assert.equal(afterRestart.cacheHit, true)
})

test('usage ledger учитывает успешную и ошибочную генерацию, но не cache hit и static portrait', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'npc-portrait-usage-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const ledgerFile = join(storage, 'engine', 'usage.json')
  const ledger = new DurableUsageLedger({
    storageFile: ledgerFile,
    dailyTokenLimit: 20_000,
    now: () => Date.parse('2026-07-31T12:00:00.000Z'),
  })
  let calls = 0
  let failNext = false
  const reservedDuringProvider = []
  const service = new NpcPortraitService({
    storageDir: storage,
    imageModel: 'test/image-metered',
    apiKey: 'configured',
    usageLedger: ledger,
    generator: async () => {
      calls += 1
      reservedDuringProvider.push(ledger.report().reserved_tokens)
      if (failNext) {
        const error = new Error('provider failed')
        error.code = 'IMAGE_PROVIDER_FAILED'
        throw error
      }
      return {
        bytes: WEBP,
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          total_tokens: 12,
          cost: 0.014,
        },
      }
    },
  })
  const minor = profile({ id: 'npc:minor', role: 'village baker' })
  const important = profile({ id: 'npc:important', tags: ['important'] })
  assert.ok(minor)
  assert.ok(important)

  const staticResult = await service.resolve({
    campaignId: 'CAMP',
    profile: minor,
    projectedState: projected(minor),
  })
  assert.equal(staticResult.kind, 'static')
  assert.equal(ledger.report().requests, 0)

  const generated = await service.resolve({
    campaignId: 'CAMP',
    profile: important,
    projectedState: projected(important),
  })
  assert.equal(generated.kind, 'generated')
  assert.equal(generated.cacheHit, false)
  assert.deepEqual(ledger.report(), {
    day: '2026-07-31',
    daily_token_limit: 20_000,
    committed_tokens: 12,
    reserved_tokens: 0,
    input_tokens: 5,
    output_tokens: 7,
    provider_cost: 0.014,
    requests: 1,
    completed_requests: 1,
    failed_requests: 0,
  })

  const cached = await service.resolve({
    campaignId: 'CAMP',
    profile: important,
    projectedState: projected(important),
  })
  assert.equal(cached.kind, 'generated')
  assert.equal(cached.cacheHit, true)
  assert.equal(calls, 1)
  assert.equal(ledger.report().requests, 1)

  failNext = true
  const failed = await service.resolve({
    campaignId: 'FAIL',
    profile: important,
    projectedState: projected(important),
  })
  assert.equal(failed.kind, 'static')
  assert.equal(failed.reason, 'generation_failed')
  assert.equal(calls, 2)
  const failedReport = ledger.report()
  assert.equal(failedReport.completed_requests, 1)
  assert.equal(failedReport.failed_requests, 1)
  assert.equal(failedReport.reserved_tokens, 0)
  assert.equal(failedReport.provider_cost, 0.014)
  assert.ok(reservedDuringProvider.every((tokens) => tokens > 0))

  const persisted = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const entries = Object.values(persisted.requests)
  assert.deepEqual(entries.map((entry) => entry.scope), ['npc-portrait', 'npc-portrait'])
  assert.deepEqual(entries.map((entry) => entry.model), ['test/image-metered', 'test/image-metered'])
  assert.equal(entries[1].error_code, 'IMAGE_PROVIDER_FAILED')
  assert.doesNotMatch(JSON.stringify(persisted), /Осторожная торговка|server-owned prompt/u)
})

test('одновременные запросы одного NPC делят одну генерацию, а rate limit проверяется только на cache miss', async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'npc-portrait-concurrent-'))
  t.after(() => rmSync(storage, { recursive: true, force: true }))
  const important = profile({ tags: ['important'] })
  assert.ok(important)
  const state = projected(important)
  let calls = 0
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const service = new NpcPortraitService({
    storageDir: storage,
    imageModel: 'test/image',
    apiKey: 'configured',
    generator: async () => {
      calls += 1
      await barrier
      return { bytes: WEBP }
    },
  })
  const first = service.resolve({ campaignId: 'CAMP', profile: important, projectedState: state })
  const second = service.resolve({ campaignId: 'CAMP', profile: important, projectedState: state })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const results = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.kind === 'generated'))

  let allowanceChecks = 0
  const cached = await service.resolve({
    campaignId: 'CAMP',
    profile: important,
    projectedState: state,
    allowGeneration: () => { allowanceChecks += 1; return false },
  })
  assert.equal(cached.kind, 'generated')
  assert.equal(allowanceChecks, 0)

  const blocked = await service.resolve({
    campaignId: 'OTHER',
    profile: important,
    projectedState: state,
    allowGeneration: () => { allowanceChecks += 1; return false },
  })
  assert.deepEqual(blocked, { kind: 'rate_limited', source: 'rate_limited' })
  assert.equal(allowanceChecks, 1)
})

test('RouterAI generator получает server-owned image contract через injected fetch', async () => {
  let request = null
  const generator = createRouterNpcPortraitGenerator({
    baseUrl: 'https://images.example/v1/',
    apiKey: 'fake-key',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return new Response(JSON.stringify({
        data: [{ b64_json: WEBP.toString('base64') }],
        usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
        cost: 0.025,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const generated = await generator({ prompt: 'server prompt', model: 'image/model' })
  assert.equal(generated.bytes.equals(WEBP), true)
  assert.deepEqual(generated.usage, {
    input_tokens: 4,
    output_tokens: 8,
    total_tokens: 12,
    cost: 0.025,
  })
  assert.equal(request.url, 'https://images.example/v1/images')
  assert.equal(request.options.headers.Authorization, 'Bearer fake-key')
  const body = JSON.parse(request.options.body)
  assert.deepEqual(body, {
    model: 'image/model',
    prompt: 'server prompt',
    n: 1,
    aspect_ratio: '1:1',
    resolution: '1K',
    quality: 'low',
    output_format: 'webp',
  })
})

test('cache path не использует campaign/npc как сегменты и не допускает traversal', () => {
  const root = join(tmpdir(), 'npc-portrait-root')
  const location = npcPortraitCacheLocation(root, '..\\..\\outside', '../../secret')
  assert.equal(relative(resolveForTest(root), location.filePath).startsWith('..'), false)
  assert.doesNotMatch(location.filePath, /outside|secret/u)
})

function resolveForTest(path) {
  return isAbsolute(path) ? path : join(process.cwd(), path)
}
