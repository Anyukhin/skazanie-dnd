import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  compareStorageToBackup,
  createStorageBackup,
  restoreStorageBackup,
  verifyStorageBackup,
} from '../server/backup-service.mjs'
import { auditStorage, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Репетиция восстановления.
 *
 * Юнит-тесты `backup-service` доказывают, что формат архива честен: шифрование
 * держится, хеши сходятся, восстановление в пустой каталог проходит. Но это
 * доказательство про **файлы**, а не про игру. Настоящий вопрос звучит иначе:
 * если диск потерян, поднимется ли из архива работающая кампания — та же, с
 * тем же состоянием, целостная с точки зрения аудита.
 *
 * Тест проводит полный цикл: живая кампания → архив → проверка → сверка с
 * источником → восстановление в чистый каталог → **новый сервер на нём** →
 * кампания открывается, версия совпадает, блокеров целостности нет.
 *
 * `docs/production-readiness.md` требовал такую репетицию по расписанию; здесь
 * она становится частью обычного прогона.
 */

const SECRET = 'rehearsal-secret-key-not-a-production-value'

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
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

const hero = (id, name) => ({
  id, name, character: name, characterClass: 'fighter', level: 1, experience: 0,
  hp: 20, maxHp: 20, armor: 10, speed: 30,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [],
})

test('из архива поднимается та же играбельная кампания, а не только те же файлы', { timeout: runnerTimeout(180_000) }, async (t) => {
  const vault = mkdtempSync(join(tmpdir(), 'skazanie-rehearsal-vault-'))
  const restoredRoot = mkdtempSync(join(tmpdir(), 'skazanie-rehearsal-restored-'))
  const restored = join(restoredRoot, 'storage')
  const backupFile = join(vault, 'rehearsal.skzbackup')
  /** @type {Awaited<ReturnType<typeof startTestServer>> | null} */
  let restoredServer = null
  t.after(async () => {
    // Чужое хранилище набор не удаляет: сначала сервер, затем каталоги.
    await restoredServer?.stop()
    for (const directory of [vault, restoredRoot]) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  // 1. Живая кампания с несколькими подтверждёнными командами.
  const liveServer = await startTestServer(t, { setupToken: 'rehearsal-setup', storagePrefix: 'skazanie-rehearsal-live-' })
  const live = liveServer.storageDir
  const liveUrl = liveServer.baseUrl

  const owner = await request(liveUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Owner', email: 'rehearsal@test.local', password: 'secure-owner-password', setupToken: 'rehearsal-setup' },
  })
  assert.equal(owner.status, 201, owner.text)
  const cookie = sessionCookie(owner)

  assert.equal((await request(liveUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: 'VAULT', name: 'Хранилище', bootstrap: { partyName: 'Двое', players: [hero('hero-1', 'Первый'), hero('hero-2', 'Второй')] } },
  })).status, 201)

  for (let index = 1; index <= 3; index += 1) {
    const key = `rehearsal-${index}`
    const result = await request(liveUrl, '/api/campaigns/VAULT/commands', {
      method: 'POST', cookie, key,
      body: { idempotency_key: key, command: { command_type: 'ApplyHealing', actor_id: 'hero-1', amount: 1 } },
    })
    assert.equal(result.status, 200, result.text)
  }
  const before = await request(liveUrl, '/api/rooms/VAULT', { cookie })
  assert.equal(before.status, 200, before.text)
  const liveVersion = Number(before.body.state.state_version)
  assert.ok(liveVersion > 0)

  // 2. Сервер остановлен: архив снимается с покоящегося хранилища.
  await liveServer.stop()

  const created = createStorageBackup({ sourceDir: live, backupFile, secret: SECRET })
  assert.ok(created.file_count > 0)
  assert.equal(created.encrypted, true)

  const verified = verifyStorageBackup({ backupFile, secret: SECRET })
  assert.equal(verified.file_count, created.file_count)

  const compared = compareStorageToBackup({ sourceDir: live, backupFile, secret: SECRET })
  assert.equal(compared.identical, true, `архив разошёлся с источником: ${JSON.stringify(compared).slice(0, 400)}`)
  assert.deepEqual(compared.changed, [])
  assert.deepEqual(compared.missing, [])

  // Чужой ключ не открывает архив: шифрование — не украшение.
  assert.throws(() => verifyStorageBackup({ backupFile, secret: `${SECRET}-wrong` }))

  // 3. Восстановление в чистый каталог и подъём **нового** сервера на нём.
  restoreStorageBackup({ backupFile, targetDir: restored, secret: SECRET })

  restoredServer = await startTestServer(t, { setupToken: 'rehearsal-setup', storageDir: restored })
  const restoredUrl = restoredServer.baseUrl

  // Вход тем же аккаунтом: учётные записи тоже часть хранилища.
  const login = await request(restoredUrl, '/api/auth/login', {
    method: 'POST', body: { email: 'rehearsal@test.local', password: 'secure-owner-password' },
  })
  assert.equal(login.status, 200, login.text)
  const restoredCookie = sessionCookie(login)

  const after = await request(restoredUrl, '/api/rooms/VAULT', { cookie: restoredCookie })
  assert.equal(after.status, 200, after.text)
  assert.equal(Number(after.body.state.state_version), liveVersion, 'восстановленная кампания отстала от исходной')
  assert.equal(after.body.state.campaign, before.body.state.campaign)

  // 4. Игра продолжается: восстановленное хранилище принимает новую команду.
  const continued = await request(restoredUrl, '/api/campaigns/VAULT/commands', {
    method: 'POST', cookie: restoredCookie, key: 'rehearsal-after-restore',
    body: { idempotency_key: 'rehearsal-after-restore', command: { command_type: 'ApplyHealing', actor_id: 'hero-2', amount: 1 } },
  })
  assert.equal(continued.status, 200, continued.text)

  // 5. Целостность восстановленного хранилища — без блокеров.
  await restoredServer.stop()
  const report = await auditStorage(restoredServer)
  assert.ok(report.campaigns.some((entry) => entry.campaign_id === 'VAULT'), `аудит не увидел восстановленную кампанию: ${JSON.stringify(report)}`)
  assert.deepEqual(report.blockers, [], `восстановленное хранилище не прошло аудит: ${JSON.stringify(report.blockers)}`)
})
