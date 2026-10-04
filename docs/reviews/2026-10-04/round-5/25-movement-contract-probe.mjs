// Детерминированный probe контракта предпросмотра движения. Он компилирует
// production-модули src/tactical-ui.ts и src/move-preview.ts во временный
// каталог, а затем сравнивает их с тем же Rules Engine, который исполняет
// MoveActor. Рабочие storage/.env не читаются и не меняются.

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { DiceService } from '../../../../server/dice-service.mjs'
import { movementCostOfPath, normalizeCampaignState, resolveCommand } from '../../../../server/rules-engine.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'skazanie-movement-contract-'))
// Зарегистрировать уборку сразу: ошибка tsc/import до создания модулей тоже
// не должна оставлять временный каталог.
process.on('exit', () => rmSync(BUILD_ROOT, { recursive: true, force: true }))
const BUILD_DIR = join(BUILD_ROOT, 'build')
const SERVER_DIR = join(BUILD_ROOT, 'server')
mkdirSync(BUILD_DIR, { recursive: true })
mkdirSync(SERVER_DIR, { recursive: true })
copyFileSync(join(REPO_ROOT, 'server', 'actor-footprint.mjs'), join(SERVER_DIR, 'actor-footprint.mjs'))
copyFileSync(join(REPO_ROOT, 'server', 'circular-area-geometry.mjs'), join(SERVER_DIR, 'circular-area-geometry.mjs'))
const compiler = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const sources = ['tactical-ui.ts', 'tactical-map-client.ts', 'area-geometry.ts', 'move-preview.ts']
const compiled = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--outDir', BUILD_DIR,
  ...sources.map((file) => join(REPO_ROOT, 'src', file))], { encoding: 'utf8' })
assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
for (const file of ['tactical-map-client', 'area-geometry']) renameSync(join(BUILD_DIR, `${file}.js`), join(BUILD_DIR, file))
for (const file of ['tactical-ui', 'move-preview']) renameSync(join(BUILD_DIR, `${file}.js`), join(BUILD_DIR, `${file}.mjs`))
const tacticalUi = await import(pathToFileURL(join(BUILD_DIR, 'tactical-ui.mjs')).href)
const movePreview = await import(pathToFileURL(join(BUILD_DIR, 'move-preview.mjs')).href)

const economy = () => ({ action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 })
const cellsFor = (width = 8, height = 4) => Array.from({ length: width * height }, (_, index) => ({
  x: index % width, y: Math.floor(index / width), type: 'floor', revealed: true,
}))
const actor = (id, x, y) => ({
  id, name: id, hp: 30, maxHp: 30, armor: 10, speed: 30,
  abilities: { str: 12, dex: 12, con: 12, int: 8, wis: 8, cha: 8 },
  action_profiles: [{ id: 'bite', name: 'Укус', kind: 'melee', attack_modifier: 3, damage_expression: '1d4', damage_type: 'piercing', range_feet: 5 }],
  attack_profile: { kind: 'melee', range_feet: 5 },
  x, y, alive: true,
})

function stateFor({ enemies = [], effects = [], hero = { x: 1, y: 0 }, width = 8, height = 4 } = {}) {
  const ids = ['hero', ...enemies.map((entry) => entry.id)]
  return normalizeCampaignState({
    sessionCode: 'MOVEMENT-CONTRACT-PROBE', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [{ id: 'hero', character: 'Герой', characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 15,
      speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], ...hero }],
    enemies, partyMemberIds: ['hero'], activePlayerId: 'hero',
    scene: { turn: 1, cells: cellsFor(width, height) },
    mechanics: {
      active_effects: effects,
      combat: { active: true, round: 1, active_index: 0,
        initiative: ids.map((actorId, index) => ({ actor_id: actorId, total: 20 - index })),
        action_economy: Object.fromEntries(ids.map((actorId) => [actorId, economy()])),
      },
    },
  })
}

function deterministicDice() {
  return new DiceService({ rng: { randint: (_minimum, maximum) => maximum }, idFactory: () => 'movement-contract-roll', now: () => '2026-10-04T00:00:00.000Z' })
}

function serverMove(state, to) {
  return resolveCommand({ command_type: 'MoveActor', command_id: `movement-contract:${to.x}:${to.y}`, actor_id: 'hero', to, server_authoritative: true }, state, {
    diceService: deterministicDice(), context: { serverAuthoritativeCombat: true, allowedActorIds: ['hero'] },
  })
}

function productionThreats(state, active) {
  return state.enemies.filter((enemy) => {
    const conditions = new Set((state.mechanics?.conditions?.[enemy.id] ?? []).map((condition) => String(condition.id)))
    const reactionAvailable = state.mechanics.combat?.action_economy?.[enemy.id]?.reaction !== false
    const range = Number(enemy.attack_profile?.range_feet ?? enemy.attackRange ?? 5) || 5
    return reactionAvailable && range <= 5
      && !['incapacitated', 'unconscious', 'stunned', 'paralyzed'].some((condition) => conditions.has(condition))
      && tacticalUi.actorDistanceFeet(active, enemy) === 5
  })
}

function previewFor(state, destination) {
  const active = state.players[0]
  const route = tacticalUi.buildMovementPaths(state, active, 5).get(`${destination.x},${destination.y}`)
  assert.ok(route, `Клиент не построил маршрут до ${destination.x},${destination.y}`)
  const threats = productionThreats(state, active)
  const threatened = (point) => threats.some((threat) => tacticalUi.actorDistanceFeet(threat, point) <= 5)
  return { route, threats: threats.map((threat) => threat.id), risk: movePreview.moveRiskPoint({ start: active, path: route.path }, threatened) }
}

function opportunityActors(result) {
  return result.events.filter((event) => event.event_type === 'CombatActionUsed' && event.payload?.action_id === 'opportunity-attack').map((event) => event.actor_id)
}

// Positive control: из одной зоны досягаемости выход виден и preview, и движку.
const oneThreatState = stateFor({ enemies: [actor('threat-a', 0, 0)] })
const oneThreatPreview = previewFor(oneThreatState, { x: 1, y: 2 })
const oneThreatResult = serverMove(oneThreatState, { x: 1, y: 2 })
assert.deepEqual(oneThreatPreview.risk, { x: 1, y: 1.5 })
assert.deepEqual(opportunityActors(oneThreatResult), ['threat-a'])

// Дефект нового risk marker: переход A -> B остаётся внутри объединённой зоны,
// но Rules Engine всё равно видит выход именно из зоны A и оплачивает её OA.
const splitThreatState = stateFor({ enemies: [actor('threat-a', 0, 0), actor('threat-b', 2, 1)] })
const splitThreatPreview = previewFor(splitThreatState, { x: 1, y: 2 })
const splitThreatResult = serverMove(splitThreatState, { x: 1, y: 2 })
assert.equal(splitThreatPreview.risk, null)
assert.deepEqual(opportunityActors(splitThreatResult), ['threat-a'])

// Положительный контроль для отсутствия выхода: шаг остаётся в зоне A.
const noExitState = stateFor({ enemies: [actor('threat-a', 0, 0)] })
const noExitPreview = previewFor(noExitState, { x: 1, y: 1 })
const noExitResult = serverMove(noExitState, { x: 1, y: 1 })
assert.equal(noExitPreview.risk, null)
assert.deepEqual(opportunityActors(noExitResult), [])

// Ещё один parity gap старого pathfinder: маршрут строится для испуганного
// героя, хотя authoritative MoveActor отклоняет добровольное приближение к
// источнику страха.
const frightenedState = stateFor({ enemies: [actor('fear-source', 3, 0)], hero: { x: 1, y: 0 }, width: 5, height: 3 })
frightenedState.mechanics.conditions.hero = [{ id: 'frightened', source_actor: 'fear-source' }]
const frightenedPreview = previewFor(frightenedState, { x: 2, y: 0 })
assert.deepEqual(frightenedPreview.route.path, [{ x: 2, y: 0 }])
assert.throws(() => serverMove(frightenedState, { x: 2, y: 0 }), (error) => error.code === 'FRIGHTENED_CLOSER')

const terrain = (movementCostMultiplier) => ({
  id: `heavy-terrain-${movementCostMultiplier}`, spell_id: 'wall-of-sand', difficult_terrain: true,
  movement_cost_multiplier: movementCostMultiplier, cells: [{ x: 1, y: 0 }],
})
const ordinaryState = stateFor({ enemies: [], effects: [terrain(2)], hero: { x: 0, y: 0 }, width: 5, height: 1 })
const heavyState = stateFor({ enemies: [], effects: [terrain(3)], hero: { x: 0, y: 0 }, width: 5, height: 1 })
const ordinaryPreview = previewFor(ordinaryState, { x: 3, y: 0 })
const heavyPreview = previewFor(heavyState, { x: 3, y: 0 })
const ordinaryServerCost = movementCostOfPath(ordinaryState, 'hero', ordinaryPreview.route.path)
const heavyServerCost = movementCostOfPath(heavyState, 'hero', heavyPreview.route.path)
assert.equal(ordinaryServerCost, ordinaryPreview.route.costFeet)
assert.equal(ordinaryPreview.route.costFeet, 20)
assert.equal(heavyServerCost, 25)
assert.equal(heavyPreview.route.costFeet, 20)

console.log(JSON.stringify({
  ok: true,
  source_commit: '88c620e6011ae607913efb224cb8f850b4ee5028',
  risk_union: { single_threat: oneThreatPreview, split_threat: splitThreatPreview, server_opportunity_actors: opportunityActors(splitThreatResult), no_exit: noExitPreview },
  directional_restriction: { route: frightenedPreview.route, server_error: 'FRIGHTENED_CLOSER' },
  terrain_multiplier: { ordinary: { client_cost: ordinaryPreview.route.costFeet, server_cost: ordinaryServerCost }, heavy: { client_cost: heavyPreview.route.costFeet, server_cost: heavyServerCost } },
}, null, 2))
