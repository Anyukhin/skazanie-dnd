import { readFileSync } from 'node:fs'

import { parseDiceExpression } from './dice-service.mjs'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const overrideSource = readFileSync(new URL('../data/dndsu-spell-mechanics-overrides.json', import.meta.url), 'utf8')
const overrides = JSON.parse(overrideSource)

/**
 * `JSON.parse` keeps the last of two identical keys and says nothing, so a
 * second definition of the same spell silently replaces the first.  The raw
 * text is the only place that mistake is still visible.
 */
function duplicateOverrideIds() {
  const ids = [...overrideSource.matchAll(/^\s{4}"([a-z0-9-]+)"\s*:\s*\{/gmu)].map((match) => match[1])
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
}

const BASE_SPELLS = new Map((catalog.spells ?? []).map((spell) => [spell.id, spell]))

/**
 * Shapes the Rules Engine actually dispatches on.  A card of any other kind
 * would be accepted by the loader and then silently do nothing, which is the
 * failure mode this audit exists to prevent.
 */
const EXECUTABLE_KINDS = new Set([
  'attack', 'save', 'area-save', 'damage', 'area-damage', 'debuff', 'buff', 'utility', 'healing', 'teleport', 'summon',
])
const TARGETS = new Set(['self', 'ally', 'enemy', 'point', 'creature'])
const ABILITIES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const AREA_SHAPES = new Set(['sphere', 'cone', 'cube', 'line'])
const CREATURE_TYPES = new Set(['humanoid', 'undead', 'construct', 'beast', 'fiend', 'celestial', 'giant', 'dragon', 'elemental', 'fey', 'monstrosity', 'ooze', 'plant', 'aberration'])

/**
 * Conditions whose mechanical consequences the engine enforces.  A card may
 * still name a narrative condition, but the audit reports it so nobody mistakes
 * a label for a rule.
 */
const ENFORCED_CONDITIONS = new Set([
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'speed-zero', 'stunned', 'unconscious',
])

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Поля карточки, которые Rules Engine действительно читает.  Список собирается
 * из исходника движка, а не поддерживается руками: объявить в данных поле,
 * которого никто не читает, — то же самое, что соврать в карточке. Так уже
 * случилось с `beamScaling` у Мистического заряда: поле было в данных, было в
 * типах клиента и не читалось нигде, поэтому колдун бил одним лучом вместо трёх.
 */
const ENGINE_SOURCE = readFileSync(new URL('./rules-engine.mjs', import.meta.url), 'utf8')
// Опциональная цепочка (`spell?.beams`) — такое же чтение поля, как обычная
// точка, и пропускать её нельзя: иначе живое поле выглядит мёртвым.
const FIELDS_READ_BY_ENGINE = new Set([...ENGINE_SOURCE.matchAll(/\bspell\??\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]))

/** Метаданные карточки: их читают каталог и интерфейс, а не движок правил. */
const PRESENTATION_FIELDS = new Set([
  'mechanicsSupport', 'mechanicsAccuracy', 'supportNote', 'description', 'name', 'englishName',
  'school', 'classes', 'ritual', 'rangeText', 'castingTime', 'duration', 'sourceUrl', 'prepared',
  'damageTypes', 'radius', 'areaShape', 'areaOrigin', 'createsAreaEffect',
])

function diceProblem(expression, label, id) {
  if (expression == null) return null
  try {
    parseDiceExpression(String(expression))
    return null
  } catch {
    return { id, code: 'INVALID_DICE', message: `${label}: «${expression}» не разбирается как формула костей` }
  }
}

/**
 * Cross-checks every hand-written spell override against the scraped catalog.
 *
 * The overrides exist because the generated catalog infers mechanics from prose
 * and gets them wrong; the point of this audit is that the corrections stay
 * deliberate. Facts that identify the card — its level and the slot it spends —
 * may never diverge, because a mismatch there silently charges the wrong
 * resource. Everything else may diverge, and the report counts those so the
 * scale of the correction stays visible instead of implicit.
 */
export function auditSpellOverrides() {
  const problems = []
  const corrections = []
  const entries = Object.entries(overrides.spells ?? {})

  for (const id of duplicateOverrideIds()) {
    problems.push({ id, code: 'DUPLICATE_OVERRIDE', message: 'заклинание описано дважды: второе определение молча заменяет первое' })
  }

  for (const [id, override] of entries) {
    const base = BASE_SPELLS.get(id)
    if (!base) {
      problems.push({ id, code: 'UNKNOWN_SPELL', message: 'override описывает заклинание, которого нет в каталоге' })
      continue
    }
    if (!isPlainObject(override)) {
      problems.push({ id, code: 'INVALID_OVERRIDE', message: 'override обязан быть объектом' })
      continue
    }

    // --- инварианты, расхождение по которым списывает не тот ресурс ---
    if (override.level != null && override.level !== base.level) {
      problems.push({ id, code: 'LEVEL_MISMATCH', message: `круг ${override.level} против ${base.level} в каталоге` })
    }
    if (override.slotResource != null && override.slotResource !== base.slotResource) {
      problems.push({ id, code: 'SLOT_MISMATCH', message: `ячейка ${override.slotResource} против ${base.slotResource} в каталоге` })
    }
    if (override.concentration != null && override.concentration !== base.concentration) {
      problems.push({ id, code: 'CONCENTRATION_MISMATCH', message: 'концентрация не совпадает с каталогом' })
    }

    // --- форма карточки должна быть исполнимой ---
    const kind = override.kind ?? base.kind
    if (!EXECUTABLE_KINDS.has(String(kind))) {
      problems.push({ id, code: 'UNSUPPORTED_KIND', message: `движок не исполняет вид «${kind}»` })
    }
    const target = override.target ?? base.target
    if (!TARGETS.has(String(target))) {
      problems.push({ id, code: 'UNKNOWN_TARGET', message: `неизвестная цель «${target}»` })
    }
    if (override.saveAbility != null && !ABILITIES.has(String(override.saveAbility))) {
      problems.push({ id, code: 'UNKNOWN_SAVE', message: `неизвестная характеристика спасброска «${override.saveAbility}»` })
    }
    if (override.areaShape != null && !AREA_SHAPES.has(String(override.areaShape))) {
      problems.push({ id, code: 'UNKNOWN_AREA_SHAPE', message: `неизвестная форма области «${override.areaShape}»` })
    }
    if (String(kind).startsWith('area-') && !(Number(override.radius ?? base.radius) > 0)) {
      problems.push({ id, code: 'AREA_WITHOUT_RADIUS', message: 'площадное заклинание объявлено без радиуса' })
    }
    if (String(kind) === 'area-save' && override.saveAbility == null && base.saveAbility == null) {
      problems.push({ id, code: 'AREA_SAVE_WITHOUT_ABILITY', message: 'область со спасброском объявлена без характеристики' })
    }

    // --- формулы обязаны разбираться, иначе карточка падает в бою ---
    for (const [value, label] of [
      [override.damage, 'урон'], [override.healing, 'лечение'],
      [override.hitPointPoolDice, 'пул хитов'], [override.temporaryHpDice, 'временные хиты'],
    ]) {
      const problem = diceProblem(value, label, id)
      if (problem) problems.push(problem)
    }

    // --- выбор эффекта обязан быть согласован ---
    for (const field of ['conditionsByOption', 'removesConditionsByOption']) {
      if (override[field] == null) continue
      const options = new Set((override.spellOptions ?? []).map(String))
      if (!options.size) {
        problems.push({ id, code: 'OPTIONS_MISSING', message: `${field} объявлен без spellOptions` })
      }
      for (const key of Object.keys(override[field])) {
        if (!options.has(key)) problems.push({ id, code: 'OPTION_UNLISTED', message: `${field}: вариант «${key}» отсутствует в spellOptions` })
      }
      for (const option of options) {
        if (!override[field][option]) problems.push({ id, code: 'OPTION_WITHOUT_EFFECT', message: `${field}: вариант «${option}» не даёт эффекта` })
      }
    }

    for (const [field, allowed] of [['requiredCreatureTypes', CREATURE_TYPES], ['immuneCreatureTypes', CREATURE_TYPES]]) {
      for (const value of override[field] ?? []) {
        if (!allowed.has(String(value))) problems.push({ id, code: 'UNKNOWN_CREATURE_TYPE', message: `${field}: неизвестный тип «${value}»` })
      }
    }

    // --- состояния: помечаем те, что движок не исполняет ---
    const declared = [
      ...(override.conditions ?? []),
      ...Object.values(override.conditionsByOption ?? {}).flat(),
      ...(override.onHitConditions ?? []),
    ].map(String)
    // Состояние-носитель периодического урона не бесполезно: следствия у него
    // есть, просто описаны не таблицей состояний, а полями самой карточки.
    const carriesRecurringDamage = Boolean(override.recurringDamage)
    for (const condition of new Set(declared)) {
      const marker = condition.includes(':') || condition.startsWith('spell-effect:')
      if (!marker && !ENFORCED_CONDITIONS.has(condition) && !carriesRecurringDamage) {
        corrections.push({ id, field: 'conditions', note: `«${condition}» — маркер карточки, механических следствий у него нет` })
      }
    }

    // --- объявленное поле обязано кем-то читаться ---
    for (const field of Object.keys(override)) {
      if (PRESENTATION_FIELDS.has(field) || FIELDS_READ_BY_ENGINE.has(field)) continue
      problems.push({ id, code: 'FIELD_NEVER_READ', message: `поле «${field}» объявлено в карточке, но Rules Engine его нигде не читает` })
    }

    // --- сколько именно исправлено против автогенерации ---
    for (const field of ['kind', 'target', 'saveAbility', 'range', 'damage', 'damageType']) {
      if (override[field] === undefined) continue
      const before = base[field] ?? null
      const after = override[field] ?? null
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        corrections.push({ id, field, from: before, to: after })
      }
    }
  }

  return {
    ok: problems.length === 0,
    checked: entries.length,
    catalog: BASE_SPELLS.size,
    corrections: corrections.length,
    correctionsByField: corrections.reduce((total, entry) => ({ ...total, [entry.field]: (total[entry.field] ?? 0) + 1 }), {}),
    problems,
    details: corrections,
  }
}
