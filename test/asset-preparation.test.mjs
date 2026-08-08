// Картинки готовятся заранее, а не во время игры.
//
// Решение владельца: вечер стоит около 50 ₽, и платить за иллюстрацию посреди
// хода, пока стол ждёт, незачем. Сторож проверяет обе стороны этого решения:
// выключенный рантайм-флаг действительно не зовёт модель (и не ломает игру), а
// режим подготовки работает независимо от флага и пишет расход в леджер.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_PREPARATION_BATCH,
  itemsWithoutIllustration,
  npcPortraitInventory,
  planPreparation,
} from '../server/asset-preparation.mjs'
import { NpcPortraitService, publicNpcPortraitProfile } from '../server/npc-portraits.mjs'
import { DurableUsageLedger } from '../server/usage-ledger.mjs'

const WEBP = Buffer.from('524946460400000057454250', 'hex')

function profile(id = 'npc:marta', name = 'Марта') {
  return publicNpcPortraitProfile({ id, name, role: 'merchant', public_summary: 'Осторожная торговка.', tags: ['merchant'] })
}

function projected(npcs) {
  return {
    social: { npcs, conversations: [], promises: [], relationships: {} },
    merchants: npcs.map((npc) => ({ id: npc.id })),
  }
}

function serviceWith(rootDir, calls, options = {}) {
  return new NpcPortraitService({
    storageDir: rootDir,
    imageModel: 'openai/gpt-image-1',
    apiKey: 'test-key',
    generator: async (input) => {
      calls.push(input)
      return { bytes: WEBP, usage: { total_tokens: 12, cost: 0.4 } }
    },
    ...options,
  })
}

test('выключенная рантайм-генерация не зовёт модель и отдаёт заглушку без ошибки', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-asset-prep-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const calls = []
  const service = serviceWith(rootDir, calls)
  const npc = profile()

  const off = await service.resolve({
    campaignId: 'PREP', profile: npc, projectedState: projected([npc]), generationEnabled: false,
  })
  assert.equal(calls.length, 0, 'модель не должна вызываться при выключенном флаге')
  assert.equal(off.kind, 'static')
  assert.equal(off.reason, 'runtime_generation_disabled')
  assert.match(off.url, /^\/assets\/npcs\/roles\//u, 'вместо картинки — существующая ролевая заглушка')

  // Включённый флаг — прежнее поведение: обратная совместимость.
  const on = await service.resolve({
    campaignId: 'PREP', profile: npc, projectedState: projected([npc]), generationEnabled: true,
  })
  assert.equal(calls.length, 1)
  assert.equal(on.kind, 'generated')
  assert.equal(on.cacheHit, false)
})

test('готовый кеш отдаётся и при выключенном флаге', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-asset-prep-cache-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const calls = []
  const service = serviceWith(rootDir, calls)
  const npc = profile()

  await service.prepare({ campaignId: 'PREP', profile: npc })
  assert.equal(calls.length, 1)

  const served = await service.resolve({
    campaignId: 'PREP', profile: npc, projectedState: projected([npc]), generationEnabled: false,
  })
  assert.equal(served.kind, 'generated', 'уже готовая картинка отдаётся как обычно')
  assert.equal(served.cacheHit, true)
  assert.equal(calls.length, 1, 'второй генерации не случилось')
})

test('подготовка работает независимо от флага, пишет кеш и расход в леджер', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-asset-prep-ledger-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const calls = []
  const usageLedger = new DurableUsageLedger({ storageFile: join(rootDir, 'engine', 'usage.json'), dailyTokenLimit: 10_000 })
  const service = serviceWith(rootDir, calls, { usageLedger })
  const npc = profile()

  const prepared = await service.prepare({ campaignId: 'PREP', profile: npc })
  assert.equal(prepared.kind, 'generated')
  assert.equal(calls.length, 1)
  assert.equal((await service.cached('PREP', npc.id))?.cacheHit, true)
  const report = usageLedger.report()
  assert.equal(report.completed_requests, 1, 'расход подготовки обязан попасть в леджер')
  assert.equal(report.committed_tokens, 12)
  assert.equal(report.provider_cost, 0.4, 'цена провайдера учтена, а не потеряна')

  // Повторная подготовка перезаписывает кеш, а не падает на существующем файле.
  const again = await service.prepare({ campaignId: 'PREP', profile: npc })
  assert.equal(again.kind, 'generated')
  assert.equal(calls.length, 2)
})

test('инвентарь подготовки показывает, у кого портрета ещё нет', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-asset-prep-list-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const calls = []
  const service = serviceWith(rootDir, calls)
  const first = profile('npc:bram', 'Брам')
  const second = profile('npc:marta', 'Марта')
  await service.prepare({ campaignId: 'PREP', profile: second })

  const inventory = await npcPortraitInventory({
    service,
    campaignId: 'PREP',
    projectedState: projected([first, second]),
    significance: () => true,
    profiles: [second, first],
  })
  assert.deepEqual(inventory.map((entry) => [entry.id, entry.has_portrait]), [
    ['npc:bram', false],
    ['npc:marta', true],
  ], 'порядок детерминирован, состояние кеша честное')

  // Второстепенные NPC в подготовку не попадают: платить за невидимое незачем.
  const filtered = await npcPortraitInventory({
    service, campaignId: 'PREP', projectedState: projected([first]), significance: () => false, profiles: [first],
  })
  assert.deepEqual(filtered, [])
})

test('план подготовки уважает кап, неизвестные позиции и уже готовое', () => {
  const npcs = [
    { id: 'npc:a', has_portrait: false },
    { id: 'npc:b', has_portrait: true },
  ]
  const inventories = { npcs, locations: [] }
  assert.deepEqual(planPreparation({ npc_ids: ['npc:a', 'npc:b'] }, inventories).npc_ids, ['npc:a'], 'готовое пропускается')
  assert.deepEqual(planPreparation({ npc_ids: ['npc:a', 'npc:b'] }, inventories, { regenerate: true }).npc_ids, ['npc:a', 'npc:b'])
  assert.deepEqual(planPreparation({ npc_ids: ['npc:a', 'npc:a'] }, inventories).npc_ids, ['npc:a'], 'дубликаты схлопываются')

  assert.equal(planPreparation({}, inventories).code, 'NOTHING_REQUESTED')
  assert.equal(planPreparation({ npc_ids: [] }, inventories).code, 'NOTHING_REQUESTED')
  assert.equal(planPreparation({ npc_ids: ['npc:zzz'] }, inventories).code, 'UNKNOWN_ASSET')

  const large = Array.from({ length: MAX_PREPARATION_BATCH + 1 }, (_, index) => ({ id: `npc:${index}`, has_portrait: false }))
  const overflow = planPreparation({ npc_ids: large.map((entry) => entry.id) }, { npcs: large })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.code, 'BATCH_TOO_LARGE')
  assert.match(overflow.message, new RegExp(String(MAX_PREPARATION_BATCH), 'u'))
  assert.equal(planPreparation({ npc_ids: large.slice(0, MAX_PREPARATION_BATCH).map((entry) => entry.id) }, { npcs: large }).ok, true)
})

test('кап один на все виды картинок: локации и NPC складываются, а не считаются порознь', () => {
  const npcs = Array.from({ length: MAX_PREPARATION_BATCH - 1 }, (_, index) => ({ id: `npc:${index}`, has_portrait: false }))
  const locations = [
    { id: 'loc:norvin', has_illustration: false },
    { id: 'loc:archive', has_illustration: true },
  ]
  const inventories = { npcs, locations }

  const fits = planPreparation({ npc_ids: npcs.map((entry) => entry.id), location_ids: ['loc:norvin'] }, inventories)
  assert.equal(fits.ok, true, 'ровно потолок проходит')
  assert.deepEqual(fits.location_ids, ['loc:norvin'])

  const overflow = planPreparation(
    { npc_ids: npcs.map((entry) => entry.id), location_ids: ['loc:norvin', 'loc:archive'] },
    inventories,
    { regenerate: true },
  )
  assert.equal(overflow.code, 'BATCH_TOO_LARGE', 'потолок общий, а не по потолку на вид')
  assert.deepEqual([overflow.npc_ids, overflow.location_ids], [[], []])

  // Готовая иллюстрация пропускается так же, как готовый портрет, и
  // перегенерация её возвращает.
  assert.deepEqual(planPreparation({ location_ids: ['loc:archive'] }, inventories).location_ids, [])
  assert.deepEqual(planPreparation({ location_ids: ['loc:archive'] }, inventories, { regenerate: true }).location_ids, ['loc:archive'])
  assert.equal(planPreparation({ location_ids: ['loc:unknown'] }, inventories).code, 'UNKNOWN_ASSET')
  assert.match(planPreparation({ location_ids: ['loc:unknown'] }, inventories).message, /локации/u)
})

test('отказ отдаёт свои пустые списки, а не общий экземпляр на все отказы', () => {
  const inventories = { npcs: [{ id: 'npc:a', has_portrait: false }], locations: [] }
  const first = planPreparation({ npc_ids: ['npc:zzz'] }, inventories)
  const second = planPreparation({}, inventories)
  assert.notEqual(first.npc_ids, second.npc_ids, 'два отказа не должны делить один массив')
  assert.notEqual(first.location_ids, second.location_ids)

  // Ответ разбора — обычный изменяемый объект, и вызывающий вправе с ним
  // работать. Общий замороженный экземпляр либо молча проглотил бы правку, либо
  // разнёс её по всем прошлым и будущим отказам.
  first.npc_ids.push('npc:a')
  assert.deepEqual(second.npc_ids, [])
  assert.deepEqual(planPreparation({}, inventories).npc_ids, [])
})

test('предметы без иллюстрации перечисляются детерминированно и без дублей', () => {
  const state = {
    players: [
      { id: 'hero', inventory: [
        { id: 'sword', name: 'Меч', image: '/generated/items/x.webp' },
        { id: 'amulet', name: 'Амулет' },
        { id: 'rope', name: 'Верёвка', image: '' },
      ] },
      { id: 'ally', inventory: [
        { id: 'amulet', name: 'Амулет' },
        { id: 'lantern', name: 'Фонарь' },
      ] },
    ],
  }
  assert.deepEqual(itemsWithoutIllustration(state).map((entry) => entry.id), ['amulet', 'lantern', 'rope'])
  assert.deepEqual(itemsWithoutIllustration({}), [])
  assert.deepEqual(itemsWithoutIllustration(null), [])
})
