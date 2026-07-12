import { createHash } from 'node:crypto'
import { generateDynamicSceneMap } from './dynamic-map.mjs'

const WIDTH = 13
const HEIGHT = 9

function text(value, maxLength, fallback = '') {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function publicText(value, maximum, fallback = '') {
  return typeof value === 'string' ? text(value, maximum, fallback) : fallback
}

function publicTextList(value, maximum, limit) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string')
    .map((item) => text(item, maximum))
    .filter(Boolean))].slice(-limit)
}

function publicHistoryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = ['completed', 'unresolved', 'abandoned'].includes(value.status) ? value.status : null
  return {
    chapter: integer(value.chapter, 1, 1, 999),
    title: publicText(value.title, 80, 'Предыдущая сцена'),
    location: publicText(value.location, 120),
    objective: publicText(value.objective, 160),
    outcome: publicText(value.outcome, 240),
    ...(status ? { status } : {}),
  }
}

/**
 * Produces the only adventure shape allowed inside public SceneAdvanced data.
 * Private/GM buckets remain server-side and are intentionally not copied into
 * the transition payload.
 */
export function publicAdventureMemory(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const currentHook = publicText(source.currentHook, 240)
  const lastTransition = publicText(source.lastTransition, 500)
  return {
    chapter: integer(source.chapter, 1, 1, 999),
    ...(currentHook ? { currentHook } : {}),
    ...(lastTransition ? { lastTransition } : {}),
    unresolvedThreads: publicTextList(source.unresolvedThreads, 240, 20),
    visitedLocations: publicTextList(source.visitedLocations, 120, 50),
    history: (Array.isArray(source.history) ? source.history : [])
      .map(publicHistoryEntry)
      .filter(Boolean)
      .slice(-20),
  }
}

function seededRandom(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function featurePool(theme) {
  if (/лес|болот|чащ|роща/iu.test(theme)) return ['torch', 'rune', 'altar', 'chest']
  if (/город|деревн|таверн|улиц/iu.test(theme)) return ['torch', 'chest', 'stairs', 'altar']
  if (/пещ|шахт|подзем|руин|храм/iu.test(theme)) return ['torch', 'rune', 'stairs', 'altar', 'chest']
  return ['torch', 'rune', 'chest', 'stairs']
}

/** Builds a playable, connected 13x9 map. Content choices come from the director;
 * topology is deterministic so retries cannot silently produce another location. */
function generateSceneMapLegacy({ seed, theme = '', danger = 'средняя' } = {}) {
  const random = seededRandom(`${seed}:${theme}:${danger}`)
  const cells = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const border = x === 0 || y === 0 || x === WIDTH - 1 || y === HEIGHT - 1
      const onSpine = y === 4 || x === 6
      const chamber = (x >= 2 && x <= 4 && y >= 2 && y <= 6) || (x >= 8 && x <= 10 && y >= 2 && y <= 6)
      const passable = !border && (onSpine || chamber || random() > 0.34)
      cells.push({ x, y, type: passable ? 'floor' : 'wall', revealed: passable && x <= 2 })
    }
  }

  const floor = cells.filter((cell) => cell.type === 'floor' && cell.x >= 4)
  const features = featurePool(theme)
  const count = danger === 'высокая' ? 6 : danger === 'низкая' ? 3 : 4
  for (let index = 0; index < count && floor.length; index += 1) {
    const chosen = floor.splice(Math.floor(random() * floor.length), 1)[0]
    chosen.feature = index === 0 ? 'stairs' : features[Math.floor(random() * features.length)]
  }
  return cells
}

export function createSceneTransition(input = {}, state = {}) {
  const previousScene = state.scene ?? {}
  const previousAdventure = publicAdventureMemory(state.adventure)
  const chapter = integer(previousAdventure.chapter, 1, 1, 999) + 1
  const title = text(input.title, 80, `Глава ${chapter}`)
  const location = text(input.location, 120, title)
  const mood = text(input.mood, 160, 'Неизведанное место, полное новых возможностей')
  const objective = text(input.objective, 160, 'Исследовать новую локацию и найти путь дальше')
  const transition = text(input.transition, 500, `Путь из «${text(previousScene.location || previousScene.title, 100, 'прежнего места')}» приводит героев в «${location}».`)
  const arrival = text(input.arrival, 500, `Перед героями открывается ${location}.`)
  const hook = text(input.hook, 240, objective)
  const theme = text(input.theme, 80, location)
  const danger = ['низкая', 'средняя', 'высокая'].includes(input.danger) ? input.danger : 'средняя'
  const seed = text(input.seed, 120, `${state.sessionCode ?? 'campaign'}:${chapter}:${location}`)
  const completedObjective = text(input.completed_objective, 160, previousScene.objective)
  const objectiveStatus = ['completed', 'unresolved', 'abandoned'].includes(input.objective_status) ? input.objective_status : 'completed'
  const historyEntry = {
    chapter: Math.max(1, chapter - 1),
    title: text(previousScene.title, 80, 'Предыдущая сцена'),
    location: text(previousScene.location, 120),
    objective: completedObjective,
    outcome: text(input.outcome, 240, completedObjective ? `Цель «${completedObjective}» завершена.` : 'Герои покинули эту локацию.'),
    status: objectiveStatus,
  }
  const history = [...(Array.isArray(previousAdventure.history) ? previousAdventure.history : []), historyEntry].slice(-20)
  const suggestions = (Array.isArray(input.suggestions) ? input.suggestions : [])
    .map((item) => text(item, 100)).filter(Boolean).slice(0, 3)
  const unresolvedThreads = [...(Array.isArray(previousAdventure.unresolvedThreads) ? previousAdventure.unresolvedThreads : [])]
  if (input.carry_unresolved || objectiveStatus === 'unresolved') {
    unresolvedThreads.push(text(previousAdventure.currentHook || previousScene.objective, 240))
  }

  return {
    scene: { title, location, mood, objective, turn: Math.max(0, Number(previousScene.turn) || 0) + 1, cells: generateDynamicSceneMap({ seed, theme, danger, ...(input.map ?? {}) }) },
    adventure: {
      chapter,
      history,
      currentHook: hook,
      lastTransition: transition,
      unresolvedThreads: [...new Set(unresolvedThreads.filter(Boolean))].slice(-20),
      visitedLocations: [...new Set([...(Array.isArray(previousAdventure.visitedLocations) ? previousAdventure.visitedLocations : []), location])].slice(-50),
    },
    transition,
    arrival,
    suggestions: suggestions.length ? suggestions : ['Осмотреться', 'Проверить ближайший проход', 'Обсудить дальнейший путь'],
    entrance: { x: 1, y: 4 },
  }
}

export const generateSceneMap = generateDynamicSceneMap
