// Эталон «Г» отката и жизненного цикла кампании (С8):
// `node rust/crates/sk-server/fixtures/gen-c8.mjs` пишет `fixtures/c8.json`;
// сверка — `tests/c8_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1` (правила сверки те же):
// * тело создания кампании — `<c6>`: его сверяет эталон С6, здесь только статус;
// * у `state` ответа отката и жизненного цикла снята летопись `messages`
//   (её строки несут время прогона; летопись сверяют С1 и С7), остальное
//   состояние зрителя сравнивается целиком, но поле верхнего уровня длиннее
//   `BIG_BODY` — по частям, а неделимое — хешем `<sha256:хеш:длина>`
//   канонического текста (ключи по алфавиту, см. `canonical`);
// * игровые ходы — смена домашнего правила (`PATCH …/settings`, С7):
//   единственный перенесённый маршрут, который пишет игровое событие;
// * в конце — журнал кампании (`journal`): события по порядку с `event_id`,
//   типом и `payload` без `state` (снимок состояния отката сверяют ответы);
// * кости сервера — правила `DICE` (тот же JSON читает Rust-набор).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readJournal } from '../../../../test/kit/journal.mjs'
import { FIXTURES_DIR, GOLDEN_FORMAT, normalize, recorder, startGoldenServer } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 2 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const CODE = 'TALE-8'
const STRIKE = 'house:bg3-opening-strike'

const BIG_BODY = 4_000

/**
 * `JSON.stringify` с ключами по алфавиту: порядок ключей состояния у Rust —
 * журнала, а не JS (`src/room.rs`), хеш от него зависеть не должен.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Большие ветви состояния — хешем канонического текста (`<sha256:хеш:длина>`).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function shrink(value) {
  if (value === null || typeof value !== 'object') return value
  const text = canonical(value)
  if (text.length <= BIG_BODY) return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (canonical(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

/**
 * Состояние ответа без летописи, большие ветви — хешем.
 *
 * @param {any} body
 */
function withoutMessages(body) {
  if (!body || typeof body !== 'object' || !body.state || typeof body.state !== 'object') return body
  const { messages: _messages, ...state } = body.state
  return { ...body, state: Object.fromEntries(Object.entries(state).map(([key, item]) => [key, shrink(item)])) }
}

/**
 * Событие журнала для эталона: без снимка состояния отката.
 *
 * @param {any} event
 */
function journalEvent(event) {
  const { state: _state, ...payload } = event.payload ?? {}
  return normalize({ event_id: event.event_id ?? null, event_type: event.event_type, actor_id: event.actor_id ?? null, payload })
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const controls = (code) => `/api/campaigns/${code}/controls`
  const lifecycle = (code) => `/api/campaigns/${code}/lifecycle`
  const control = (role, body, headers) => send(role, 'POST', controls(CODE), { body, headers })
  const transition = (role, body, headers) => send(role, 'POST', lifecycle(CODE), { body, headers })
  const houseRule = (enabled, key) => send('owner', 'PATCH', `/api/campaigns/${CODE}/settings`, { body: { houseRules: { [STRIKE]: enabled }, idempotency_key: key } })

  // Без входа.
  await send('anon', 'POST', controls(CODE), { body: { action: 'rewind_turn', idempotency_key: 'anon' } })
  await send('anon', 'GET', lifecycle(CODE))
  await send('anon', 'POST', lifecycle(CODE), { body: { action: 'pause' } })
  // Аккаунты и кампания.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('owner', 'POST', '/api/auth/register', { body: OWNER })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await send('owner', 'POST', '/api/campaigns', {
    body: { code: 'tale-8', name: 'Сказ о мосте', bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: { premise: 'Мост через реку сожгли', startingLocation: 'Переправа' } } },
  })
  Object.assign(exchanges[exchanges.length - 1], { body_norm: '<c6>' })

  // Откат: права, форма запроса, рано откатывать.
  await send('owner', 'POST', controls('NOPE-8'), { body: { action: 'rewind_turn', idempotency_key: 'nope' } })
  await control('outsider', { action: 'rewind_turn', idempotency_key: 'denied' })
  await control('owner', { action: 'rewind_turn' })
  await control('owner', { action: 'rewind_turn', idempotency_key: '   ' })
  await control('owner', { action: 'rewind_turn', idempotency_key: null }, { 'x-idempotency-key': '  ' })
  await control('owner', { action: 'undo_everything', idempotency_key: 'unknown' })
  await control('owner', { idempotency_key: 'no-action' })
  await control('owner', [])
  await control('owner', { action: 'rewind_turn', idempotency_key: 'too-early' })
  await control('owner', { action: 'replay_scene', idempotency_key: 'too-early-scene' })
  await send('owner', 'GET', controls(CODE))
  await send('owner', 'PUT', controls(CODE), { body: {} })

  // Два хода (домашнее правило), откат последнего — ключ из заголовка.
  await houseRule(false, 'hr-1')
  await houseRule(true, 'hr-2')
  await control('owner', { action: ' rewind_turn ' }, { 'x-idempotency-key': 'r-1' })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'r-1' })
  await control('owner', { action: 'replay_scene', idempotency_key: 'r-1' })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'hr-1' })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'r-2' })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'r-3' })
  // Новый ход и переигрывание сцены администратором; длинный ключ обрезается до 200.
  await houseRule(false, 'hr-3')
  await houseRule(true, 'hr-4')
  await control('admin', { action: 'replay_scene', idempotency_key: `s-${'k'.repeat(250)}` })
  await control('admin', { action: 'replay_scene', idempotency_key: `s-${'k'.repeat(198)}` })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'query' })
  await send('owner', 'POST', `${controls(CODE)}?x=1`, { body: { action: 'replay_scene', idempotency_key: 'query-scene' } })

  // Жизненный цикл: чтение и права.
  await send('owner', 'GET', lifecycle('NOPE-8'))
  await send('outsider', 'GET', lifecycle(CODE))
  await send('owner', 'GET', lifecycle('tale-8'))
  await send('admin', 'GET', `${lifecycle(CODE)}?x=1`)
  await send('owner', 'DELETE', lifecycle(CODE))
  await send('owner', 'POST', lifecycle('NOPE-8'), { body: { action: 'pause', idempotency_key: 'nope' } })
  await transition('outsider', { action: 'pause', idempotency_key: 'denied' })
  await transition('owner', [])
  await transition('owner', { action: 'resume', idempotency_key: 'resume-active' })
  await transition('owner', { action: 'fail', idempotency_key: 'fail-1' })
  await transition('owner', { action: 'chain_arcs', idempotency_key: 'chain-1', reason: 'дальше по цепочке' })
  await transition('owner', { action: 'constructor', idempotency_key: 'proto' })
  await transition('owner', { action: 'pause', idempotency_key: '' })
  await transition('owner', { action: 'pause', idempotency_key: 'k'.repeat(201) })
  // Пауза, повтор ключа (заголовок), возобновление, финал со сводкой.
  await transition('owner', { action: 'PAUSE', reason: 'перерыв на чай', idempotency_key: 'pause-1' })
  await transition('owner', { action: 'resume' }, { 'x-idempotency-key': 'pause-1' })
  await transition('owner', { action: 'complete', idempotency_key: 'complete-paused' })
  await transition('admin', { action: 'resume', idempotency_key: 'resume-1', reason: null })
  await houseRule(false, 'hr-5')
  await transition('owner', { action: 'complete', idempotency_key: 'finale' })
  await transition('owner', { action: 'complete', idempotency_key: 'finale' })
  await control('owner', { action: 'rewind_turn', idempotency_key: 'after-finale' })
  await control('owner', { action: 'replay_scene', idempotency_key: 'after-finale-scene' })
  await transition('owner', { action: 'pause', idempotency_key: 'pause-finished' })
  await transition('owner', { action: 'archive', idempotency_key: 'archive-1' })
  await transition('owner', { action: 'complete', idempotency_key: 'archive-1' })
  await send('outsider', 'GET', lifecycle(CODE))
  await send('owner', 'GET', lifecycle(CODE))

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.body_norm !== '<c6>') entry.body_norm = withoutMessages(entry.body_norm)
  }
  const journal = await readJournal(server, CODE)
  const file = join(FIXTURES_DIR, 'c8.json')
  writeFileSync(file, `${JSON.stringify({
    format: GOLDEN_FORMAT,
    scenario: 'откат хода и сцены, жизненный цикл: права, ключ, повтор и конфликт, финал со сводкой, журнал с event_id',
    exchanges,
    journal: { campaign: CODE, events: journal.events.map(journalEvent) },
  }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов, ${journal.events.length} событий)`)
} finally {
  await close()
}
