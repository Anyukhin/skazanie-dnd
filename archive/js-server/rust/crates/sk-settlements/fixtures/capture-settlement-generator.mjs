// Обёртка `server/settlement-generator.mjs` для `capture.mjs`: те же
// экспорты, а `buildSettlementScene` записывает вход и хеш построенной карты.
import * as real from '../../../../server/settlement-generator.mjs?real'
import { serializeTacticalMap } from '../../../../server/tactical-map.mjs'
import { hash, plain } from './common.mjs'

export const { SETTLEMENT_GENERATOR, LARGE_HOUSE_FLOOR, MARKET_STALLS_MAX } = real

/** @param {any} [options] */
export function buildSettlementScene(options = {}) {
  const input = plain(options)
  const result = real.buildSettlementScene(options)
  globalThis.__skSettlementsCaptured?.settlement.push({ options: input, mapHash: hash(serializeTacticalMap(result.map)), uses: plain(result.uses) })
  return result
}
