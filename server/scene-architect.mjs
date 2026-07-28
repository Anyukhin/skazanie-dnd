import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { publicAdventureMemory } from './adventure-director.mjs'
import { defaultSceneShopIntent, normalizeSceneShopIntent } from './scene-commerce.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { buildDataOnlyContext } from './security.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/map_architect/v2.txt', import.meta.url)), 'utf8')

function clean(value, maximum = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

const MAP_SCALES = new Set(['room', 'site', 'stronghold', 'region'])
const MAP_PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])
const MAP_MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])

function scaleDimensions(scale) {
  if (scale === 'room') return { width: 9, height: 7, minimumWidth: 7, minimumHeight: 7 }
  if (scale === 'stronghold') return { width: 23, height: 17, minimumWidth: 19, minimumHeight: 13 }
  if (scale === 'region') return { width: 25, height: 19, minimumWidth: 21, minimumHeight: 15 }
  return { width: 15, height: 11, minimumWidth: 11, minimumHeight: 9 }
}

/** Builds a data-only, public context for the external Scene Architect. */
export function buildDirectorPlanningBrief(state = {}) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {}
  const scene = source.scene && typeof source.scene === 'object' && !Array.isArray(source.scene) ? source.scene : {}
  const currentScene = {
    title: clean(scene.title, 80),
    location: clean(scene.location, 120),
    mood: clean(scene.mood, 160),
    objective: clean(scene.objective, 160),
    turn: clampInteger(scene.turn, 0, 0, 1_000_000),
    ...(typeof scene.theme === 'string' ? { theme: clean(scene.theme, 80) } : {}),
    ...(['низкая', 'средняя', 'высокая'].includes(scene.danger) ? { danger: scene.danger } : {}),
    ...(['settlement', 'wilderness', 'dungeon', 'road', 'other'].includes(scene.scene_kind) ? { scene_kind: scene.scene_kind } : {}),
    ...(['village', 'town', 'city', 'outpost', 'traveling'].includes(scene.settlement_type) ? { settlement_type: scene.settlement_type } : {}),
  }
  return {
    current_scene: currentScene,
    adventure_memory: publicAdventureMemory(source.adventure),
    campaign_premise: campaignConceptForAgent(source),
    heroes: (source.players ?? []).map((hero) => ({
      id: clean(hero?.id, 40),
      name: clean(hero?.character ?? hero?.name, 80),
      role: clean(hero?.role, 100),
      species: clean(hero?.species, 80),
      background: clean(hero?.background, 100),
      backstory: clean(hero?.backstory, 400),
      traits: clean(hero?.traits, 200),
    })).slice(0, 12),
    visible_enemies: (source.enemies ?? []).filter((enemy) => enemy?.alive !== false).map((enemy) => ({
      id: clean(enemy?.id, 40),
      name: clean(enemy?.name, 80),
      kind: clean(enemy?.kind ?? enemy?.type, 80),
    })).slice(0, 16),
  }
}

function selectedDecision(action, state = {}) {
  const interaction = state.agentInteraction ?? {}
  const option = Array.isArray(interaction.options)
    ? interaction.options.find((candidate) => candidate?.id === interaction.resolvedOptionId)
    : null
  return clean(option?.label || action, 500)
}

export function interpretResolvedPartyDecision(action, state = {}) {
  const text = clean(action, 2000).normalize('NFKC')
  if (!/^\[РЕШЕНИЕ ГРУППЫ\]/iu.test(text)) return null
  const decision = selectedDecision(text, state)
  const normalized = decision.toLocaleLowerCase('ru')
  const stays = /(?:оста(?:ться|ёмся|емся)|не\s+уход|продолж(?:ить|аем)\s+(?:исслед|поиск)|исследовать\s+дальше)/iu.test(normalized)
  const moves = /(?:уход(?:им|ить)|уйти|уйд[её]м|покин(?:уть|ем|уть)|отступ(?:аем|ить)|выбраться|возвращаемся|ид[её]м\s+(?:в|на|к)|направляемся\s+(?:в|на|к))/iu.test(normalized)
  if (stays && !moves) return { kind: 'stay', decision }
  if (!moves) return { kind: 'other', decision }

  const destinationMatch = normalized.match(/(?:уходим|уйти|уйд[её]м|ид[её]м|направляемся|возвращаемся)\s+(?:из\s+[^—,.;]+\s+)?(?:в|на|к)\s+([^—,.;]+)/iu)
    ?? normalized.match(/(?:^|\s)(?:в|на|к)\s+(город(?:\w*)?|деревн(?:ю|е)|порт|лес|замок|тракт|лагерь|храм|башн(?:ю|е)|пещер(?:у|е)|горы?)(?:\s+[^—,.;]*)?/iu)
  const normalizedHint = destinationMatch?.[1] ?? ''
  const hintOffset = normalizedHint ? normalized.indexOf(normalizedHint) : -1
  const destinationHint = clean(
    hintOffset >= 0 ? decision.slice(hintOffset, hintOffset + normalizedHint.length) : normalizedHint,
    120,
  )
  return { kind: 'move', decision, destinationHint }
}

function themeFor(destination, action) {
  const destinationValue = String(destination ?? '').toLocaleLowerCase('ru')
  const hasExplicitDestinationKind = /крепост|замок|цитадел|дом|хижин|комнат|кабинет|зал|камор|спальн|таверн|город|деревн|порт|рынок|улиц|лес|чащ|болот|роща|мост|тракт|дорог|путь|перевал|руин|развал|храм|пещер|подзем|склеп|архив|шахт|арен|круг|кольц|башн/u.test(destinationValue)
  // The explicit destination must win over the source location mentioned in
  // a resolved vote (for example, "leave the city and go to the forest").
  const value = hasExplicitDestinationKind
    ? destinationValue
    : `${destinationValue} ${String(action ?? '').toLocaleLowerCase('ru')}`
  if (/крепост|замок|цитадел/u.test(value)) return { theme: 'крепость', layout: 'rooms', scale: 'stronghold', pattern: 'keep', material: 'stone', width: 23, height: 17, openness: 0.62, water: 0.02, featureCount: 10, danger: 'высокая' }
  if (/дом|хижин|комнат|кабинет|небольш.*зал|камор|спальн|таверн/u.test(value)) return { theme: /таверн/u.test(value) ? 'уютная таверна' : 'жилой дом', layout: 'rooms', scale: 'room', pattern: 'small-room', material: 'wood', width: 9, height: 7, openness: 0.82, water: 0, featureCount: 9, danger: 'низкая' }
  if (/город|деревн|порт|рынок|таверн|улиц/u.test(value)) return { theme: 'городские улицы', layout: 'streets', scale: 'site', pattern: 'village', material: 'stone', width: 17, height: 11, openness: 0.68, water: /порт|канал/u.test(value) ? 0.12 : 0.02, featureCount: 7, danger: 'низкая' }
  if (/лес|чащ|болот|роща/u.test(value)) return { theme: 'дикая местность', layout: 'winding', scale: 'site', pattern: 'natural', material: 'grass', width: 15, height: 11, openness: 0.62, water: /болот/u.test(value) ? 0.22 : 0.06, featureCount: 10, danger: 'средняя' }
  if (/мост/u.test(value)) return { theme: 'мост и подступы', layout: 'winding', scale: 'site', pattern: 'bridge', material: 'wood', width: 17, height: 9, openness: 0.7, water: 0.2, featureCount: 5, danger: 'средняя' }
  if (/тракт|дорог|путь|перевал/u.test(value)) return { theme: 'дорога', layout: 'winding', scale: 'site', pattern: 'natural', material: 'earth', width: 15, height: 9, openness: 0.58, water: 0.03, featureCount: 5, danger: 'средняя' }
  if (/руин|развал|храм/u.test(value)) return { theme: 'древние руины', layout: 'ruins', scale: 'site', pattern: 'courtyard', material: /храм/u.test(value) ? 'marble' : 'stone', width: 15, height: 11, openness: 0.58, water: 0.05, featureCount: 6, danger: 'средняя' }
  if (/пещер|подзем|склеп|архив|шахт/u.test(value)) return { theme: /склеп/u.test(value) ? 'древний склеп' : 'подземные пещеры', layout: 'cavern', scale: 'site', pattern: /склеп|архив/u.test(value) ? 'crypt' : 'cave-cluster', material: 'earth', width: 15, height: 11, openness: 0.62, water: 0.08, featureCount: 10, danger: 'средняя' }
  if (/арен|круг|кольц|башн/u.test(value)) return { theme: 'радиальная локация', layout: 'radial', scale: 'site', pattern: 'great-hall', material: 'stone', width: 15, height: 15, openness: 0.58, water: 0.02, featureCount: 6, danger: 'средняя' }
  return { theme: 'новая местность', layout: 'open', scale: 'site', pattern: 'natural', material: 'earth', width: 15, height: 11, openness: 0.64, water: 0.05, featureCount: 5, danger: 'средняя' }
}

function fallbackPlan({ action, state, decision, destinationHint }) {
  const from = clean(state.scene?.location || state.scene?.title, 120) || 'прежняя локация'
  const destination = clean(destinationHint, 120) || `Окрестности ${from}`
  const location = destination.charAt(0).toLocaleUpperCase('ru') + destination.slice(1)
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1) + 1
  const oldHook = clean(state.adventure?.currentHook, 240)
  const oldObjective = clean(state.scene?.objective, 160)
  const requestedHook = /печат[ьи]\s+архивариуса/iu.test(action) ? 'Печать архивариуса остаётся незавершённой нитью и может открыть другой путь.' : ''
  const hook = requestedHook || oldHook || oldObjective || `В ${location} обнаружится связь с оставленным позади путём.`
  const map = themeFor(location, action)
  return {
    title: `Глава ${chapter} · ${location}`,
    location,
    mood: map.theme === 'городские улицы' ? 'Шумная передышка за городскими стенами, где опасность прячется среди людей' : 'Неизведанное место, в котором путь ещё предстоит найти',
    objective: oldHook ? `Найти в ${location} другой путь к разгадке: ${oldHook}` : `Осмотреться в ${location} и найти другой путь`,
    transition: `Отряд отступает из «${from}» и следует принятому решению: ${clean(decision, 220)}.`,
    arrival: map.theme === 'городские улицы' ? `Дорога выводит героев к воротам. За ними открываются улицы локации «${location}» — с площадями, переулками и местами, где можно искать сведения.` : `Путь из «${from}» приводит героев в новую локацию — «${location}».`,
    hook,
    theme: map.theme,
    danger: map.danger,
    outcome: `Отряд покинул «${from}», не закрыв прежнюю сюжетную нить.`,
    objective_status: 'unresolved',
    carry_unresolved: true,
    suggestions: map.theme === 'городские улицы' ? ['Расспросить горожан', 'Найти архив или храм', 'Осмотреть городские ворота'] : ['Осмотреться', 'Проверить ближайший путь', 'Обсудить следующий шаг'],
    map: { layout: map.layout, scale: map.scale, pattern: map.pattern, material: map.material, width: map.width, height: map.height, openness: map.openness, water: map.water, featureCount: map.featureCount },
  }
}

function normalizePlan(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const mapSource = source.map && typeof source.map === 'object' && !Array.isArray(source.map) ? source.map : {}
  const layouts = new Set(['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'])
  const danger = new Set(['низкая', 'средняя', 'высокая'])
  const objectiveStatus = new Set(['completed', 'unresolved', 'abandoned'])
  const scale = MAP_SCALES.has(mapSource.scale) ? mapSource.scale : fallback.map.scale
  const dimensions = scaleDimensions(scale)
  return {
    title: clean(source.title, 80) || fallback.title,
    location: clean(source.location, 120) || fallback.location,
    mood: clean(source.mood, 160) || fallback.mood,
    objective: clean(source.objective, 160) || fallback.objective,
    transition: clean(source.transition, 500) || fallback.transition,
    arrival: clean(source.arrival, 500) || fallback.arrival,
    hook: clean(source.hook, 240) || fallback.hook,
    theme: clean(source.theme, 80) || fallback.theme,
    danger: danger.has(source.danger) ? source.danger : fallback.danger,
    outcome: clean(source.outcome, 240) || fallback.outcome,
    objective_status: objectiveStatus.has(source.objective_status) ? source.objective_status : fallback.objective_status,
    carry_unresolved: source.carry_unresolved !== false,
    suggestions: (Array.isArray(source.suggestions) ? source.suggestions : fallback.suggestions).map((item) => clean(item, 100)).filter(Boolean).slice(0, 3),
    map: {
      layout: layouts.has(mapSource.layout) ? mapSource.layout : fallback.map.layout,
      scale,
      pattern: MAP_PATTERNS.has(mapSource.pattern) ? mapSource.pattern : fallback.map.pattern,
      material: MAP_MATERIALS.has(mapSource.material) ? mapSource.material : fallback.map.material,
      width: clampInteger(mapSource.width, dimensions.width, dimensions.minimumWidth, 25),
      height: clampInteger(mapSource.height, dimensions.height, dimensions.minimumHeight, 19),
      openness: Math.max(0.35, Math.min(0.85, Number(mapSource.openness) || fallback.map.openness)),
      water: Math.max(0, Math.min(0.3, Number(mapSource.water) || fallback.map.water)),
      featureCount: clampInteger(mapSource.featureCount, fallback.map.featureCount, 2, 12),
    },
  }
}

export class SceneArchitectAgent {
  constructor({ llmClient = null } = {}) {
    this.llmClient = llmClient
  }

  async plan({ action, state = {}, decision = '', destinationHint = '' } = {}) {
    const fallback = fallbackPlan({ action: clean(action, 2000), state, decision: clean(decision, 500), destinationHint })
    const fallbackShopIntent = defaultSceneShopIntent(fallback)
    if (!this.llmClient) return {
      sceneArgs: fallback,
      shopIntent: fallbackShopIntent,
      trace: { agent: 'AgentCartographer', mode: 'deterministic-fallback', reason: 'LLM is not configured' },
    }
    try {
      const planningBrief = buildDirectorPlanningBrief(state)
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          // Решение партии и текст разрешения — свободный текст игроков; память
          // кампании тоже могла быть записана из их слов. Всё уходит только
          // внутри UNTRUSTED_DATA, снаружи не остаётся ни одной их строки.
          { role: 'user', content: buildDataOnlyContext({ scene_planning: { selected_party_decision: clean(decision, 500), destination_hint: clean(destinationHint, 120), ...planningBrief, full_resolution_context: clean(action, 2000) } }) },
        ],
        temperature: 0.45,
        maxTokens: 1000,
      })
      const sceneArgs = normalizePlan(result, fallback)
      return {
        sceneArgs,
        shopIntent: normalizeSceneShopIntent(result?.shop_intent, sceneArgs),
        trace: { agent: 'AgentCartographer', mode: 'model', model: this.llmClient.model ?? null },
      }
    } catch (error) {
      return {
        sceneArgs: fallback,
        shopIntent: fallbackShopIntent,
        trace: { agent: 'AgentCartographer', mode: 'deterministic-fallback', reason: error instanceof Error ? error.message : 'unknown error' },
      }
    }
  }
}

