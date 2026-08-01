// @ts-check
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Предыстории редакции 2024. Каталог — единственный источник их последствий.
 *
 * Клиент присылает только идентификатор предыстории и раскладку её прибавок;
 * сами прибавки, навыки, инструмент и черту сервер берёт отсюда. Иначе набор
 * бонусов стал бы недоверенным полем: подставить «+2 ко всему» было бы делом
 * одной строки в запросе.
 *
 * Черта происхождения записывается, но механически **не исполняется**: feats
 * в покрытии проекта помечены `missing` (`data/rules-coverage-matrix.json`),
 * и притворяться, что она работает, нельзя — это прямо запрещено словарём
 * статусов в `AGENTS.md`.
 */

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../data/backgrounds-srd-5-2-1.json', import.meta.url)), 'utf8'))

export const BACKGROUND_POLICY_ID = String(catalog.policyId ?? 'skazanie.backgrounds')
export const BACKGROUND_ABILITY_MODES = Object.freeze(
  (catalog.abilityChoiceModes ?? []).map((mode) => Object.freeze({ ...mode, increases: Object.freeze([...mode.increases]) })),
)

const ABILITY_IDS = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const byId = new Map(catalog.backgrounds.map((entry) => [String(entry.id), Object.freeze(entry)]))

export function listBackgrounds() {
  return catalog.backgrounds.map((entry) => structuredClone(entry))
}

export function backgroundById(id) {
  return byId.get(String(id ?? '')) ?? null
}

/**
 * Раскладка прибавок: какая характеристика получает сколько. Принимается
 * только выбор из трёх, предложенных предысторией, и только в одной из двух
 * разрешённых форм — +2/+1 либо +1/+1/+1.
 *
 * @param {string} backgroundId
 * @param {{ mode?: string, abilities?: string[] }} choice
 * @returns {{ ok: true, bonuses: Record<string, number>, mode: string } | { ok: false, reason: string }}
 */
export function resolveBackgroundAbilityChoice(backgroundId, choice = {}) {
  const background = backgroundById(backgroundId)
  if (!background) return { ok: false, reason: 'Такой предыстории нет в каталоге' }
  const allowed = new Set(background.abilityOptions)
  const mode = BACKGROUND_ABILITY_MODES.find((entry) => entry.id === String(choice.mode ?? ''))
    ?? BACKGROUND_ABILITY_MODES[0]
  const picked = (Array.isArray(choice.abilities) ? choice.abilities : []).map((value) => String(value).toLowerCase())
  const expected = mode.increases.length
  if (picked.length !== expected) {
    return { ok: false, reason: `Для раскладки «${mode.label}» нужно выбрать ${expected} ${expected === 2 ? 'характеристики' : 'характеристики'}` }
  }
  if (new Set(picked).size !== picked.length) return { ok: false, reason: 'Характеристики в раскладке не должны повторяться' }
  for (const ability of picked) {
    if (!ABILITY_IDS.includes(ability)) return { ok: false, reason: 'Неизвестная характеристика' }
    if (!allowed.has(ability)) return { ok: false, reason: 'Эта предыстория такую характеристику не повышает' }
  }
  /** @type {Record<string, number>} */
  const bonuses = {}
  picked.forEach((ability, index) => { bonuses[ability] = mode.increases[index] })
  return { ok: true, bonuses, mode: mode.id }
}

/** Раскладка по умолчанию: +2 первой из предложенных, +1 второй. */
export function defaultBackgroundAbilityChoice(backgroundId) {
  const background = backgroundById(backgroundId)
  if (!background) return null
  return { mode: 'two_one', abilities: background.abilityOptions.slice(0, 2) }
}

/**
 * Достраивает герою производные предыстории: владения навыками и разбор
 * последствий. Хранить их в документе персонажа нельзя — он ходит через
 * контракт импорта, который перечитывается при применении события и replay,
 * а производные поля в контракт не входят. Поэтому источник истины —
 * `backgroundId`, а всё остальное выводится здесь.
 */
export function withBackgroundBenefits(actor) {
  const background = backgroundById(actor?.backgroundId)
  if (!background) {
    const { backgroundSkillProficiencies: _skills, backgroundBenefits: _benefits, ...rest } = actor ?? {}
    return rest
  }
  return {
    ...actor,
    backgroundSkillProficiencies: [...background.skillProficiencies],
    backgroundBenefits: backgroundBenefits(background.id, actor.backgroundAbilityChoice),
  }
}

/**
 * Что предыстория даёт герою на самом деле. Возвращается ровно то, что движок
 * умеет применить, плюс честная отметка о неисполняемой части.
 */
export function backgroundBenefits(backgroundId, abilityChoice) {
  const background = backgroundById(backgroundId)
  if (!background) return null
  const resolved = resolveBackgroundAbilityChoice(backgroundId, abilityChoice ?? defaultBackgroundAbilityChoice(backgroundId) ?? {})
  if (!resolved.ok) return null
  return {
    background_id: background.id,
    policy_id: BACKGROUND_POLICY_ID,
    ability_bonuses: resolved.bonuses,
    ability_mode: resolved.mode,
    skill_proficiencies: [...background.skillProficiencies],
    tool_proficiency: background.toolProficiency?.id ?? null,
    // Черта записана для листа и повествования; движок её не применяет.
    origin_feat: background.originFeat?.id ?? null,
    origin_feat_supported: false,
  }
}
