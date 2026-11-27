import assert from 'node:assert/strict'
import { buildCombatLabState, serverBatch, serverCall } from '../test/kit/fixtures.mjs'

export const projectedFigure = (state, record, kind) => {
  const appearance = state.actor_appearances[record.id]
  assert.ok(appearance, `${record.name}: отсутствует публичная внешность`)
  return {
    actor: {
      id: record.id, kind, label: record.name, appearance,
      color: kind === 'enemy' ? '#c86c5d' : '#9d8f72',
      archetype: kind === 'enemy' ? record.creature_type : record.role,
    },
    side: record.footprint?.size ?? 1,
  }
}

export const projectFigureState = state => serverCall('campaignStateForViewer', state, { role: 'player' }, state.players[0].id)
export const figureAuditParty = [{ source: 'class', classId: 'fighter', level: 7, x: 1, y: 1 }]

/** Боевые записи тем Асстохана через штатную подготовку и проекцию Rust. */
export async function astohanEncounterFigures(scenario) {
  const themes = scenario.locations.map(location => location.encounter?.theme).filter(Boolean)
  themes.push(scenario.attention.finale.ready_ambush.theme)
  const uniqueThemes = [...new Set(themes)]
  assert.equal(uniqueThemes.length, 4, 'аудит включает все четыре темы Асстохана')
  const pools = await serverBatch(uniqueThemes.map(theme => ['classicEncounterMonsterIds', theme]))
  const counts = Object.fromEntries(uniqueThemes.map((theme, index) => [theme, pools[index].length]))
  const records = [...new Set(pools.flat())]
  assert.ok(records.every(id => typeof id === 'string' && id))
  assert.equal(records.length, 53, 'размер объединения изменился, проверьте состав тем')
  const rows = []
  const checks = []
  for (let index = 0; index < records.length; index += 3) {
    const batch = records.slice(index, index + 3)
    const state = await buildCombatLabState({
      mapId: 'forest-clearing', party: figureAuditParty,
      enemies: batch.map((monsterId, place) => ({ monsterId, x: place * 3, y: 6 })),
    })
    const visible = await projectFigureState(state)
    assert.equal(visible.enemies.length, batch.length)
    for (const enemy of visible.enemies) {
      const original = state.enemies.find(record => record.id === enemy.id)
      const row = { ...projectedFigure(visible, enemy, 'enemy'), size: original.size, statBlockId: original.stat_block_id }
      const expectedSide = { large: 2, huge: 3, gargantuan: 4 }[row.size] ?? 1
      if (row.side !== expectedSide) checks.push(`${enemy.name}: площадь ${row.side}, ожидалась ${expectedSide}`)
      if (['tiny', 'small'].includes(row.size) && row.actor.appearance.stature !== row.size) {
        checks.push(`${enemy.name}: в публичной внешности нет роста ${row.size}`)
      }
      rows.push(row)
    }
  }
  assert.deepEqual(new Set(rows.map(row => row.statBlockId)), new Set(records))
  return { rows, checks, counts }
}
