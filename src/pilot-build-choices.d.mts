import type { CharacterCreationCatalog } from './types'
import type { AstohanPilotBuild } from './astohan-pilot-builds'

export function pilotCreationChoicesFor(
  catalog: CharacterCreationCatalog,
  recipe: AstohanPilotBuild,
): {
  speciesChoices: Record<string, string[]>
  classChoices: Record<string, unknown>
  backgroundTools: string[]
  backgroundLanguages: string[]
  backgroundReplacementSkills: string[]
  backgroundReplacementTools: string[]
}
