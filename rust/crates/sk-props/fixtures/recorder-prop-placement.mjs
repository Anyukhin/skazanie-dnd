// Обёртка `server/prop-placement.mjs` для записи вызовов (см. `recorder.mjs`).
import * as real from '../../../../server/prop-placement.mjs?real'
import { wrap } from './recorder.mjs'

export const PROP_PLACEMENT_VERSION = real.PROP_PLACEMENT_VERSION
export const INDOOR_THEMES = real.INDOOR_THEMES
export const ensurePropAccess = wrap('ensurePropAccess', real.ensurePropAccess)
export const placeProps = wrap('placeProps', real.placeProps)
export const placeRequiredProps = wrap('placeRequiredProps', real.placeRequiredProps)
export const placeColonnade = wrap('placeColonnade', real.placeColonnade)
export const attachPropSupports = wrap('attachPropSupports', real.attachPropSupports)
