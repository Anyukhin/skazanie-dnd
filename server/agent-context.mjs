import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'
import { campaignModeFor } from './campaign-stories.mjs'
import { questStateForViewer } from './quest-consequences.mjs'
import { platformCells } from './map-quality.mjs'
import { normalizeSceneRequirements, requirementAssets, requirementLabel, requirementTerrain } from './scene-requirements.mjs'

/** Сторона света от героя до якоря: север вверху карты. */
function directionWord(dx, dy) {
  if (Math.hypot(dx, dy) <= 3) return 'рядом'
  const angle = Math.atan2(-dy, dx) * 180 / Math.PI
  const sectors = ['к востоку', 'к северо-востоку', 'к северу', 'к северо-западу', 'к западу', 'к юго-западу', 'к югу', 'к юго-востоку']
  return sectors[Math.round(((angle + 360) % 360) / 45) % 8]
}

/**
 * Якоря программы сцены на карте (этап 7 `docs/map-generation-plan.md`):
 * что из обещанного текстом действительно стоит на карте и видно отряду, и в
 * какой стороне. И отдельно — что текст обещал, а карты нет: Рассказчик об
 * этом молчит, чтобы слова и доска говорили одно.
 *
 * Видимое — только на раскрытых клетках: якорь за закрытой дверью Рассказчик
 * не называет. Отсутствующее берётся из программы, а её пишут слова сцены,
 * которые игрок уже прочёл, поэтому список ничего не выдаёт.
 *
 * @param {Record<string, any>} scene
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {{x: number, y: number}|null} position
 */
function sceneLandmarks(scene, map, position) {
  const items = normalizeSceneRequirements(scene.map_requirements)
  // Программа без предметов, но с недостроенной постройкой («Старый маяк»
  // без помещений, `missingStructureFor`) тоже говорит Рассказчику, о чём молчать.
  if (!items.length && !(Array.isArray(scene.map_requirements?.missing) && scene.map_requirements.missing.length)) return null
  const origin = position ?? map.spawnPoints?.find((point) => point.role === 'party') ?? { x: map.width / 2, y: map.height / 2 }
  const landmarks = []
  const absent = []
  for (const item of items) {
    const terrain = requirementTerrain(item.id)
    const assets = new Set(requirementAssets(item.id))
    const all = terrain ? platformCells(map).map((cell) => [cell])
      : (map.props ?? []).filter((prop) => assets.has(prop.assetId)).map((prop) => (prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]))
    if (!all.length) {
      absent.push(item.id)
      continue
    }
    const visible = all.filter((cells) => cells.every((point) => cellAt(map, point.x, point.y)?.revealed))
    if (!visible.length) continue
    const points = visible.flat()
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length
    landmarks.push({
      kind: item.id,
      label: requirementLabel(item.id),
      count: terrain ? Math.max(1, Math.round(visible.length / 6)) : visible.length,
      where: directionWord(cx - Number(origin.x), cy - Number(origin.y)),
      ...(scene.map_requirements?.focus === item.id ? { focus: true } : {}),
    })
  }
  const missing = Array.isArray(scene.map_requirements?.missing) ? scene.map_requirements.missing.map(String) : []
  return {
    landmarks: landmarks.slice(0, 12),
    landmarks_absent: [...new Set([...absent, ...missing])].map((id) => ({ kind: id, label: requirementLabel(id) })).slice(0, 12),
  }
}

const clean = (value, maximum) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
export const AGENT_CONTEXT_SCHEMA_VERSION = 1
export const SPATIAL_CONTEXT_SCHEMA_VERSION = 2

function safeIdentifier(value, maximum = 120) {
  const result = clean(value, maximum)
  return result || null
}

function safeStateVersion(state = {}) {
  const value = Number(state.state_version ?? state.stateVersion ?? state.version)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function campaignIdFor(state = {}) {
  return safeIdentifier(state.sessionCode ?? state.campaign_id ?? state.campaignId ?? state.campaign?.id)
}

/**
 * Метаданные вызова принадлежат серверу и не принимаются из ответа модели.
 * Они нужны для привязки ответа к роли, актёру, кампании, версии состояния и
 * контракту роли;
 * отдельного долговечного реестра контекстов для этого не требуется.
 */
export function agentContextMetadata(state = {}, { role = 'unknown', actorId = null, targetId = null, contractVersion = null } = {}) {
  return {
    role: clean(role, 80) || 'unknown',
    actor_id: safeIdentifier(actorId),
    target_id: safeIdentifier(targetId),
    campaign_id: campaignIdFor(state),
    state_version: safeStateVersion(state),
    contract_version: safeIdentifier(contractVersion, 80),
    schema_version: AGENT_CONTEXT_SCHEMA_VERSION,
  }
}

/**
 * Метаданные ограниченной выборки. `candidateCount` должен быть посчитан уже
 * после фильтрации доступности, поэтому скрытые записи не влияют на полноту.
 */
export function boundedSelectionMetadata({ scope, candidateCount = 0, limit = 0, sourceAvailable = true } = {}) {
  const boundedLimit = Math.max(0, Number(limit) || 0)
  if (!sourceAvailable) return {
    scope: clean(scope, 160), status: 'unavailable', availability: 'unavailable',
    complete_within_scope: null, truncation_reason: 'source_unavailable',
  }
  const count = Math.max(0, Number(candidateCount) || 0)
  const truncated = count > boundedLimit
  return {
    scope: clean(scope, 160), status: truncated ? 'truncated' : count ? 'complete' : 'empty',
    availability: 'available', complete_within_scope: !truncated,
    ...(truncated ? { truncation_reason: 'item_limit' } : {}),
  }
}

function selectionFields(metadata, prefix) {
  return {
    [`${prefix}_scope`]: metadata.scope,
    [`${prefix}_status`]: metadata.status,
    [`${prefix}_availability`]: metadata.availability,
    [`${prefix}_complete_within_scope`]: metadata.complete_within_scope,
    ...(metadata.truncation_reason ? { [`${prefix}_truncation_reason`]: metadata.truncation_reason } : {}),
  }
}

function unavailableSpatialContext() {
  const objects = boundedSelectionMetadata({ scope: 'visible_interactable_objects_in_current_area', sourceAvailable: false })
  const areas = boundedSelectionMetadata({ scope: 'visible_discovered_areas_in_current_location', sourceAvailable: false })
  return {
    schema_version: SPATIAL_CONTEXT_SCHEMA_VERSION,
    current_area: null,
    known_areas: [],
    known_area_ids: [],
    objects: [],
    ...selectionFields(areas, 'known_areas'),
    ...selectionFields(objects, 'objects'),
  }
}

/**
 * Канон сцены — установленные публичные факты исходной ситуации
 * (`scene_canon`, campaign_creator/v8): рассказчик, NPC и судья заявок
 * держатся их, а не достраивают мир каждый по-своему.
 *
 * @param {Record<string, any>} state
 * @returns {string[]}
 */
export function sceneCanonFor(state = {}) {
  return (state.worldMemory?.facts ?? [])
    .filter((fact) => fact?.predicate === 'scene_canon' && fact.status !== 'superseded' && fact.visibility === 'party')
    .map((fact) => clean(fact.summary, 220))
    .filter(Boolean)
    .slice(0, 8)
}

const HEALTH_WORDS = Object.freeze({ unharmed: 'цел', wounded: 'ранен', bloodied: 'тяжело ранен', critical: 'едва стоит', defeated: 'выбыл' })

/** Состояние словами стола — те же ступени, что видит игрок у противника. */
function healthWord(actor = {}, { hero = false, dead = false } = {}) {
  if (dead) return 'погиб'
  if (actor.hp == null && actor.maxHp == null) {
    if (actor.alive === false) return hero ? 'без сознания' : 'выбыл'
    return HEALTH_WORDS[String(actor.healthStatus ?? '')] ?? 'цел'
  }
  const hp = Math.max(0, Number(actor.hp) || 0)
  const maximum = Math.max(1, Number(actor.maxHp ?? actor.max_hp) || 1)
  if (hp <= 0 || actor.alive === false) return hero ? 'без сознания' : 'выбыл'
  const ratio = hp / maximum
  return ratio >= 1 ? 'цел' : ratio > 0.5 ? 'ранен' : ratio > 0.25 ? 'тяжело ранен' : 'едва стоит'
}

/**
 * Сводка поля для рассказчика: кто где стоит (часть места, под крышей или
 * нет), в каком состоянии и кто с кем рядом. Рассказчик знал только, где
 * стоит сам действующий, и описывал очаг и свечи, когда отряд стоял на
 * причале под грозой; в бою — не знал, кто кому угрожает (замеры 27–31,
 * 2026-10-11). Чисел здесь нет: состояние — словами, как видит игрок;
 * противники — только на раскрытых клетках.
 *
 * @param {Record<string, any>} state
 * @param {import('./tactical-map.mjs').TacticalMap|null} [preparedMap]
 * @returns {{ heroes: any[], enemies: any[], people: any[] } | null}
 */
export function fieldSummaryFor(state = {}, preparedMap = null) {
  const scene = state.scene ?? {}
  let map = preparedMap
  if (!map && scene.map && typeof scene.map === 'object') {
    try { map = scene.map.layers?.present instanceof Uint8Array ? scene.map : deserializeTacticalMap(scene.map) } catch { map = null }
  }
  if (!map) return null
  const zones = new Map((Array.isArray(map.zones) ? map.zones : []).map((zone) => [zone.id, zone]))
  const positionOf = (id, actor) => {
    const stored = state.mechanics?.positions?.[id]
    const x = Number(stored?.x ?? actor?.x)
    const y = Number(stored?.y ?? actor?.y)
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  }
  const areaOf = (at) => {
    const cell = at ? cellAt(map, at.x, at.y) : null
    const zone = cell ? zones.get(cell.zone) : null
    return zone ? { area: clean(zone.label || zone.kind, 80), indoors: zone.kind === 'interior' } : {}
  }
  const dead = state.mechanics?.death?.heroes ?? {}
  const entries = []
  for (const hero of state.players ?? []) {
    const at = positionOf(String(hero.id), hero)
    if (!at) continue
    entries.push({ side: 'heroes', id: String(hero.id), name: clean(hero.character || hero.name, 80), at, ...areaOf(at), condition: healthWord(hero, { hero: true, dead: dead[hero.id]?.status === 'dead' }) })
  }
  for (const enemy of state.enemies ?? []) {
    const at = positionOf(String(enemy.id), enemy)
    if (!at || cellAt(map, at.x, at.y)?.revealed !== true) continue
    const condition = healthWord(enemy)
    if (condition === 'выбыл' && !state.mechanics?.combat?.active) continue
    entries.push({ side: 'enemies', id: String(enemy.id), name: clean(enemy.name, 80), at, ...areaOf(at), condition })
  }
  const here = clean(scene.location_id, 120)
  for (const placement of state.npc_world?.placements ?? []) {
    if (here && clean(placement?.location_id, 120) !== here) continue
    const npc = (state.social?.npcs ?? []).find((entry) => String(entry?.id) === String(placement?.npc_id))
    if (!npc || npc.available === false) continue
    const at = { x: Number(placement.x), y: Number(placement.y) }
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue
    entries.push({ side: 'people', id: String(npc.id), name: clean(npc.name, 80), at, ...areaOf(at) })
  }
  const near = (entry) => entries
    .filter((other) => other !== entry && Math.max(Math.abs(other.at.x - entry.at.x), Math.abs(other.at.y - entry.at.y)) <= 1)
    .map((other) => other.name)
    .slice(0, 6)
  const shape = (entry) => {
    const close = near(entry)
    const { at: _at, side: _side, id: _id, ...rest } = entry
    return { ...rest, ...(close.length ? { next_to: close } : {}) }
  }
  return {
    heroes: entries.filter((entry) => entry.side === 'heroes').map(shape).slice(0, 8),
    enemies: entries.filter((entry) => entry.side === 'enemies').map(shape).slice(0, 12),
    people: entries.filter((entry) => entry.side === 'people').map(shape).slice(0, 8),
  }
}

/** Видимая обстановка у действующего лица, без скрытых комнат и бинарных слоёв карты. */
export function sceneContextForAgent(state = {}, actorId = '') {
  const scene = state.scene ?? {}
  const baseContext = Object.fromEntries(['title', 'location', 'mood', 'objective', 'theme', 'scene_kind', 'layout'].map((key) => [key, clean(scene[key], key === 'layout' ? 400 : 300)]).filter(([key, value]) => key !== 'layout' || value))
  // Что карта мира обещает об этом месте: «заброшенный маяк, чей свет вновь
  // замечают по ночам». Без этого ведущий на «загорится ли огонь?» отвечал то
  // «горит», то «в темноте не видно» (замеры 11–18, 2026-10-11).
  const place = (Array.isArray(state.worldMap?.locations) ? state.worldMap.locations : [])
    .find((entry) => entry?.known !== false && (String(entry?.id ?? '') === String(state.worldMap?.currentLocationId ?? '')
      || clean(entry?.name, 160).toLocaleLowerCase('ru') === clean(scene.location, 160).toLocaleLowerCase('ru')))
  const placeSummary = clean(place?.summary, 300)
  const canon = sceneCanonFor(state)
  const context = { ...baseContext, ...(placeSummary ? { place_summary: placeSummary } : {}), ...(canon.length ? { canon } : {}) }
  const metadata = agentContextMetadata(state, { role: 'scene_context', actorId, contractVersion: 'scene-context/v2' })
  if (!scene.map || typeof scene.map !== 'object') return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() }
  let map
  try { map = scene.map.layers?.present instanceof Uint8Array ? scene.map : deserializeTacticalMap(scene.map) }
  catch { return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() } }
  const requiredLayers = ['present', 'passable', 'revealed', 'moveCost', 'surface', 'material', 'variant', 'elevation', 'zoneId']
  if (!Number.isSafeInteger(map?.width) || !Number.isSafeInteger(map?.height)
    || !requiredLayers.every((name) => ArrayBuffer.isView(map?.layers?.[name]))) {
    return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() }
  }
  const id = String(actorId || state.activePlayerId || '')
  const actor = [...(state.players ?? []), ...(state.actors ?? [])].find((entry) => entry.id === id)
  const position = state.mechanics?.positions?.[id] ?? actor
    ?? state.npc_world?.placements?.find((entry) => entry.npc_id === id && entry.location_id === scene.location_id)
  const at = position ? cellAt(map, Number(position.x), Number(position.y)) : null
  const zones = Array.isArray(map.zones) ? map.zones : []
  const props = Array.isArray(map.props) ? map.props : []
  const currentZone = at?.revealed ? zones.find((zone) => zone.id === at.zone) : null
  const discovered = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.revealed && cell.passable && cell.zone) discovered.add(cell.zone)
  }
  const visibleObjects = props.filter((prop) => {
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    const footprintVisible = !prop.footprint?.length || prop.footprint.every((point) => cellAt(map, point.x, point.y)?.revealed)
    const visibility = String(prop.visibility ?? prop.interaction?.visibility ?? '').toLowerCase()
    return !['gm_only', 'npc_private'].includes(visibility)
      && cell?.revealed && (!currentZone || cell.zone === currentZone.id)
      && footprintVisible && !['broken', 'destroyed'].includes(prop.state)
  }).sort((left, right) => position
    ? Math.hypot(left.x - position.x, left.y - position.y) - Math.hypot(right.x - position.x, right.y - position.y)
    : String(left.id).localeCompare(String(right.id)))
  const objects = visibleObjects.slice(0, 16).map((prop) => ({ id: clean(prop.id, 120), kind: prop.assetId, x: prop.x, y: prop.y, state: prop.state }))
  const visibleAreas = zones.filter((zone) => discovered.has(zone.id) && zone.label)
  const objectSelection = boundedSelectionMetadata({ scope: 'visible_interactable_objects_in_current_area', candidateCount: visibleObjects.length, limit: 16 })
  const areaSelection = boundedSelectionMetadata({ scope: 'visible_discovered_areas_in_current_location', candidateCount: visibleAreas.length, limit: 16 })
  const program = sceneLandmarks(scene, map, position ? { x: Number(position.x), y: Number(position.y) } : null)
  const field = fieldSummaryFor(state, map)
  return { ...context,
    ...(program ? program : {}),
    ...(field && (field.heroes.length || field.enemies.length || field.people.length) ? { field } : {}),
    context_metadata: metadata,
    ...(currentZone ? { id: `${scene.location_id || scene.location}:${currentZone.id}`, theme: currentZone.label || currentZone.kind } : {}),
    spatial_context: {
      schema_version: SPATIAL_CONTEXT_SCHEMA_VERSION,
      current_area: currentZone ? { name: currentZone.label, indoors: currentZone.kind === 'interior' } : null,
      known_areas: visibleAreas.slice(0, 16).map((zone) => zone.label),
      known_area_ids: visibleAreas.slice(0, 16).map((zone) => clean(zone.id, 120)).filter(Boolean),
      objects,
      ...selectionFields(areaSelection, 'known_areas'),
      ...selectionFields(objectSelection, 'objects'),
    },
  }
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/** Заглушки незаполненного листа героя: в карточку они не идут. */
const HERO_CARD_PLACEHOLDERS = new Set(['не выбран', 'не выбрано', 'не определено', 'ожидает игрока', 'герой ещё не создан'])

/**
 * Текст карточки, обрезанный по концу предложения, а не на полуслове:
 * «…ушла в море на баркасе „Чайка“.» лучше, чем «…ушла в море на бар».
 */
function heroCardText(value, maximum) {
  const text = clean(value, 8_000)
  if (!text || HERO_CARD_PLACEHOLDERS.has(text.toLocaleLowerCase('ru'))) return ''
  if (text.length <= maximum) return text
  const cut = text.slice(0, maximum)
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('… '))
  return sentenceEnd >= maximum / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.replace(/\s+\S*$/u, '')}…`
}

/**
 * Карточка героя для агента, который с ним говорит или о нём рассказывает:
 * имя, класс, предыстория (до 300 знаков) и привязанности. Предыстория и
 * привязанности героя видны отряду (лист героя), поэтому карточка не несёт
 * скрытого. Имена полей намеренно без «secret»/«unrevealed»: бриф рассказчика
 * вырезает такие ключи (`server/security.mjs`, `NARRATOR_PRIVATE_KEYS`).
 *
 * Плейтест 2026-10-10: сестра волшебника пропала в море, бывшего стражника
 * капитан учил не замечать ночных лодок у маяка — и ни один NPC этого не знал.
 *
 * @param {Record<string, any>} state
 * @param {string} heroId
 * @returns {{ id: string, name: string, class?: string, species?: string, background?: string, backstory?: string, bonds?: string, ideals?: string } | null}
 */
export function heroCardForAgent(state = {}, heroId = '') {
  const expected = String(heroId ?? '')
  const hero = (Array.isArray(state.players) ? state.players : []).find((player) => String(player?.id ?? '') === expected)
  if (!hero) return null
  const role = heroCardText(String(hero.role ?? '').split('·')[0], 80)
  const card = {
    id: clean(hero.id, 120),
    name: heroCardText(hero.character || hero.name, 120),
    class: role || heroCardText(hero.characterClass, 60),
    species: heroCardText(hero.species, 80),
    background: heroCardText(hero.background, 120),
    backstory: heroCardText(hero.backstory, 300),
    bonds: heroCardText(hero.bonds, 200),
    ideals: heroCardText(hero.ideals, 160),
  }
  return /** @type {any} */ (Object.fromEntries(Object.entries(card).filter(([, value]) => value)))
}

/** Public, bounded campaign contract shared by every creative agent. */
export function campaignConceptForAgent(state = {}, viewer = { isPartyMember: true }) {
  const visibleState = questStateForViewer(state, viewer)
  const concept = visibleState.campaignConcept ?? visibleState.campaign_concept ?? {}
  const arcHistory = (Array.isArray(concept.arc_history) ? concept.arc_history : [])
    .slice(-3)
    .map((entry) => ({
      arc_number: positiveInteger(entry?.arc_number),
      title: clean(entry?.title, 160),
      epilogue: clean(entry?.epilogue, 1_200),
      concluded_at: clean(entry?.concluded_at, 80),
    }))
    .filter((entry) => entry.arc_number && entry.epilogue)
  const factions = (Array.isArray(concept.factions) ? concept.factions : [])
    .slice(0, 6)
    .map((entry) => ({
      id: clean(entry?.id, 80),
      name: clean(entry?.name, 120),
      summary: clean(entry?.summary, 360),
      goal: clean(entry?.goal, 240),
    }))
    .filter((entry) => entry.id && entry.name && entry.summary)
  const storyArcs = (Array.isArray(concept.story_arcs) ? concept.story_arcs : Array.isArray(concept.storyArcs) ? concept.storyArcs : [])
    .slice(0, 4)
    .map((entry) => ({
      title: clean(entry?.title, 160),
      levels: clean(entry?.levels, 40),
      summary: clean(entry?.summary, 520),
      stakes: clean(entry?.stakes, 360),
    }))
    .filter((entry) => entry.title && entry.summary)
  return {
    preset: clean(concept.preset, 160),
    ...(campaignModeFor(state) === 'persistent' ? {
      campaign_mode: 'persistent',
      quests_optional: true,
      wait_for_player_after_story: true,
      completed_stories: (Array.isArray(concept.story_history) ? concept.story_history : []).slice(-3).map((story) => ({
        story_id: clean(story.story_id, 120), title: clean(story.title, 180),
        outcome: clean(story.outcome, 30), summary: clean(story.summary, 600),
      })),
    } : {}),
    era: clean(concept.era, 80),
    genre: clean(concept.genre, 100),
    tone: clean(concept.tone, 160),
    premise: clean(concept.premise, 400),
    themes: clean(concept.themes ?? concept.theme, 240),
    boundaries: clean(concept.boundaries, 500),
    magic_level: clean(concept.magicLevel ?? concept.magic_level, 80),
    technology_level: clean(concept.technologyLevel ?? concept.technology_level, 80),
    world_template_id: clean(concept.world_template_id ?? concept.worldTemplateId, 80),
    world_template_version: clean(concept.world_template_version ?? concept.worldTemplateVersion, 40),
    world_summary: clean(concept.worldSummary ?? concept.world_summary, 1_200),
    world_history: clean(concept.worldHistory ?? concept.world_history, 3_000),
    factions,
    story_arcs: storyArcs,
    current_arc_number: positiveInteger(concept.arc?.arc_number),
    current_chapter: positiveInteger(visibleState.adventure?.chapter),
    arc_history: arcHistory,
  }
}
