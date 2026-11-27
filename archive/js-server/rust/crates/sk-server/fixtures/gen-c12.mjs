// Эталон «Г» ассетов и картинок (С12):
// `node rust/crates/sk-server/fixtures/gen-c12.mjs` пишет `fixtures/c12.json`
// (поставщик картинок — локальная заглушка, ключ есть, рантайм-флаг включён)
// и `fixtures/c12-off.json` (без ключа, флаг выключен); сверка —
// `tests/c12_golden.rs`.
//
// Правила сверх общего формата `skazanie.golden/1`:
// * псевдообмен `ASSIGN` — назначить игроку героев (`body` — список id) через
//   `GET /api/admin/users` + `PATCH /api/admin/users/:id` (id случаен);
// * тело ответа создания кампании — `"<skip>"` (его сверяет эталон С6);
// * путь `<url:N>` (с необязательным хвостом) — адрес картинки предмета из
//   ответа обмена N (`body.url`, в нём uuid);
// * заглушка поставщика: `/images` отдаёт один и тот же webp, а на промпт со
//   словом `BROKEN` — HTML; прочие пути — 503 (стартовая проба текстовой
//   модели JS уходит в cooldown).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'

import { startFakeProvider } from '../../../../test/kit/llm.mjs'
import { normalize, normalizeString, recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const WEBP_HEX = '524946460400000057454250'
export const IMAGE_MODEL = 'test/golden-image-v1'
const WEBP = Buffer.from(WEBP_HEX, 'hex')
const ETAG = `"${createHash('sha256').update(WEBP).digest('hex')}"`
const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const PROMPT = 'Старый бронзовый ключ с волчьей головой на кольце'
const PORTRAIT_HEADERS = ['content-type', 'content-length', 'etag', 'cache-control', 'vary', 'x-npc-portrait-source', 'x-npc-portrait-cache']
const STATIC_HEADERS = ['location', 'cache-control', 'vary', 'x-npc-portrait-source', 'x-npc-portrait-role', 'x-npc-portrait-reason']
const LOCATION_HEADERS = ['content-type', 'content-length', 'etag', 'cache-control', 'vary', 'x-location-illustration-source', 'x-location-illustration-cache']
const ITEM_FILE_HEADERS = ['content-type', 'content-length', 'cache-control']

function npc(id, overrides = {}) {
  return {
    id,
    name: `NPC ${id}`,
    role: 'village guard',
    location: 'Рынок',
    public_summary: `Публичное описание ${id}.`,
    voice: '',
    goals: [`PRIVATE_GOAL_${id}`],
    beliefs: [],
    known_fact_ids: [],
    social_dcs: {},
    visibility: 'party',
    available: true,
    tags: ['important'],
    schedule: [],
    inventory: [],
    ...overrides,
  }
}

/** Состояние кампании для импорта администратором. */
export function campaignState(code) {
  return {
    sessionCode: code,
    campaign: 'Картины',
    partyName: 'Отряд',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero', name: 'Player', character: 'Ада', hp: 10, maxHp: 10, armor: 12, proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      inventory: [{ id: 'item:key', name: 'Ключ', image: '' }, { id: 'item:map', name: 'Карта', image: '/generated/items/x.webp' }],
      online: true,
    }],
    merchants: [],
    social: {
      npcs: [
        npc('npc:marta', { name: 'Марта', role: 'merchant', public_summary: 'Торговка с серебряной прядью.' }),
        npc('npc:minor', { name: 'Страж ворот', role: 'city guard', tags: [] }),
        npc('npc:hidden', { name: 'Скрытый советник', public_summary: 'GM_ONLY_SUMMARY', visibility: 'gm_only' }),
        npc('npc:broken', { name: 'Сломанный BROKEN', role: 'scholar' }),
        npc('toString', { name: 'Прототип', role: 'priest', tags: [] }),
      ],
      relationships: {},
      conversations: [],
      promises: [],
    },
    scene: { title: 'Разбитый обоз', location: 'Норвинский тракт', location_id: 'loc-road', mood: 'Тревожно', objective: 'Найти уцелевших', turn: 1, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 60 } },
    adventure: { chapter: 1, history: [], visitedLocations: ['Норвинский тракт'] },
    worldMap: {
      version: 1, seed: 'c12-seed', name: 'Норвин', width: 1000, height: 640, currentLocationId: 'loc-road',
      regions: [{ id: 'reg:north', name: 'Север', biome: 'plains', x: 10, y: 10, radius: 100 }],
      locations: [{ id: 'loc-road', name: 'Норвинский тракт', kind: 'landmark', x: 10, y: 10, regionId: 'reg:north', summary: 'Разбитая дорога', known: true, visited: true }],
      routes: [],
    },
    worldMemory: {
      entities: [
        { id: 'loc-road', kind: 'location', name: 'Норвинский тракт', summary: 'Разбитая дорога', visibility: 'party', aliases: [], tags: [] },
        { id: 'loc:lair', kind: 'location', name: 'Логово культа', summary: 'GM_ONLY_SUMMARY', visibility: 'gm_only', aliases: [], tags: [] },
      ],
      facts: [], relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [], knowledge_ledger: [],
    },
  }
}

/** Общий сценарий: аккаунты, кампания `code`, назначение героя игроку. */
async function setup(send, exchanges, code) {
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  const registered = await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await send('admin', 'POST', '/api/campaigns', { body: { code, name: 'Картины', state: campaignState(code) } })
  Object.assign(exchanges[exchanges.length - 1], { body_norm: '<skip>' })
  const admin = await send('admin', 'GET', '/api/admin/users')
  exchanges.pop()
  const user = admin.body.users.find((candidate) => candidate.email === PLAYER.email)
  const patched = await send('admin', 'PATCH', `/api/admin/users/${user.id}`, { body: { heroIds: ['hero'] } })
  exchanges.pop()
  exchanges.push({ as: 'admin', method: 'ASSIGN', path: PLAYER.email, headers: {}, body: ['hero'], status: patched.status, body_norm: null })
  return registered.cookie
}

/**
 * `GET` игрока без перехода по 302 (`fetch` набора идёт по редиректу, а
 * эталону нужен сам ответ портрета-заглушки).
 */
function redirectless(server, exchanges, cookie) {
  return async (path) => {
    const response = await fetch(`${server.baseUrl}${path}`, { redirect: 'manual', headers: { Cookie: cookie } })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* не JSON */ }
    const headers_norm = Object.fromEntries(STATIC_HEADERS.map((name) => {
      const value = response.headers.get(name)
      return [name, value === null ? null : normalizeString(value)]
    }))
    exchanges.push({ as: 'player', method: 'GET', path, headers: {}, body: null, status: response.status, body_norm: normalize(parsed), headers_norm })
  }
}

const portrait = (code, id) => `/api/campaigns/${code}/npcs/${encodeURIComponent(id)}/portrait`
const illustration = (code, id) => `/api/campaigns/${code}/locations/${encodeURIComponent(id)}/illustration`
const preparation = (code) => `/api/campaigns/${code}/asset-preparation`

const cleanups = []
const provider = await startFakeProvider({ after: (fn) => { cleanups.push(fn) } }, (request) => {
  if (request.path !== '/images' || request.method !== 'POST') return { status: 503, body: '{"error":"text model disabled in c12 golden"}' }
  const broken = String(request.body?.prompt ?? '').includes('BROKEN')
  return {
    data: [{ b64_json: (broken ? Buffer.from('<!doctype html><title>no</title>') : WEBP).toString('base64') }],
    usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
    cost: 0.025,
  }
})
try {
  const { server, close } = await startGoldenServer({
    env: { ...provider.env, DND_IMAGE_MODEL: IMAGE_MODEL, DND_RUNTIME_IMAGE_GENERATION: 'on', DND_AI_MODEL: 'test/text-model', DND_AI_FALLBACK_MODELS: '' },
  })
  try {
    const { send, exchanges } = recorder(server)
    const C = 'ART-1'
    // Без входа и маршрутизация.
    await send('anon', 'GET', portrait(C, 'npc:marta'))
    await send('anon', 'GET', illustration(C, 'loc-road'))
    await send('anon', 'GET', preparation(C))
    await send('anon', 'POST', preparation(C), { body: {} })
    await send('anon', 'PUT', preparation(C), { body: {} })
    await send('anon', 'GET', '/generated/items/abc.webp')
    await send('anon', 'POST', '/api/items/generate-image', { body: {} })
    await send('anon', 'POST', '/api/items/generate-image?x=1', { body: {} })
    const redirect = redirectless(server, exchanges, await setup(send, exchanges, C))

    // Портрет NPC.
    await send('player', 'GET', portrait('NOPE-1', 'npc:marta'))
    await send('player', 'GET', `/api/campaigns/${C}/npcs/%E0/portrait`)
    await send('player', 'GET', portrait(C, 'a'.repeat(121)))
    await send('player', 'GET', portrait(C, 'a'.repeat(120)))
    await send('outsider', 'GET', portrait(C, 'npc:marta'))
    await send('player', 'GET', portrait(C, 'npc:hidden'))
    await send('player', 'GET', portrait(C, '../../auth.json'))
    await redirect(portrait(C, 'npc:minor'))
    await redirect(portrait(C, 'toString'))
    await redirect(portrait(C, 'npc:broken'))
    await send('player', 'GET', portrait(C, 'npc:marta'), { responseHeaders: PORTRAIT_HEADERS })
    await send('player', 'GET', `${portrait(C, 'npc:marta')}?x=1`, { responseHeaders: PORTRAIT_HEADERS })
    await send('player', 'GET', portrait(C, 'npc:marta'), { headers: { 'If-None-Match': ETAG }, responseHeaders: PORTRAIT_HEADERS })
    await send('player', 'GET', portrait(C, 'npc:marta'), { headers: { 'If-None-Match': '"other"' }, responseHeaders: PORTRAIT_HEADERS })
    await send('admin', 'GET', portrait(C, 'npc:hidden'), { responseHeaders: PORTRAIT_HEADERS })

    // Иллюстрация места: только кеш.
    await send('player', 'GET', illustration(C, 'loc-road'))
    await send('player', 'GET', illustration(C, 'loc:lair'))
    await send('player', 'GET', `/api/campaigns/${C}/locations/%E0/illustration`)
    await send('player', 'GET', illustration(C, '../../auth.json'))
    await send('outsider', 'GET', illustration(C, 'loc-road'))
    await send('player', 'GET', illustration('NOPE-1', 'loc-road'))

    // Подготовка ассетов.
    await send('player', 'GET', preparation(C))
    await send('outsider', 'POST', preparation(C), { body: { location_ids: ['loc-road'] } })
    await send('admin', 'GET', preparation('NOPE-1'))
    await send('admin', 'GET', `${preparation(C)}?x=1`)
    await send('admin', 'POST', preparation(C), { body: {} })
    await send('admin', 'POST', preparation(C), { body: 'x' })
    await send('admin', 'POST', preparation(C), { body: { npc_ids: ['npc:nope', 'npc:marta'] } })
    await send('admin', 'POST', preparation(C), { body: { location_ids: ['loc:nope'] } })
    await send('admin', 'POST', preparation(C), { body: { npc_ids: ['npc:marta'] } })
    await send('admin', 'POST', preparation(C), { body: { location_ids: ['loc-road', 'loc:lair'], npc_ids: ['npc:broken'] } })
    await send('admin', 'POST', preparation(C), { body: { location_ids: ['loc-road'] } })
    await send('admin', 'POST', preparation(C), { body: { location_ids: ['loc-road'], npc_ids: ['npc:marta'], regenerate: true } })
    await send('admin', 'GET', preparation(C))
    await send('player', 'GET', illustration(C, 'loc-road'), { responseHeaders: LOCATION_HEADERS })
    await send('player', 'GET', illustration(C, 'loc-road'), { headers: { 'If-None-Match': ETAG }, responseHeaders: LOCATION_HEADERS })
    await send('player', 'GET', illustration(C, 'loc:lair'))
    await send('admin', 'GET', illustration(C, 'loc:lair'), { responseHeaders: LOCATION_HEADERS })

    // Картинка предмета и раздача файла.
    await send('player', 'POST', '/api/items/generate-image', { body: { prompt: 'коротко' } })
    await send('player', 'POST', '/api/items/generate-image', { body: { prompt: { a: 1 } } })
    await send('player', 'POST', '/api/items/generate-image', { body: 'x' })
    const generated = await send('player', 'POST', '/api/items/generate-image', { body: { prompt: PROMPT, aspectRatio: '16:9' } })
    const from = exchanges.length - 1
    await send('player', 'GET', generated.body.url, { responseHeaders: ITEM_FILE_HEADERS })
    Object.assign(exchanges[exchanges.length - 1], { path: `<url:${from}>` })
    await send('outsider', 'GET', `${generated.body.url}?v=1`, { responseHeaders: ITEM_FILE_HEADERS })
    Object.assign(exchanges[exchanges.length - 1], { path: `<url:${from}>?v=1` })
    await send('player', 'GET', '/generated/items/abc.gif')
    await send('player', 'GET', '/generated/items/0000-aaaa.webp')
    await send('player', 'POST', '/api/items/generate-image', { body: { prompt: `${PROMPT} BROKEN` } })
    for (let index = 0; index < 5; index += 1) await send('player', 'POST', '/api/items/generate-image', { body: { prompt: 'x' } })
    await send('player', 'POST', '/api/items/generate-image', { body: { prompt: PROMPT } })
    await send('admin', 'POST', '/api/items/generate-image', { body: { prompt: PROMPT } })

    console.log(writeGolden('c12', 'ассеты и картинки: портрет NPC, иллюстрация, подготовка, файлы и картинки предметов (поставщик — заглушка)', exchanges))
  } finally {
    await close()
  }

  // Без ключа и с выключенным рантайм-флагом (боевая настройка по умолчанию).
  const off = await startGoldenServer()
  try {
    const { send, exchanges } = recorder(off.server)
    const C = 'ART-2'
    const redirect = redirectless(off.server, exchanges, await setup(send, exchanges, C))
    await redirect(portrait(C, 'npc:marta'))
    await send('admin', 'GET', preparation(C))
    await send('admin', 'POST', preparation(C), { body: { location_ids: ['loc-road'] } })
    await send('admin', 'POST', preparation(C), { body: {} })
    await send('player', 'POST', '/api/items/generate-image', { body: { prompt: PROMPT } })
    await send('player', 'GET', '/generated/items/0000-aaaa.webp')
    console.log(writeGolden('c12-off', 'ассеты и картинки без ключа и с выключенной генерацией в игре', exchanges))
  } finally {
    await off.close()
  }
} finally {
  for (const fn of cleanups.reverse()) await fn()
}
