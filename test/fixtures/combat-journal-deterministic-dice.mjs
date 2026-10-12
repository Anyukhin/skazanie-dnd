import { DiceService } from '../../server/dice-service.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

// Кости для `test/combat-journal-order-api.test.mjs`: огр попадает и бьёт
// максимумом, чтобы атака по возможности наверняка валила героя. Остальные
// броски — настоящие. Работает только в тестовом окружении и только в своём
// временном хранилище.
const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
const isolatedStorage = dirname(storageDir) === resolve(tmpdir())
  && /^skazanie-combat-journal-order-[^/\\]+$/u.test(basename(storageDir))
if (process.env.NODE_ENV !== 'test' || !isolatedStorage) {
  throw new Error('combat-journal preload requires NODE_ENV=test and its own mkdtemp storage')
}

const originalRoll = DiceService.prototype.roll
const originalRollD20 = DiceService.prototype.rollD20
const controlled = (actorId) => String(actorId ?? '') === 'ogre'

function withMaximumRng(service, callback) {
  const originalRng = service.rng
  service.rng = { randint: (minimum, maximum) => (minimum === 1 && maximum === 20 ? 18 : maximum) }
  try {
    return callback()
  } finally {
    service.rng = originalRng
  }
}

DiceService.prototype.roll = function combatJournalRoll(expression, purpose, actorId, visibility) {
  if (!controlled(actorId)) return originalRoll.call(this, expression, purpose, actorId, visibility)
  return withMaximumRng(this, () => originalRoll.call(this, expression, purpose, actorId, visibility))
}

DiceService.prototype.rollD20 = function combatJournalRollD20(options = {}) {
  if (!controlled(options?.actorId)) return originalRollD20.call(this, options)
  return withMaximumRng(this, () => originalRollD20.call(this, options))
}
