// Эталон `server/asset-preparation.mjs` для `tests/asset_preparation_fixture.rs`:
// случайные (seeded mulberry32) запросы подготовки и инвентари, состояния
// кампании с предметами, профили NPC с заглушкой кеша портретов.
//
// `localeCompare` здесь — корневая сортировка ICU (`en`): так сортирует
// сервер в контейнере и `sk_core::text::locale_compare`. На Windows Node по
// умолчанию берёт локаль системы (ru-RU, кириллица раньше латиницы) — это
// свойство окружения, а не модуля.
//
// Запуск из корня репозитория:
//   node rust/crates/sk-infra/fixtures/gen-asset-preparation.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_COLLATOR = new Intl.Collator('en')
// eslint-disable-next-line no-extend-native
String.prototype.localeCompare = function localeCompare(other) { return ROOT_COLLATOR.compare(String(this), String(other)) }

const { MAX_PREPARATION_BATCH, itemsWithoutIllustration, npcPortraitInventory, planPreparation } = await import('../../../../server/asset-preparation.mjs')

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

const UNDEFINED = { undefined: true }
const pick = (random, list) => list[Math.floor(random() * list.length)]
const set = (target, key, value) => { if (value !== UNDEFINED) target[key] = value }

const IDS = ['npc:a', 'npc:b', 'npc:C', 'npc:ä', 'npc:10', 'npc:9', 'Марта', 'брам', ' npc:a ', 'loc:norvin', 'loc:archive', 'loc:Ёлка', '']
const READY = [true, false, 'true', 1, UNDEFINED, null]

function planCases(random) {
  const cases = []
  for (let index = 0; index < 400; index += 1) {
    const inventories = {}
    for (const key of ['npcs', 'locations']) {
      const shape = pick(random, ['list', 'list', 'list', 'list', 'list', 'missing', 'object'])
      if (shape === 'missing') continue
      if (shape === 'object') { inventories[key] = { id: 'npc:a' }; continue }
      const size = Math.floor(random() * 30)
      inventories[key] = Array.from({ length: size }, (_, position) => {
        const entry = {}
        set(entry, 'id', random() < 0.9 ? (random() < 0.8 ? `${key}:${position}` : pick(random, IDS)) : pick(random, [7, null, UNDEFINED]))
        set(entry, key === 'npcs' ? 'has_portrait' : 'has_illustration', pick(random, READY))
        return entry
      })
    }
    const requested = pick(random, [null, 'строка', [], UNDEFINED, 'object', 'object', 'object', 'object', 'object', 'object', 'object', 'object'])
    let body = requested === UNDEFINED ? undefined : requested
    if (requested === 'object') {
      body = {}
      for (const [key, inventoryKey] of [['npc_ids', 'npcs'], ['location_ids', 'locations']]) {
        const shape = pick(random, ['ids', 'ids', 'ids', 'ids', 'ids', 'missing', 'string', 'empty'])
        if (shape === 'missing') continue
        if (shape === 'string') { body[key] = 'npc:a'; continue }
        if (shape === 'empty') { body[key] = []; continue }
        const known = Array.isArray(inventories[inventoryKey]) ? inventories[inventoryKey].map((entry) => entry.id).filter((id) => typeof id === 'string') : []
        const size = Math.floor(random() * 22)
        body[key] = Array.from({ length: size }, () => (known.length ? pick(random, known) : pick(random, ['   ', null, ''])))
        // Пустые, пробельные и нестроковые id отбрасываются; неизвестный — отказ.
        if (random() < 0.25) body[key].push(pick(random, [...IDS, 5, null, '   ', 'x'.repeat(130)]))
      }
    }
    const regenerate = random() < 0.3
    const entry = { inventories, regenerate }
    if (body !== undefined) entry.requested = body
    entry.result = planPreparation(body, inventories, { regenerate })
    cases.push(entry)
  }
  return cases
}

function itemCases(random) {
  const cases = []
  const names = ['Меч', 'Амулет', '  Верёвка  ', '', UNDEFINED, 'x'.repeat(130), 42]
  const images = [UNDEFINED, '', '  ', '/generated/items/x.webp', null, 0]
  const itemIds = ['sword', 'amulet', 'rope', 'Lantern', 'ёж', 'Ёж', 'a b', '  spaced  ', '', 7, UNDEFINED, 'x'.repeat(130)]
  for (let index = 0; index < 200; index += 1) {
    const shape = pick(random, ['players', 'players', 'players', 'empty', 'null', 'no_list'])
    let state
    if (shape === 'empty') state = {}
    else if (shape === 'null') state = null
    else if (shape === 'no_list') state = { players: 'нет' }
    else {
      state = {
        players: Array.from({ length: Math.floor(random() * 4) }, () => {
          const player = {}
          set(player, 'id', pick(random, ['hero', 'ally', '  mage ', UNDEFINED, 3]))
          const inventory = pick(random, ['list', 'list', 'missing', 'string'])
          if (inventory === 'string') player.inventory = 'сумка'
          else if (inventory === 'list') {
            player.inventory = Array.from({ length: Math.floor(random() * 5) }, () => {
              const item = {}
              set(item, 'id', pick(random, itemIds))
              set(item, 'name', pick(random, names))
              set(item, 'image', pick(random, images))
              return item
            })
          }
          return player
        }),
      }
    }
    const entry = { result: itemsWithoutIllustration(state) }
    if (state !== undefined) entry.state = state
    cases.push(entry)
  }
  return cases
}

async function inventoryCases(random) {
  const cases = []
  const profileIds = ['npc:marta', 'npc:bram', 'npc:Ivo', 'Ёрш', 'ангел', 'npc:10', 'npc:9', 5, '']
  for (let index = 0; index < 150; index += 1) {
    const cachedIds = profileIds.filter(() => random() < 0.3)
    const profiles = Array.from({ length: Math.floor(random() * 6) }, () => {
      const profile = {}
      set(profile, 'id', pick(random, profileIds))
      set(profile, 'name', pick(random, ['Марта', 'Брам', '', UNDEFINED, '  Иво  ']))
      set(profile, 'role', pick(random, ['merchant', 'guard', UNDEFINED, '']))
      set(profile, 'portrait_url', pick(random, [UNDEFINED, '', '   ', '/assets/npcs/x.webp', null]))
      set(profile, 'tags', pick(random, [UNDEFINED, ['major'], ['minor'], 'major']))
      return profile
    })
    const calls = []
    const service = {
      cached: async (campaignId, id) => {
        calls.push([campaignId, id])
        return cachedIds.includes(id) ? { cacheHit: true } : null
      },
    }
    const result = await npcPortraitInventory({
      service,
      campaignId: 'PREP',
      projectedState: { marker: 'state' },
      significance: (state, profile) => state?.marker === 'state' && Array.isArray(profile?.tags) && profile.tags.includes('major'),
      profiles,
    })
    cases.push({ cached_ids: cachedIds, profiles, result, calls })
  }
  return cases
}

const random = mulberry32(2026)
const fixture = { max_batch: MAX_PREPARATION_BATCH, plans: planCases(random), items: itemCases(random), inventories: await inventoryCases(random) }
writeFileSync(join(here, 'asset-preparation.json'), `${JSON.stringify(fixture)}\n`, 'utf8')
console.log(`asset-preparation: ${fixture.plans.length} планов, ${fixture.items.length} состояний, ${fixture.inventories.length} инвентарей`)
