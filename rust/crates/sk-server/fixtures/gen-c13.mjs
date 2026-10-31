// Эталон «Г» импорта и перестройки карт (С13):
// `node rust/crates/sk-server/fixtures/gen-c13.mjs` пишет `fixtures/c13.json`;
// сверка — `tests/c13_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1` (правила сверки те же):
// * тела подготовительных обменов (регистрация, создание кампании, приглашение,
//   вход по приглашению, жизненный цикл) — `<skip>`: их сверяют эталоны С6/С8,
//   здесь только статус; токен приглашения в теле входа — ссылка `<invite:N>`
//   (токен из ответа обмена N), прогон подставляет свой;
// * у `state` ответа снята летопись `messages` (строки несут время прогона),
//   а поля верхнего уровня тела и `state` длиннее `BIG_BODY` — по частям или
//   хешем канонического текста `<sha256:хеш:длина>` (как в С8);
// * `open_check` — перед обменом `before` у кампании открывается проверка героя
//   на версии `state_version`: JS-сервер останавливается, проверка дописывается
//   в `engine/roll-registry.json`, сервер поднимается снова (сессии в storage);
//   Rust-прогон регистрирует её в реестре ядра;
// * кости сервера — правила `DICE` (тот же JSON читает Rust-набор), иначе мир
//   кампании (жанр, история) выпадает по-разному;
// * в конце — журнал основной кампании (`journal`): события с `event_id`,
//   типом, актором и `payload` (большие ветви — хешем).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readJournal } from '../../../../test/kit/journal.mjs'
import { ASSETS, HOUSE_SLAB, encodeSlabV1, encodeSlabV2, housePlacements } from '../../../../test/talespire-fixtures.mjs'
import { SLAB_MAX_INSTANCES, SLAB_MAX_TEXT_LENGTH } from '../../../../server/talespire-slab.mjs'
import { FIXTURES_DIR, GOLDEN_FORMAT, normalize, recorder, startGoldenServer } from './golden.mjs'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const CODE = 'MAP-13'
const BIG_BODY = 4_000

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @param {unknown} value @returns {unknown} */
function shrink(value) {
  if (value === null || typeof value !== 'object') return value
  const text = canonical(value)
  if (text.length <= BIG_BODY) return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (canonical(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

/** Тело ответа: `state` без летописи, большие ветви — хешем. @param {any} body */
function reduce(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  return Object.fromEntries(Object.entries(body).map(([key, item]) => {
    if (key === 'state' && item && typeof item === 'object' && !Array.isArray(item)) {
      const { messages: _messages, ...state } = item
      return [key, Object.fromEntries(Object.entries(state).map(([field, value]) => [field, shrink(value)]))]
    }
    return [key, shrink(item)]
  }))
}

/** @param {any} event */
function journalEvent(event) {
  return normalize({ event_id: event.event_id ?? null, event_type: event.event_type, actor_id: event.actor_id ?? null, payload: shrink(event.payload ?? {}) })
}

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 2 }] }

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const skip = () => Object.assign(exchanges[exchanges.length - 1], { body_norm: '<skip>' })
  const path = (code) => `/api/campaigns/${code}/map-import`
  const post = (role, body, { code = CODE, headers, suffix = '' } = {}) => send(role, 'POST', `${path(code)}${suffix}`, { body, headers })

  // 405 — на любой метод, кроме POST, ещё до входа; POST без входа — 401.
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) await send('anon', method, path(CODE))
  await send('anon', 'GET', `${path('nope_1')}`)
  await post('anon', { slab: HOUSE_SLAB })

  // Аккаунты, кампания, игрок по приглашению.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } }); skip()
  await send('owner', 'POST', '/api/auth/register', { body: OWNER }); skip()
  await send('guest', 'POST', '/api/auth/register', { body: GUEST }); skip()
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER }); skip()
  await send('owner', 'POST', '/api/campaigns', {
    body: { code: 'map-13', name: 'Карты из TaleSpire', bootstrap: { partyName: 'Двое', players: [{ id: 'hero-1' }, { id: 'hero-2' }], rulesetId: 'srd_5_2_1', world: { premise: 'Дом на холме пустует', startingLocation: 'Холм' } } },
  }); skip()
  const invite = await send('owner', 'POST', `/api/campaigns/${CODE}/invites`, { body: { hero_ids: ['hero-2'] } }); skip()
  const inviteIndex = exchanges.length - 1
  await send('guest', 'POST', `/api/campaigns/${CODE}/join`, { body: { invite_token: invite.body.token } }); skip()
  Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${inviteIndex}>` } })

  // Права и форма запроса.
  await send('owner', 'GET', `${path(CODE)}?x=1`)
  await post('guest', { slab: HOUSE_SLAB })
  await post('outsider', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'outsider' })
  await post('owner', { slab: HOUSE_SLAB }, { code: 'NOPE-13' })
  await post('owner', [])
  await post('owner', 42)
  await post('owner', { mode: 'preview', slab: HOUSE_SLAB, location_id: { toString: 1 } })

  // Предпросмотр: текущая сцена, другое место карты мира, отказы разбора.
  const initial = await readJournal(server, CODE)
  const current = initial.state.scene?.location_id || initial.state.worldMap?.currentLocationId
  const other = (initial.state.worldMap?.locations ?? []).find((location) => location.id !== current)?.id ?? 'нет-другого-места'
  await post('owner', { mode: 'preview', slab: HOUSE_SLAB })
  await post('owner', { mode: 'whatever', slab: HOUSE_SLAB }, { suffix: '?from=query' })
  await post('admin', { slab: HOUSE_SLAB, location_id: ` ${other} ` })
  await post('owner', { slab: HOUSE_SLAB, location_id: 'nowhere' })
  await post('owner', { slab: HOUSE_SLAB, location_id: 'x'.repeat(130) })
  await post('owner', { mode: 'apply' })
  await post('owner', { mode: 'apply', slab: '   ' })
  await post('owner', { slab: 42 })
  await post('owner', { slab: 'A'.repeat(SLAB_MAX_TEXT_LENGTH + 1) })
  await post('owner', { slab: 'не слэб' })
  await post('owner', { slab: encodeSlabV2(Array.from({ length: SLAB_MAX_INSTANCES + 1 }, () => ({ asset: ASSETS.floor, x: 1, y: 0, z: 1 }))) })
  await post('owner', { mode: 'apply', slab: 'не слэб', idempotency_key: 'broken' })

  // Применение: ключ обязателен, повтор, конфликт ключа, другое место.
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: '   ' })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: { toString: 1 } })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB }, { headers: { 'x-idempotency-key': ' house-1 ' } })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'house-1' })
  await post('owner', { mode: 'apply', slab: encodeSlabV1(housePlacements()), idempotency_key: 'house-1' })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, location_id: other, idempotency_key: 'house-1' })
  await post('admin', { mode: 'apply', slab: HOUSE_SLAB, location_id: other, idempotency_key: `far-${'k'.repeat(250)}` })
  await post('admin', { mode: 'apply', slab: HOUSE_SLAB, location_id: other, idempotency_key: `far-${'k'.repeat(196)}` })
  await post('owner', { mode: 'rebuild', idempotency_key: 'house-1' })

  // Перестройка: права, ключ, обновление покрытий, полная перестройка, повторы.
  await post('guest', { mode: 'rebuild', preserve_layout: true, idempotency_key: 'refresh-guest' })
  await post('owner', { mode: 'rebuild' })
  await post('owner', { mode: 'rebuild', preserve_layout: true, idempotency_key: 'refresh-1' })
  await post('owner', { mode: 'rebuild', preserve_layout: true, idempotency_key: 'refresh-1' })
  await post('owner', { mode: 'rebuild', preserve_layout: 'yes', idempotency_key: 'refresh-1' })
  await post('owner', { mode: 'rebuild', text: 'В центре двора колодец, у стены — три бочки.', idempotency_key: 'rebuild-1' })
  await post('owner', { mode: 'rebuild', text: 'другой текст', idempotency_key: 'rebuild-1' })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'rebuild-1' })
  await post('admin', { mode: 'rebuild', text: 42, idempotency_key: 'rebuild-admin' })

  // Открытая проверка героя: перестройка ждёт, импорт — нет.
  const opened = await readJournal(server, CODE)
  const openCheck = { before: exchanges.length, campaign: CODE, actor_id: 'hero-1', state_version: opened.state_version }
  await server.stop()
  const registryFile = join(server.storageDir, 'engine', 'roll-registry.json')
  const registry = existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, 'utf8')) : { schema_version: 1, rolls: [], checks: [] }
  registry.checks.push(['check-c13', {
    check_id: 'check-c13', campaign_id: CODE, actor_id: 'hero-1', label: 'Проверка', modifier: 0, difficulty: 10, ability: null,
    advantage: false, disadvantage: false, visibility: 'public', context: { state_version: opened.state_version }, expires_at: Date.now() + 3_600_000,
  }])
  writeFileSync(registryFile, JSON.stringify(registry))
  await server.start()
  await post('owner', { mode: 'rebuild', idempotency_key: 'checked-1' })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'house-2' })
  await post('owner', { mode: 'rebuild', preserve_layout: true, idempotency_key: 'checked-1' })

  // Бой и голосование отряда — кампании администратора с готовым состоянием.
  const minimal = (extra) => ({
    players: [{ id: 'hero-1', character: 'Герой' }],
    worldMap: { currentLocationId: 'loc-yard', locations: [{ id: 'loc-yard', name: 'Двор' }, { id: 'loc-far', name: 'Дальний форт' }] },
    scene: { title: 'Двор', location: 'Двор', location_id: 'loc-yard' },
    ...extra,
  })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'VOTE-13', name: 'Голос', state: minimal({ agentInteraction: { id: 'vote-1', type: 'vote', status: 'open', options: [] } }) } }); skip()
  await post('admin', { mode: 'rebuild', idempotency_key: 'vote-r0' }, { code: 'VOTE-13' })
  await post('admin', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'vote-a' }, { code: 'VOTE-13' })
  await post('admin', { mode: 'rebuild', idempotency_key: 'vote-r' }, { code: 'VOTE-13' })
  const voteMap = (await readJournal(server, 'VOTE-13')).state.scene.map
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'WAR-13', name: 'Бой', state: minimal({ mechanics: { combat: { active: true, round: 1 } } }) } }); skip()
  await post('admin', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'war-a' }, { code: 'WAR-13' })
  await post('admin', { mode: 'apply', slab: HOUSE_SLAB, location_id: 'loc-far', idempotency_key: 'war-far' }, { code: 'WAR-13' })
  await post('admin', { mode: 'rebuild', idempotency_key: 'war-r' }, { code: 'WAR-13' })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'WAR-14', name: 'Бой на карте', state: minimal({ scene: { title: 'Двор', location: 'Двор', location_id: 'loc-yard', map: voteMap }, mechanics: { combat: { active: true, round: 1 } } }) } }); skip()
  await post('admin', { mode: 'rebuild', idempotency_key: 'war-r' }, { code: 'WAR-14' })

  // Завершённая кампания: только предпросмотр.
  await send('owner', 'POST', `/api/campaigns/${CODE}/lifecycle`, { body: { action: 'complete', idempotency_key: 'finale' } }); skip()
  await post('owner', { mode: 'preview', slab: HOUSE_SLAB })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'after-finale' })
  await post('owner', { mode: 'rebuild', idempotency_key: 'after-finale' })
  await post('owner', { mode: 'apply', slab: HOUSE_SLAB, idempotency_key: 'house-1' })

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.body_norm !== '<skip>') entry.body_norm = reduce(entry.body_norm)
  }
  const journal = await readJournal(server, CODE)
  const file = join(FIXTURES_DIR, 'c13.json')
  writeFileSync(file, `${JSON.stringify({
    format: GOLDEN_FORMAT,
    scenario: 'импорт и перестройка карт: 405 на прочие методы, права, предпросмотр, применение, перестройка, повтор и конфликт ключа, открытая проверка, бой, голосование, завершённая кампания, журнал с event_id',
    exchanges,
    open_check: openCheck,
    journal: { campaign: CODE, events: journal.events.map(journalEvent) },
  }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов, ${journal.events.length} событий)`)
} finally {
  await close()
}
