// Записывающая обёртка `server/party-tactics.mjs` (см. `hooks.mjs`).
import * as original from '../../../../../server/party-tactics.mjs?orig'
import { clone, outcome, record } from './common.mjs'

export const HEAL_THRESHOLD_RATIO = original.HEAL_THRESHOLD_RATIO
export const UNCANNY_DODGE_DAMAGE_PERCENT = original.UNCANNY_DODGE_DAMAGE_PERCENT
export const AUTONOMOUS_REACTION_PRIORITY = original.AUTONOMOUS_REACTION_PRIORITY

function wrap(name) {
  return (...args) => {
    const copy = clone(args)
    record({ f: name, a: copy, o: outcome(() => original[name](...clone(copy))) })
    return original[name](...args)
  }
}

export const healingTargetFor = wrap('healingTargetFor')
export const planHeroTurn = wrap('planHeroTurn')
export const planHeroReaction = wrap('planHeroReaction')
export const planHeroCombatCommand = wrap('planHeroCombatCommand')
