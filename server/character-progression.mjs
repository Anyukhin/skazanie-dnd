import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const catalogSource = readFileSync(new URL('../data/dndsu-class-build-rules-1-12.json', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../data/character-rules-manifest.json', import.meta.url), 'utf8'))
const catalogHash = createHash('sha256').update(catalogSource).digest('hex')
if (catalogHash !== manifest.source_sha256 || catalogSource.byteLength !== manifest.source_size_bytes) {
  throw new Error('Character rules catalog does not match its versioned provenance manifest')
}
const payload = JSON.parse(catalogSource.toString('utf8'))
if (manifest.maximum_character_level !== payload.maximumCharacterLevel) {
  throw new Error('Character rules manifest level cap does not match the catalog')
}
export const CHARACTER_RULES_PROVENANCE = Object.freeze(structuredClone(manifest))
const SKILLS = new Map(payload.skills.map((entry) => [entry.id, Object.freeze(entry)]))
const CLASS_RULES = new Map(payload.classes.map((entry) => [entry.classKey, Object.freeze(entry)]))
const FEATURE_GROUPS = Object.freeze(payload.featureChoiceGroups ?? [])
const normalizedName = (value) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim()

const roleText = (actor) => `${actor?.role ?? ''} ${actor?.class ?? ''} ${actor?.characterClass ?? ''}`.toLocaleLowerCase('ru')

export function characterClassKey(actor) {
  const explicit = String(actor?.characterClass ?? '').toLocaleLowerCase('en')
  if (CLASS_RULES.has(explicit)) return explicit
  const role = roleText(actor)
  for (const [key, pattern] of [
    ['barbarian', /варвар|barbarian/u], ['bard', /бард|bard/u], ['cleric', /жрец|cleric/u], ['druid', /друид|druid/u],
    ['fighter', /воин|fighter/u], ['monk', /монах|monk/u], ['paladin', /паладин|paladin/u], ['ranger', /следопыт|ranger/u],
    ['rogue', /плут|разбойник|rogue/u], ['sorcerer', /чарод|sorcer/u], ['warlock', /колдун|warlock/u], ['wizard', /волшеб|wizard|маг\b/u],
  ]) if (pattern.test(role)) return key
  return null
}

export function classSkillRuleFor(actor) {
  const classKey = characterClassKey(actor)
  const rule = CLASS_RULES.get(classKey)
  return rule ? structuredClone(rule) : null
}

/**
 * Один и тот же навык приходит сюда в двух написаниях: каталог правил хранит
 * `animal_handling` и `sleight_of_hand`, а движок и свободные действия говорят
 * дефисами (`canonicalSkillId`, `server/rules-engine.mjs`). Пока сравнение шло
 * буквальным, эти два навыка — и только они — молча теряли и владение, и
 * характеристику: `skillAbility('animal-handling')` возвращал `null`, а ловчий
 * с классовым владением Уходом за животными бросал его без бонуса владения.
 *
 * Ключ сравнения нечувствителен к написанию, но сам по себе он проблему не
 * закрывает: сравнивать мало, надо ещё и **отвечать** одним написанием.
 */
const canonicalSkillKey = (value) => String(value ?? '').trim().toLocaleLowerCase('en').replace(/_/gu, '-')

const SKILL_ABILITY_BY_KEY = new Map([...SKILLS].map(([id, entry]) => [canonicalSkillKey(id), entry.ability]))
const SKILL_ID_BY_KEY = new Map([...SKILLS.keys()].map((id) => [canonicalSkillKey(id), id]))

/**
 * Написание навыка в каноне проекта — том, в котором его хранит каталог правил
 * и перечисляет лист героя (`SKILL_IDS`, `server/character-lifecycle.mjs`):
 * подчёркивания. Это единственное место, где проект решает, как навык пишется.
 *
 * Нормализация стоит **на входе**, а не в каждом сравнении, и это не стилевое
 * предпочтение. Пока `normalizedClassSkillProficiencies` отвечала написанием
 * актора, лист и кость расходились молча: `isSkillProficient` сравнивал
 * нечувствительно и давал владение, а `deriveCharacterSheet` сверял ответ с
 * `SKILL_IDS` буквально и писал `proficient: false`. Следопыт с дефисным
 * `animal-handling` получал в карточке броска +5, а в своём же листе — навык
 * без владения.
 *
 * Незнакомое значение возвращается как есть: отбраковка не дело нормализатора,
 * её делает список навыков класса шагом ниже.
 */
export function catalogSkillId(value) {
  return SKILL_ID_BY_KEY.get(canonicalSkillKey(value)) ?? String(value ?? '')
}

export function normalizedClassSkillProficiencies(actor) {
  const rule = classSkillRuleFor(actor)
  if (!rule || !Array.isArray(actor?.classSkillProficiencies)) return []
  const allowed = new Set(rule.skills.map(canonicalSkillKey))
  return [...new Set(actor.classSkillProficiencies.map(catalogSkillId))]
    .filter((id) => allowed.has(canonicalSkillKey(id)))
    .slice(0, rule.choiceCount)
}

export function isSkillProficient(actor, skillId) {
  const selected = actor?.classSkillProficiencies
  if (!Array.isArray(selected)) return true
  const wanted = canonicalSkillKey(skillId)
  return normalizedClassSkillProficiencies(actor).some((id) => canonicalSkillKey(id) === wanted)
}

export function skillAbility(skillId) {
  return SKILL_ABILITY_BY_KEY.get(canonicalSkillKey(skillId)) ?? null
}

function choiceCountAtLevel(group, level) {
  return Object.entries(group.countsByLevel ?? {}).sort(([left], [right]) => Number(right) - Number(left)).find(([minimum]) => level >= Number(minimum))?.[1] ?? 0
}

export function featureChoiceGroupsFor(actor) {
  const classKey = characterClassKey(actor)
  const level = Math.max(1, Math.min(12, Number(actor?.level) || 1))
  const subclass = normalizedName(actor?.subclass ?? actor?.subClass ?? actor?.archetype)
  return FEATURE_GROUPS
    .filter((group) => group.classKey === classKey && level >= group.unlockLevel && (!group.subclass || normalizedName(group.subclass) === subclass))
    .map((group) => ({ ...structuredClone(group), choiceCount: Number(choiceCountAtLevel(group, level)) }))
}

/** Уровни, на которых этот класс получает стандартное улучшение характеристик. */
export function abilityScoreChoiceLevelsFor(actor) {
  const classKey = characterClassKey(actor)
  if (classKey === 'fighter') return [4, 6, 8, 12]
  if (classKey === 'rogue') return [4, 8, 10, 12]
  return [4, 8, 12]
}

export function normalizedSelectedFeatureIds(actor) {
  if (!Array.isArray(actor?.selectedFeatureIds)) return []
  const selected = new Set(actor.selectedFeatureIds.map(String))
  return featureChoiceGroupsFor(actor).flatMap((group) => group.options.filter((option) => selected.has(option.id)).slice(0, group.choiceCount).map((option) => option.id))
}

export function isOptionalFeatureSelected(actor, featureId) {
  if (!Array.isArray(actor?.selectedFeatureIds)) return true
  const optional = featureChoiceGroupsFor(actor).some((group) => group.options.some((option) => option.id === featureId))
  return !optional || normalizedSelectedFeatureIds(actor).includes(String(featureId ?? ''))
}

export function classBuildCatalogInfo() {
  return {
    provenance: structuredClone(CHARACTER_RULES_PROVENANCE),
    rulesProfile: payload.rulesProfile,
    maximumCharacterLevel: payload.maximumCharacterLevel,
    skillCount: SKILLS.size,
    featureChoiceGroupCount: FEATURE_GROUPS.length,
    skills: payload.skills.map((entry) => structuredClone(entry)),
    classes: payload.classes.map((entry) => ({
      classKey: entry.classKey,
      choiceCount: entry.choiceCount,
      optionCount: entry.skills.length,
      skillIds: [...entry.skills],
      sourceUrl: entry.sourceUrl,
    })),
  }
}
