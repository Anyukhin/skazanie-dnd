import assert from 'node:assert/strict'
import test from 'node:test'

import { corruptCampaign, readJournal } from './kit/journal.mjs'
import { createClient, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Стык двух правок аудита PR #131. RCV-01/02: потерянный хвост журнала или
 * seed-снимок кампании дают явный отказ `CAMPAIGN_RECOVERY_REQUIRED` вместо
 * тихой загрузки старого состояния. MAP-BOUNDARY-03: необработанная ошибка
 * маршрута завершает только свой запрос. Без второй правки первая превращала
 * одну повреждённую кампанию в падение сервера для всех: первый же
 * `GET /api/rooms/:id` ронял процесс с кодом 1.
 */

test('повреждённая кампания отвечает отказом, а сервер обслуживает остальные (аудит PR #131, RCV-01/02 + MAP-BOUNDARY-03)', { timeout: runnerTimeout(120_000) }, async (t) => {
  const server = await startTestServer(t, { setupToken: 'recovery-setup', storagePrefix: 'skazanie-recovery-api-' })
  const logs = server.output

  const owner = createClient(server)
  const registered = await owner.post('/api/auth/register', { name: 'Owner', email: 'recovery-owner@test.local', password: 'secure-owner-password' })
  assert.equal(registered.status, 201, registered.text)
  for (const [code, name] of [['RECOVA', 'Повреждённая'], ['RECOVB', 'Целая']]) {
    const created = await owner.post('/api/campaigns', {
      code, name, bootstrap: { partyName: 'Один', players: [{ id: 'hero-1' }] },
    })
    assert.equal(created.status, 201, created.text)
  }
  assert.equal((await owner.get('/api/rooms/RECOVA')).status, 200)

  // Файл теряется, пока сервер выключен: так выглядит восстановление из
  // неполной копии или сбой диска, а не действие игрока. Повреждение, которое
  // журнал больше не прощает молча: последний коммит, если коммиты есть, иначе
  // единственный seed-снимок v0.
  await server.stop()
  const journal = await readJournal(server, 'RECOVA')
  assert.equal(journal.campaign_id, 'RECOVA', 'нет журнала кампании RECOVA')
  // Нет ни коммитов, ни снимков — corruptCampaign откажет: повреждать нечего.
  const reason = await corruptCampaign(server, 'RECOVA', journal.commits.length ? 'tail' : 'seed')
  assert.ok(['EVENT_LOG_TAIL_MISSING', 'SEED_SNAPSHOT_MISSING'].includes(reason), `повреждение не нанесено: ${reason}`)
  await server.start()

  const damaged = await owner.get('/api/rooms/RECOVA')
  assert.ok(damaged.status >= 500, `повреждённая кампания не должна открываться молча (${reason}): ${damaged.status} ${damaged.text}`)
  assert.equal(server.running(), true, `сервер упал на повреждённой кампании\n${logs()}`)
  assert.match(logs(), /CAMPAIGN_RECOVERY_REQUIRED|Необработанная ошибка/u, 'отказ виден в журнале сервера')

  // Сервер жив и обслуживает остальных.
  assert.equal((await createClient(server).get('/api/health')).status, 200)
  const healthy = await owner.get('/api/rooms/RECOVB')
  assert.equal(healthy.status, 200, healthy.text)
  // Повтор запроса к повреждённой кампании отказывает так же и процесс не роняет.
  assert.ok((await owner.get('/api/rooms/RECOVA')).status >= 500)
  assert.equal(server.running(), true, `сервер упал на повторном запросе\n${logs()}`)
})
