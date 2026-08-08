import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  FREE_ACTION_CONSEQUENCE_TYPES,
  FREE_ACTION_PROFICIENCY_LEVELS,
  bindFreeActionReadingToState,
  normalizeFreeActionReading,
} from './free-action-adjudication.mjs'
import { ENVIRONMENT_HAZARD_IDS, IMPROVISED_EFFECT_IDS, scenePropIntentFor } from './improvised-effects.mjs'
import { hazardPropCells, igniteDefinitionFor, sceneHazardVerbsFor, toppleDefinitionFor } from './scene-hazards.mjs'
import { sceneInteractionCatalogEntry } from './scene-interactions.mjs'
import { buildDataOnlyContext } from './security.mjs'

/**
 * Арбитр свободного действия. Единственная роль модели здесь — **понять
 * задумку**: какой характеристикой и навыком её судить, насколько она вообще
 * возможна, чем игрок рискует и чего это стоит в бою.
 *
 * Модель не бросает кубики, не выбирает СЛ, не описывает исход и не может
 * назначить эффект вне закрытого списка. Всё, что она вернула, проходит через
 * `normalizeFreeActionReading` и каталог `improvised-effects.mjs`; при любой
 * ошибке, таймауте или отсутствии ключа предложение молча заменяется
 * детерминированным прочтением, и игра продолжается.
 */
const prompt = readFileSync(fileURLToPath(new URL('../prompts/action_adjudicator/v4.txt', import.meta.url)), 'utf8')

const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const list = (value) => Array.isArray(value) ? value : []

/** Лист героя в том объёме, который нужен для выбора кубика, и не шире. */
function heroBrief(state, actorId) {
  const hero = (state?.players ?? []).find((actor) => String(actor?.id) === String(actorId)) ?? {}
  const sheet = hero.characterSheet ?? {}
  return {
    id: String(hero.id ?? actorId),
    name: clean(hero.character ?? hero.name, 80),
    role: clean(hero.role, 80),
    abilities: sheet.abilities ?? hero.abilities ?? {},
    skill_proficiencies: list(hero.classSkillProficiencies).map((entry) => clean(entry, 60)),
    skill_expertise: [
      ...list(hero.skillExpertiseIds),
      ...list(hero.expertiseSkillIds),
      ...list(hero.skillExpertise),
      ...list(hero.expertiseSkills),
    ].map((entry) => clean(entry, 60)).slice(0, 20),
    prepared_spells: list(hero.preparedSpellIds).map((entry) => clean(entry, 60)).slice(0, 20),
    known_spells: list(hero.knownSpellIds).map((entry) => clean(entry, 60)).slice(0, 20),
    features: list(hero.selectedFeatureIds).map((entry) => clean(entry, 60)).slice(0, 20),
    inventory: list(hero.inventory).map((item) => ({
      id: clean(item?.id, 120), name: clean(item?.name, 80), equipped: item?.equipped === true,
    })).slice(0, 30),
    speed: Number(hero.speed) || 30,
  }
}

/** Кто на поле. Без этого модель не может назвать корректный `effect_target`. */
function participantsBrief(state) {
  const position = (actor) => (Number.isFinite(Number(actor?.x)) ? { x: Number(actor.x), y: Number(actor.y) } : null)
  const location = clean(state?.scene?.location, 180).toLocaleLowerCase('ru')
  const social = (state?.social?.npcs ?? []).filter((actor) => {
    const actorLocation = clean(actor?.location, 180).toLocaleLowerCase('ru')
    return actor?.available !== false && (!location || !actorLocation || location === actorLocation)
  })
  return [
    ...(state?.players ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.character ?? actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'party', at: position(actor) })),
    ...(state?.actors ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'party', at: position(actor) })),
    ...(state?.enemies ?? []).filter((actor) => actor?.alive !== false && Number(actor?.hp ?? 1) > 0)
      .map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'enemy', at: position(actor) })),
    ...social.map((actor) => ({
      id: String(actor.id),
      name: clean(actor.name, 80),
      role: clean(actor.role, 80),
      aliases: (actor.tags ?? []).map((entry) => clean(entry, 60)).filter((entry) => entry && !entry.includes(':')).slice(0, 8),
      side: 'npc',
      at: position(actor),
    })),
  ].filter((actor, index, all) => all.findIndex((candidate) => candidate.id === actor.id) === index).slice(0, 24)
}

/**
 * Предметы обстановки, с которыми движок действительно умеет работать.
 *
 * Без этого списка «поджигаю сено» превращалось в одноразовый импровизированный
 * урон: модель не знала идентификатора пропса и назвать его не могла. Список
 * строится из авторитетной карты сцены и справочника опасностей, поэтому в него
 * не попадает ни один предмет, которому движок откажет по каталогу.
 *
 * Скрытого здесь нет: id, русское имя, состояние, доступные глаголы и клетка —
 * ровно то, что игрок и так видит на доске.
 */
function scenePropsBrief(state, actorId) {
  const hero = (state?.players ?? []).find((actor) => String(actor?.id) === String(actorId)) ?? null
  const at = Number.isFinite(Number(hero?.x)) && Number.isFinite(Number(hero?.y))
    ? { x: Math.floor(Number(hero.x)), y: Math.floor(Number(hero.y)) }
    : null
  const props = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  return props
    .flatMap((prop) => {
      const id = clean(prop?.id, 120)
      const verbs = sceneHazardVerbsFor(prop?.assetId)
      if (!id || !verbs.length || !sceneInteractionCatalogEntry(prop?.assetId)) return []
      const name = toppleDefinitionFor(prop?.assetId)?.mass || igniteDefinitionFor(prop?.assetId)?.what || ''
      const cell = hazardPropCells(prop)[0] ?? null
      return [{
        id,
        name: clean(name, 80),
        state: clean(state?.mechanics?.scene_interactions?.[id]?.state || prop?.state, 40) || 'idle',
        verbs,
        at: cell,
        distance_feet: at && cell ? Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y)) * 5 : null,
      }]
    })
    // Ближнее — первым: досягаемость всё равно проверит движок, но выбирать
    // модели проще из упорядоченного списка, а порядок обязан быть устойчивым.
    .sort((left, right) => (left.distance_feet ?? 10_000) - (right.distance_feet ?? 10_000) || left.id.localeCompare(right.id))
    .slice(0, 12)
}

function economyBrief(state, actorId) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return { in_combat: false }
  const economy = combat.action_economy?.[String(actorId)] ?? {}
  return {
    in_combat: true,
    round: Number(combat.round) || 1,
    action_available: economy.action !== false,
    bonus_action_available: economy.bonus_action !== false,
    movement_spent_feet: Number(economy.movement_spent) || 0,
  }
}

export function adjudicationBrief(state, actorId, text) {
  return {
    player_action: clean(text, 1_000),
    hero: heroBrief(state, actorId),
    scene: {
      title: clean(state?.scene?.title, 120),
      location: clean(state?.scene?.location, 120),
      mood: clean(state?.scene?.mood, 160),
      objective: clean(state?.scene?.objective, 160),
    },
    participants: participantsBrief(state),
    scene_props: scenePropsBrief(state, actorId),
    turn_economy: economyBrief(state, actorId),
    allowed: {
      effects: [...IMPROVISED_EFFECT_IDS],
      hazards: [...ENVIRONMENT_HAZARD_IDS],
      proficiency_levels: [...FREE_ACTION_PROFICIENCY_LEVELS],
      consequence_types: [...FREE_ACTION_CONSEQUENCE_TYPES],
    },
  }
}

export class ActionAdjudicator {
  constructor({ llmClient = null, timeoutMs = 9_000 } = {}) {
    this.llmClient = llmClient
    this.timeoutMs = timeoutMs
  }

  /**
   * Возвращает прочтение задумки. Никогда не бросает: отказ модели — это
   * возврат к детерминированной таблице, а не сломанный ход.
   */
  async read(state, actorId, text, fallbackReading) {
    if (!this.llmClient?.completeJson) return bindFreeActionReadingToState(state, actorId, text, fallbackReading)
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ free_action_brief: adjudicationBrief(state, actorId, text) }) },
        ],
        temperature: 0.2,
        maxTokens: 500,
      })
      const reading = normalizeFreeActionReading({ ...result, source: 'agent-adjudicator' }, text)
      // Модель могла назвать эффект, которого нет в каталоге. Оставлять такой
      // ключ нельзя: дальше он всё равно превратится в «ничего не произошло»,
      // но в трассе выглядел бы как решение агента.
      if (!IMPROVISED_EFFECT_IDS.includes(reading.effect)) reading.effect = 'none'
      if (reading.hazard && !ENVIRONMENT_HAZARD_IDS.includes(reading.hazard)) reading.hazard = ''
      const participantIds = new Set(participantsBrief(state).map((entry) => entry.id))
      if (reading.effect_target && !participantIds.has(reading.effect_target)) reading.effect_target = ''
      // Предмет обстановки — только из переданного списка и только с тем
      // глаголом, который у него действительно есть. Иначе «поджигаю бочку с
      // порохом» превратилось бы в поджог придуманной бочки.
      const propsById = new Map(scenePropsBrief(state, actorId).map((entry) => [entry.id, entry]))
      const propIntent = scenePropIntentFor(reading.effect)
      const namedProp = propsById.get(reading.prop_id) ?? null
      if (!namedProp || !propIntent || !namedProp.verbs.includes(propIntent)) reading.prop_id = ''
      if (propIntent && !reading.prop_id) reading.effect = 'none'
      return bindFreeActionReadingToState(state, actorId, text, reading)
    } catch {
      return bindFreeActionReadingToState(state, actorId, text, {
        ...fallbackReading,
        source: `${fallbackReading.source}-after-agent-error`,
      })
    }
  }
}
