// @ts-check

import { readFileSync } from 'node:fs'

import { combatActionsFor } from './combat-actions.mjs'
import { characterCreationCatalog } from './character-lifecycle.mjs'
import { normalizedClassSkillProficiencies, normalizedSelectedFeatureIds } from './character-progression.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/astohan-pilot-builds-v1.json', import.meta.url), 'utf8'))
const RULESET_ID = 'dnd_5e_2014'
const TARGET_LEVEL = 7

const clone = (value) => structuredClone(value)

export function astohanPilotBuildCatalog() {
  return clone(catalog)
}

export function astohanPilotBuildFor(id) {
  const build = catalog.builds.find((entry) => entry.id === String(id))
  return build ? clone(build) : null
}

/**
 * Проверка рецепта через те же каталоги, что использует мастер героя.
 * @param {any} recipe
 * @returns {{ok: true, actor: any, actions: any[]} | {ok: false, errors: string[]}}
 */
export function validateAstohanPilotBuild(recipe) {
  const errors = []
  const build = recipe && typeof recipe === 'object' ? recipe : null
  const classKey = String(build?.class ?? '')
  const actor = {
    id: 'pilot-' + classKey,
    characterClass: classKey,
    subclass: String(build?.subclass ?? ''),
    level: TARGET_LEVEL,
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 12 },
    classSkillProficiencies: Array.isArray(build?.class_skills) ? build.class_skills : [],
    selectedFeatureIds: Array.isArray(build?.features) ? build.features : [],
  }
  const creation = characterCreationCatalog(RULESET_ID)
  const classEntry = creation.classes.find((entry) => entry.id === classKey)
  const species = creation.ability_policy.species_options.find((entry) => entry.id === build?.species)
  const background = creation.backgrounds.options.find((entry) => entry.id === build?.background)
  if (!classEntry) errors.push('unknown class ' + classKey)
  if (!species) errors.push('unknown species ' + build?.species)
  if (!background) errors.push('unknown background ' + build?.background)
  if (classEntry && !classEntry.subclasses.some((entry) => entry.name === actor.subclass)) errors.push('unknown subclass ' + actor.subclass)
  if (!sameIds(actor.classSkillProficiencies, normalizedClassSkillProficiencies(actor))) errors.push('class skills are not a valid class choice')
  if (!sameIds(actor.selectedFeatureIds, normalizedSelectedFeatureIds(actor))) errors.push('feature choices are not valid')
  if (classEntry) {
    for (const group of classEntry.starter_equipment?.choice_groups ?? []) {
      const selected = build?.starter_equipment?.[group.id]
      if (!selected || !group.options.some((option) => option.id === selected)) errors.push('invalid starter equipment choice ' + group.id)
    }
  }
  if ((build?.known_spells ?? []).length || (build?.prepared_spells ?? []).length) errors.push('pilot builds must not request spell cards')
  const actions = combatActionsFor(actor)
  const actionById = new Map(actions.map((entry) => [entry.id, entry]))
  const exposed = Array.isArray(build?.exposed_actions) ? build.exposed_actions : []
  for (const id of exposed) {
    const action = actionById.get(id)
    if (!action) errors.push('unknown exposed action ' + id)
    else if (action.mechanicsSupport !== 'verified') errors.push('exposed action ' + id + ' is ' + action.mechanicsSupport)
  }
  for (const [level, choices] of Object.entries(build?.ability_score_increases ?? {})) {
    const numeric = Number(level)
    if (![4, 6, 8, 12].includes(numeric) || !Array.isArray(choices) || ![1, 2].includes(choices.length)) errors.push('invalid ASI at level ' + level)
  }
  return errors.length ? { ok: false, errors } : { ok: true, actor, actions: exposed.map((id) => actionById.get(id)) }
}

/**
 * Commands executed by the normal staged character wizard after level-one setup.
 * @param {any} recipe
 * @param {string} actorId
 */
export function stagedCommandsForPilotBuild(recipe, actorId = 'pilot-' + recipe.id) {
  const commands = []
  const base = {
    command_type: 'SetCharacterChoices',
    actor_id: actorId,
    subclass: '',
    class_skill_proficiencies: recipe.class_skills,
    selected_feature_ids: recipe.id === 'fighter' ? recipe.features : [],
  }
  commands.push(base)
  const subclass = { ...base, subclass: recipe.subclass, selected_feature_ids: recipe.features }
  for (let level = 1; level < TARGET_LEVEL; level += 1) {
    commands.push({ command_type: 'LevelUp', actor_id: actorId, expected_level: level })
    const nextLevel = level + 1
    if (nextLevel === 2 && recipe.id === 'paladin') commands.push({ ...base, selected_feature_ids: recipe.features })
    if (nextLevel === 3) commands.push(subclass)
    if (nextLevel === 4 || (nextLevel === 6 && recipe.ability_score_increases[String(nextLevel)])) {
      const choices = recipe.ability_score_increases[String(nextLevel)]
      if (choices) commands.push({ ...subclass, ability_score_level: nextLevel, ability_score_increases: choices })
    }
  }
  return commands
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
}
