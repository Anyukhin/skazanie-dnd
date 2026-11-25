import catalog from '../data/astohan-pilot-builds-v1.json'

export type AstohanPilotBuild = (typeof catalog.builds)[number]

export const astohanPilotBuildCatalog = catalog.builds as AstohanPilotBuild[]

export function stagedCommandsForPilotBuild(recipe: AstohanPilotBuild, actorId: string) {
  const commands: Array<Record<string, unknown>> = [{
    command_type: 'SetCharacterChoices',
    actor_id: actorId,
    subclass: '',
    class_skill_proficiencies: recipe.class_skills,
    selected_feature_ids: recipe.id === 'fighter' ? recipe.features : [],
  }]
  const subclass = { ...commands[0], subclass: recipe.subclass, selected_feature_ids: recipe.features }
  for (let level = 1; level < catalog.target_level; level += 1) {
    commands.push({ command_type: 'LevelUp', actor_id: actorId, expected_level: level })
    const nextLevel = level + 1
    if (nextLevel === 2 && recipe.id === 'paladin') commands.push({ ...commands[0], selected_feature_ids: recipe.features })
    if (nextLevel === 3) commands.push(subclass)
    if (nextLevel === 4 || (nextLevel === 6 && recipe.ability_score_increases[String(nextLevel) as keyof typeof recipe.ability_score_increases])) {
      const choices = recipe.ability_score_increases[String(nextLevel) as keyof typeof recipe.ability_score_increases]
      if (choices) commands.push({ ...subclass, ability_score_level: nextLevel, ability_score_increases: choices })
    }
  }
  return commands
}
