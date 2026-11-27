// Записывающая обёртка `server/adjudicator.mjs` (см. `hooks.mjs`).
import * as original from '../../../../../server/adjudicator.mjs?orig'
import { clone, outcome, record } from './common.mjs'

export const DIFFICULTY_CLASSES = original.DIFFICULTY_CLASSES
export const DIFFICULTY_CATEGORIES = original.DIFFICULTY_CATEGORIES

export function difficultyCategoryFor(...args) {
  const copy = clone(args)
  record({ f: 'difficultyCategoryFor', a: copy, o: outcome(() => original.difficultyCategoryFor(...clone(copy))) })
  return original.difficultyCategoryFor(...args)
}

export const difficultyClassFor = original.difficultyClassFor

export class Adjudicator extends original.Adjudicator {
  async createPlan(input) {
    const copy = clone(input)
    record({ f: 'createPlan', a: [copy], o: await outcome(() => super.createPlan(clone(copy))) })
    return super.createPlan(input)
  }
}
