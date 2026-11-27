// Входы контрактных тестов тем же кодом, что работает в игре.
//
// Контрактный HTTP-тест готовит кампанию сам: карту с дверью и сундуком,
// предмет из каталога, бой стенда, сцену Асстохана после перехода. Раньше он
// строил это JS-библиотекой `server/`, то есть входы готовил не тот код, что
// их потом исполнял. Теперь каждая функция ниже — вызов подкоманды бинаря
// Rust (`skazanie-server fixture`, только с фичей `test-hooks`,
// `rust/crates/sk-server/src/test_hooks/fixture_cli.rs`): тест получает ровно
// ту форму, которую сервер сам построил бы и принял. Имена и аргументы — как
// у прежних функций JS, только результат — промис.
//
// Функции чистые: хранилища, сети и модели нет. Отказ правила приходит
// исключением с полем `code`, как `RulesValidationError`.
import { tmpdir } from 'node:os'

import { spawnRust } from './http.mjs'

/**
 * Вызвать функцию подкоманды: `[имя, ...аргументы]` или пакет `{ batch }`.
 *
 * @param {unknown} input
 * @returns {Promise<any>}
 */
async function fixture(input) {
  const child = spawnRust(['fixture'], { storageDir: tmpdir(), stdin: 'pipe' })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  child.stdin?.end(JSON.stringify(input))
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  if (code !== 0) {
    let failure = null
    try { failure = JSON.parse(stderr.trim()).error } catch { /* не JSON — отказ входа */ }
    const name = Array.isArray(input) ? input[0] : 'batch'
    const error = /** @type {Error & { code?: string }} */ (new Error(failure?.message ?? `skazanie-server fixture ${name}: код ${code}\n${stderr.slice(-4_000)}`))
    if (failure?.code) error.code = failure.code
    throw error
  }
  return JSON.parse(stdout)
}

/**
 * Одна функция по имени JS.
 *
 * @param {string} name
 * @param {...unknown} args
 */
export function serverCall(name, ...args) {
  return fixture([name, ...args])
}

/**
 * Несколько функций одним процессом — результаты по порядку.
 *
 * @param {Array<[string, ...unknown[]]>} calls
 * @returns {Promise<any[]>}
 */
export async function serverBatch(calls) {
  return (await fixture({ batch: calls })).results
}

/**
 * Построитель тактической карты: `createTacticalMap(options)` и шаги
 * `setDoor`/`addProp`/`setCell`/`setEdge` по порядку; `build()` отдаёт
 * `{ map, cells }` — карту в форме `serializeTacticalMap` и клетки
 * `legacyCellsFromTacticalMap`, как их кладут в `scene`.
 *
 * @param {Record<string, unknown>} options
 */
export function tacticalMap(options) {
  /** @type {unknown[]} */
  const steps = []
  const builder = {
    /** @param {Record<string, unknown>} door */
    door(door) { steps.push({ door }); return builder },
    /** @param {Record<string, unknown>} prop */
    prop(prop) { steps.push({ prop }); return builder },
    /** @param {number} x @param {number} y @param {Record<string, unknown>} patch */
    cell(x, y, patch) { steps.push({ cell: [x, y, patch] }); return builder },
    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {Record<string, unknown>} edge */
    edge(ax, ay, bx, by, edge) { steps.push({ edge: [ax, ay, bx, by, edge] }); return builder },
    /** @returns {Promise<{ map: any, cells: any[] }>} */
    build() { return serverCall('buildMap', { options, steps }) },
  }
  return builder
}

/**
 * Карта из ответа сервера: та же форма и `cellAt(x, y)` — клетка или `null`.
 *
 * @param {any} map сериализованная карта (`scene.map`)
 */
export async function readMap(map) {
  const read = await serverCall('readMap', map)
  const byKey = new Map(read.cells.map((/** @type {{ x: number, y: number }} */ cell) => [`${cell.x},${cell.y}`, cell]))
  return { ...read.map, cells: read.cells, props: read.props, cellAt: (/** @type {number} */ x, /** @type {number} */ y) => byKey.get(`${x},${y}`) ?? null }
}

/**
 * Карта из старых клеток; `steps` — шаги построителя поверх неё, как у
 * `tacticalMap().cell(...)`: `{ cell: [x, y, patch] }`, `{ door }`, `{ prop }`, `{ edge }`.
 *
 * @param {any[]} cells @param {Record<string, unknown>} [options] @param {unknown[]} [steps]
 * @returns {Promise<{ map: any, cells: any[] }>}
 */
export const tacticalMapFromLegacyCells = (cells, options = {}, steps = []) => serverCall('tacticalMapFromLegacyCells', cells, options, steps)
/**
 * Правка готовой карты (`deserializeTacticalMap` + шаги + `serializeTacticalMap`)
 * — те же шаги, что у `tacticalMapFromLegacyCells`.
 *
 * @param {any} map @param {unknown[]} steps @returns {Promise<{ map: any, cells: any[] }>}
 */
export const editMap = (map, steps) => serverCall('editMap', map, steps)
/** @param {string} id @returns {Promise<{ map: any, cells: any[] } | null>} */
export const authoredLocationMapFor = (id) => serverCall('authoredLocationMapFor', id)
/** @param {string} catalogId @param {Record<string, unknown>} [instance] */
export const materializeCatalogItem = (catalogId, instance) => serverCall('materializeCatalogItem', catalogId, instance ?? null)
/** @param {Record<string, unknown>} config */
export const buildCombatLabState = (config) => serverCall('buildCombatLabState', config)
/** @param {any} state */
export const normalizeCampaignState = (state) => serverCall('normalizeCampaignState', state)
/** @param {any} state @param {any[]} events */
export const replayEvents = (state, events) => serverCall('replayEvents', state, events)

/**
 * @typedef {object} ResolveOptions
 * @property {Record<string, unknown>} [context] контекст разбора (`isAdmin`, `isDirector`, …)
 * @property {number[]} [dice] значения костей по очереди; лишний бросок — отказ
 * @property {number} [fixed] одно значение на каждой кости, прижатое к грани
 * @property {boolean} [stopAttackAfterMovement]
 */

/** @param {any[]} commands @param {any} state @param {ResolveOptions} [options] @returns {Promise<{ commands: any[], events: any[], rolls: any[], state: any, pending: boolean }>} */
export const resolveCommands = (commands, state, options = {}) => serverCall('resolveCommands', commands, state, options)
/** @param {any} command @param {any} state @param {ResolveOptions} [options] @returns {Promise<{ command: any, events: any[], rolls: any[], state: any, pending: boolean }>} */
export const resolveCommand = (command, state, options = {}) => serverCall('resolveCommand', command, state, options)
/** @param {any} state @param {string} actorId @param {{ x: number, y: number }} target @returns {Promise<Array<{ x: number, y: number }> | null>} */
export const shortestTacticalPath = (state, actorId, target) => serverCall('shortestTacticalPath', state, actorId, target)
/** @param {any} state @param {string} actorId @param {Array<{ x: number, y: number }>} path @returns {Promise<number>} */
export const movementCostOfPath = (state, actorId, path) => serverCall('movementCostOfPath', state, actorId, path)
/**
 * Путь и его цена до каждой клетки при одном состоянии — без повтора состояния
 * комнаты на каждую клетку, как в пакете `shortestTacticalPath`.
 *
 * @param {any} state @param {string} actorId @param {Array<{ x: number, y: number }>} targets
 * @returns {Promise<Array<{ path: Array<{ x: number, y: number }> | null, cost: number | null }>>}
 */
export const tacticalRoutes = (state, actorId, targets) => serverCall('tacticalRoutes', state, actorId, targets.map(({ x, y }) => ({ x, y })))

/** Исходная ситуация кампании без модели (`CampaignBootstrapper().create`). @param {Record<string, unknown>} input */
export const createCampaignState = (input) => serverCall('createCampaign', input)
/** План новой сцены без модели (`SceneArchitectAgent().plan`). @param {{ state: any, decision?: string, destinationLocationId?: string, action?: string, destinationHint?: string, abandonsQuest?: boolean }} input */
export const planScene = (input) => serverCall('planScene', input)

/** @param {any} state */
export const campaignScenario = (state) => serverCall('campaignScenario', state)
/** @param {any} scenario @param {string} clueId @returns {Promise<string>} */
export const scenarioClueFactId = (scenario, clueId) => serverCall('scenarioClueFactId', scenario, clueId)
/** @param {any} state */
export const scenarioEnding = (state) => serverCall('scenarioEnding', state)
/** @param {any} state @returns {Promise<string>} */
export const scenarioLocationId = (state) => serverCall('scenarioLocationId', state)
/** @param {string} worldTemplateId */
export const scenarioForWorldTemplate = (worldTemplateId) => serverCall('scenarioForWorldTemplate', worldTemplateId)
/** @param {any} scenario */
export const buildScenarioArcPlan = (scenario) => serverCall('buildScenarioArcPlan', scenario)
/** @param {any} state @param {string} locationId @returns {Promise<any[]>} */
export const scenarioSecretsFor = (state, locationId) => serverCall('scenarioSecretsFor', state, locationId)
/** @param {any} scene @param {any} [knownLevels] */
export const publicSceneFor = (scene, knownLevels) => serverCall('publicSceneFor', scene, knownLevels ?? null)
/** @param {any} state @param {any} user @param {string} actorId */
export const campaignStateForViewer = (state, user, actorId) => serverCall('campaignStateForViewer', state, user, actorId)

/** @param {any} interaction @param {string | null} [actorId] @param {Record<string, unknown>} [options] */
export const partyDecisionOpenedEvent = (interaction, actorId = null, options = {}) => serverCall('partyDecisionOpenedEvent', interaction, actorId, options)
/** @param {any} state @param {Record<string, unknown>} input */
export const resolvePartyVote = (state, input) => serverCall('resolvePartyVote', state, input)
/** @param {any} state @returns {Promise<string>} */
export const projectionHash = (state) => serverCall('projectionHash', state)
/** @param {any} state */
export const canonicalProjection = (state) => serverCall('canonicalProjection', state)
/** @param {any} authoritative @param {any} projected @returns {Promise<{ matched: boolean, authoritative_hash: string, projected_hash: string }>} */
export const compareProjection = (authoritative, projected) => serverCall('compareProjection', authoritative, projected)
/** Отпечаток пакета команд, как его считает сервер. @param {any[]} commands @returns {Promise<string>} */
export const structuredCommandsFingerprint = (commands) => serverCall('structuredCommandsFingerprint', commands)
/** Отпечаток запроса `/api/narrate`, как его считает сервер. @param {Record<string, unknown>} fields @returns {Promise<string>} */
export const narrationRequestFingerprint = (fields) => serverCall('narrationRequestFingerprint', fields)
/** @param {any} state @param {number} minutes @returns {Promise<any[]>} */
export const worldClockEventDrafts = (state, minutes) => serverCall('worldClockEventDrafts', state, minutes)
/** @param {any} state @param {string} id */
export const findActor = (state, id) => serverCall('findActor', state, id)
/** @param {any} state @param {string} id @returns {Promise<{ x: number, y: number } | null>} */
export const actorPosition = (state, id) => serverCall('actorPosition', state, id)
/** @param {any} actor @param {any} anchor @returns {Promise<Array<{ x: number, y: number }>>} */
export const footprintCellsFor = (actor, anchor) => serverCall('footprintCellsFor', actor ?? null, anchor ?? null)
/** @param {any} left @param {any} right @param {any} [leftAnchor] @param {any} [rightAnchor] @returns {Promise<number | null>} */
export const footprintDistanceFeet = (left, right, leftAnchor, rightAnchor) => serverCall('footprintDistanceFeet', left ?? null, right ?? null, leftAnchor ?? null, rightAnchor ?? null)
/** @param {any} memory */
export const normalizeWorldMemory = (memory) => serverCall('normalizeWorldMemory', memory)
/** @param {string} seed @param {number} [arcNumber] */
export const buildCampaignArcPlan = (seed, arcNumber) => serverCall('buildCampaignArcPlan', seed, arcNumber ?? null)
/** @param {number} level @returns {Promise<number>} */
export const experienceForLevel = (level) => serverCall('experienceForLevel', level)
/** @param {number} elapsedMinutes @returns {Promise<number>} */
export const clockMinuteOf = (elapsedMinutes) => serverCall('clockMinuteOf', elapsedMinutes)
/** Минут до ближайшего `targetMinute` суток. @param {number} elapsedMinutes @param {number} targetMinute @returns {Promise<number>} */
export const minutesUntilClock = (elapsedMinutes, targetMinute) => serverCall('minutesUntilClock', elapsedMinutes, targetMinute)
/** @param {any} state @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to @returns {Promise<boolean>} */
export const hasClearTrajectory = (state, from, to) => serverCall('hasClearTrajectory', state, from, to)
/** @param {{ mapSeed: string, props: any[], propId: string }} input */
export const sceneInteractionDefinition = (input) => serverCall('sceneInteractionDefinition', input)
