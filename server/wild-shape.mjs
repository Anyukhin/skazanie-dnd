// @ts-check
/**
 * Дикий облик друида (PHB 2014): в каких зверей друид умеет обращаться по
 * кругу и уровню. Формы берутся из бестиария 2014 той же сборкой, что у врагов
 * стенда (`enemyFrom2014`): хиты, КД, скорость, размер и основная атака зверя.
 *
 * - Круг земли и прочие: ПО ¼ со 2-го уровня, ½ с 4-го, 1 с 8-го.
 * - Круг луны: ПО 1 со 2-го уровня, с 6-го — уровень / 3 (на 7-м — ПО 2).
 *
 * Летающих и плавающих зверей в наборе нет, поэтому запреты 2-го и 4-го
 * уровня на полёт и плавание соблюдаются составом списка. Модуль — лист:
 * Rules Engine не импортирует; команду и события исполняет он.
 */
import { readFileSync } from 'node:fs'

import { enemyFrom2014 } from './combat-lab-monsters.mjs'

const BEAST_IDS = Object.freeze(['wolf', 'brown-bear', 'dire-wolf', 'lion', 'giant-spider', 'giant-boar'])
const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters

/** `1/4` → 0.25. @param {unknown} raw */
function challengeRating(raw) {
  const text = String(raw ?? '').trim()
  const fraction = /^(\d+)\s*\/\s*(\d+)$/u.exec(text)
  if (fraction) return Number(fraction[1]) / Math.max(1, Number(fraction[2]))
  const value = Number(text)
  return Number.isFinite(value) ? value : 0
}

/**
 * @typedef {{ id: string, name: string, challenge_rating: number, hp: number, armor: number, speed: number, size: string, attack_profile: any }} WildShapeForm
 */

/** @type {readonly WildShapeForm[]} */
export const WILD_SHAPE_FORMS = Object.freeze(BEAST_IDS.map((id) => {
  const record = records.find((/** @type {any} */ entry) => String(entry.id).endsWith(`:${id}`))
  if (!record) throw new Error(`Дикий облик: в бестиарии нет зверя ${id}`)
  const beast = enemyFrom2014(record, { x: 0, y: 0 })
  return Object.freeze({
    id,
    name: String(beast.name),
    challenge_rating: challengeRating(record.challenge_rating),
    hp: Number(beast.maxHp ?? beast.hp),
    armor: Number(beast.armor),
    speed: Number(beast.speed),
    size: String(beast.size ?? 'medium'),
    attack_profile: beast.attack_profile ? JSON.parse(JSON.stringify(beast.attack_profile)) : null,
  })
}))

/** Друид Круга луны. @param {any} actor */
export function isMoonDruid(actor) {
  return /луны|moon/iu.test(String(actor?.subclass ?? actor?.subClass ?? ''))
}

/** Предельный показатель опасности зверя для друида. @param {any} actor */
export function wildShapeChallengeLimit(actor) {
  const level = Math.max(1, Math.trunc(Number(actor?.level) || 1))
  if (level < 2) return -1
  if (isMoonDruid(actor)) return level >= 6 ? Math.floor(level / 3) : 1
  return level >= 8 ? 1 : level >= 4 ? 0.5 : 0.25
}

/** Звери, доступные друиду. @param {any} actor @returns {WildShapeForm[]} */
export function wildShapeFormsFor(actor) {
  const limit = wildShapeChallengeLimit(actor)
  return WILD_SHAPE_FORMS.filter((form) => form.challenge_rating <= limit)
}

/**
 * Облик по выбору игрока или сильнейший доступный: выше показатель опасности,
 * затем больше хитов. `null` — друиду ещё некого принять.
 * @param {any} actor
 * @param {unknown} formId
 * @returns {WildShapeForm | null}
 */
export function wildShapeFormFor(actor, formId = '') {
  const forms = wildShapeFormsFor(actor)
  const chosen = forms.find((form) => form.id === String(formId ?? ''))
  if (chosen) return chosen
  return [...forms].sort((left, right) => right.challenge_rating - left.challenge_rating || right.hp - left.hp || left.id.localeCompare(right.id, 'en'))[0] ?? null
}
