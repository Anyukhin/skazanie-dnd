const normalizeSkill = (id) => String(id).replaceAll('-', '_')
const arrayStrings = (value) => Array.isArray(value) ? value.map(String) : []
const toolKey = (id) => ({
  dragonchess_set: 'dragonchess',
  three_dragon_ante_set: 'three_dragon_ante',
  playing_card_set: 'playing_cards',
  land_vehicles: 'vehicles_land',
  water_vehicles: 'vehicles_water',
})[id] ?? id

const defaultChoiceRecord = (groups = []) => Object.fromEntries(
  groups.map((group) => [group.id, group.options.slice(0, group.count).map((option) => option.id)]),
)

/**
 * Заполняет только те выборы пилотного листа, которые зависят от каталога
 * мастера: замены повторяющихся навыков/инструментов и неповторяющиеся языки.
 * Это намеренно тот же порядок источников, что и проверки мастера.
 */
export function pilotCreationChoicesFor(catalog, recipe) {
  const species = catalog.ability_policy.species_options.find((entry) => entry.id === recipe.species)
  const background = catalog.backgrounds?.options.find((entry) => entry.id === recipe.background)
  const phbClass = catalog.phb?.classes.find((entry) => entry.id === recipe.class)
  const speciesChoices = defaultChoiceRecord(species?.choice_groups)
  const classChoices = recipe.class === 'monk'
    ? { tool_or_instrument: { kind: 'artisan_tool', id: 'smiths_tools' } }
    : {}
  const backgroundTools = (background?.toolChoice?.options ?? [])
    .slice(0, background?.toolChoice?.count ?? 0)
    .map((entry) => entry.id)
  const speciesLanguageIds = new Set([
    ...(species?.languages ?? []),
    ...species?.choice_groups?.filter((group) => group.kind === 'language').flatMap((group) => speciesChoices[group.id] ?? []) ?? [],
  ])
  const backgroundLanguages = (catalog.backgrounds?.language_options ?? [])
    .filter((entry) => !speciesLanguageIds.has(entry.id))
    .slice(0, background?.languageChoiceCount ?? 0)
    .map((entry) => entry.id)

  const speciesFixedSkills = Array.isArray(species?.mechanics?.skill_proficiencies)
    ? species.mechanics.skill_proficiencies.map(String)
    : []
  const grantedSkills = [
    ...recipe.class_skills,
    ...speciesFixedSkills,
    ...species?.choice_groups?.filter((group) => group.kind === 'skill').flatMap((group) => speciesChoices[group.id] ?? []) ?? [],
    ...(background?.skillProficiencies ?? []),
  ].map(normalizeSkill)
  const knownSkills = new Set(grantedSkills)
  const allSkills = [...new Map(catalog.classes
    .flatMap((entry) => entry.class_skills?.options ?? [])
    .map((skill) => [normalizeSkill(skill.id), normalizeSkill(skill.id)])).values()]
  const replacementSkillCount = catalog.ruleset_id === 'dnd_5e_2014'
    ? grantedSkills.length - knownSkills.size
    : 0
  const backgroundReplacementSkills = allSkills
    .filter((id) => !knownSkills.has(id))
    .slice(0, replacementSkillCount)

  const grantedTools = [
    ...arrayStrings(species?.mechanics?.tool_proficiencies),
    ...species?.choice_groups?.filter((group) => group.kind === 'tool').flatMap((group) => speciesChoices[group.id] ?? []) ?? [],
    ...(background?.toolProficiencies ?? []).map((entry) => entry.id),
    ...backgroundTools,
    ...(phbClass?.tool_proficiencies ?? []),
    ...arrayStrings(classChoices.instruments),
    ...(classChoices.tool_or_instrument && typeof classChoices.tool_or_instrument === 'object' ? [String(classChoices.tool_or_instrument.id)] : []),
  ].map(toolKey)
  const knownTools = new Set(grantedTools)
  const replacementToolCount = catalog.phb ? grantedTools.length - knownTools.size : 0
  const allTools = (catalog.phb?.tools ?? []).map((tool) => toolKey(tool.id))
  const backgroundReplacementTools = allTools
    .filter((id) => !knownTools.has(id))
    .slice(0, replacementToolCount)

  return {
    speciesChoices,
    classChoices,
    backgroundTools,
    backgroundLanguages,
    backgroundReplacementSkills,
    backgroundReplacementTools,
  }
}
