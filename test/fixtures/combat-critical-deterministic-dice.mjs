import { DiceService } from '../../server/dice-service.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

// Кости для `test/combat-critical-turn-api.test.mjs`: у огра на d20 всегда
// натуральная 20 — критический удар по герою. Урон и остальные броски —
// настоящие. Работает только в тестовом окружении и только в своём временном
// хранилище.
const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
const isolatedStorage = dirname(storageDir) === resolve(tmpdir())
  && /^skazanie-combat-critical-turn-[^/\\]+$/u.test(basename(storageDir))
if (process.env.NODE_ENV !== 'test' || !isolatedStorage) {
  throw new Error('combat-critical preload requires NODE_ENV=test and its own mkdtemp storage')
}

const originalRollD20 = DiceService.prototype.rollD20

DiceService.prototype.rollD20 = function combatCriticalRollD20(options = {}) {
  if (String(options?.actorId ?? '') !== 'ogre') return originalRollD20.call(this, options)
  const originalRng = this.rng
  this.rng = { randint: (minimum, maximum) => (minimum === 1 && maximum === 20 ? 20 : originalRng.randint(minimum, maximum)) }
  try {
    return originalRollD20.call(this, options)
  } finally {
    this.rng = originalRng
  }
}
