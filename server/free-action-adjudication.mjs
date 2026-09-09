import { createHash } from 'node:crypto'

import { DIFFICULTY_CLASSES } from './adjudicator.mjs'
import { actorPosition, findActor, shortestTacticalPath, skillProficiencyForActor } from './rules-engine.mjs'
import { cellAt, deserializeTacticalMap, doorsReachableFrom, edgeBetween } from './tactical-map.mjs'
import { npcPlacementFor, presentSceneNpcs } from './npc-positioning.mjs'
import { npcSocialForViewer } from './npc-social.mjs'
import { campaignStateForViewer } from './viewer-projection.mjs'
import { ENVIRONMENT_HAZARD_IDS, ENVIRONMENT_HAZARDS } from './improvised-effects.mjs'
import { hazardPropCells, sceneHazardTagsFor } from './scene-hazards.mjs'
import {
  LOOT_CONTAINER_REACH_FEET,
  lootContainerList,
  lootContainerReachFor,
  lootContainersInScene,
  lootItemForViewer,
} from './loot-containers.mjs'

/**
 * Серверное судейство свободного действия — то, что живой ведущий решает в уме.
 *
 * Разделение обязанностей жёсткое: модель может предложить только смысл действия и
 * категорию из перечисления, а режим разрешения, число СЛ и последствие выбирает
 * сервер. Модуль детерминированный и без вызовов LLM, как `campaign-loop-policy.mjs`.
 */

const clean = (value, maximum = 300) => String(value ?? '')
  .normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)

export const PLAUSIBILITY_LEVELS = Object.freeze(['trivial', 'plausible', 'strenuous', 'impossible_without_means'])
export const RISK_LEVELS = Object.freeze(['none', 'minor', 'serious', 'deadly'])
export const RESOLUTION_MODES = Object.freeze(['auto_success', 'check', 'counter_offer'])
export const FREE_ACTION_SKILLS = Object.freeze([
  'acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception',
  'history', 'insight', 'intimidation', 'investigation', 'medicine', 'nature',
  'perception', 'performance', 'persuasion', 'religion', 'sleight-of-hand',
  'stealth', 'survival',
])
export const FREE_ACTION_PROFICIENCY_LEVELS = Object.freeze(['none', 'proficient', 'expertise'])
export const FREE_ACTION_CONSEQUENCE_TYPES = Object.freeze(['time', 'noise', 'exposure', 'lost_opportunity', 'injury'])
export const FREE_ACTION_ACTIVITY_KINDS = Object.freeze(['routine', 'stunt', 'environmental', 'stealth', 'social', 'knowledge'])
export const FREE_ACTION_DURATION_CLASSES = Object.freeze(['instant', 'brief', 'minutes', 'extended', 'prolonged'])
const LEGACY_RESOLUTION_POLICY_VERSION = 'free-action-resolution/v1'
const RESOLUTION_POLICY_VERSION = 'free-action-resolution/v2'
export const FREE_ACTION_RESOLUTION_POLICY_VERSION = RESOLUTION_POLICY_VERSION

const inEnum = (values, value, fallback) => (values.includes(String(value)) ? String(value) : fallback)

const HAZARD_ALIASES = Object.freeze({
  fire: Object.freeze(['fire', 'hazard-fire', 'огонь', 'огня', 'огнем', 'огнём', 'пламя', 'пламени', 'костер', 'костёр', 'костра', 'жаровня', 'жаровни', 'горящий']),
  scalding: Object.freeze(['scalding', 'hazard-scalding', 'кипяток', 'кипятка', 'паром', 'паре', 'ошпар']),
  caustic: Object.freeze(['acid', 'caustic', 'hazard-acid', 'hazard-caustic', 'кислота', 'кислоты', 'кислотой', 'едкое', 'едкой', 'щелочь', 'щелочи']),
  fall: Object.freeze(['fall', 'hazard-fall', 'падение', 'падения', 'падаю', 'падать', 'обрыв', 'обрыва', 'пропасть', 'пропасти']),
  crush: Object.freeze(['crush', 'hazard-crush', 'обвал', 'обвала', 'обрушение', 'обрушения', 'придав', 'раздав', 'столкнов', 'вреза']),
  shards: Object.freeze(['shards', 'hazard-shards', 'осколок', 'осколки', 'стекло', 'стекла', 'обломок', 'обломки', 'шип']),
})

const HAZARD_CONTACT_VERBS = /(?:сажусь|садя|сесть|сяду|сижу|ложусь|ложа|наступа|трога|каса|прикаса|лезу|лезть|вхожу|войти|ступа|прыга|прыгнуть|броса|обжига|облокачива|наклоняюсь)/iu
const UNKNOWN_HAZARD_WORDS = /(?:опасност|ловуш|метеор|лав[аы]|яд|токсич|скольз|пропаст|обрыв|обвал|шип|оскол|стекл)/iu
const HAZARD_AVOIDANCE = /(?:перепрыг|перешаг|обход|обхожу|обойти|мимо|держусь +подальше|(?:прыга|прыгну|перепрыг)[^.!?]{0,40} +(?:через|мимо))/iu
const HAZARD_NEAR_OR_NONE = /(?:рядом +с|возле|около|не +(?:каса|трога|наступ|вхож|пада|прыга|лез))/iu
const WALL_COLLISION_ACTION = /(?<![\p{L}\p{M}])врезаюсь(?![\p{L}\p{M}])[^.!?]{0,64}(?<![\p{L}\p{M}])стен(?:а|ы|е|у|ой|ами|ах)(?![\p{L}\p{M}])/iu
const WALL_COLLISION_NEGATION = /(?<![\p{L}\p{M}])не\s+врезаю\p{L}*/iu
const WALL_BREAK_ACTION = /(?:пролом|пробива|пробить|пробью|лома\p{L}*|выламыва\p{L}*|разруш\p{L}*|разбива\p{L}*)/iu
const WALL_COLLISION_NON_ACTION = /(?:\?|(?<![\p{L}\p{M}])(?:если|хочу|могу|можно)(?![\p{L}\p{M}]))/iu
const SELF_HAZARD_CONTACT_VERBS = /(?<![\p{L}\p{M}])(?:сажусь|сяду|сижу|ложусь|лягу|вхожу|наступаю|трогаю|касаюсь|прикасаюсь|лезу|прыгаю)(?![\p{L}\p{M}])/iu
const SELF_HAZARD_CONTACT_NEGATION = /(?<![\p{L}\p{M}])не\s+(?:сажусь|сяду|сижу|ложусь|лягу|вхожу|наступаю|трогаю|касаюсь|прикасаюсь|лезу|прыгаю)(?![\p{L}\p{M}])/iu

/** Приводит название опасности к закрытому серверному каталогу. */
export function canonicalEnvironmentHazardId(value = '') {
  const normalized = clean(value, 80).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (ENVIRONMENT_HAZARD_IDS.includes(normalized)) return normalized
  return ENVIRONMENT_HAZARD_IDS.find((id) => (HAZARD_ALIASES[id] ?? []).some((alias) => normalized.includes(alias))) ?? ''
}

function hazardIdMentionedIn(text = '') {
  const value = clean(text, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  return Object.entries(HAZARD_ALIASES).find(([, aliases]) => aliases.some((alias) => value.includes(alias)))?.[0] ?? ''
}

function hazardIntentFor(text, reading = {}) {
  const hazardId = canonicalEnvironmentHazardId(reading.hazard) || hazardIdMentionedIn(text)
    || (HAZARD_CONTACT_VERBS.test(clean(text, 1_000)) && UNKNOWN_HAZARD_WORDS.test(clean(text, 1_000)) ? 'unknown' : '')
  return hazardId || null
}

function hazardRelationFor(text, reading = {}) {
  const value = clean(text, 1_000)
  const hazardId = hazardIntentFor(value, reading)
  if (!hazardId) return null
  if (SELF_HAZARD_CONTACT_NEGATION.test(value) || WALL_COLLISION_NON_ACTION.test(value)) return { hazard_id: hazardId, relation: 'none' }
  if (HAZARD_NEAR_OR_NONE.test(value)) return { hazard_id: hazardId, relation: 'none' }
  if (HAZARD_AVOIDANCE.test(value)) return { hazard_id: hazardId, relation: 'avoid' }
  if (!HAZARD_CONTACT_VERBS.test(value)) return null
  // Контакт с опасностью — самоурон. Подстановка другого существа под огонь
  // идёт отдельным эффектом hazard_damage и сюда не попадает.
  if (reading.effect === 'hazard_damage') return null
  if (reading.target_id || reading.effect_target) return { hazard_id: hazardId, relation: 'invalid_target' }
  return { hazard_id: hazardId, relation: 'contact' }
}

function wallCollisionIntent(text) {
  const value = clean(text, 1_000)
  return WALL_COLLISION_ACTION.test(value)
    && !WALL_COLLISION_NEGATION.test(value)
    && !WALL_BREAK_ACTION.test(value)
    && !WALL_COLLISION_NON_ACTION.test(value)
}

function selfHazardContactId(state, text, reading, actorId) {
  const value = clean(text, 1_000)
  if (!SELF_HAZARD_CONTACT_VERBS.test(value)
    || SELF_HAZARD_CONTACT_NEGATION.test(value)
    || HAZARD_NEAR_OR_NONE.test(value)
    || HAZARD_AVOIDANCE.test(value)) return ''
  const targets = [reading.target_id, reading.effect_target].map((target) => String(target ?? '').trim()).filter(Boolean)
  const hazardId = hazardIdMentionedIn(value)
  const sourceIds = targets.length ? nearestHazardAt(state, actorId)
    .filter(candidate => candidate.hazard_id === hazardId)
    .map(candidate => candidate.source?.id).filter(Boolean) : []
  if (targets.some((target) => target !== String(actorId) && !sourceIds.includes(target))) return ''
  // Предмет-источник может быть целью прочтения, но урон от явного контакта
  // получает сам герой. Название опасности берём из его исходного действия.
  return hazardId
}

function visibleMapForHazards(state) {
  const serialized = state?.scene?.map
  if (!serialized || typeof serialized !== 'object') return null
  try { return deserializeTacticalMap(serialized) } catch { return null }
}

function nearestHazardAt(state, actorId) {
  const at = actorPosition(state, actorId)
  if (!at) return []
  const map = visibleMapForHazards(state)
  const candidates = []
  if (map) {
    for (const [index, rawHazard] of Object.entries(map.hazards ?? {})) {
      const cellIndexValue = Number(index)
      if (!Number.isSafeInteger(cellIndexValue) || cellIndexValue < 0) continue
      const x = cellIndexValue % map.width
      const y = Math.floor(cellIndexValue / map.width)
      const cell = cellAt(map, x, y)
      const hazardId = canonicalEnvironmentHazardId(rawHazard)
      if (!cell?.revealed || !hazardId) continue
      candidates.push({ hazard_id: hazardId, source: { kind: 'cell', x, y, cells: [{ x, y }], hazard_id: String(rawHazard) }, distance: Math.max(Math.abs(x - at.x), Math.abs(y - at.y)) })
    }
    for (const prop of map.props ?? []) {
      const propVisibility = String(prop?.visibility ?? prop?.interaction?.visibility ?? '').toLowerCase()
      if (['gm_only', 'npc_private'].includes(propVisibility) || prop?.revealed === false) continue
      const tags = sceneHazardTagsFor(prop?.assetId)
      const stateId = String(state?.mechanics?.scene_interactions?.[String(prop?.id ?? '')]?.state ?? prop?.state ?? '').toLowerCase()
      const cells = hazardPropCells(prop)
      const visible = cells.some((cell) => cellAt(map, cell.x, cell.y)?.revealed === true)
      const inactiveFire = ['extinguished', 'unlit', 'cold', 'out', 'burned', 'off', 'disabled'].includes(stateId)
      if (!visible || inactiveFire || (!tags.fireSource && !(tags.flammable && stateId === 'burning'))) continue
      const distance = Math.min(...cells.map((cell) => Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y))), Number.POSITIVE_INFINITY)
      candidates.push({ hazard_id: 'fire', source: { kind: 'prop', id: String(prop?.id ?? ''), asset_id: String(prop?.assetId ?? ''), cells }, distance })
    }
  }
  // Старые снимки могут хранить открытые опасные клетки без tactical map.
  for (const cell of Array.isArray(state?.scene?.cells) ? state.scene.cells : []) {
    const hazardId = canonicalEnvironmentHazardId(cell?.hazardId ?? cell?.hazard_id)
    const x = Math.floor(Number(cell?.x)); const y = Math.floor(Number(cell?.y))
    if (!hazardId || cell?.revealed !== true || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) continue
    candidates.push({ hazard_id: hazardId, source: { kind: 'cell', x, y, cells: [{ x, y }], hazard_id: String(cell.hazardId ?? cell.hazard_id) }, distance: Math.max(Math.abs(x - at.x), Math.abs(y - at.y)) })
  }
  for (const hazard of Array.isArray(state?.mechanics?.hazards?.[String(actorId)]) ? state.mechanics.hazards[String(actorId)] : []) {
    const hazardId = canonicalEnvironmentHazardId(hazard?.id ?? hazard?.hazard_id ?? hazard?.type)
    if (hazardId) candidates.push({ hazard_id: hazardId, source: { kind: 'active-hazard', id: String(hazard?.id ?? hazardId) }, distance: 0 })
  }
  return candidates.sort((left, right) => left.distance - right.distance || left.hazard_id.localeCompare(right.hazard_id))
}

function hazardCandidateReachable(state, actorId, candidate) {
  if (candidate?.source?.kind === 'active-hazard') return true
  const map = visibleMapForHazards(state)
  if (!map) return candidate?.distance <= 1
  const cells = Array.isArray(candidate?.source?.cells) ? candidate.source.cells : []
  return cells.some((cell) => {
    const path = shortestTacticalPath(state, actorId, cell, { allowOccupiedDestination: true })
    return Array.isArray(path) && path.length <= 1
  })
}

function wallContactSource(state, actorId) {
  const at = actorPosition(state, actorId)
  if (!at) return null
  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const map = visibleMapForHazards(state)
  const nativeEdges = new Set()
  if (map) {
    const origin = cellAt(map, at.x, at.y)
    if (origin?.revealed !== true) return null
    for (const [dx, dy] of neighbors) {
      const x = at.x + dx
      const y = at.y + dy
      const edge = edgeBetween(map, at.x, at.y, x, y)
      if (!edge) continue
      nativeEdges.add(`${x},${y}`)
      if (edge.kind === 'wall' && edge.blocksMove === true) {
        return { kind: 'wall-edge', x: edge.x, y: edge.y, dir: edge.dir, cells: [{ x: at.x, y: at.y }, { x, y }] }
      }
    }
  }
  const legacyCells = Array.isArray(state?.scene?.cells) ? state.scene.cells : []
  const current = legacyCells.find((cell) => Number(cell?.x) === at.x && Number(cell?.y) === at.y)
  if (current?.revealed !== true) return null
  for (const [dx, dy] of neighbors) {
    if (nativeEdges.has(`${at.x + dx},${at.y + dy}`)) continue
    const wall = legacyCells.find((cell) => (
      Number(cell?.x) === at.x + dx
      && Number(cell?.y) === at.y + dy
      && String(cell?.type ?? '') === 'wall'
      && cell?.revealed === true
    ))
    if (wall) return { kind: 'wall-cell', x: Number(wall.x), y: Number(wall.y), cells: [{ x: at.x, y: at.y }, { x: Number(wall.x), y: Number(wall.y) }] }
  }
  return null
}

/** Разрешает только намеренный контакт с реально видимой ближайшей опасностью. */
export function resolveHazardContact(state = {}, actorId = '', text = '', reading = {}) {
  const selfHazard = selfHazardContactId(state, text, reading, actorId)
  if (selfHazard) reading = { ...reading, hazard: selfHazard, effect: 'none', target_id: '', effect_target: '' }
  if (wallCollisionIntent(text) && reading.effect !== 'hazard_damage' && !reading.target_id && !reading.effect_target) {
    const source = wallContactSource(state, actorId)
    if (!source) return {
      status: 'unavailable', relation: 'contact', hazard_id: 'crush',
      reason: 'Рядом с героем нет доступной стены для такого удара.',
    }
    const profile = ENVIRONMENT_HAZARDS.crush
    const risk = inEnum(RISK_LEVELS, reading.risk, 'minor')
    return {
      status: 'contact', relation: 'contact', hazard_id: 'crush',
      expression: profile.expressions[risk] ?? profile.expressions.minor,
      damage_type: profile.damage_type,
      label: 'удар о стену',
      source,
      distance: 1,
    }
  }
  const relation = hazardRelationFor(text, reading)
  if (!relation || relation.relation === 'none') return null
  const requestedHazard = relation.hazard_id
  if (relation.relation === 'invalid_target') return {
    status: 'unavailable', relation: relation.relation, hazard_id: requestedHazard,
    reason: 'Намеренный контакт с опасностью разрешён только самому герою.',
  }
  const nearby = nearestHazardAt(state, actorId).find((candidate) => candidate.distance <= 1
    && candidate.hazard_id === requestedHazard && hazardCandidateReachable(state, actorId, candidate))
  if (!nearby) return {
    status: 'unavailable', relation: relation.relation, hazard_id: requestedHazard,
    reason: 'Рядом с героем нет доступного источника этой опасности.',
  }
  if (relation.relation === 'avoid') return {
    status: 'avoid', relation: 'avoid', hazard_id: requestedHazard,
    source: nearby.source, distance: nearby.distance,
  }
  const profile = ENVIRONMENT_HAZARDS[nearby.hazard_id]
  const risk = inEnum(RISK_LEVELS, reading.risk, 'minor')
  return {
    status: 'contact', relation: 'contact', hazard_id: nearby.hazard_id,
    expression: profile.expressions[risk] ?? profile.expressions.minor,
    damage_type: profile.damage_type,
    label: profile.label,
    source: nearby.source,
    distance: nearby.distance,
  }
}

/** Есть ли у указанной видимой цели подтверждённая ближайшая опасность. */
export function confirmedHazardNear(state = {}, actorId = '', hazardId = '') {
  const expected = canonicalEnvironmentHazardId(hazardId)
  return Boolean(expected && nearestHazardAt(state, actorId).some((candidate) => candidate.distance <= 1
    && candidate.hazard_id === expected && hazardCandidateReachable(state, actorId, candidate)))
}

const canonicalSkill = (value) => {
  const normalized = clean(value, 60).toLocaleLowerCase('en').replace(/_/gu, '-')
  return inEnum(FREE_ACTION_SKILLS, normalized, 'perception')
}

/**
 * Шаг 3 брифа: ведущий не требует броска, когда на кону ничего нет. Незапертую дверь
 * открывают без кубика — это правило, а не срезание угла.
 */
export function resolutionModeFor({ plausibility, risk } = {}) {
  const level = inEnum(PLAUSIBILITY_LEVELS, plausibility, 'plausible')
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  if (level === 'impossible_without_means') return { mode: 'counter_offer', difficulty_category: null, difficulty: null }
  if (stake === 'none' && (level === 'trivial' || level === 'plausible')) {
    return { mode: 'auto_success', difficulty_category: null, difficulty: null }
  }
  const category = level === 'trivial'
    ? 'easy'
    : level === 'strenuous' || stake === 'deadly'
      ? 'hard'
      : 'medium'
  return { mode: 'check', difficulty_category: category, difficulty: DIFFICULTY_CLASSES[category] }
}

/**
 * Шаг 1 брифа, детерминированная половина. Модель, когда она доступна, предлагает те же
 * поля из тех же перечислений; здесь они выводятся из текста без вызова LLM, чтобы игра
 * оставалась играбельной без ключа.
 *
 * Подход определяет характеристику: «запугиваю силой» — это Запугивание от Силы, поэтому
 * характеристика и навык выбираются независимо друг от друга.
 */
const APPROACH_PATTERNS = Object.freeze([
  { test: /(?<![\p{L}\p{M}])(?:сальто|кувырк\p{L}*|кувырок|кульбит\p{L}*|фляк\p{L}*|рондат\p{L}*|балансир\p{L}*|пируэт\p{L}*|акробатическ\p{L}*\s+(?:трюк|переворот))(?![\p{L}\p{M}])/iu, ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'minor', obstacle: 'равновесие и точность движения' },
  { test: /(?:отвле[кч]|переключ\p{L}*\s+внимани|шум\p{L}*\s+приманк)/iu, ability: 'cha', skill: 'performance', plausibility: 'plausible', risk: 'minor', obstacle: 'внимание собеседника' },
  { test: /(подпира|баррикад|завал|подпер|держ\w+\s+двер)/iu, ability: 'str', skill: 'athletics', plausibility: 'plausible', risk: 'minor', obstacle: 'дверь' },
  { test: /(взлам|выбива|выломать|ломаю)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'преграда' },
  { test: /(опрокид|сбива|толка|рывк|поднож|жаровн|спотык|оступить)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'противник' },
  { test: /(поджиг|зажиг|подпал|факел\w*\s+к)/iu, ability: 'dex', skill: 'sleight-of-hand', plausibility: 'plausible', risk: 'serious', obstacle: 'огонь' },
  { test: /(крад|тих\w+|незамет|прячусь|скрыва)/iu, ability: 'dex', skill: 'stealth', plausibility: 'plausible', risk: 'minor', obstacle: 'наблюдатели' },
  { test: /(запуг|угрож|пригрож)/iu, ability: 'cha', skill: 'intimidation', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(убежда|уговар|догова|прош\w+\s+помощ)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(обман|вру|соврать|притвор)/iu, ability: 'cha', skill: 'deception', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(крич|зову|окликa|подзыва)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'окружающие' },
  { test: /(осматр|разгляд|изуча|ищу\s+след|обыск)/iu, ability: 'wis', skill: 'perception', plausibility: 'trivial', risk: 'none', obstacle: 'обстановка' },
  { test: /(вспомина|припомин|знаю\s+ли|что\s+известно)/iu, ability: 'int', skill: 'history', plausibility: 'trivial', risk: 'none', obstacle: 'память' },
  { test: /(залез|взбира|караб|подтягива)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'высота' },
  { test: /(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|перескоч)/iu, ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'serious', obstacle: 'разрыв' },
])

/**
 * Приведение прочтения к контракту. Отдельная функция, потому что тот же контракт
 * обязан выдержать и предложение модели: перечисления одни и те же, а незнакомое
 * значение молча заменяется безопасным, а не доходит до движка.
 */
export function normalizeFreeActionReading(input = {}, fallbackText = '') {
  const value = clean(fallbackText, 1_000)
  return {
    goal_summary: clean(input.goal_summary, 200) || value.slice(0, 200),
    approach_summary: clean(input.approach_summary, 200) || value.slice(0, 200),
    ability: inEnum(['str', 'dex', 'con', 'int', 'wis', 'cha'], input.ability, 'wis'),
    skill: canonicalSkill(input.skill),
    plausibility: inEnum(PLAUSIBILITY_LEVELS, input.plausibility, 'plausible'),
    risk: inEnum(RISK_LEVELS, input.risk, 'minor'),
    obstacle: clean(input.obstacle, 120) || value.slice(0, 120),
    required_means: [...new Set((Array.isArray(input.required_means) ? input.required_means : [])
      .map((entry) => clean(entry, 160)).filter(Boolean))].slice(0, 4),
    // Цена хода и эффект проверяются каталогом `improvised-effects.mjs`;
    // здесь достаточно не пропустить мусор дальше.
    action_cost: inEnum(['action', 'bonus_action', 'free'], input.action_cost, 'action'),
    effect: clean(input.effect, 40) || 'none',
    effect_target: clean(input.effect_target, 120),
    hazard: canonicalEnvironmentHazardId(input.hazard),
    // Предмет обстановки для `topple_prop`/`ignite_prop`. Здесь только форма:
    // существует ли такой предмет на карте, решает привязка к состоянию ниже.
    prop_id: clean(input.prop_id, 120),
    target_id: clean(input.target_id, 120),
    item_id: clean(input.item_id, 120),
    proficiency: inEnum(FREE_ACTION_PROFICIENCY_LEVELS, input.proficiency, 'none'),
    consequence_type: inEnum(FREE_ACTION_CONSEQUENCE_TYPES, input.consequence_type, 'time'),
    activity_kind: inEnum(FREE_ACTION_ACTIVITY_KINDS, input.activity_kind, ''),
    duration_class: inEnum(FREE_ACTION_DURATION_CLASSES, input.duration_class, ''),
    source: clean(input.source, 60) || 'deterministic-default',
  }
}

/** Бытовые жесты со своей вещью вне боя: нет противодействия и нет броска. */
export function harmlessFreeActionReading(state, actorId, text) {
  if (state?.mechanics?.combat?.active) return null
  const value = clean(text, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (/[;]|\b(?:if|then)\b|(?:затем|потом|чтобы|противник|страж|двер|обрыв|пропаст|огонь|подж|связать\s+его)/iu.test(value)) return null
  const actor = (state?.players ?? []).find(entry => String(entry.id) === String(actorId))
  if (!actor) return null
  const ropeGesture = /^(?:я\s+)?(?:развязываю\s+и\s+заново\s+завязываю|завязываю|перевязываю|сматываю|распутываю)\s+(?:(?:свою|имеющуюся)\s+)?веревку(?:,?\s+проверяя\s+прочность\s+узлов(?:\s+перед\s+использованием)?)?[.!]?$/u.test(value)
  const rope = ropeGesture
    ? (actor.inventory ?? []).find(item => /веревк|rope/iu.test(String(item.name).replace(/ё/gu, 'е'))) : null
  const coinGesture = /^(?:я\s+)?подбрасываю\s+(?:свою\s+)?монету\s+и\s+ловлю\s+(?:ее\s+)?(?:(?:другой|левой|правой)\s+)?рукой[.!]?$/u.test(value)
  const coin = coinGesture
    && Object.values(actor.currency ?? {}).some(amount => Number(amount) > 0)
  if ((coinGesture && !coin) || (ropeGesture && !rope)) return normalizeFreeActionReading({
    goal_summary: clean(text, 200), approach_summary: clean(text, 200),
    plausibility: 'impossible_without_means', risk: 'none', effect: 'none',
    required_means: [coinGesture ? 'монета' : 'верёвка'], source: 'deterministic-trivial',
  }, text)
  if (!rope && !coin) return null
  return normalizeFreeActionReading({
    goal_summary: clean(text, 200), approach_summary: clean(text, 200),
    plausibility: 'trivial', risk: 'none', effect: 'none', action_cost: 'free',
    ability: 'dex', skill: 'sleight_of_hand', item_id: rope?.id ?? '',
    required_means: rope ? [String(rope.id)] : [], source: 'deterministic-trivial',
  }, text)
}

export function interpretFreeAction(text = '') {
  const value = clean(text, 1_000)
  const match = APPROACH_PATTERNS.find((pattern) => pattern.test.test(value)) ?? null
  const consequenceType = ['stealth', 'deception'].includes(match?.skill)
    ? 'exposure'
    : ['persuasion', 'intimidation'].includes(match?.skill)
      ? 'lost_opportunity'
      : /(крич|лома|выбива|поджиг|зажиг)/iu.test(value)
        ? 'noise'
        : 'time'
  return normalizeFreeActionReading({
    ability: match?.ability,
    skill: match?.skill,
    plausibility: match?.plausibility,
    risk: match?.risk,
    obstacle: match?.obstacle,
    // Детерминированная таблица механических следствий не назначает: она не
    // понимает, что именно в сцене можно опрокинуть. Это работа агента.
    effect: 'none',
    consequence_type: consequenceType,
    source: match ? 'deterministic-pattern' : 'deterministic-default',
  }, value)
}

/**
 * Детерминированный fallback не должен выбирать Восприятие для фразы, смысл
 * которой он не понял. Модель может распознать такой текст отдельно, но без
 * её подтверждённого прочтения действие получает уточнение.
 */
export function hasRecognizedFreeActionApproach(text = '') {
  const value = clean(text, 1_000)
  return APPROACH_PATTERNS.some((pattern) => pattern.test.test(value))
}

/** Проверка согласованной заявки до расходования зарегистрированной кости. */
export function assertFreeActionConfirmation(context, text, stateVersion) {
  if (context?.kind !== 'free_action' || context.action_fingerprint !== digest(clean(text, 1_000)) || !context.reading) {
    const error = new Error('Бросок не относится к согласованной заявке. Отправьте действие ещё раз, чтобы согласовать проверку.')
    error.code = 'ROLL_CONTEXT_MISMATCH'
    throw error
  }
  if (!Number.isSafeInteger(context.state_version) || context.state_version !== stateVersion) {
    const error = new Error('Обстановка изменилась после предложения. Отправьте действие ещё раз: ведущий заново проверит цену и последствия.')
    error.code = 'STATE_VERSION_CONFLICT'
    throw error
  }
}

function normalizedWords(value) {
  return clean(value, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    .match(/\p{L}[\p{L}\p{M}0-9-]*/gu) ?? []
}

function wordStem(value) {
  const word = String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (!/^[а-я]{3,}$/u.test(word)) return word
  for (const suffix of ['иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ах', 'ях', 'ой', 'ей', 'ом', 'ем', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length)
  }
  return word
}

function mentionsReference(text, values) {
  const message = normalizedWords(text)
  return (Array.isArray(values) ? values : []).some((value) => {
    const words = normalizedWords(value)
    return words.length > 0 && words.every((word) => message.some((candidate) => (
      candidate === word || wordStem(candidate) === wordStem(word)
    )))
  })
}

function currentSocialActors(state) {
  const location = clean(state?.scene?.location, 180).toLocaleLowerCase('ru')
  return (state?.social?.npcs ?? []).filter((npc) => {
    const npcLocation = clean(npc?.location, 180).toLocaleLowerCase('ru')
    return npc?.available !== false && (!location || !npcLocation || location === npcLocation)
  })
}

function referenceNames(actor) {
  return [
    actor?.id,
    actor?.name,
    actor?.character,
    actor?.label,
    actor?.role,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
    ...(Array.isArray(actor?.tags) ? actor.tags.filter((tag) => !String(tag).includes(':')) : []),
  ].map((value) => clean(value, 160)).filter(Boolean)
}

function itemReferenceNames(item) {
  return [item?.id, item?.catalog_id, item?.name, item?.label]
    .map((value) => clean(value, 160)).filter(Boolean)
}

function namedActors(candidates, text) {
  const ranked = candidates.map(actor => ({ actor, score: mentionsReference(text, referenceNames(actor)) ? 2
    : [actor.name, actor.character, actor.label].some(name => {
      const words = normalizedWords(name)
      return words.length > 1 && mentionsReference(text, [words[0]])
    }) ? 1 : 0 })).filter(entry => entry.score > 0)
  const best = Math.max(0, ...ranked.map(entry => entry.score))
  return ranked.filter(entry => entry.score === best).map(entry => entry.actor)
}

function actionTargets(state, actorId) {
  const visible = campaignStateForViewer(state, { role: 'player' }, actorId) ?? {}
  const social = npcSocialForViewer(state.social, { state, playerId: actorId, isPartyMember: true })
  return [...new Map([
    ...(state?.players ?? []),
    ...(visible.actors ?? []),
    ...(visible.enemies ?? []),
    ...currentSocialActors({ ...state, social }),
  ].map((actor) => [String(actor?.id ?? ''), actor]).filter(([id]) => id)).values()]
}

/**
 * Модель может назвать только ID из переданного брифа. Сервер повторно
 * связывает их с текущим состоянием, выводит отсутствующие ссылки из текста и
 * всегда перезаписывает уровень владения значением из листа героя.
 */
export function bindFreeActionReadingToState(state = {}, actorId = '', text = '', input = {}, { preserveActionProfile = false } = {}) {
  const reading = normalizeFreeActionReading(input, text)
  if (!preserveActionProfile) {
    const hazardRelation = hazardRelationFor(text, reading)
    if (hazardRelation?.relation === 'none') {
      reading.hazard = ''
      reading.activity_kind = 'routine'
      reading.plausibility = 'trivial'
      reading.risk = 'none'
      reading.consequence_type = 'time'
      reading.duration_class = 'instant'
    } else if (reading.hazard && !hazardRelation && reading.effect !== 'hazard_damage') {
      // Поле hazard от модели не создаёт опасность без причинной связи в тексте.
      reading.hazard = ''
    }
    const social = ['animal-handling', 'deception', 'intimidation', 'performance', 'persuasion'].includes(reading.skill)
    const physical = ['acrobatics', 'athletics'].includes(reading.skill)
    const routine = (reading.activity_kind === 'routine' || reading.source.startsWith('deterministic-trivial')
      || (!reading.activity_kind && !physical)) && reading.risk === 'none'
      && reading.plausibility === 'trivial' && reading.effect === 'none'
      && !reading.hazard && !reading.target_id && !reading.effect_target
    // Механика зависит от семейства действия, а не от наличия слова из примера.
    reading.activity_kind = routine ? 'routine'
      : reading.skill === 'acrobatics' || (reading.activity_kind === 'stunt' && physical) ? 'stunt'
        : reading.skill === 'stealth' ? 'stealth'
          : social ? 'social'
            : ['athletics', 'sleight-of-hand', 'medicine'].includes(reading.skill) ? 'environmental' : 'knowledge'
    if (reading.activity_kind === 'stunt') {
      if (reading.plausibility !== 'impossible_without_means') reading.plausibility = 'strenuous'
      if (reading.risk === 'none') reading.risk = 'minor'
      reading.consequence_type = 'injury'
      reading.duration_class = 'instant'
    } else {
      // Огонь, обвал и ловушки исполняются своими командами реального объекта;
      // слово injury от модели не создаёт отсутствующую опасность окружения.
      if (reading.consequence_type === 'injury') {
        reading.consequence_type = social ? 'lost_opportunity' : 'time'
      }
      if (!reading.duration_class) {
        reading.duration_class = routine || (reading.risk === 'none' && reading.plausibility === 'trivial')
          || ['history', 'arcana', 'nature', 'religion'].includes(reading.skill) ? 'instant'
          : social || reading.skill === 'stealth' ? 'brief' : 'minutes'
      }
    }
  }
  // Предмет обстановки живёт в авторитетной карте сцены, а не в списке
  // участников: сверяется он отдельно и по тому же принципу — назван моделью,
  // но существует ли он, решает сервер.
  const sceneProps = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  const boundPropId = sceneProps.some((prop) => String(prop?.id ?? '') === reading.prop_id) ? reading.prop_id : ''
  const targets = actionTargets(state, actorId).filter((actor) => String(actor?.id) !== String(actorId))
  const allowedTarget = targets.find((actor) => String(actor?.id) === reading.target_id) ?? null
  const mentionedTargets = allowedTarget ? [allowedTarget] : namedActors(targets, text)
  const actor = findActor(state, actorId)
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  const allowedItem = inventory.find((item) => String(item?.id) === reading.item_id) ?? null
  const mentionedItems = allowedItem ? [allowedItem] : inventory.filter((item) => mentionsReference(text, itemReferenceNames(item)))
  const proficiency = skillProficiencyForActor(actor, reading.skill)
  const ambiguities = [
    ...(mentionedTargets.length > 1 ? ['target_id'] : []),
    ...(mentionedItems.length > 1 ? ['item_id'] : []),
  ]
  return {
    ...reading,
    prop_id: boundPropId,
    target_id: mentionedTargets.length === 1 ? String(mentionedTargets[0].id) : '',
    item_id: mentionedItems.length === 1 ? String(mentionedItems[0].id) : '',
    proficiency: proficiency.expertise ? 'expertise' : proficiency.proficient ? 'proficient' : 'none',
    proficiency_bonus: proficiency.bonus,
    reference_ambiguities: ambiguities,
    // Старые согласованные проверки сохраняют прежнюю цену при подтверждении.
    policy_version: preserveActionProfile
      ? [RESOLUTION_POLICY_VERSION, LEGACY_RESOLUTION_POLICY_VERSION].includes(input.policy_version) ? input.policy_version : null
      : RESOLUTION_POLICY_VERSION,
  }
}

const DIFFICULTY_ORDER = Object.freeze(['easy', 'medium', 'hard'])

/**
 * СЛ остаётся серверной: модель сообщает только смысл/риск. Контекст сдвигает
 * категорию максимум на одну ступень за каждую подтверждённую причину.
 */
export function contextualResolutionFor(state = {}, actorId = '', reading = {}, text = '') {
  const base = resolutionModeFor(reading)
  if (base.mode !== 'check') return { ...base, difficulty_factors: [] }
  let index = DIFFICULTY_ORDER.indexOf(base.difficulty_category)
  const factors = []
  const actor = findActor(state, actorId)
  const item = (actor?.inventory ?? []).find((entry) => String(entry?.id) === String(reading.item_id ?? ''))
  if (item) {
    index -= 1
    factors.push('confirmed_item')
  }
  const hasCover = reading.skill === 'stealth'
    && /(телег|бочк|укрыт|занавес|тень|колонн|ящик)/iu.test(text)
    && (state?.scene?.map?.props?.length > 0 || state?.scene?.cells?.length > 0)
  if (hasCover) {
    index -= 1
    factors.push('scene_cover')
  }
  if (state?.mechanics?.combat?.active) {
    index += 1
    factors.push('combat_pressure')
  }
  const environmentalPressure = `${text} ${state?.scene?.mood ?? ''}`
  if (/(шторм|бур[яе]|пожар|обвал|скольз|темнот|дым|хаос|движущ)/iu.test(environmentalPressure)) {
    index += 1
    factors.push('environmental_pressure')
  }
  if (/(незаперт|прост\w+\s+задач|без\s+спешк|много\s+времен)/iu.test(text)) {
    index -= 1
    factors.push('favorable_conditions')
  }
  const difficulty_category = DIFFICULTY_ORDER[Math.max(0, Math.min(DIFFICULTY_ORDER.length - 1, index))]
  return {
    ...base,
    difficulty_category,
    difficulty: DIFFICULTY_CLASSES[difficulty_category],
    difficulty_factors: factors,
  }
}

const TRANSFER_GIVE = /(?<![\p{L}\p{M}])(переда\p{L}*|отда\p{L}*|даю|дам|вруча\p{L}*|give|hand)(?![\p{L}\p{M}])/iu
const TRANSFER_TAKE = /(?<![\p{L}\p{M}])(беру|возьму|забира\p{L}*|получа\p{L}*|take|get)(?![\p{L}\p{M}])/iu
const INVENTORY_NOUN = /(предмет|вещ|вер[её]в|меч|кинжал|лук|факел|зель|ключ|карта|свиток|па[её]к|ration|rope|item)/iu

function partyActors(state, actorId) {
  const visibleNpcIds = new Set(npcSocialForViewer(state.social, { state, playerId: actorId, isPartyMember: true }).npcs.map(npc => String(npc.id)))
  return [...(state?.players ?? []), ...(state.social?.npcs ?? []).filter(npc => visibleNpcIds.has(String(npc.id)))]
    .filter((actor) => String(actor?.id) !== String(actorId))
}

function mentionedPartyActors(state, actorId, text, requestedId = '') {
  const candidates = partyActors(state, actorId)
  const requested = candidates.find((actor) => String(actor?.id) === String(requestedId ?? ''))
  if (requested) return [requested]
  const mentioned = namedActors(candidates, text)
  if (mentioned.length) return mentioned
  return /(?:товарищ|союзник|другому\s+герою|напарник)/iu.test(text) && candidates.length === 1 ? candidates : []
}

function mentionedInventoryItems(inventory, text, requestedId = '') {
  const requested = (inventory ?? []).find((item) => String(item?.id) === String(requestedId ?? ''))
  if (requested) return [requested]
  return (inventory ?? []).filter((item) => mentionsReference(text, itemReferenceNames(item)))
}

/**
 * Возвращает существующую авторитетную TransferItem либо уточнение. Чужой
 * инвентарь никогда не становится actor_id команды от лица запрашивающего
 * игрока: «беру у товарища» требует действия владельца вещи.
 */
export function resolveInventoryTransfer(state = {}, actorId = '', text = '', reading = {}) {
  const give = TRANSFER_GIVE.test(text)
  const take = TRANSFER_TAKE.test(text)
  if (!give && !take) return null
  const actor = findActor(state, actorId)
  if (!actor) return { status: 'clarification', narration: 'Герой для передачи предмета не найден.' }
  const targets = mentionedPartyActors(state, actorId, text, reading.target_id)
  const ownItems = mentionedInventoryItems(actor.inventory ?? [], text, reading.item_id)
  if (!ownItems.length && !INVENTORY_NOUN.test(text)) return null
  if (targets.length !== 1) {
    return {
      status: 'clarification',
      narration: targets.length > 1
        ? `Уточните получателя: подходят ${targets.map((target) => target.character ?? target.name ?? target.id).join(', ')}.`
        : 'Уточните, кому нужно передать предмет: назовите героя или присутствующего собеседника.',
    }
  }
  const target = targets[0]
  if (take && !give) {
    const sourceItems = mentionedInventoryItems(target.inventory ?? [], text)
    return {
      status: 'clarification',
      narration: sourceItems.length === 1
        ? `Эта вещь принадлежит герою ${target.character ?? target.name ?? target.id}. Передачу должен подтвердить её владелец своим действием.`
        : sourceItems.length > 1
          ? 'У владельца найдено несколько подходящих вещей. Пусть он явно укажет, что передаёт.'
          : 'У указанного героя нет однозначно названного предмета для передачи.',
    }
  }
  if (ownItems.length !== 1) {
    return {
      status: 'clarification',
      narration: ownItems.length > 1
        ? `Уточните предмет: подходят ${ownItems.map((item) => item.name ?? item.id).join(', ')}.`
        : 'У героя нет однозначно названного предмета для передачи.',
    }
  }
  if (state?.mechanics?.combat?.active) {
    return { status: 'clarification', narration: 'Передавать предметы между инвентарями во время боя нельзя.' }
  }
  const item = ownItems[0]
  if (item.equipped) return { status: 'clarification', narration: 'Сначала снимите передаваемый предмет.' }
  if (item.attuned_to) return { status: 'clarification', narration: 'Сначала разорвите настройку с передаваемым предметом.' }
  const requestedQuantity = Number(/(?:^|\s)(\d{1,3})(?=\s|$)/u.exec(text)?.[1] ?? 1)
  const available = Math.max(1, Number(item.quantity) || 1)
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > available) {
    return { status: 'clarification', narration: `Доступное количество предмета: ${available}.` }
  }
  return {
    status: 'command',
    command: {
      command_type: 'TransferItem',
      actor_id: String(actorId),
      recipient_id: String(target.id),
      item_id: String(item.id),
      quantity: requestedQuantity,
    },
    narration: `${actor.character ?? actor.name ?? actor.id} передаёт ${item.name ?? 'предмет'}: получатель — ${target.character ?? target.name ?? target.id}.`,
  }
}

/** Свободная фраза выбирает только существующую команду; путь и замок считает движок. */
export function resolveExplorationCommand(state, actorId, text) {
  const value = clean(text, 2_000)
  const actorAt = actorPosition(state, actorId)
  if (!actorAt || !state.scene?.map) return null
  let map
  try { map = deserializeTacticalMap(state.scene.map) } catch { return null }
  const makeBarricade = /^(?:я\s+)?(?:подпираю|баррикадирую|забаррикадирую|ставлю\s+баррикаду)/iu.test(value)
  const clearBarricade = /^(?:я\s+)?(?:снимаю|убираю|разбираю|выбиваю|разрушаю)\s+баррикаду/iu.test(value)
  const doorOperation = makeBarricade || clearBarricade || (/^(?:я\s+)?(?:открыва|закрыва|отпира|взламыва|выламыва|выбива)/iu.test(value) && /двер/iu.test(value))
  if (doorOperation) {
    const visible = map.doors.filter(door => cellAt(map, door.x, door.y)?.revealed === true)
    const named = visible.filter(door => value.includes(door.id))
    const nearby = doorsReachableFrom(map, actorAt.x, actorAt.y).filter(door => visible.some(entry => entry.id === door.id))
    const candidates = named.length ? named : nearby
    if (candidates.length !== 1) return { status: 'clarification', narration: candidates.length > 1
      ? 'Здесь несколько дверей. Выберите нужную на карте, чтобы я не открыл другую.'
      : 'До двери нужно дотянуться. Подойдите вплотную к нужной двери на карте; сама попытка открыть её пока ничего не расходует.' }
    const door = candidates[0]
    if (makeBarricade) {
      const actor = findActor(state, actorId)
      const items = mentionedInventoryItems(actor?.inventory ?? [], value)
      if (items.length !== 1) return { status: 'clarification', narration: 'Назовите один материал из своего инвентаря: доску, верёвку или подходящую скамью. Предмет будет израсходован на баррикаду.' }
      return { status: 'command', command: { command_type: 'BarricadeDoor', actor_id: String(actorId), door_id: door.id, material_item_id: items[0].id },
        requires_confirmation: true, confirmation: `Материал баррикады: «${items[0].name}» — он будет израсходован. В бою потребуется действие. Подтвердите шаг или выберите другой материал.`,
        narration: `Дверь забаррикадирована. Материал «${items[0].name}» израсходован.` }
    }
    if (clearBarricade || (door.barricade && /^(?:я\s+)?(?:выламываю|выбиваю)/iu.test(value))) {
      const force = /выбиваю|разрушаю|выламываю/iu.test(value)
      return { status: 'command', command: { command_type: 'ClearDoorBarricade', actor_id: String(actorId), door_id: door.id, force },
        requires_confirmation: force,
        confirmation: 'Выбивание баррикады: Атлетика от Силы, СЛ 15. Успех уберёт препятствие, при провале оно останется. В бою действие расходуется в любом случае. Подтвердите шаг или выберите другой способ.',
        narration: 'Баррикада снята. Дверью снова можно пользоваться.' }
    }
    const force = /^(?:я\s+)?(?:выламыва|выбива)/iu.test(value)
    if (force && /не\s+лом|не\s+повреж|без\s+повреж/iu.test(value)) return { status: 'clarification', narration: 'Выламывание повредит дверь. Для целого замка выберите взлом отмычками или другой проход.' }
    const intent = force ? 'force' : /взламыва|отмыч/iu.test(value) ? 'lockpick' : /закрыва/iu.test(value) ? 'close' : 'open'
    if (intent === 'open' && door.state === 'locked') return { status: 'clarification', narration: 'Дверь заперта. Открыть её обычным движением нельзя: можно взломать замок отмычками, выломать дверь с риском шума или поискать другой проход.' }
    return { status: 'command', command: { command_type: 'OperateDoor', actor_id: String(actorId), door_id: door.id, intent }, narration: 'Действие с дверью разрешено по её состоянию.' }
  }
  if (!/^(?:я\s+)?(?:подхожу|приближаюсь|иду)\s+к\s+/iu.test(value) || /(?:затем|потом|и\s+(?:прошу|спрашиваю|атакую|открываю))/iu.test(value)) return null
  if (/не\s+(?:покида|выход|двига)|без\s+перемещ/iu.test(value)) return { status: 'clarification', narration: 'Подход означает перемещение, а вы просите оставаться на месте или под укрытием. Можно обратиться к собеседнику с места; либо уточните, какое перемещение допустимо.' }
  const candidates = namedActors(partyActors(state, actorId), value)
  if (candidates.length !== 1) return { status: 'clarification', narration: 'К кому именно подойти? Назовите одного видимого собеседника или выберите клетку на карте.' }
  const target = candidates[0]
  const at = npcPlacementFor(state, target.id) ?? actorPosition(state, target.id)
  if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) return { status: 'clarification', narration: 'Положение собеседника на карте пока не определено. Можно обратиться к нему словами, не объявляя перемещение.' }
  const distance = Math.max(Math.abs(at.x - actorAt.x), Math.abs(at.y - actorAt.y))
  if (distance <= 1) return { status: 'clarification', narration: 'Вы уже рядом с собеседником. Можно заговорить или выбрать другое действие.' }
  const routes = []
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
    if (!dx && !dy) continue
    const to = { x: at.x + dx, y: at.y + dy }
    if (cellAt(map, to.x, to.y)?.revealed !== true) continue
    const path = shortestTacticalPath(state, actorId, to)
    if (path?.length) routes.push({ to, path })
  }
  routes.sort((a, b) => a.path.length - b.path.length || a.to.y - b.to.y || a.to.x - b.to.x)
  if (!routes.length) return { status: 'clarification', narration: 'Свободного раскрытого пути к собеседнику нет. Можно выбрать другой маршрут на карте или обратиться с места.' }
  return { status: 'command', command: { command_type: 'MoveActor', actor_id: String(actorId), to: routes[0].to, server_authoritative: true }, narration: `Вы подходите к собеседнику: ${target.character ?? target.name}.` }
}

/**
 * «Обчищаю карманы торговца», «залезаю в кошель стражнику», «тяну кошелёк».
 *
 * Ветка обязана стоять **до** обыска трупа: у того в шаблоне уже есть слово
 * «карман», и без этого порядка живой купец разбирался бы как тело. Пустой
 * список слов здесь не годится — «карман» в паре с живым человеком читается
 * однозначно, а в паре с телом остаётся обыском.
 */
const PICKPOCKET_PHRASE = /(?:обчищ\p{L}*|обчист\p{L}*|очищ\p{L}*|шар\p{L}*|лез\p{L}*|залез\p{L}*|тян\p{L}*|крад\p{L}*|ворую|своро\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)[^.!?]{0,80}(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*|кошель)|(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*)[^.!?]{0,80}(?:обчищ\p{L}*|обчист\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)/iu

/**
 * Карманная кража свободной фразой.
 *
 * Контракт арбитра расширять не пришлось: `sleight_of_hand` уже есть в списке
 * навыков (`action_adjudicator/v3.txt`), а `target_id` он и так называет.
 * Не хватало **маршрута**: прочтение приходило честное, но разрешалось общей
 * проверкой навыка с абстрактной ценой провала — то есть без кармана, без
 * свидетелей и без розыска. Здесь заявка переводится в ту же команду, что
 * приходит из меню NPC, и дальше обе идут одним путём.
 */
export function resolvePickpocket(state = {}, actorId = '', text = '', reading = {}) {
  const looksLikeTheft = PICKPOCKET_PHRASE.test(text) || String(reading?.skill ?? '') === 'sleight-of-hand'
  if (!looksLikeTheft) return null
  const requested = clean(reading?.target_id, 120)
  const npcs = currentSocialActors(state)
  const named = npcs.filter((npc) => String(npc.id) === requested
    || mentionsReference(text, referenceNames(npc)))
  // Кража у своих не разбирается вовсе: у отряда нет карманов друг для друга, и
  // честнее сказать это словами, чем молча судить проверкой навыка.
  const party = (state?.players ?? []).filter((hero) => mentionsReference(text, referenceNames(hero)))
  if (!named.length && party.length) {
    return { status: 'clarification', narration: 'У своих не крадут: обчистить можно только чужой карман.' }
  }
  if (!PICKPOCKET_PHRASE.test(text)) return null
  if (named.length !== 1) {
    return {
      status: 'clarification',
      narration: named.length > 1
        ? `Уточните, чей карман: подходят ${named.map((npc) => npc.name ?? npc.id).join(', ')}.`
        : 'Уточните, у кого именно вы хотите обчистить карман.',
    }
  }
  if (state?.mechanics?.combat?.active === true) {
    return { status: 'clarification', narration: 'Посреди боя карманов не чистят.' }
  }
  const npc = named[0]
  return {
    status: 'command',
    command: { command_type: 'PickpocketNpc', actor_id: String(actorId), npc_id: String(npc.id) },
    narration: `Рука тянется к чужому кошельку: ${npc.name ?? npc.id}.`,
  }
}

const CORPSE_SEARCH = /(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)[^.!?]{0,80}(?:труп|тел[оаеу]|останки|карман)|(?:труп|тел[оаеу]|останки|карман)[^.!?]{0,80}(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)/iu

/**
 * Как фраза называет вид контейнера. Таблица работает в одну сторону: названный
 * вид **сужает** выбор и вправе не совпасть ни с чем — сказавшему «обыскиваю
 * тело» нельзя подсунуть мешок брошенного, — а неназванный ничего не запрещает.
 */
const LOOT_KIND_WORDS = Object.freeze({
  // «Тело» кончается здесь и не продолжается: без границы слова `тел[оаеу]\p{L}*`
  // считал телом всякую телегу.
  corpse: /(?:труп\p{L}*|тел[оаеу](?![\p{L}\p{M}])|телами|останк\p{L}*|павш\p{L}*|мертвец\p{L}*|убит\p{L}*)/iu,
  captive: /(?:пленн\p{L}*|сдавш\p{L}*|связанн\p{L}*)/iu,
  abandoned: /(?:брошенн\p{L}*|оставленн\p{L}*|откуп\p{L}*)/iu,
  cache: /(?:схрон\p{L}*|тайник\p{L}*|заначк\p{L}*)/iu,
})

/** Столько предметов помещается в устный ответ; остальное считается числом. */
const MAX_SPOKEN_LOOT_ITEMS = 8

/**
 * Имена, которыми фраза может назвать контейнер: своё и павшего.
 *
 * Имя контейнера начинается с вида («Тело: Разбойник»), поэтому в список идёт и
 * хвост после двоеточия: «обыскиваю разбойника» — та же заявка, что и
 * «обыскиваю тело разбойника».
 */
function lootContainerReferenceNames(state, container) {
  const sources = new Set([container.source_enemy_id, ...container.source_enemy_ids].filter(Boolean).map(String))
  const enemyNames = (state?.enemies ?? [])
    .filter((enemy) => sources.has(String(enemy?.id ?? '')))
    .flatMap((enemy) => referenceNames(enemy))
  const name = clean(container.name, 160)
  const subject = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : ''
  return [name, subject, ...enemyNames].filter(Boolean)
}

/**
 * Контейнеры яруса, которые могла иметь в виду фраза. Отбор идёт от узкого к
 * широкому: явная цель прочтения, затем имя из фразы, затем названный вид.
 * Пустой ответ означает «фраза говорила не об этом», а не «здесь пусто».
 */
function lootContainersNamedBy(state, text, reading, containers) {
  const requested = clean(reading?.target_id, 120)
  // Прочтение назвало конкретного актора — значит, речь о нём одном, и пустой
  // ответ здесь означает «контейнера у него нет», а не «поищем кого-нибудь ещё».
  if (requested) {
    return containers.filter((container) => container.source_enemy_id === requested
      || container.source_enemy_ids.includes(requested))
  }
  const named = containers.filter((container) => mentionsReference(text, lootContainerReferenceNames(state, container)))
  if (named.length) return named
  const kinds = Object.keys(LOOT_KIND_WORDS).filter((kind) => LOOT_KIND_WORDS[kind].test(text))
  return kinds.length ? containers.filter((container) => kinds.includes(container.kind)) : containers
}

/**
 * Кого из названных фраза имела в виду.
 *
 * Ближе — значит вероятнее: стоящий над телом и сказавший «обыскиваю тело»
 * говорит именно про него. Но ничья расстоянием — это неоднозначность, а не
 * повод выбрать по алфавиту: между двумя телами под ногами выбирает игрок, и
 * `null` здесь означает «нужно уточнение».
 */
function nearestLootContainer(state, hero, containers) {
  const measured = containers.map((container) => ({ container, ...lootContainerReachFor(state, hero, container) }))
  const within = measured.filter((entry) => entry.reachable)
  const pool = within.length ? within : measured
  const distance = (entry) => entry.distance_feet ?? Number.POSITIVE_INFINITY
  const [first, second] = [...pool].sort((left, right) => distance(left) - distance(right)
    || left.container.id.localeCompare(right.container.id))
  if (!first) return null
  return second && distance(second) === distance(first) ? null : first
}

/** Содержимое словами. Вид — тот же `lootItemForViewer`, что отдаёт панель. */
function spokenLootContents(container) {
  const items = container.items.map((item) => lootItemForViewer(item))
  const spoken = items.slice(0, MAX_SPOKEN_LOOT_ITEMS)
    .map((item) => (item.quantity > 1 ? `${item.name} (${item.quantity})` : item.name))
    .join(', ')
  const rest = items.length - Math.min(items.length, MAX_SPOKEN_LOOT_ITEMS)
  return { items, summary: rest > 0 ? `${spoken} и ещё ${rest}` : spoken }
}

/**
 * Ответ про один найденный контейнер — тот же, что даёт панель, только словами.
 *
 * Содержимое отдаётся ровно по тому же условию, по которому его отдаёт карточка
 * (`lootContainersForViewer`): герой дотянулся. Дальше пяти футов ответ честно
 * зовёт подойти и **называет** контейнер — его имя игрок и так видит в панели,
 * поэтому нового здесь не открывается. Взятия не происходит ни в одном случае:
 * осмотр бесплатен, а набор выдаёт команда обыска.
 */
function lootContainerAnswer(state, hero, container) {
  const { reachable: withinReach, distance_feet: distanceFeet } = lootContainerReachFor(state, hero, container)
  const common = {
    status: 'clarification',
    server_owned_contents: container.status === 'available',
    corpse_id: String(container.source_enemy_id || container.source_enemy_ids[0] || ''),
    loot_container_id: container.id,
    loot_container_kind: container.kind,
    loot_container_name: container.name,
    ...(distanceFeet == null ? {} : { distance_feet: distanceFeet }),
  }
  if (container.status !== 'available') {
    return { ...common, narration: `${container.name}: здесь уже всё сняли, контейнер добычи пуст.` }
  }
  if (!withinReach) {
    return {
      ...common,
      narration: `${container.name}: отсюда не дотянуться${distanceFeet == null ? '' : ` — идти ещё ${distanceFeet} фт`}.`
        + ` Обыскивают в пределах ${LOOT_CONTAINER_REACH_FEET} футов: подойдите вплотную, и я скажу, что там.`,
    }
  }
  const { items, summary } = spokenLootContents(container)
  // Цену обыска называет тот же признак, которым её решает правило
  // (`validateLootContainerCommand`): смотреть бесплатно всегда, а вот забрать
  // посреди боя стоит действия — и узнать об этом игрок обязан до, а не после.
  const combat = state?.mechanics?.combat?.active === true
  return {
    ...common,
    narration: `${container.name}: ${summary}. Забрать нужное можно через панель добычи — набор выдаёт сервер,`
      + ` и выдумывать находку я не стану.${combat ? ' В бою обыск стоит действия; смотреть — бесплатно.' : ''}`,
    loot_items: items,
    loot_action_cost: combat ? 'action' : null,
  }
}

/**
 * Обыск контейнера добычи свободной фразой.
 *
 * Путь у кнопки и у фразы один: контейнеры берутся тем же `lootContainersInScene`
 * (значит, с тем же ярусом), досягаемость — той же меркой, содержимое — тем же
 * bounded-видом. Событий здесь не рождается вовсе: осмотр бесплатен и хода не
 * стоит, а взять набор можно только командой обыска.
 *
 * `null` означает «фраза не про здешние контейнеры» — разбираться будет прежняя
 * ветка ниже.
 */
function resolveLootContainerSearch(state, hero, text, reading) {
  const inScene = lootContainersInScene(state, { includeEmptied: true })
  if (!inScene.length) return null
  const candidates = lootContainersNamedBy(state, text, reading, inScene)
  if (!candidates.length) return null
  // Полный контейнер интереснее обобранного: пустой становится ответом только
  // тогда, когда другого фраза не назвала.
  const available = candidates.filter((container) => container.status === 'available')
  const pool = available.length ? available : candidates
  const chosen = nearestLootContainer(state, hero, pool)
  if (!chosen) {
    return {
      status: 'clarification',
      narration: `Уточните, что именно обыскивает герой: рядом ${pool.map((container) => container.name).join(', ')}.`,
      server_owned_contents: available.length > 0,
    }
  }
  return lootContainerAnswer(state, hero, chosen.container)
}

/**
 * Пока у тела нет явного server-owned контейнера, поиск не подменяется
 * проверкой Внимательности и не создаёт выдуманную добычу.
 *
 * Отказ обязан говорить правду о **конкретном** теле. С появлением инвентарей
 * противников (`server/enemy-loadouts.mjs`) у трупа гуманоида есть авторитетное
 * содержимое — оружие, боеприпасы, изредка расходник и карман медяков, — и
 * ответ «у этого тела нет заданного сервером содержимого» стал бы ложью:
 * состояние говорит одно, рассказчик другое. Поэтому источников содержимого
 * здесь три, и все три учитываются: `loadout` существа, а также исторические
 * `search_contents` / `corpse_contents` объектов сцены.
 *
 * Настоящая добыча разбирается **до** этого: контейнеры волны 3
 * (`resolveLootContainerSearch` выше) — и есть тот авторитетный путь, ради
 * которого писался прежний отказ. Ниже остаётся ровно то, до чего он не
 * дотянулся: тело без контейнера и тело, оставшееся на другом ярусе.
 */
export function resolveCorpseSearch(state = {}, actorId = '', text = '', reading = {}) {
  if (!CORPSE_SEARCH.test(text)) return null
  const hero = (state?.players ?? []).find((player) => String(player?.id ?? '') === String(actorId)) ?? null
  const containerAnswer = resolveLootContainerSearch(state, hero, text, reading)
  if (containerAnswer) return containerAnswer
  const corpses = [
    ...(state?.enemies ?? []).filter((actor) => actor?.alive === false || Number(actor?.hp ?? 1) <= 0),
    ...(state?.entities ?? []).filter((entity) => ['corpse', 'body', 'remains'].includes(String(entity?.kind ?? ''))),
  ]
  const requested = corpses.find((corpse) => String(corpse?.id) === String(reading.target_id ?? ''))
  const mentioned = requested ? [requested] : corpses.filter((corpse) => mentionsReference(text, referenceNames(corpse)))
  const candidates = mentioned.length ? mentioned : corpses.length === 1 ? corpses : []
  if (candidates.length !== 1) {
    return {
      status: 'clarification',
      narration: candidates.length > 1
        ? `Уточните, чьё тело обыскивает герой: ${candidates.map((corpse) => corpse.name ?? corpse.id).join(', ')}.`
        : 'Укажите конкретное тело, которое герой хочет обыскать.',
      server_owned_contents: false,
    }
  }
  const corpse = candidates[0]
  const loadout = corpse?.loadout && typeof corpse.loadout === 'object' && !Array.isArray(corpse.loadout)
    ? corpse.loadout
    : null
  const carried = (Array.isArray(loadout?.items) ? loadout.items.length : 0) > 0
    || Number(loadout?.purse_cp) > 0
  const contents = Array.isArray(corpse?.search_contents) ? corpse.search_contents
    : Array.isArray(corpse?.corpse_contents) ? corpse.corpse_contents
      : null
  // Контейнер добычи, заведённый той же фиксацией, что и смерть
  // (`server/loot-containers.mjs`). Сюда доходят два случая, до которых отбор по
  // фразе не дотянулся: контейнер этого тела назван другим видом («оружие
  // пленного» на заявку «обыскиваю тело») — и контейнер, оставшийся на другом
  // ярусе. Первый разбирается тем же ответом, что и панель; второй обязан
  // сказать правду про место, а не отрицать содержимое.
  const container = lootContainerList(state)
    .find((entry) => entry.source_enemy_id === String(corpse.id ?? '')
      || entry.source_enemy_ids.includes(String(corpse.id ?? '')))
  if (container) {
    const here = lootContainersInScene(state, { includeEmptied: true })
      .some((entry) => entry.id === container.id)
    if (here) return { ...lootContainerAnswer(state, hero, container), corpse_id: String(corpse.id ?? '') }
    return {
      status: 'clarification',
      narration: `Добыча с этого тела осталась на другом ярусе (${container.name}): обыскать её можно, вернувшись туда.`,
      server_owned_contents: container.status === 'available',
      corpse_id: String(corpse.id ?? ''),
      loot_container_id: container.id,
    }
  }
  return {
    status: 'clarification',
    narration: carried
      ? 'На теле действительно есть снаряжение, но контейнера добычи у него не заведено: взять его сейчас нельзя. Я не буду ни выдумывать находку, ни бросать проверку вместо неё.'
      : contents
        ? 'У тела есть описанное содержимое, но оно ещё не оформлено как авторитетный контейнер. Нужна отдельная серверная команда извлечения.'
        : 'У этого тела нет заданного сервером содержимого. Я не буду выдумывать находку или бросать проверку вместо неё.',
    server_owned_contents: carried || Array.isArray(contents),
    corpse_id: String(corpse.id ?? ''),
  }
}

function actorMeans(state = {}, actorId = '') {
  const actor = (state.players ?? []).find((entry) => String(entry?.id) === String(actorId)) ?? null
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  const ids = new Set()
  for (const item of inventory) {
    for (const value of [item?.id, item?.catalog_id, item?.name]) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  for (const key of ['knownSpellIds', 'preparedSpellIds', 'selectedFeatureIds', 'classSkillProficiencies']) {
    for (const value of actor?.[key] ?? []) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  return ids
}

/**
 * Шаг 2 брифа: сверка заявленных средств с миром. Это единственное честное место
 * сказать «такого у героя нет» — до броска и до расхода хода.
 */
export function verifyMeans(state = {}, actorId = '', requiredMeans = []) {
  const available = actorMeans(state, actorId)
  const required = [...new Set((Array.isArray(requiredMeans) ? requiredMeans : [])
    .map((value) => clean(value, 160)).filter(Boolean))]
  const canonical = value => String(value).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  const normalized = new Set([...available].map(canonical))
  const missing = required.filter(value => !normalized.has(canonical(value)))
  return { satisfied: missing.length === 0, required, missing }
}

/** Причина проверки объясняется отдельно от её числа и результата. */
export function explainActionCheck({ ability = '', skill = '' } = {}) {
  const reasons = {
    athletics: 'Атлетика нужна, когда исход зависит от усилия: удержаться, взобраться или преодолеть сопротивление.',
    acrobatics: 'Акробатика проверяет равновесие и точность движения, когда можно сорваться или потерять опору.',
    sleight_of_hand: 'Ловкость рук нужна для точного обращения с предметом под риском или чужим наблюдением.',
    stealth: 'Скрытность определяет, заметят ли героя. Отвлечение может помочь, но само по себе не делает героя незаметным.',
    performance: 'Выступление подходит для отвлечения: нужно убедительно переключить чужое внимание. Осмотр или проход после этого будет отдельным шагом.',
    persuasion: 'Убеждение нужно, когда вы добиваетесь добровольного согласия собеседника. Обычный вопрос сам по себе броска не требует.',
    intimidation: 'Запугивание применяется к настоящей угрозе. Если вы не угрожаете, измените способ: мирное объяснение не должно проверяться как запугивание.',
    deception: 'Обман проверяет, поверит ли собеседник сознательно ложному утверждению.',
    perception: 'Восприятие помогает заметить доступную наблюдению деталь. Оно не выполняет отвлечение, открывание двери или перемещение.',
    investigation: 'Расследование связывает доступные улики и проверяет выводы из них.',
    insight: 'Проницательность помогает оценить поведение собеседника, но не читает его мысли и не раскрывает неизвестные герою факты.',
    history: 'История позволяет вспомнить сведения, которые герой мог знать.',
    arcana: 'Магия помогает разобраться в доступных магических признаках, но сама не создаёт заклинание.',
    survival: 'Выживание помогает идти по следу и ориентироваться с учётом местности и погоды.',
    animal_handling: 'Уход за животными нужен для взаимодействия с поведением зверя, а не для гарантированного подчинения.',
  }
  return reasons[String(skill).replace(/-/gu, '_')]
    ?? `${ABILITY_LABELS_RU[ability] ?? 'Характеристика'} должна соответствовать способу действия. Для безопасного бытового жеста проверка не нужна; для риска сначала уточним препятствие и цену неудачи.`
}

/**
 * Шаг 5 брифа: провал не означает «ничего не произошло». Каталог серверный и
 * ограниченный — модель выбирает уровень риска, но не сочиняет последствие.
 *
 * Эта таблица сохранена для уже согласованных старых проверок. Новые заявки
 * используют freeActionResolutionPolicy: длительность попытки не умножается
 * на риск, а физические последствия разрешаются отдельным серверным профилем.
 */
const FAIL_FORWARD = Object.freeze({
  none: Object.freeze({ minutes: 5, advances_quest_clock: false, summary: 'Попытка отняла немного времени и ничего не изменила в обстановке.' }),
  minor: Object.freeze({ minutes: 10, advances_quest_clock: false, summary: 'Попытка сорвалась и наделала шума: место перестало быть спокойным.' }),
  serious: Object.freeze({ minutes: 20, advances_quest_clock: true, summary: 'Неудача дорого обошлась: положение осложнилось, и события пошли своим ходом.' }),
  deadly: Object.freeze({ minutes: 30, advances_quest_clock: true, escalates: true, summary: 'Риск оправдался худшим образом: опасность стала явной и близкой.' }),
})

const CONSEQUENCE_SUMMARIES = Object.freeze({
  time: 'Попытка отняла время, а ситуация успела измениться.',
  noise: 'Попытка выдала героя шумом и привлекла нежелательное внимание.',
  exposure: 'Герой раскрыл своё положение и потерял безопасную возможность.',
  lost_opportunity: 'Собеседник или обстоятельства больше не дают прежней возможности.',
})

export function failForwardFor(risk = 'minor', consequenceType = 'time') {
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  const type = consequenceType === 'injury' ? 'time' : inEnum(FREE_ACTION_CONSEQUENCE_TYPES, consequenceType, 'time')
  return {
    risk: stake,
    consequence_type: type,
    ...FAIL_FORWARD[stake],
    summary: `${CONSEQUENCE_SUMMARIES[type]} ${FAIL_FORWARD[stake].summary}`,
  }
}

const ATTEMPT_MINUTES = Object.freeze({ instant: 0, brief: 1, minutes: 5, extended: 10, prolonged: 60 })
const INJURY_EXPRESSIONS = Object.freeze({ none: null, minor: '1d4', serious: '1d6', deadly: '2d6' })
const DAMAGE_TYPE_LABELS_RU = Object.freeze({
  bludgeoning: 'дробящего', fire: 'огненного', acid: 'кислотного', piercing: 'колющего',
  slashing: 'рубящего', cold: 'холодом', lightning: 'электрического', thunder: 'громового',
  poison: 'ядовитого', force: 'силового', necrotic: 'некротического', radiant: 'сияющего', psychic: 'психического',
})

export function damageTypeLabelRu(value = '') {
  return DAMAGE_TYPE_LABELS_RU[String(value ?? '').toLocaleLowerCase('en')] ?? 'неуточнённого'
}
const CAUSAL_FAILURE_SUMMARIES = Object.freeze({
  time: 'Попытка не дала результата. Потрачено только время самой попытки.',
  noise: 'Тихо выполнить задуманное не получилось; попытка сопровождается шумом.',
  exposure: 'Незаметно выполнить задуманное не получилось.',
  lost_opportunity: 'Этот подход не сработал. Нужен другой способ добиться цели.',
})

/** Версионированная серверная цена одной попытки, общая для preview и commit. */
export function freeActionResolutionPolicy(reading = {}) {
  if (![RESOLUTION_POLICY_VERSION, LEGACY_RESOLUTION_POLICY_VERSION].includes(reading.policy_version)) return {
    version: 'legacy', success_minutes: 5, cost: '5 минут при успехе',
    failure: failForwardFor(reading.risk, reading.consequence_type),
  }
  const duration = reading.activity_kind === 'stunt' ? 'instant' : inEnum(FREE_ACTION_DURATION_CLASSES, reading.duration_class, 'minutes')
  const minutes = ATTEMPT_MINUTES[duration]
  const physical = reading.activity_kind === 'stunt' && ['acrobatics', 'athletics'].includes(reading.skill)
  const rawHazard = reading.policy_version === LEGACY_RESOLUTION_POLICY_VERSION ? '' : clean(reading.hazard, 80)
  const hazardId = canonicalEnvironmentHazardId(rawHazard)
  const hazard = hazardId ? ENVIRONMENT_HAZARDS[hazardId] : null
  const invalidHazard = Boolean(rawHazard && !hazardId)
  const expression = reading.consequence_type === 'injury' && !invalidHazard && (physical || hazard)
    ? hazard?.expressions?.[inEnum(RISK_LEVELS, reading.risk, 'minor')] ?? hazard?.expressions?.minor
      ?? INJURY_EXPRESSIONS[inEnum(RISK_LEVELS, reading.risk, 'minor')] : null
  const damageType = hazard?.damage_type ?? 'bludgeoning'
  const type = expression ? 'injury' : reading.consequence_type === 'injury' ? 'time'
    : inEnum(FREE_ACTION_CONSEQUENCE_TYPES, reading.consequence_type, 'time')
  return {
    version: reading.policy_version,
    success_minutes: minutes,
    cost: minutes ? `время попытки: ${minutes} мин` : 'несколько секунд',
    failure: {
      risk: reading.risk, consequence_type: type, minutes, advances_quest_clock: false,
      ...(expression ? { damage_expression: expression, damage_type: damageType } : {}),
      summary: expression
        ? `Неудачное движение приводит к травме: ${expression} ${damageTypeLabelRu(damageType)} урона самому герою.`
        : CAUSAL_FAILURE_SUMMARIES[type],
    },
  }
}

/**
 * Шаг 4 брифа: ставки объявляются до броска. Живой ведущий говорит «Атлетика, СЛ 15;
 * сорвёшься — потеряешь время и наделаешь шума» прежде, чем кубик брошен.
 */
export function stakesFor({
  ability = '',
  skill = '',
  resolution = {},
  risk = 'minor',
  proficiency = 'none',
  consequence_type = 'time',
  outcome_policy = null,
} = {}) {
  if (resolution.mode !== 'check') return null
  const consequence = outcome_policy?.failure ?? failForwardFor(risk, consequence_type)
  return {
    ability: clean(ability, 20),
    skill: canonicalSkill(skill),
    proficiency: inEnum(FREE_ACTION_PROFICIENCY_LEVELS, proficiency, 'none'),
    difficulty: resolution.difficulty,
    difficulty_category: resolution.difficulty_category,
    difficulty_factors: [...new Set(Array.isArray(resolution.difficulty_factors) ? resolution.difficulty_factors.map((factor) => clean(factor, 60)).filter(Boolean) : [])].slice(0, 8),
    consequence_type: consequence.consequence_type,
    on_failure: consequence.summary,
    policy: [RESOLUTION_POLICY_VERSION, LEGACY_RESOLUTION_POLICY_VERSION].includes(outcome_policy?.version) ? 'free-action-stakes-v3' : 'free-action-stakes-v2',
  }
}

// Русские подписи d20-проверок для карточки броска и журнала. Идентификаторы
// характеристик и навыков остаются английскими (правило репозитория), подпись
// собирается на сервере — клиент показывает её как есть.
export const ABILITY_LABELS_RU = Object.freeze({
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
})
export const SKILL_LABELS_RU = Object.freeze({
  'acrobatics': 'Акробатика', 'animal-handling': 'Уход за животными', 'arcana': 'Магия', 'athletics': 'Атлетика',
  'deception': 'Обман', 'history': 'История', 'insight': 'Проницательность', 'intimidation': 'Запугивание',
  'investigation': 'Расследование', 'medicine': 'Медицина', 'nature': 'Природа', 'perception': 'Восприятие',
  'performance': 'Выступление', 'persuasion': 'Убеждение', 'religion': 'Религия', 'sleight-of-hand': 'Ловкость рук',
  'stealth': 'Скрытность', 'survival': 'Выживание',
})

export function d20CheckLabel({ kind = 'check', ability = null, skill = null } = {}) {
  const abilityName = ABILITY_LABELS_RU[String(ability ?? '').toLocaleLowerCase('en')] ?? null
  if (kind === 'save') return abilityName ? `Спасбросок: ${abilityName}` : 'Спасбросок'
  const skillName = SKILL_LABELS_RU[String(skill ?? '').toLocaleLowerCase('en').replace(/_/gu, '-')] ?? null
  if (skillName && abilityName) return `${abilityName} (${skillName})`
  return skillName ?? (abilityName ? `Проверка: ${abilityName}` : 'Проверка')
}

/**
 * Шаг 6 брифа: живой ведущий не разрешает перекатывать ту же попытку, пока
 * обстоятельства не изменились. Отпечаток берётся от героя, подхода и препятствия.
 */
export function attemptFingerprint({ actorId = '', approach = '', obstacle = '' } = {}) {
  return digest({
    actor: clean(actorId, 120),
    approach: clean(approach, 300).toLocaleLowerCase('ru'),
    obstacle: clean(obstacle, 300).toLocaleLowerCase('ru'),
  })
}

/** Отпечаток обстановки: пока он не сменился, повтор того же подхода бессмыслен. */
export function situationFingerprint(state = {}) {
  return digest({
    location: clean(state.scene?.location, 180),
    objective: clean(state.scene?.objective, 300),
    revealed: (state.scene?.cells ?? []).filter((cell) => cell.revealed === true).length,
    combat: Boolean(state.mechanics?.combat?.active),
    round: Number(state.mechanics?.combat?.round) || 0,
    elapsed: Number(state.mechanics?.world_time?.elapsed_minutes) || 0,
  })
}

/**
 * Ищет уже проваленную попытку с тем же подходом в неизменившейся обстановке.
 * Возвращает найденную запись или null.
 */
export function previousFailedAttempt(state = {}, fingerprint = '') {
  const situation = situationFingerprint(state)
  return (state.rulings ?? []).find((ruling) => {
    const provenance = ruling?.provenance ?? {}
    return provenance.attempt_fingerprint === fingerprint
      && provenance.situation_fingerprint === situation
      && ruling.outcome === 'failure'
  }) ?? null
}
