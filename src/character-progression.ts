import buildRules from '../data/dndsu-class-build-rules-1-12.json'
import type { Player } from './types'
import { playerClassKey } from './combat-actions'

export type DndSkill = { id: string; name: string; ability: keyof Player['abilities'] }
export type ClassSkillRule = { classKey: string; choiceCount: number; skills: string[]; sourceUrl: string }
export type FeatureChoiceOption = { id: string; name: string; minimumLevel?: number }
export type FeatureChoiceGroup = { id: string; classKey: string; subclass?: string; name: string; unlockLevel: number; countsByLevel: Record<string, number>; options: FeatureChoiceOption[] }

const skills = new Map((buildRules.skills as DndSkill[]).map((entry) => [entry.id, entry]))
const classRules = new Map((buildRules.classes as ClassSkillRule[]).map((entry) => [entry.classKey, entry]))
const featureGroups = buildRules.featureChoiceGroups as unknown as FeatureChoiceGroup[]
const normalizedName = (value?: string | null) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim()

export function classSkillRulesFor(player?: Player) {
  const classKey = playerClassKey(player)
  const rule = classKey ? classRules.get(classKey) : undefined
  if (!rule) return null
  return {
    ...rule,
    options: rule.skills.map((id) => skills.get(id)).filter((entry): entry is DndSkill => Boolean(entry)),
  }
}

export function normalizedClassSkills(player?: Player) {
  const rule = classSkillRulesFor(player)
  if (!rule) return []
  const allowed = new Set(rule.skills)
  return [...new Set(player?.classSkillProficiencies ?? [])].filter((id) => allowed.has(id)).slice(0, rule.choiceCount)
}

export function featureChoiceGroupsFor(player?: Player) {
  const classKey = playerClassKey(player)
  const level = Math.max(1, Math.min(12, Number(player?.level) || 1))
  const subclass = normalizedName(player?.subclass)
  return featureGroups
    .filter((group) => group.classKey === classKey && level >= group.unlockLevel && (!group.subclass || normalizedName(group.subclass) === subclass))
    .map((group) => ({
      ...structuredClone(group),
      choiceCount: Number(Object.entries(group.countsByLevel).sort(([left], [right]) => Number(right) - Number(left)).find(([minimum]) => level >= Number(minimum))?.[1] ?? 0),
    }))
}

export function normalizedSelectedFeatures(player?: Player) {
  const selected = new Set(player?.selectedFeatureIds ?? [])
  return featureChoiceGroupsFor(player).flatMap((group) => group.options.filter((option) => selected.has(option.id)).slice(0, group.choiceCount).map((option) => option.id))
}
