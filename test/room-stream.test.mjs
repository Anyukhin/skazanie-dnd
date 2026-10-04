import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enqueueRoomSnapshot,
  queuedRoomsForCampaign,
  roomSnapshotAcceptable,
  sameCampaign,
  streamAccessRevocation,
  takeQueuedRoom,
} from '../src/room-stream.mjs'

/**
 * Аудит PR #131, REC-04 (docs/reviews/2026-10-04/round-4/24-browser-queue.md):
 * игрок ждал ответа свободного действия в A, в очередь лёг снимок A версии 7,
 * игрок выбрал B (версия 1) — и отложенный снимок A победил B большим номером.
 * В адресе B, на экране A. Здесь — та же последовательность на чистой логике
 * очереди `src/room-stream.mjs`; сам хук прогоняется в
 * test/game-session-recovery.test.mjs.
 */

const room = (campaign, version, extra = {}) => ({
  version,
  state: { sessionCode: campaign, campaign: `Кампания ${campaign}`, state_version: version, ...extra },
})

test('REC-04: после перехода A → B снимок A из очереди не применяется, а свежий снимок B — применяется', () => {
  // Пока ждём ответа в A, снимок A версии 7 откладывается.
  let queue = enqueueRoomSnapshot([], 'A', room('A', 7))
  assert.equal(queue.length, 1)
  assert.equal(queue[0].campaignId, 'A')

  // Переключение на B: очередь прежней кампании не переживает перехода.
  queue = queuedRoomsForCampaign(queue, 'B')
  assert.deepEqual(queue, [], 'очередь после переключения пуста')

  // Даже не очищенная очередь не отдаёт чужой снимок: кампания проверяется до версии.
  const stale = enqueueRoomSnapshot([], 'A', room('A', 7))
  assert.equal(takeQueuedRoom(stale, 'B', 1), null, 'версия 7 из A не сравнивается с версией 1 из B')
  assert.equal(roomSnapshotAcceptable('B', 'A', room('A', 7).state), false)

  // Следующий снимок B новее применённой версии — он и применяется.
  queue = enqueueRoomSnapshot(queue, 'B', room('B', 2))
  const latest = takeQueuedRoom(queue, 'B', 1)
  assert.equal(latest?.campaignId, 'B')
  assert.equal(latest?.version, 2)
  assert.equal(roomSnapshotAcceptable('B', latest.campaignId, latest.state), true)
})

test('REC-04: из смешанной очереди берётся самый свежий снимок текущей кампании', () => {
  let queue = []
  for (const [campaign, version] of [['A', 9], ['B', 3], ['A', 12], ['B', 5], ['B', 4]]) {
    queue = enqueueRoomSnapshot(queue, campaign, room(campaign, version))
  }
  assert.equal(takeQueuedRoom(queue, 'B', 2)?.version, 5)
  assert.equal(takeQueuedRoom(queue, 'B', 5), null, 'не новее применённой версии — не применяется')
  assert.equal(takeQueuedRoom(queue, 'A', 0)?.version, 12)
  assert.deepEqual(queuedRoomsForCampaign(queue, 'b').map((entry) => entry.version), [3, 5, 4])
})

test('REC-04: в очередь не встаёт снимок, чья кампания не совпадает с потоком-источником', () => {
  // Поток B не может принести состояние A: такой кадр отбрасывается сразу.
  assert.deepEqual(enqueueRoomSnapshot([], 'B', room('A', 3)), [])
  assert.deepEqual(enqueueRoomSnapshot([], 'B', { version: 3, state: null }), [])
  assert.deepEqual(enqueueRoomSnapshot([], 'B', room('B', -1)), [])
  assert.deepEqual(enqueueRoomSnapshot([], 'B', room('B', 1.5)), [])
  assert.deepEqual(enqueueRoomSnapshot([], '', room('', 3)), [])
  // Регистр кода комнаты не делает кампанию другой.
  assert.equal(enqueueRoomSnapshot([], 'room-b', room('ROOM-B', 3)).length, 1)
})

test('REC-04: очередь ограничена пятьюдесятью последними снимками', () => {
  let queue = []
  for (let version = 1; version <= 60; version += 1) queue = enqueueRoomSnapshot(queue, 'A', room('A', version))
  assert.equal(queue.length, 50)
  assert.equal(queue[0].version, 11)
  assert.equal(takeQueuedRoom(queue, 'A', 0)?.version, 60)
})

test('REC-04: пустой код кампании не совпадает ни с чем', () => {
  assert.equal(sameCampaign('', ''), false)
  assert.equal(sameCampaign('A', ''), false)
  assert.equal(sameCampaign(' a ', 'A'), true)
  assert.equal(roomSnapshotAcceptable('', '', { sessionCode: '' }), false)
  assert.equal(roomSnapshotAcceptable('A', 'A', {}), false, 'снимок без кода кампании не применяется')
})

test('LIVE-01/02: кадр access со status revoked распознаётся, остальные — нет', () => {
  assert.deepEqual(streamAccessRevocation('{"status":"revoked","reason":"session_ended"}'), { reason: 'session_ended' })
  assert.deepEqual(streamAccessRevocation({ status: 'revoked', reason: 'access_lost' }), { reason: 'access_lost' })
  // Неизвестная или подозрительная причина не прорастает в интерфейс как есть.
  assert.deepEqual(streamAccessRevocation('{"status":"revoked","reason":"<b>x</b>"}'), { reason: 'access_lost' })
  assert.deepEqual(streamAccessRevocation('{"status":"revoked"}'), { reason: 'access_lost' })
  for (const frame of ['{"status":"granted"}', '{}', '[]', 'null', 'не json', '', `{"status":"revoked","pad":"${'x'.repeat(5_000)}"}`]) {
    assert.equal(streamAccessRevocation(frame), null, frame.slice(0, 40))
  }
})
