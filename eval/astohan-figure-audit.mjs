// После сборки skazanie-server с test-hooks:
// node eval/astohan-figure-audit.mjs
// Артефакты сохраняются в tmp/astohan-figure-audit.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'vite'
import { withBrowser } from '../.agent-tasks/browser.mjs'
import { freePort } from '../test/free-port.mjs'
import { buildCombatLabState, createCampaignState, normalizeCampaignState, serverCall } from '../test/kit/fixtures.mjs'
import { astohanEncounterFigures, figureAuditParty, projectedFigure, projectFigureState } from './astohan-figure-roster.mjs'

const output = 'tmp/astohan-figure-audit'

async function storyFigures(scenario) {
  const id = 'astohan-stormberg'
  const hero = { id: 'audit-hero', character: 'Лира', level: 7, hp: 48, maxHp: 48, inventory: [] }
  const initial = await createCampaignState({ code: 'FIGURE-AUDIT', worldTemplateId: 'astohan-plains', players: [hero] })
  const sceneNpcs = scenario.locations.flatMap(location => location.npcs ?? [])
  const stranger = scenario.attention.stranger
  const named = [...initial.social.npcs, ...sceneNpcs, { id: stranger.npc_id, name: stranger.name, role: stranger.role }]
  const tiles = await serverCall('buildMap', { options: { locationId: id, width: 32, height: 16, seed: 'figure-audit',
    fill: { passable: true, revealed: true, material: 'stone', surface: 'none' } } })
  const social = named.map(record => ({
    ...record, location: initial.scene.location, location_id: id, visibility: 'party', available: true, schedule: [],
  }))
  const placements = named.map((record, index) => {
    const size = record.id === 'astohan-eldrin' ? 3 : record.id === 'astohan-sargat' ? 2 : 1
    return { npc_id: record.id, location_id: id, x: 2 + index % 7 * 4, y: 3 + Math.floor(index / 7) * 5,
      ...(size > 1 ? { footprint: { version: 1, size } } : {}) }
  })
  // Отдельная витрина для сравнения фигур в одном масштабе. У игры остаётся
  // свой порядок появления героев, ночное окно и раскрытие Незнакомца.
  const state = await normalizeCampaignState({
    ...initial, players: [{ ...initial.players[0], x: 0, y: 0 }],
    scene: { ...initial.scene, ...tiles }, social: { ...initial.social, npcs: social },
    mechanics: { ...initial.mechanics, positions: { [hero.id]: { x: 0, y: 0 } } },
    npc_world: { ...initial.npc_world, placements },
  })
  const visible = await projectFigureState(state)
  assert.deepEqual(new Set(visible.scene_npcs.map(entry => entry.id)), new Set(named.map(entry => entry.id)))
  return visible.scene_npcs.map(record => projectedFigure(visible, record, 'neutral'))
}

async function maskedFigures(checks) {
  const dragon = await buildCombatLabState({
    mapId: 'forest-clearing', party: figureAuditParty,
    enemies: [{ monsterId: 'dnd_5e_2014:monster:young-red-dragon', x: 3, y: 6 }],
  })
  const masked = structuredClone(dragon)
  masked.enemies[0].masked = true
  const [hidden, revealed] = await Promise.all([projectFigureState(masked), projectFigureState(dragon)])
  const hiddenEnemy = hidden.enemies[0]
  const revealedEnemy = revealed.enemies[0]
  if (hiddenEnemy.creature_type || hiddenEnemy.image || hiddenEnemy.footprint
    || hidden.actor_appearances[hiddenEnemy.id].stature) checks.push('Проекция раскрыла вид замаскированного врага')
  if (revealedEnemy.creature_type !== 'dragon' || !revealedEnemy.image || revealedEnemy.footprint?.size !== 2) {
    checks.push('Проекция открытого дракона потеряла его портрет или площадь')
  }
  return [projectedFigure(hidden, hiddenEnemy, 'enemy'), projectedFigure(revealed, revealedEnemy, 'enemy')]
}

function silhouetteFailures(captures) {
  const silhouettes = new Map()
  for (const entry of captures) {
    const key = entry.hashes.map(view => view.hash).join('/')
    const group = silhouettes.get(key) ?? []
    group.push(entry)
    silhouettes.set(key, group)
  }
  const collisions = [...silhouettes.values()].filter(group => group.length > 1)
  return [
    ...captures.filter(entry => entry.source !== entry.expectedSource).map(entry => `${entry.name}: ассет заменился запасной фигуркой`),
    ...captures.filter(entry => entry.hashes.some(view => view.pixels < 10)).map(entry => `${entry.name}: пустой силуэт`),
    ...collisions.map(group => `Одинаковый силуэт в двух ракурсах: ${group.map(entry => entry.name).join(', ')}`),
  ]
}

const scenario = await serverCall('scenarioForWorldTemplate', 'astohan-plains')
const { rows: enemies, checks, counts } = await astohanEncounterFigures(scenario)
const named = await storyFigures(scenario)
const masked = await maskedFigures(checks)
await mkdir(output, { recursive: true })
const port = await freePort()
const vite = await createServer({
  server: { port, host: '127.0.0.1', strictPort: true, watch: null },
  plugins: [{
    name: 'astohan-figure-audit',
    configureServer(server) {
      server.middlewares.use('/__astohan-figure-audit', (_, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><html lang="ru"><meta charset="utf-8"><body></body></html>')
      })
    },
  }],
})
try {
  await vite.listen()
  await withBrowser({ gpu: true, pageCount: 1, timeoutMs: 120_000, windowSize: { width: 1400, height: 1200 } }, async browser => {
    const page = browser.page(0)
    await page.command('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false })
    for (const [section, figures] of [['enemies', enemies], ['named', named], ['masked', masked]]) {
      await page.navigate(`http://127.0.0.1:${port}/__astohan-figure-audit`)
      for (const mode of ['color', 'scale', 'silhouette']) {
        const result = await page.evaluate(async (rows, atlasMode) => {
          const { drawAstohanFigureAtlas } = await import('/eval/astohan-figure-stage.ts')
          return drawAstohanFigureAtlas(rows, atlasMode)
        }, figures, mode)
        if (mode === 'color') {
          assert.equal(result.captures.length, figures.length)
          checks.push(...silhouetteFailures(result.captures))
          if (section === 'enemies') {
            result.themes = counts
            result.captures.forEach((capture, index) => { capture.statBlockId = figures[index].statBlockId })
          }
          if (section === 'named') {
            const hidden = result.captures.find(entry => entry.id === scenario.attention.stranger.npc_id)
            if (hidden?.key !== 'astohan-ash-traveler' || hidden.side !== 1) checks.push('Незнакомец выдал свой облик')
          }
          if (section === 'masked') {
            const [covered, open] = result.captures
            if (covered.key === 'dragon' || covered.side !== 1 || open.key !== 'dragon') {
              checks.push('Фигурка видна в раскрытом виде с надетой маской или потеряна после раскрытия')
            }
          }
          await writeFile(join(output, `${section}.json`), JSON.stringify(result, null, 2) + '\n')
          console.log(section, result.captures.length, result.adapter ?? 'WebGL 2')
        }
        await page.screenshot(join(output, `${section}-${mode}.png`))
      }
    }
  })
} finally {
  await vite.close()
}
assert.deepEqual(checks, [])
