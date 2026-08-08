// Иллюстрации локаций готовятся заранее и в игре не генерируются.
//
// Сторож проверяет три обещания: список локаций честен и не течёт мимо
// проекции (gm_only памяти мира и неоткрытые точки карты игроку не видны),
// подготовка пишет кеш и расход в леджер, а в рантайме модель не зовётся
// вообще — у сервиса просто нет метода «сгенерируй, если нет».
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'

import {
  LocationIllustrationService,
  buildLocationIllustrationPrompt,
  locationIllustrationCacheLocation,
  locationIllustrationInventory,
  normalizeLocationId,
  visibleCampaignLocations,
  visibleLocationProfile,
} from '../server/location-illustrations.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { DurableUsageLedger } from '../server/usage-ledger.mjs'

const WEBP = Buffer.from('524946460400000057454250', 'hex')

function serviceWith(rootDir, calls, options = {}) {
  return new LocationIllustrationService({
    storageDir: rootDir,
    imageModel: 'openai/gpt-image-1',
    apiKey: 'test-key',
    generator: async (input) => {
      calls.push(input)
      return { bytes: WEBP, usage: { total_tokens: 14, cost: 0.5 } }
    },
    ...options,
  })
}

function campaignState() {
  return {
    sessionCode: 'PREP',
    campaign: 'Проба',
    partyMemberIds: ['hero:ada'],
    players: [{ id: 'hero:ada', name: 'Ада', character: 'Ада', hp: 10, maxHp: 10, x: 1, y: 1, speed: 30 }],
    scene: {
      title: 'Разбитый обоз',
      location: 'Норвинский тракт',
      location_id: 'loc:norvin-road',
      scene_kind: 'road',
      mood: 'тревожно',
      objective: 'Найти уцелевших',
      turn: 1,
      cells: [],
    },
    worldMap: {
      version: 1,
      seed: 'seed',
      name: 'Норвин',
      width: 1000,
      height: 640,
      currentLocationId: 'loc:norvin-road',
      regions: [{ id: 'reg:north', name: 'Север', biome: 'plains', x: 10, y: 10, radius: 100 }],
      locations: [
        { id: 'loc:norvin-road', name: 'Норвинский тракт', kind: 'landmark', x: 10, y: 10, regionId: 'reg:north', summary: 'Разбитая дорога', known: true, visited: true },
        { id: 'loc:hidden-vault', name: 'Тайный схрон', kind: 'ruin', x: 90, y: 90, regionId: 'reg:north', summary: 'Ещё не найден', known: false, visited: false },
      ],
      routes: [],
    },
    worldMemory: {
      entities: [
        { id: 'loc:archive', kind: 'location', name: 'Затопленный архив', summary: 'Подвалы под городом', visibility: 'party', aliases: [], tags: [] },
        { id: 'loc:cult-lair', kind: 'location', name: 'Логово культа', summary: 'Тайна ведущего', visibility: 'gm_only', aliases: [], tags: [] },
        { id: 'npc:marta', kind: 'npc', name: 'Марта', summary: 'Торговка', visibility: 'public', aliases: [], tags: [] },
      ],
      facts: [],
      relationships: [],
      quests: [],
      threads: [],
      epistemic_claims: [],
      summaries: [],
      knowledge_ledger: [],
    },
  }
}

test('список локаций собирается из проекции: сцена, карта мира и память мира', () => {
  const admin = campaignStateForViewer(campaignState(), { role: 'admin', id: 'gm' }, '')
  const locations = visibleCampaignLocations(admin)
  assert.deepEqual(
    locations.map((entry) => [entry.id, entry.name, entry.source]),
    [
      ['loc:archive', 'Затопленный архив', 'world_memory'],
      ['loc:cult-lair', 'Логово культа', 'world_memory'],
      ['loc:hidden-vault', 'Тайный схрон', 'world_map'],
      ['loc:norvin-road', 'Норвинский тракт', 'scene'],
    ],
    'порядок детерминирован; подпись текущей сцены побеждает сухую запись карты, NPC в список не попадают',
  )
  // Ведущий видит и закрытое: он готовит картинку до того, как отряд туда
  // дойдёт, — иначе подготовка заранее теряет смысл.
  assert.ok(locations.some((entry) => entry.id === 'loc:cult-lair'))
})

test('игроку не видны ни gm_only локации памяти мира, ни картинка по прямому запросу', () => {
  const state = campaignState()
  const player = campaignStateForViewer(state, { role: 'player', id: 'user:ada' }, 'hero:ada')
  const visible = visibleCampaignLocations(player)
  assert.deepEqual(visible.map((entry) => entry.id), ['loc:archive', 'loc:norvin-road'])
  assert.equal(visibleLocationProfile(player, 'loc:cult-lair'), null, 'закрытая локация для игрока не существует')
  assert.equal(visibleLocationProfile(player, 'loc:hidden-vault'), null)
  assert.ok(visibleLocationProfile(player, 'loc:archive'))

  const admin = campaignStateForViewer(state, { role: 'admin', id: 'gm' }, '')
  assert.ok(visibleLocationProfile(admin, 'loc:cult-lair'), 'ведущий готовит и закрытые локации')
})

test('идентификатор локации проверяется, а ключ кеша не содержит ни кампании, ни id', () => {
  assert.equal(normalizeLocationId('loc:archive'), 'loc:archive')
  for (const bad of ['', '../secret', 'loc archive', '/loc', 'a'.repeat(121)]) {
    assert.equal(normalizeLocationId(bad), '', `принят «${bad}»`)
  }
  const root = join(tmpdir(), 'skazanie-location-root')
  const location = locationIllustrationCacheLocation(root, '..\\..\\outside', '../../secret')
  assert.equal(isAbsolute(location.filePath), true)
  assert.equal(relative(resolve(root), location.filePath).startsWith('..'), false)
  assert.doesNotMatch(location.filePath, /outside|secret/u)
})

test('промпт берёт только публичные поля локации и не тащит скрытое', () => {
  const prompt = buildLocationIllustrationPrompt({
    id: 'loc:archive',
    name: 'Затопленный архив',
    summary: 'Подвалы под городом',
    kind: 'ruin',
    source: 'world_memory',
    gm_notes: 'GM_ONLY_NOTE',
  })
  assert.match(prompt, /Затопленный архив/u)
  assert.match(prompt, /Подвалы под городом/u)
  assert.doesNotMatch(prompt, /GM_ONLY_NOTE|gm_notes/u)
  assert.ok(prompt.length < 1_400)
})

test('подготовка пишет кеш и расход в леджер, перегенерация перекрывает файл', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-location-prep-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const calls = []
  const usageLedger = new DurableUsageLedger({ storageFile: join(rootDir, 'engine', 'usage.json'), dailyTokenLimit: 10_000 })
  const service = serviceWith(rootDir, calls, { usageLedger })
  const location = { id: 'loc:archive', name: 'Затопленный архив', summary: 'Подвалы', kind: '', source: 'world_memory' }

  assert.equal(await service.cached('PREP', location.id), null)
  const prepared = await service.prepare({ campaignId: 'PREP', location })
  assert.equal(prepared.kind, 'generated')
  assert.equal(prepared.cacheHit, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'openai/gpt-image-1')
  assert.equal((await service.cached('PREP', location.id))?.cacheHit, true)

  const report = usageLedger.report()
  assert.equal(report.completed_requests, 1, 'расход подготовки обязан попасть в леджер')
  assert.equal(report.committed_tokens, 14)
  assert.equal(report.provider_cost, 0.5)

  await service.prepare({ campaignId: 'PREP', location })
  assert.equal(calls.length, 2, 'перегенерация не падает на существующем файле')

  // Кеш разведён по кампаниям: соседний стол чужую картинку не увидит.
  assert.equal(await service.cached('OTHER', location.id), null)
})

test('в рантайме модель не зовётся: сервис умеет только читать кеш', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-location-runtime-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  let calls = 0
  const service = new LocationIllustrationService({
    storageDir: rootDir,
    imageModel: 'openai/gpt-image-1',
    apiKey: 'test-key',
    generator: async () => { calls += 1; return { bytes: WEBP } },
  })
  assert.equal(typeof service.resolve, 'undefined', 'метода «достань или сгенерируй» здесь быть не должно')
  assert.equal(await service.cached('PREP', 'loc:archive'), null)
  assert.equal(calls, 0, 'чтение кеша модель не трогает')
})

test('инвентарь локаций честно показывает, у какой картинки ещё нет', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-location-list-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const service = serviceWith(rootDir, [])
  const admin = campaignStateForViewer(campaignState(), { role: 'admin', id: 'gm' }, '')
  const known = visibleCampaignLocations(admin)
  await service.prepare({ campaignId: 'PREP', location: known.find((entry) => entry.id === 'loc:norvin-road') })

  const inventory = await locationIllustrationInventory({ service, campaignId: 'PREP', locations: known })
  assert.deepEqual(inventory.map((entry) => [entry.id, entry.has_illustration]), [
    ['loc:archive', false],
    ['loc:cult-lair', false],
    ['loc:hidden-vault', false],
    ['loc:norvin-road', true],
  ])
  assert.deepEqual(inventory.map((entry) => entry.name), ['Затопленный архив', 'Логово культа', 'Тайный схрон', 'Норвинский тракт'])
})

test('неподдерживаемый ответ генератора не превращается в файл кеша', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-location-bad-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const service = new LocationIllustrationService({
    storageDir: rootDir,
    imageModel: 'openai/gpt-image-1',
    apiKey: 'test-key',
    generator: async () => ({ bytes: Buffer.from('<html>не картинка</html>', 'utf8') }),
  })
  const location = { id: 'loc:archive', name: 'Архив', summary: '', kind: '', source: 'world_memory' }
  await assert.rejects(service.prepare({ campaignId: 'PREP', location }), /неподдерживаемый файл/u)
  assert.equal(await service.cached('PREP', location.id), null)
})
