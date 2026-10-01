// @ts-check
/**
 * Запросы к участникам сцены: кто есть, где стоит, жив ли, враг ли.
 *
 * Только чтение состояния, без костей и событий. Вынесено из
 * `rules-engine.mjs`, чтобы соседние модули (`npc-controller`,
 * `free-action-adjudication`, `improvised-effects`) не тянули ради
 * `findActor` весь движок; `rules-engine.mjs` реэкспортирует эти функции.
 */
import { safeInteger } from './core.mjs'

/**
 * Участник сцены: герой, актёр или враг. Движок хранит их свободной формой,
 * поэтому здесь описаны только читаемые поля.
 *
 * @typedef {{ id?: unknown, actor_id?: unknown, hp?: unknown, alive?: boolean, x?: unknown, y?: unknown, [key: string]: unknown }} SceneActor
 * @typedef {{ players?: SceneActor[], actors?: SceneActor[], enemies?: SceneActor[], mechanics?: { positions?: Record<string, { x?: unknown, y?: unknown }> }, [key: string]: unknown }} ActorState
 */

/** @param {SceneActor | null | undefined} actor */
export function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

/**
 * @param {ActorState | null | undefined} state
 * @returns {SceneActor[]}
 */
export function listActors(state) {
  const players = Array.isArray(state?.players) ? state.players : []
  const actors = Array.isArray(state?.actors) ? state.actors : []
  const enemies = Array.isArray(state?.enemies) ? state.enemies : []
  const byId = new Map()
  for (const actor of [...players, ...actors, ...enemies]) if (actorId(actor)) byId.set(actorId(actor), actor)
  return [...byId.values()]
}

/**
 * @param {ActorState | null | undefined} state
 * @param {unknown} id
 * @returns {SceneActor | null}
 */
export function findActor(state, id) {
  const expected = String(id ?? '')
  return listActors(state).find((actor) => actorId(actor) === expected) ?? null
}

/**
 * @param {ActorState | null | undefined} state
 * @param {unknown} id
 */
export function isEnemyActor(state, id) {
  const expected = String(id ?? '')
  return (state?.enemies ?? []).some((enemy) => actorId(enemy) === expected)
}

/** @param {SceneActor | null | undefined} actor */
export function isLivingActor(actor) {
  return Boolean(actor) && actorHp(actor) > 0 && actor?.alive !== false
}

/**
 * @param {ActorState | null | undefined} state
 * @param {unknown} id
 * @returns {{ x: number, y: number } | null}
 */
export function actorPosition(state, id) {
  const actor = findActor(state, id)
  const stored = state?.mechanics?.positions?.[String(id)]
  const x = Number(stored?.x ?? actor?.x)
  const y = Number(stored?.y ?? actor?.y)
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null
}

/** @param {SceneActor | null | undefined} actor */
export function actorHp(actor) {
  return Math.max(0, safeInteger(actor?.hp, 0))
}
