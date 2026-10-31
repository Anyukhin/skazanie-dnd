// С19.2: перенос хранилища JS-сервера в хранилище Rust-сервера
// (`skazanie-server import-legacy`). Данные только сгенерированные: JS-сервер
// поднимается набором на временном storage, играются кампании (создание,
// герои, приглашение, команды, бой до победы, общий кубик, настройки), затем
// копия импортируется, и Rust-сервер на перенесённой базе обязан отвечать
// так же, как JS-сервер на исходном хранилище: список кампаний, комнаты,
// настройки, герои, сессии и вход по старому паролю. Журнал каждой кампании
// сверяется с JS-движком на том же журнале: голова, полный replay, коммиты.
//
// Тест нужен бинарь Rust — в режиме js (весь корпус, `test:contract:js`) он
// пропускается.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createCampaign, createClient, expectStatus, login, registerUser, sendCommand, serverImpl, setupAdmin, spawnRust, startTestServer,
} from './kit/http.mjs'
import { corruptCampaign, readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SETUP_TOKEN = 'legacy-import-setup-token'

function cells(width, height) {
  return Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true }))
}

function hero(id, name, x, y) {
  return {
    id, character: name, name, characterClass: 'fighter', role: 'Воин · ур. 5', level: 5, proficiency: 3,
    hp: 30, maxHp: 30, armor: 16, speed: 30, x, y, experience: 6500,
    abilities: { str: 20, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [{ id: `${id}-potion`, catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 1 }],
    attackBonus: 100, damageDice: 6, damageBonus: 100, damageType: 'slashing', attackRange: 5,
  }
}

/** Бой: герой ходит первым, враг падает с одного удара — бой кончается победой. */
function arenaState(code) {
  return {
    state_version: 0, sessionCode: code, campaign: 'Арена переноса', partyName: 'Отряд переноса',
    activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [hero('hero', 'Бран', 1, 1)],
    enemies: [{
      id: 'enemy', name: 'Разбойник', hp: 5, maxHp: 5, armor: 1, speed: 30, alive: true,
      attackBonus: 3, damageDice: 4, damageBonus: 1, damageType: 'piercing', attackRange: 5, x: 2, y: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    }],
    actors: [], messages: [], battleLog: [],
    scene: { title: 'Арена', location: 'Арена', turn: 1, cells: cells(4, 4) },
    mechanics: {
      positions: { hero: { x: 1, y: 1 }, enemy: { x: 2, y: 1 } },
      conditions: {},
      death: { saving_throws: {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'enemy', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 2 },
          enemy: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, attacks_used: 0, attacks_allowed: 1 },
        },
      },
    },
  }
}

/** Исследование без боя: два героя, второго занимает приглашённый игрок. */
function quietState(code) {
  return {
    state_version: 0, sessionCode: code, campaign: 'Тихая деревня', partyName: 'Двое у костра',
    activePlayerId: 'hero', partyMemberIds: ['hero', 'scout'],
    players: [hero('hero', 'Бран', 0, 0), { ...hero('scout', 'Ива', 1, 0), characterClass: 'rogue', role: 'Плут · ур. 5' }],
    enemies: [], actors: [], messages: [], battleLog: [],
    scene: { title: 'Площадь', location: 'Деревня', turn: 1, cells: cells(6, 6) },
    mechanics: { positions: { hero: { x: 0, y: 0 }, scout: { x: 1, y: 0 } } },
  }
}

/** Все файлы каталога: путь → sha256 содержимого (источник не должен меняться). */
function fingerprint(root) {
  const result = {}
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const relative = prefix ? `${prefix}/${name}` : name
      if (statSync(path).isDirectory()) walk(path, relative)
      else result[relative] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(root, '')
  return result
}

/** `skazanie-server import-legacy …`: код выхода, отчёт `--json`, stderr. */
async function importLegacy(args, storageDir) {
  const child = spawnRust(['import-legacy', ...args], { storageDir })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  let report = null
  try { report = stdout.trim() ? JSON.parse(stdout) : null } catch { /* не JSON — проверка по stdout */ }
  return { code, report, stdout, stderr }
}

/** Ответ без меток времени чтения: их ставит сам запрос, а не хранилище. */
function stable(value) {
  return JSON.parse(JSON.stringify(value ?? null, (key, inner) => (key === 'serverTime' || key === 'server_time' ? undefined : inner)))
}

/** Первое расхождение двух JSON-значений — путь и обе стороны. */
function firstDifference(left, right, path = '$') {
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    for (const key of keys) {
      const found = firstDifference(left[key], right[key], `${path}.${key}`)
      if (found) return found
    }
    return null
  }
  return `${path}: JS ${JSON.stringify(left)?.slice(0, 300)} — Rust ${JSON.stringify(right)?.slice(0, 300)}`
}

function assertSame(js, rust, label) {
  const difference = firstDifference(stable(js), stable(rust))
  assert.equal(difference, null, `${label}: ${difference}`)
}

const CODES = ['LEGACY-ARENA', 'LEGACY-QUIET', 'LEGACY-TAIL', 'LEGACY-SEED']

test('import-legacy: JS-хранилище переезжает в SQLite, Rust отвечает как JS', {
  timeout: runnerTimeout(240_000),
  skip: serverImpl() !== 'rust' && 'нужен бинарь Rust-сервера (SKAZANIE_SERVER_IMPL=rust)',
}, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'skazanie-legacy-import-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const jsStorage = join(scratch, 'js-storage')
  const rustStorage = join(scratch, 'rust-storage')

  // --- 1. Игра на JS-сервере ---------------------------------------------
  const js = await startTestServer(t, { impl: 'js', storageDir: jsStorage, setupToken: SETUP_TOKEN })
  const admin = await setupAdmin(js, { email: 'gm@legacy-import.test', password: 'legacy-admin-password' })
  const owner = await registerUser(js, { name: 'Владелец', email: 'owner@legacy-import.test', password: 'legacy-owner-password' })
  const scout = await registerUser(js, { name: 'Разведчица', email: 'scout@legacy-import.test', password: 'legacy-scout-password' })
  const users = expectStatus(await admin.client.get('/api/admin/users')).users
  const ownerUser = users.find((user) => user.email === 'owner@legacy-import.test')
  expectStatus(await admin.client.patch(`/api/admin/users/${ownerUser.id}`, { heroIds: ['hero'] }))

  for (const code of CODES) {
    await createCampaign(admin.client, { code, name: code, state: code === 'LEGACY-QUIET' ? quietState(code) : arenaState(code) })
  }
  // Бой: удар, враг падает, бой кончается.
  const strike = await sendCommand(owner.client, 'LEGACY-ARENA', 'legacy-arena-strike', { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy' }, { message: 'Бран бьёт разбойника' })
  const struck = expectStatus(strike)
  assert.ok(struck.mechanics.some((event) => event.event_type === 'DamageApplied'), strike.text.slice(0, 400))
  // Общий кубик и летопись.
  expectStatus(await owner.client.post('/api/rooms/LEGACY-ARENA/dice', { playerId: 'hero', sides: 20 }))
  // Приглашение и вход второго игрока, настройки ИИ.
  const invite = expectStatus(await admin.client.post('/api/campaigns/LEGACY-QUIET/invites', { hero_ids: ['scout'] }), 201)
  expectStatus(await scout.client.post('/api/campaigns/LEGACY-QUIET/join', { invite_token: invite.token }))
  expectStatus(await admin.client.patch('/api/campaigns/LEGACY-QUIET/settings', { improvMode: 'chaos', narratorStyle: 'ironic' }))
  expectStatus(await scout.client.post('/api/rooms/LEGACY-QUIET/dice', { playerId: 'scout', sides: 6 }))
  // Кампании, которые потом испортим в копии.
  for (const code of ['LEGACY-TAIL', 'LEGACY-SEED']) {
    expectStatus(await sendCommand(owner.client, code, `${code}-strike`, { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'enemy' }))
  }
  // Координатор хода и часы досчитывают своё до остановки.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  await js.stop()

  // --- 2. Перенос ----------------------------------------------------------
  const before = fingerprint(jsStorage)

  const dryTarget = join(scratch, 'dry-target')
  const dry = await importLegacy(['--from', jsStorage, '--to', dryTarget, '--dry-run', '--json'], dryTarget)
  assert.equal(dry.code, 0, `${dry.stderr}\n${dry.stdout.slice(0, 2_000)}`)
  assert.equal(dry.report.dry_run, true)
  assert.equal(existsSync(dryTarget), false, '--dry-run ничего не пишет')
  // Сводка для человека — тот же перенос, видна в выводе теста.
  const text = await importLegacy(['--from', jsStorage, '--to', dryTarget, '--dry-run'], dryTarget)
  assert.equal(text.code, 0, text.stderr)
  assert.match(text.stdout, /Перенос хранилища JS → Rust: проверка \(--dry-run\)/u)
  t.diagnostic(text.stdout)

  const imported = await importLegacy(['--from', jsStorage, '--to', rustStorage, '--json'], rustStorage)
  assert.equal(imported.code, 0, `${imported.stderr}\n${imported.stdout.slice(0, 4_000)}`)
  const report = imported.report
  assert.equal(report.format, 'skazanie.import-legacy/1')
  assert.deepEqual(report.campaigns.map((campaign) => [campaign.campaign_id, campaign.status, campaign.warnings]).sort(),
    CODES.map((code) => [code, 'imported', []]).sort())
  assert.deepEqual(report.rooms.map((room) => [room.code, room.status]).sort(), CODES.map((code) => [code, 'imported']).sort())
  assert.deepEqual(report.unknown, [], 'в хранилище JS нет записей неизвестного назначения')
  assert.equal(report.accounts.users, 3)
  assert.equal(report.accounts.admins, 1)
  assert.ok(report.accounts.sessions >= 3, 'живые сессии переносятся')
  assert.equal(report.accounts.campaign_settings, 1)
  assert.equal(report.files.copied, report.files.planned)
  // Сводка dry-run совпадает с настоящим переносом (кроме копирования).
  assert.deepEqual({ ...dry.report, dry_run: true, to: '', files: null }, { ...report, dry_run: true, to: '', files: null })
  // В отчёте нет секретов: ни хешей паролей и токенов, ни почты.
  for (const secret of ['passwordHash', 'passwordSalt', 'tokenHash', '@legacy-import.test']) {
    assert.equal(imported.stdout.includes(secret), false, `отчёт не печатает ${secret}`)
  }
  for (const room of report.rooms) {
    assert.ok(room.overlay_fields.includes('messages'), `${room.code}: летопись — в накладке`)
    assert.ok(room.messages <= 400)
  }

  // Отказы: непустая база, совпадающие каталоги, каталог без JS-файлов.
  const again = await importLegacy(['--from', jsStorage, '--to', rustStorage, '--force'], rustStorage)
  assert.equal(again.code, 1, again.stdout)
  assert.match(again.stderr, /уже есть данные/u)
  const same = await importLegacy(['--from', jsStorage, '--to', jsStorage], jsStorage)
  assert.equal(same.code, 1)
  assert.match(same.stderr, /не должны совпадать/u)
  const nested = await importLegacy(['--from', jsStorage, '--to', join(jsStorage, 'rust')], join(jsStorage, 'rust'))
  assert.equal(nested.code, 1)
  const notJs = await importLegacy(['--from', rustStorage, '--to', join(scratch, 'nowhere')], join(scratch, 'nowhere'))
  assert.equal(notJs.code, 1)
  assert.match(notJs.stderr, /нет хранилища JS-сервера/u)
  const unknownArg = await importLegacy(['--from', jsStorage, '--port', '1'], join(scratch, 'nowhere'))
  assert.equal(unknownArg.code, 2, 'неизвестный аргумент — справка и код 2, а не запуск сервера')
  assert.equal(existsSync(join(scratch, 'nowhere')), false)

  assert.deepEqual(fingerprint(jsStorage), before, 'импорт только читает --from')

  // --- 3. Журнал: Rust-движок на перенесённом журнале = JS-движок ---------
  for (const code of CODES) {
    for (const useSnapshots of [true, false]) {
      const fromJs = await readJournal({ impl: 'js', storageDir: jsStorage }, code, { useSnapshots })
      const fromRust = await readJournal({ impl: 'rust', storageDir: rustStorage }, code, { useSnapshots })
      const label = `${code}${useSnapshots ? '' : ' (replay без снимков)'}`
      assert.equal(fromRust.state_version, fromJs.state_version, label)
      assert.equal(fromRust.current_state_version, fromJs.current_state_version, label)
      assertSame(fromJs.commits, fromRust.commits, `${label}: коммиты`)
      assertSame(fromJs.state, fromRust.state, `${label}: состояние`)
      assert.equal(
        createHash('sha256').update(JSON.stringify(fromRust.state)).digest('hex').length, 64,
      )
      assertSame(fromJs.pending_projection, fromRust.pending_projection, `${label}: отставание проекции`)
    }
  }

  // --- 4. Серверы бок о бок: JS на исходном, Rust на перенесённом ----------
  const jsAgain = await startTestServer(t, { impl: 'js', storageDir: jsStorage, setupToken: SETUP_TOKEN })
  const rust = await startTestServer(t, { impl: 'rust', storageDir: rustStorage, setupToken: SETUP_TOKEN })
  const sessions = { admin: admin.client.cookie, owner: owner.client.cookie, scout: scout.client.cookie }
  for (const [who, cookie] of Object.entries(sessions)) {
    // Старая cookie действует на обоих серверах: сессии перенесены.
    const onJs = createClient(jsAgain, { cookie })
    const onRust = createClient(rust, { cookie })
    const meJs = expectStatus(await onJs.get('/api/auth/me'))
    const meRust = expectStatus(await onRust.get('/api/auth/me'))
    assertSame(meJs, meRust, `${who}: /api/auth/me`)
    const listJs = expectStatus(await onJs.get('/api/campaigns'))
    assertSame(listJs, expectStatus(await onRust.get('/api/campaigns')), `${who}: /api/campaigns`)
    if (who === 'admin') assert.deepEqual(listJs.campaigns.map((campaign) => campaign.code).sort(), [...CODES].sort())
    for (const code of CODES) {
      const roomJs = await onJs.get(`/api/rooms/${code}`)
      const roomRust = await onRust.get(`/api/rooms/${code}`)
      assert.equal(roomRust.status, roomJs.status, `${who}: /api/rooms/${code} ${roomRust.text.slice(0, 300)}`)
      if (who === 'admin') assert.equal(roomJs.status, 200, `${code}: ${roomJs.text.slice(0, 300)}`)
      assertSame(roomJs.body, roomRust.body, `${who}: /api/rooms/${code}`)
      const settingsJs = await onJs.get(`/api/campaigns/${code}/settings`)
      const settingsRust = await onRust.get(`/api/campaigns/${code}/settings`)
      assert.equal(settingsRust.status, settingsJs.status, `${who}: settings ${code}`)
      assertSame(settingsJs.body, settingsRust.body, `${who}: /api/campaigns/${code}/settings`)
    }
  }
  const heroesJs = expectStatus(await createClient(jsAgain, { cookie: sessions.admin }).get('/api/heroes'))
  const heroesRust = expectStatus(await createClient(rust, { cookie: sessions.admin }).get('/api/heroes'))
  assertSame(heroesJs, heroesRust, '/api/heroes')
  // Вход по старому паролю (тот же scrypt).
  const relogged = await login(rust, { email: 'scout@legacy-import.test', password: 'legacy-scout-password' })
  expectStatus(await relogged.get('/api/rooms/LEGACY-QUIET'))
  // Игра продолжается на перенесённой базе: новый кубик пишется и читается.
  expectStatus(await createClient(rust, { cookie: sessions.owner }).post('/api/rooms/LEGACY-ARENA/dice', { playerId: 'hero', sides: 8 }))
  await jsAgain.stop()
  await rust.stop()

  // --- 5. Битая копия: потерянный хвост и seed, остальные переносятся ------
  const brokenStorage = join(scratch, 'js-broken')
  cpSync(jsStorage, brokenStorage, { recursive: true })
  rmSync(join(brokenStorage, '.server-writer.json'), { force: true })
  const brokenJs = { impl: /** @type {'js'} */ ('js'), storageDir: brokenStorage, running: () => false }
  const tailReason = await corruptCampaign(brokenJs, 'LEGACY-TAIL', 'tail')
  const seedReason = await corruptCampaign(brokenJs, 'LEGACY-SEED', 'seed')
  const brokenTarget = join(scratch, 'rust-broken')
  const partial = await importLegacy(['--from', brokenStorage, '--to', brokenTarget, '--json'], brokenTarget)
  assert.equal(partial.code, 3, `часть кампаний пропущена — код 3\n${partial.stderr}\n${partial.stdout.slice(0, 2_000)}`)
  const byId = Object.fromEntries(partial.report.campaigns.map((campaign) => [campaign.campaign_id, campaign]))
  assert.equal(byId['LEGACY-ARENA'].status, 'imported')
  assert.equal(byId['LEGACY-QUIET'].status, 'imported')
  for (const [code, reason] of [['LEGACY-TAIL', tailReason], ['LEGACY-SEED', seedReason]]) {
    assert.equal(byId[code].status, 'skipped', code)
    assert.equal(byId[code].code, 'CAMPAIGN_RECOVERY_REQUIRED', code)
    assert.match(byId[code].reason, new RegExp(reason, 'u'), code)
    const room = partial.report.rooms.find((entry) => entry.code === code)
    assert.equal(room.status, 'skipped', `${code}: комната пропущенной кампании не переносится`)
  }
  const survivor = await startTestServer(t, { impl: 'rust', storageDir: brokenTarget, setupToken: SETUP_TOKEN })
  const list = expectStatus(await createClient(survivor, { cookie: sessions.admin }).get('/api/campaigns'))
  assert.deepEqual(list.campaigns.map((campaign) => campaign.code).sort(), ['LEGACY-ARENA', 'LEGACY-QUIET'])
  await survivor.stop()

  // --- 6. Отказ старта: JS-файлы рядом с пустой базой ----------------------
  const untouched = join(scratch, 'js-untouched')
  cpSync(jsStorage, untouched, { recursive: true })
  rmSync(join(untouched, '.server-writer.json'), { force: true })
  await assert.rejects(
    startTestServer(t, { impl: 'rust', storageDir: untouched, setupToken: SETUP_TOKEN, healthTimeoutMs: runnerTimeout(15_000) }),
    /import-legacy/u,
    'сервер не стартует с пустым миром поверх JS-хранилища',
  )
  assert.equal(existsSync(join(untouched, 'skazanie.sqlite')), false, 'отказ старта не создаёт базу')
})
