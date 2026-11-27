// Обёртка `server/scene-dressing.mjs` для записи вызовов (см. `recorder.mjs`).
import * as real from '../../../../server/scene-dressing.mjs?real'
import { calls, encodeArgs, wrap } from './recorder.mjs'

export const VIGNETTES = real.VIGNETTES
export const placeVignettes = wrap('placeVignettes', real.placeVignettes)
export const roughenGround = wrap('roughenGround', real.roughenGround)
export const markLowFurniture = wrap('markLowFurniture', real.markLowFurniture)
export const placeRuins = wrap('placeRuins', real.placeRuins)
export const placeRuinsField = wrap('placeRuinsField', real.placeRuinsField)

/** Карты у этой функции нет — пишется только текст и ответ. */
export function vignettesNamedBy(set, text) {
  const result = real.vignettesNamedBy(set, text)
  calls.push({ fn: 'vignettesNamedBy', before: null, args: encodeArgs([set, text]), after: null, result })
  return result
}
