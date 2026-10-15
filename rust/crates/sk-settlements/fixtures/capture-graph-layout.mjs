// Обёртка `server/graph-layout.mjs` для `capture.mjs`: те же экспорты, а
// `buildSceneFromGraph` записывает вход и хеш построенной карты.
import * as real from '../../../../server/graph-layout.mjs?real'
import { serializeTacticalMap } from '../../../../server/tactical-map.mjs'
import { hash, plain } from './common.mjs'

export const { GRAPH_LAYOUT, splitArea, sharedWall, assignZonesToLeaves, planChambers, layoutSceneGraph } = real

/** @param {any} graph @param {any} [options] */
export function buildSceneFromGraph(graph, options = {}) {
  const input = { graph: plain(graph), options: plain(options) }
  const result = real.buildSceneFromGraph(graph, options)
  globalThis.__skSettlementsCaptured?.graphLayout.push({ ...input, mapHash: hash(serializeTacticalMap(result.map)) })
  return result
}
