// Сбой вокруг commit журнала для проверки резерва броска (аудит PR #131, SEC-04).
//
// DND_COMMIT_FAULTS — список `ключ:режим` через запятую; каждый ключ срабатывает
// один раз за жизнь процесса:
//   throw        — commit отклонён до записи журнала;
//   exit-before  — процесс останавливается до записи журнала;
//   exit-after   — журнал записан, процесс останавливается до ответа.
import { FileEventStore } from '../../server/event-store.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
if (process.env.NODE_ENV !== 'test' || dirname(storageDir) !== resolve(tmpdir())
  || !basename(storageDir).startsWith('skazanie-roll-reservation-')) {
  throw new Error('Сбой commit разрешён только в изолированном тестовом хранилище')
}

const faults = new Map(String(process.env.DND_COMMIT_FAULTS ?? '')
  .split(',')
  .map((entry) => entry.trim().split(':'))
  .filter(([key, mode]) => key && ['throw', 'exit-before', 'exit-after'].includes(mode)))

const original = FileEventStore.prototype.commit

FileEventStore.prototype.commit = async function (input = {}) {
  const key = String(input.idempotency_key ?? input.idempotencyKey ?? '')
  const mode = faults.get(key)
  if (!mode) return original.call(this, input)
  faults.delete(key)
  if (mode === 'exit-before') process.exit(70)
  if (mode === 'exit-after') {
    await original.call(this, input)
    process.exit(71)
  }
  throw new Error('synthetic commit failure before journal write')
}
