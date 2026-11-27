import { DiceService } from '../../server/dice-service.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

const storageDir = resolve(String(process.env.DND_STORAGE_DIR ?? ''))
const tempDir = resolve(tmpdir())
const isolatedMvpStorage = dirname(storageDir) === tempDir
  && /^skazanie-mvp-player-cycle-[^/\\]+$/u.test(basename(storageDir))
if (process.env.NODE_ENV !== 'test' || !isolatedMvpStorage) {
  throw new Error('MVP preload controls only positive fixture rolls; requires NODE_ENV=test and a direct mkdtemp child of os.tmpdir()')
}

const originalRoll = DiceService.prototype.roll
const originalRollD20 = DiceService.prototype.rollD20

function isMvpCombatActor(actorId) {
  const id = String(actorId ?? '')
  return /^mvp-hero-[1-4]$/u.test(id) || /^encounter-[0-9a-f]+-/u.test(id)
}

function isHero(actorId) {
  return /^mvp-hero-[1-4]$/u.test(String(actorId ?? ''))
}

function controlledD20(actorId, purpose) {
  const text = String(purpose ?? '')
  if (text === 'initiative') return isHero(actorId) ? 18 : 8
  if (text === 'attack' || text.startsWith('monster_action_attack:')) return isHero(actorId) ? 18 : 2
  if (text === 'death_saving_throw') return 20
  if (text.includes('saving_throw') || text.includes('save')) return isHero(actorId) ? 18 : 2
  return isHero(actorId) ? 18 : 2
}

function controlledDie(actorId, purpose, minimum, maximum) {
  if (minimum === 1 && maximum === 20) return Math.min(maximum, Math.max(minimum, controlledD20(actorId, purpose)))
  return isHero(actorId) ? maximum : minimum
}

function withControlledRng(service, actorId, purpose, callback) {
  const originalRng = service.rng
  service.rng = { randint: (minimum, maximum) => controlledDie(actorId, purpose, minimum, maximum) }
  try {
    return callback()
  } finally {
    service.rng = originalRng
  }
}

DiceService.prototype.roll = function mvpDeterministicRoll(expression, purpose, actorId, visibility) {
  if (!isMvpCombatActor(actorId)) return originalRoll.call(this, expression, purpose, actorId, visibility)
  return withControlledRng(this, actorId, purpose, () => originalRoll.call(this, expression, purpose, actorId, visibility))
}

DiceService.prototype.rollD20 = function mvpDeterministicRollD20(options = {}) {
  const actorId = options?.actorId
  if (!isMvpCombatActor(actorId)) return originalRollD20.call(this, options)
  return withControlledRng(this, actorId, options?.purpose, () => originalRollD20.call(this, options))
}
