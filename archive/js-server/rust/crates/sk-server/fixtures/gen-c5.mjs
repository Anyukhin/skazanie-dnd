// Эталон «Г» боевого стенда администратора (С5):
// `node rust/crates/sk-server/fixtures/gen-c5.mjs` пишет `fixtures/c5.json`;
// сверка — `tests/c5_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1` (сверку делает свой прогон
// в `tests/c5_golden.rs`, правила те же):
// * `<run:N>` в пути — id N-го принятого прогона (ответ 202 `{ id }`);
// * `wait_run: N` — перед обменом дождаться конца прогона N (опрос
//   `GET runs/:id` без записи);
// * у отчёта `trace.final_state` — хеш канонического текста (ключи по
//   алфавиту): порядок ключей `scene` итогового состояния у Rust другой
//   (`map` раньше `cells`, нормализация движка), значения те же;
// * большие ветви тела (каталог, кадры) — хешем, см. `shrink`.
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'

import { buildCombatLabState } from '../../../../server/combat-lab-setup.mjs'
import { createClient } from '../../../../test/kit/http.mjs'
import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
/** Тело длиннее (в символах `JSON.stringify`) хранится по частям или хешем. */
const BIG_BODY = 4_000
const LAB = '/api/admin/combat-lab'

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex')

/**
 * `shrink` как в `gen-c4.mjs`: значение длиннее `BIG_BODY` сжимается по
 * частям, а если и так длиннее — `<sha256:хеш:длина>` своего текста.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function shrink(value) {
  const text = JSON.stringify(value)
  if (text === undefined || text.length <= BIG_BODY || value === null || typeof value !== 'object') return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (JSON.stringify(parts).length <= BIG_BODY) return parts
  return `<sha256:${sha(text)}:${text.length}>`
}

/**
 * `JSON.stringify` с ключами по алфавиту (единицы UTF-16).
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

const encounterConfig = { mapId: 'open-courtyard',
  party: ['fighter', 'rogue', 'cleric', 'wizard'].map((classId, y) => ({ source: 'class', classId, level: 3, x: 0, y })), enemies: [] }
const duelConfig = { mapId: 'open-courtyard',
  party: [{ source: 'class', classId: 'fighter', level: 1, x: 0, y: 0 }],
  enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }] }

const sourceState = await buildCombatLabState({ mapId: 'open-courtyard',
  party: [{ source: 'class', classId: 'wizard', level: 5, x: 0, y: 0 }],
  enemies: [{ monsterId: 'dnd_5e_2014:monster:goblin', x: 8, y: 5 }] })
sourceState.sessionCode = 'LAB-SOURCE'
sourceState.enemies = []

const { server, close } = await startGoldenServer()
try {
  const { send, exchanges } = recorder(server)
  /** @type {string[]} */
  const runs = []
  const poller = createClient(server)
  /** @param {number} index */
  async function waitRun(index) {
    for (let attempt = 0; attempt < 2_400; attempt += 1) {
      const run = await poller.request(`${LAB}/runs/${runs[index]}`)
      if (run.body?.status !== 'running') return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`прогон ${index} не завершился`)
  }
  /**
   * Обмен с подстановкой `<run:N>` и ожиданием прогона.
   *
   * @param {string} role
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, responseHeaders?: string[], waitRun?: number }} [options]
   */
  async function lab(role, method, path, { waitRun: wait, ...options } = {}) {
    if (wait !== undefined) await waitRun(wait)
    const resolved = path.replace(/<run:(\d+)>/gu, (_, index) => runs[Number(index)])
    const response = await send(role, method, resolved, options)
    const entry = /** @type {any} */ (exchanges.at(-1))
    entry.path = path
    if (wait !== undefined) entry.wait_run = wait
    if (method === 'POST' && path === `${LAB}/runs` && response.status === 202) runs.push(response.body.id)
    return response
  }

  // Без входа и чужая роль.
  await lab('anon', 'GET', `${LAB}/scenarios`)
  await lab('anon', 'POST', `${LAB}/encounter/assess`, { body: { config: encounterConfig } })
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await poller.request('/api/auth/login', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password } })
  await lab('player', 'GET', `${LAB}/scenarios`)
  await lab('player', 'GET', `${LAB}/catalog`)
  await lab('player', 'POST', `${LAB}/encounter/generate`, { body: { config: encounterConfig } })
  await lab('player', 'POST', `${LAB}/runs`, { body: { scenario: 'missing', seed: 1 } })
  await lab('player', 'GET', `${LAB}/runs`)
  await lab('player', 'GET', `${LAB}/runs/x`)
  await lab('player', 'DELETE', `${LAB}/runs/x/report`)
  // Справочники.
  await lab('admin', 'GET', `${LAB}/scenarios`)
  await lab('admin', 'GET', `${LAB}/scenarios?x=1`)
  await lab('admin', 'GET', `${LAB}/catalog`)
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'LAB-SOURCE', name: 'Источник для стенда', state: sourceState } })
  await lab('admin', 'GET', `${LAB}/catalog`)
  // Оценка и генерация стычки.
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: { config: encounterConfig } })
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: { config: { ...encounterConfig, xp: 0 } } })
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: { config: { ...duelConfig, party: [{ source: 'hero', campaignId: 'LAB-SOURCE', heroId: sourceState.players[0].id, x: 0, y: 0 }] } } })
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: [] })
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: {} })
  await lab('admin', 'POST', `${LAB}/encounter/generate`, { body: { config: encounterConfig, difficulty: 'medium', seed: 17 } })
  await lab('admin', 'POST', `${LAB}/encounter/generate`, { body: { config: encounterConfig, difficulty: 'deadly', seed: 'стенд' } })
  await lab('admin', 'POST', `${LAB}/encounter/generate`, { body: { config: { ...encounterConfig, party: [{ ...encounterConfig.party[0], level: 99 }] }, difficulty: 'medium', seed: 17 } })
  await lab('admin', 'POST', `${LAB}/encounter/generate`, { body: { config: encounterConfig, difficulty: 'nightmare' } })
  await lab('admin', 'GET', `${LAB}/encounter/assess`)
  // Нераспознанное под префиксом проваливается дальше — 404 API.
  await lab('admin', 'POST', `${LAB}/scenarios`)
  await lab('admin', 'GET', `${LAB}/unknown`)
  await lab('admin', 'GET', `${LAB}/`)
  await lab('admin', 'PUT', `${LAB}/runs`, { body: {} })
  await lab('admin', 'PATCH', `${LAB}/runs/x`, { body: {} })
  await lab('admin', 'GET', `${LAB}/runs/x/reports`)
  await lab('admin', 'GET', `${LAB}/runs/x/report/y`)
  // Запуск: отказы до прогона.
  await lab('admin', 'GET', `${LAB}/runs`)
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'missing', seed: 1 } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: null, seed: 1 } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'duel', seed: 1.5 } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'duel', seed: -1 } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'duel', seed: 4294967296 } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'duel', seed: '1' } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: {} })
  await lab('admin', 'POST', `${LAB}/runs`, { body: [] })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { seed: 1, config: { ...duelConfig, xp: 0 } } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { seed: 1, config: null } })
  // Дуэль: прогон, кадры, отчёт, отмена завершённого.
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'duel', seed: 2 } })
  await lab('admin', 'GET', `${LAB}/runs/<run:0>`, { waitRun: 0 })
  await lab('admin', 'GET', `${LAB}/runs`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=5`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=2000`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=0x3`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=abc`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=2001`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=-2`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>?after=1.5`)
  await lab('admin', 'GET', `${LAB}/runs/<run:0>/report`, { responseHeaders: ['content-disposition'] })
  await lab('admin', 'DELETE', `${LAB}/runs/<run:0>/report`)
  await lab('player', 'GET', `${LAB}/runs/<run:0>/report`)
  await lab('admin', 'DELETE', `${LAB}/runs/<run:0>`)
  await lab('admin', 'GET', `${LAB}/runs/nope`)
  await lab('admin', 'GET', `${LAB}/runs/nope/report`)
  await lab('admin', 'DELETE', `${LAB}/runs/nope`)
  await lab('admin', 'GET', `${LAB}/runs/%E0`)
  await lab('admin', 'GET', `${LAB}/runs/report`)
  // Остальные арены и свой бой.
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'ranged', seed: 5 } })
  await lab('admin', 'GET', `${LAB}/runs/<run:1>/report`, { waitRun: 1 })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'not-a-scenario', seed: 3, config: duelConfig } })
  await lab('admin', 'GET', `${LAB}/runs/<run:2>`, { waitRun: 2 })
  await lab('admin', 'GET', `${LAB}/runs/<run:2>/report`)
  // История из трёх прогонов: четвёртый вытесняет старейший завершённый.
  await lab('admin', 'POST', `${LAB}/runs`, { body: { scenario: 'opportunity-attack', seed: 9 } })
  await lab('admin', 'GET', `${LAB}/runs/<run:3>`, { waitRun: 3 })
  await lab('admin', 'GET', `${LAB}/runs/<run:0>`)
  await lab('admin', 'GET', `${LAB}/runs/<run:1>?after=100`)

  // Герой из кампании-источника: загрузка журнала через ядро.
  const sourceParty = [{ source: 'hero', campaignId: 'lab-source', heroId: sourceState.players[0].id, x: 0, y: 0 }]
  await lab('admin', 'POST', `${LAB}/encounter/assess`, { body: { config: { ...duelConfig, party: [{ ...sourceParty[0], campaignId: 'NOPE' }] } } })
  await lab('admin', 'POST', `${LAB}/runs`, { body: { seed: 4, config: { ...duelConfig, party: sourceParty } } })
  await lab('admin', 'GET', `${LAB}/runs/<run:4>`, { waitRun: 4 })
  await lab('admin', 'GET', `${LAB}/runs/<run:4>/report`)
  for (const entry of /** @type {any[]} */ (exchanges)) {
    const body = entry.body_norm
    if (body?.schema === 'combat-lab-observer/v1' && body.trace?.final_state) {
      body.trace.final_state = `<canonical:${sha(canonical(body.trace.final_state))}>`
    }
    entry.body_norm = shrink(body)
  }
  const file = writeGolden('c5', 'боевой стенд: права, справочники, оценка и генерация стычки, проваливание пути, запуск, кадры, отчёт, отмена, история', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
