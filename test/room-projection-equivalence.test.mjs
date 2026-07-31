import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalProjection, compareProjection, projectionHash } from '../server/projection-integrity.mjs'

/**
 * Шаг 1 плана `docs/agent-architecture-plan.md`: доказать инвариант
 *
 * ```
 * инкрементальная проекция после события = полная проекция того же состояния
 * ```
 *
 * `persistAuthoritativeProjection` сливает авторитетное состояние в «комнату»
 * по спискам типов событий: `refreshInventory` перечисляет одиннадцать
 * `Item*`-типов, `characterBuildChanged` — четыре. Забыли тип в списке —
 * интерфейс молча показывает устаревшие данные, и ни один тест этого не видит.
 *
 * Тест намеренно проверяет то, что видит игрок, а не внутренности: после каждой
 * команды публичная комната обязана совпасть с полной проекцией авторитетного
 * состояния. Поэтому он остаётся честным и после шага 3 плана, когда списки
 * либо исчезнут, либо переедут в executor.
 *
 * Контрольные типы событий **вне** обоих списков идут тем же набором: именно
 * они дают молчаливое устаревание, если страховка `reconcileCampaignProjection`
 * когда-нибудь перестанет срабатывать.
 */

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'projection-equivalence-setup',
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* сырое тело уходит в assert */ }
  return { response, status: response.status, body: parsed, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

/**
 * `compareProjection` отдаёт только хэши. Для отчёта нужно имя поля, иначе
 * падение теста ничего не подсказывает.
 *
 * @param {Record<string, unknown>} authoritative
 * @param {Record<string, unknown>} projected
 * @returns {string[]}
 */
function divergedFields(authoritative, projected) {
  const left = canonicalProjection(authoritative ?? {})
  const right = canonicalProjection(projected ?? {})
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))
    .sort()
}

const CODE = 'PROJECTION-EQUIV'

function initialState() {
  return {
    state_version: 0,
    sessionCode: CODE,
    campaign: 'Эквивалентность проекции',
    activePlayerId: 'fighter',
    partyMemberIds: ['fighter', 'wizard'],
    players: [
      {
        id: 'fighter', character: 'Бран', characterClass: 'fighter', role: 'Воин · ур. 3', level: 3,
        hp: 12, maxHp: 30, armor: 16, experience: 900,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
        inventory: [
          { id: 'sword-1', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', quantity: 1 },
          { id: 'ring-1', catalog_id: 'srd_5_2_1:ring-of-protection', name: 'Кольцо защиты', quantity: 1 },
          { id: 'potion-1', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 2 },
        ],
      },
      {
        id: 'wizard', character: 'Мира', characterClass: 'wizard', role: 'Волшебник · ур. 3', level: 3,
        hp: 14, maxHp: 18, armor: 12, experience: 900,
        abilities: { str: 8, dex: 12, con: 10, int: 16, wis: 12, cha: 10 },
        inventory: [],
      },
    ],
    enemies: [], actors: [], messages: [], battleLog: [],
    scene: { location: 'Лагерь', cells: [], turn: 1 },
    mechanics: { resources: { fighter: {}, wizard: {} } },
  }
}

test('комната после каждого события совпадает с полной проекцией авторитетного состояния', { timeout: 120_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-projection-equivalence-'))
  let logs = ''
  let child = null
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'GM', email: 'gm@projection.test', password: 'secure-admin-password', setupToken: 'projection-equivalence-setup',
  } })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const adminCookie = cookie(admin)

  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Owner', email: 'owner@projection.test', password: 'secure-owner-password',
  } })
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  const ownerCookie = cookie(owner)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@projection.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['fighter', 'wizard'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: CODE, name: 'Эквивалентность проекции', state: initialState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  /**
   * Прогоняет одну команду и проверяет инвариант на её результате.
   *
   * @param {string} label человекочитаемое имя пробы
   * @param {Record<string, unknown>} command
   * @param {{ expectedEvent?: string, inRefreshList: boolean }} options
   */
  async function probe(label, command, { expectedEvent, inRefreshList }) {
    const key = `equivalence:${label}`
    const result = await request(baseUrl, `/api/campaigns/${CODE}/commands`, {
      method: 'POST', cookie: ownerCookie, key,
      body: { idempotency_key: key, command, message: label },
    })
    assert.equal(result.status, 200, `${label}: ${result.text}\n${logs}`)
    const authoritative = result.body.authoritative_state
    assert.ok(authoritative, `${label}: сервер не вернул авторитетное состояние`)
    if (expectedEvent) {
      const types = (result.body.mechanics ?? []).map((event) => event.event_type)
      assert.ok(types.includes(expectedEvent),
        `${label}: ожидалось событие ${expectedEvent}, пришли ${types.join(', ') || 'никакие'}`)
    }

    // Обе стороны берутся глазами одного и того же зрителя: сравнивается
    // инкрементальная проекция против полной, а не admin против игрока.
    const room = await request(baseUrl, `/api/rooms/${CODE}`, { cookie: ownerCookie })
    assert.equal(room.status, 200, `${label}: ${room.text}`)
    const comparison = compareProjection(authoritative, room.body.state)
    assert.ok(comparison.matched, [
      `${label}: комната разошлась с полной проекцией авторитетного состояния.`,
      inRefreshList
        ? 'Тип события есть в списке обновления — значит сломался сам инкрементальный слив.'
        : 'Типа события нет в списке обновления — это и есть молчаливое устаревание, о котором предупреждает шаг 1 плана.',
      `Разошлись поля: ${divergedFields(authoritative, room.body.state).join(', ') || 'нет — расходится только порядок ключей'}.`,
    ].join(' '))
    return result
  }

  // 1. Экипировка: `ItemEquipped` есть в списке `refreshInventory`.
  await probe('equip', { command_type: 'EquipItem', actor_id: 'fighter', item_id: 'sword-1' },
    { expectedEvent: 'ItemEquipped', inRefreshList: true })

  // 2. Настройка: `ItemAttunementChanged` тоже в списке и меняет КД героя.
  await probe('equip-ring', { command_type: 'EquipItem', actor_id: 'fighter', item_id: 'ring-1' },
    { expectedEvent: 'ItemEquipped', inRefreshList: true })
  await probe('attune', { command_type: 'AttuneItem', actor_id: 'fighter', item_id: 'ring-1', attuned: true },
    { expectedEvent: 'ItemAttunementChanged', inRefreshList: true })

  // 3. Передача союзнику: `ItemTransferred` меняет инвентарь **двух** героев.
  await probe('transfer', {
    command_type: 'TransferItem', actor_id: 'fighter', item_id: 'potion-1', recipient_id: 'wizard', quantity: 1,
  }, { expectedEvent: 'ItemTransferred', inRefreshList: true })

  // 4. Использование зелья: `ItemUsed` плюс лечение — hp сливается всегда.
  await probe('use-potion', {
    command_type: 'UseItem', actor_id: 'fighter', item_id: 'potion-1', target_id: 'fighter',
  }, { expectedEvent: 'ItemUsed', inRefreshList: true })

  // 5. Контроль: отдых и кость хитов. `RestStarted` и `HitPointDieSpent` **не**
  //    входят ни в `refreshInventory`, ни в `characterBuildChanged`.
  await probe('rest-start', { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' },
    { expectedEvent: 'RestStarted', inRefreshList: false })
  await probe('hit-die', { command_type: 'SpendHitPointDie', actor_id: 'fighter' },
    { expectedEvent: 'HitPointDieSpent', inRefreshList: false })
  await probe('rest-complete', { command_type: 'CompleteRest', actor_id: 'fighter' },
    { expectedEvent: 'RestCompleted', inRefreshList: false })
  // Шаг 1 плана требует решения по данным: если полный пересчёт укладывается в
  // бюджет хода, инкрементальные списки можно удалить вместе с классом багов.
  // Замер печатается всегда и живёт рядом с инвариантом, а не в чьей-то памяти.
  const room = await request(baseUrl, `/api/rooms/${CODE}`, { cookie: ownerCookie })
  const samples = []
  for (let index = 0; index < 9; index += 1) {
    const started = process.hrtime.bigint()
    projectionHash(room.body.state)
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((left, right) => left - right)
  const median = samples[Math.floor(samples.length / 2)]
  console.log(`  полный пересчёт проекции комнаты: медиана ${median.toFixed(2)} мс`)
  assert.ok(median <= 250, `полный пересчёт ${median.toFixed(2)} мс — это уже сравнимо с ходом, списки удалять нельзя`)
})
