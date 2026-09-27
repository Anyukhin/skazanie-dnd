import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const EXPECTED_SPELL_COUNT = 439
export const SPELL_SOURCE_INDEX = 'https://www.dnd.su/piece/spells/index-list/'

const ALLOWED_SOURCE_HOSTS = new Set(['dnd.su', 'www.dnd.su', '5e14.dnd.su', 'www.5e14.dnd.su'])
const CLASS_IDS = new Set(['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard'])
const SPELL_KINDS = new Set(['attack', 'save', 'area-save', 'damage', 'area-damage', 'debuff', 'buff', 'utility', 'healing', 'teleport', 'summon'])
const TARGETS = new Set(['self', 'ally', 'enemy', 'point', 'creature'])
const ACTION_TYPES = new Set(['action', 'bonus_action', 'reaction', 'long_cast'])
const AREA_SHAPES = new Set(['sphere', 'cone', 'cube', 'line', 'cylinder'])
const ABILITIES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])

const REQUIRED_FIELDS = Object.freeze([
  'id', 'name', 'englishName', 'level', 'school', 'classes', 'ritual',
  'concentration', 'range', 'rangeText', 'castingTime', 'duration',
  'sourceUrl', 'slotResource', 'kind', 'target', 'damage', 'damageTypes',
  'damageType', 'healing', 'saveAbility', 'halfOnSave', 'conditions',
  'durationRounds', 'addAbilityModifier', 'actionType', 'description',
  'components', 'higherLevels', 'sourceClasses', 'subclasses',
])

const requiredText = new Set([
  'id', 'name', 'englishName', 'school', 'rangeText', 'castingTime',
  'duration', 'description',
])

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hasText = (value) => typeof value === 'string' && value.trim().length > 0
const hasRussianText = (value) => hasText(value) && /\p{Script=Cyrillic}/u.test(value)
const wordCount = (value) => String(value ?? '').trim().split(/\s+/u).filter(Boolean).length
const READER_WORD_LIMIT = 190

function problem(problems, id, code, field, message) {
  problems.push({ id, code, ...(field ? { field } : {}), message })
}

function gap(gaps, id, code, fields, message) {
  gaps.push({ id, code, fields, message })
}

function validSourceUrl(value) {
  if (!hasText(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && ALLOWED_SOURCE_HOSTS.has(url.hostname)
      && /^\/spells\//u.test(url.pathname)
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

function validDate(value) {
  return hasText(value) && Number.isFinite(Date.parse(value))
}

function validateComponents(components, id, problems) {
  if (!isObject(components)) {
    problem(problems, id, 'COMPONENTS_MISSING', 'components', 'Строка компонентов отсутствует или имеет не объектную форму.')
    return
  }
  for (const field of ['verbal', 'somatic']) {
    if (typeof components[field] !== 'boolean') problem(problems, id, 'COMPONENT_FLAG_INVALID', `components.${field}`, 'Флаг компонента должен быть boolean.')
  }
  if (components.material !== null && !isObject(components.material)) {
    problem(problems, id, 'MATERIAL_COMPONENT_INVALID', 'components.material', 'Материальный компонент должен быть объектом или null.')
  }
  if (isObject(components.material)) {
    const material = components.material
    if (!hasText(material.description)) problem(problems, id, 'MATERIAL_DESCRIPTION_MISSING', 'components.material.description', 'Материальный компонент должен иметь описание.')
    if (material.costGp !== null && (!Number.isFinite(material.costGp) || material.costGp < 0)) problem(problems, id, 'MATERIAL_COST_INVALID', 'components.material.costGp', 'Стоимость материала должна быть null или неотрицательным числом.')
    for (const field of ['consumed', 'focusSubstitutable']) {
      if (typeof material[field] !== 'boolean') problem(problems, id, 'MATERIAL_FLAG_INVALID', `components.material.${field}`, 'Флаг материала должен быть boolean.')
    }
    if (material.unresolved !== undefined && typeof material.unresolved !== 'boolean') problem(problems, id, 'MATERIAL_UNRESOLVED_INVALID', 'components.material.unresolved', 'Признак нерешённого материала должен быть boolean.')
    if (material.requirementNote !== undefined && !hasText(material.requirementNote)) problem(problems, id, 'MATERIAL_NOTE_INVALID', 'components.material.requirementNote', 'Пояснение требования материала не может быть пустым.')
  }
  if (components.special !== undefined) {
    if (!Array.isArray(components.special)) problem(problems, id, 'SPECIAL_COMPONENT_INVALID', 'components.special', 'Особые требования должны быть массивом.')
    else for (const entry of components.special) {
      if (!isObject(entry) || !hasText(entry.kind) || !hasText(entry.description)) problem(problems, id, 'SPECIAL_COMPONENT_INVALID', 'components.special', 'Особое требование должно иметь kind и description.')
    }
  }
}

function checkDescriptionDictionary(catalog, dictionary, problems) {
  if (!isObject(dictionary)) {
    problems.push({ code: 'DESCRIPTION_DICTIONARY_MISSING', message: 'Словарь русских пересказов не является объектом.' })
    return
  }
  if (dictionary.count !== EXPECTED_SPELL_COUNT) problems.push({ code: 'DESCRIPTION_COUNT_MISMATCH', message: `Словарь должен содержать ${EXPECTED_SPELL_COUNT} записей.` })
  if (!isObject(dictionary.descriptions)) {
    problems.push({ code: 'DESCRIPTION_MAP_MISSING', message: 'В словаре отсутствует объект descriptions.' })
    return
  }
  const catalogIds = new Set((catalog.spells ?? []).map((spell) => spell.id))
  const descriptionIds = new Set(Object.keys(dictionary.descriptions))
  for (const id of catalogIds) {
    const description = dictionary.descriptions[id]
    if (!hasText(description)) problems.push({ id, code: 'DESCRIPTION_MISSING', field: 'descriptions', message: 'Нет самостоятельного русского пересказа.' })
  }
  for (const id of descriptionIds) if (!catalogIds.has(id)) problems.push({ id, code: 'DESCRIPTION_UNKNOWN_ID', field: 'descriptions', message: 'Словарь содержит ID вне каталога.' })
  const details = dictionary.details
  if (!isObject(details)) problems.push({ code: 'DETAILS_MAP_MISSING', field: 'details', message: 'В словаре отсутствует объект подробных русских карточек.' })
  else {
    for (const id of catalogIds) {
      const value = details[id]
      if (!hasRussianText(value)) problems.push({ id, code: 'DETAILS_MISSING', field: 'details', message: 'Нет самостоятельного подробного русского текста.' })
      else if (wordCount(value) > READER_WORD_LIMIT) problems.push({ id, code: 'DETAILS_TOO_LONG', field: 'details', message: `Подробный текст длиннее ${READER_WORD_LIMIT} слов.` })
      if (wordCount(`${value ?? ''} ${dictionary.higherLevels?.[id] ?? ''}`) > READER_WORD_LIMIT) problems.push({ id, code: 'READER_TEXT_TOO_LONG', field: 'details', message: `Описание вместе с усилением длиннее ${READER_WORD_LIMIT} слов.` })
    }
    for (const id of Object.keys(details)) if (!catalogIds.has(id)) problems.push({ id, code: 'DETAILS_UNKNOWN_ID', field: 'details', message: 'Карта подробных текстов содержит ID вне каталога.' })
  }
  const higherLevels = dictionary.higherLevels
  if (!isObject(higherLevels)) problems.push({ code: 'HIGHER_LEVELS_MAP_MISSING', field: 'higherLevels', message: 'Карта higherLevels должна быть объектом на каждый ID каталога.' })
  else {
    for (const id of catalogIds) {
      if (!Object.hasOwn(higherLevels, id)) {
        problems.push({ id, code: 'HIGHER_LEVELS_MISSING', field: 'higherLevels', message: 'Для каждой карточки нужна проверенная строка higherLevels или явный null.' })
        continue
      }
      const value = higherLevels[id]
      if (value !== null && !hasRussianText(value)) problems.push({ id, code: 'HIGHER_LEVELS_EMPTY', field: 'higherLevels', message: 'higherLevels должен быть null или непустым русским пересказом.' })
      else if (typeof value === 'string' && wordCount(value) > READER_WORD_LIMIT) problems.push({ id, code: 'HIGHER_LEVELS_TOO_LONG', field: 'higherLevels', message: `Парафраз higherLevels длиннее ${READER_WORD_LIMIT} слов.` })
    }
    for (const id of Object.keys(higherLevels)) if (!catalogIds.has(id)) problems.push({ id, code: 'HIGHER_LEVELS_UNKNOWN_ID', field: 'higherLevels', message: 'Карта higherLevels содержит ID вне каталога.' })
  }
}

function checkSpell(spell, descriptions, higherLevels, problems, gaps, fieldCounts) {
  const id = hasText(spell?.id) ? spell.id : '<unknown>'
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(spell ?? {}, field)) {
      problem(problems, id, 'FIELD_MISSING', field, `У карточки отсутствует обязательное поле «${field}».`)
      continue
    }
    fieldCounts[field] += 1
    if (requiredText.has(field) && !hasText(spell[field])) problem(problems, id, 'FIELD_EMPTY', field, `Поле «${field}» должно быть непустой строкой.`)
  }

  if (!/^[-a-z0-9]+$/u.test(String(spell.id ?? ''))) problem(problems, id, 'INVALID_ID', 'id', 'ID должен быть стабильным slug.')
  if (Object.hasOwn(spell ?? {}, 'details')) problem(problems, id, 'DETAILS_IN_SERVER_CATALOG', 'details', 'Подробный читательский текст хранится только в frontend-словаре.')
  if (!Number.isInteger(spell.level) || spell.level < 0 || spell.level > 6) problem(problems, id, 'INVALID_LEVEL', 'level', 'Круг должен быть целым числом от 0 до 6.')
  if (!Array.isArray(spell.classes) || spell.classes.length === 0 || spell.classes.some((classId) => !CLASS_IDS.has(classId))) problem(problems, id, 'INVALID_CLASSES', 'classes', 'Классы должны быть непустым массивом базовых class ID.')
  if (spell.sourceBooks !== undefined && (!Array.isArray(spell.sourceBooks) || spell.sourceBooks.some((book) => !hasText(book)))) problem(problems, id, 'INVALID_SOURCE_BOOKS', 'sourceBooks', 'sourceBooks должен быть массивом непустых названий книг.')
  if (spell.higherLevels !== null && !hasRussianText(spell.higherLevels)) problem(problems, id, 'INVALID_HIGHER_LEVELS', 'higherLevels', 'higherLevels должен быть null или непустым русским пересказом.')
  if (higherLevels && spell.higherLevels !== higherLevels[id]) problem(problems, id, 'HIGHER_LEVELS_DRIFT', 'higherLevels', 'Каталог и редакционная карта higherLevels расходятся.')
  if (spell.subclasses !== undefined && (!Array.isArray(spell.subclasses) || spell.subclasses.some((subclass) => !hasText(subclass)))) problem(problems, id, 'INVALID_SUBCLASSES', 'subclasses', 'Подклассы должны быть массивом непустых строк.')
  if (!Array.isArray(spell.sourceClasses) || !spell.sourceClasses.length || spell.sourceClasses.some((label) => !hasRussianText(label))) problem(problems, id, 'INVALID_SOURCE_CLASSES', 'sourceClasses', 'Полный список классов источника должен содержать русские подписи.')
  for (const field of ['ritual', 'concentration', 'halfOnSave', 'addAbilityModifier']) if (typeof spell[field] !== 'boolean') problem(problems, id, 'INVALID_BOOLEAN', field, `Поле «${field}» должно быть boolean.`)
  if (!Number.isInteger(spell.range) || spell.range < 0) problem(problems, id, 'INVALID_RANGE', 'range', 'Дальность должна быть целым неотрицательным числом в футах.')
  const expectedSlot = spell.level === 0 ? null : `spell_slots_${spell.level}`
  if (spell.slotResource !== expectedSlot) problem(problems, id, 'INVALID_SLOT_RESOURCE', 'slotResource', `Для круга ${spell.level} ожидался ресурс ${expectedSlot ?? 'null'}.`)
  if (!SPELL_KINDS.has(spell.kind)) problem(problems, id, 'INVALID_KIND', 'kind', `Неизвестный вид карточки: ${spell.kind}.`)
  if (!TARGETS.has(spell.target)) problem(problems, id, 'INVALID_TARGET', 'target', `Неизвестная цель карточки: ${spell.target}.`)
  if (!ACTION_TYPES.has(spell.actionType)) problem(problems, id, 'INVALID_ACTION_TYPE', 'actionType', `Неизвестное время действия: ${spell.actionType}.`)
  if (!validSourceUrl(spell.sourceUrl)) problem(problems, id, 'INVALID_SOURCE_URL', 'sourceUrl', 'Источник должен быть HTTPS-карточкой dnd.su /spells/.')
  if (!Array.isArray(spell.damageTypes) || spell.damageTypes.some((type) => !hasText(type))) problem(problems, id, 'INVALID_DAMAGE_TYPES', 'damageTypes', 'Типы урона должны быть массивом строк.')
  if (spell.damageType !== null && spell.damageType !== undefined && Array.isArray(spell.damageTypes) && !spell.damageTypes.includes(spell.damageType)) problem(problems, id, 'DAMAGE_TYPE_NOT_IN_LIST', 'damageType', 'Основной тип урона должен входить в damageTypes.')
  if (spell.healing !== null && spell.healing !== undefined && !hasText(spell.healing)) problem(problems, id, 'INVALID_HEALING', 'healing', 'Формула лечения должна быть строкой или null.')
  if (spell.saveAbility !== null && spell.saveAbility !== undefined && !ABILITIES.has(spell.saveAbility)) problem(problems, id, 'INVALID_SAVE_ABILITY', 'saveAbility', `Неизвестная характеристика спасброска: ${spell.saveAbility}.`)
  if (!Array.isArray(spell.conditions) || spell.conditions.some((condition) => !hasText(condition))) problem(problems, id, 'INVALID_CONDITIONS', 'conditions', 'Состояния должны быть массивом строк.')
  if (spell.durationRounds !== null && spell.durationRounds !== undefined && (!Number.isInteger(spell.durationRounds) || spell.durationRounds <= 0)) problem(problems, id, 'INVALID_DURATION_ROUNDS', 'durationRounds', 'Раунды должны быть положительным целым числом или null.')
  if (spell.areaShape !== undefined || spell.radius !== undefined) {
    if (!AREA_SHAPES.has(spell.areaShape)) problem(problems, id, 'INVALID_AREA_SHAPE', 'areaShape', 'Форма области должна быть поддержанной формой.')
    if (!Number.isFinite(spell.radius) || spell.radius <= 0) problem(problems, id, 'INVALID_AREA_RADIUS', 'radius', 'Радиус/размер области должен быть положительным числом.')
  }
  if (spell.kind?.startsWith('area-') && (!AREA_SHAPES.has(spell.areaShape) || !(Number.isFinite(spell.radius) && spell.radius > 0))) {
    gap(gaps, id, 'AREA_GEOMETRY_UNREPRESENTED', ['areaShape', 'radius'], 'Площадной вид карточки не имеет структурной формы и размера области; описание сохраняет эту семантику только текстом или требует специальной геометрии.')
  }
  if (descriptions && descriptions[id] !== spell.description) problem(problems, id, 'DESCRIPTION_DRIFT', 'description', 'Каталог расходится с единым словарём пересказов.')
  validateComponents(spell.components, id, problems)
}

/**
 * Проверяет полный контракт локальной карточки, не обращаясь к сети и не
 * включая полный текст страницы dnd.su. `ok` означает структурную валидность;
 * `semanticComplete` отдельно показывает известные пробелы в conditional-полях.
 */
export function auditDndsuSpellCatalog({ catalog, dictionary, overrides } = {}) {
  const currentCatalog = catalog ?? JSON.parse(readFileSync(resolve('data/dndsu-spells-0-6.json'), 'utf8'))
  const currentDictionary = dictionary ?? JSON.parse(readFileSync(resolve('data/spell-descriptions-ru.json'), 'utf8'))
  const currentOverrides = overrides === null
    ? {}
    : overrides ?? JSON.parse(readFileSync(resolve('data/dndsu-spell-mechanics-overrides.json'), 'utf8')).spells ?? {}
  const problems = []
  const semanticGaps = []
  const fieldCounts = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, 0]))

  if (currentCatalog.schemaVersion !== 1) problems.push({ code: 'CATALOG_SCHEMA_UNSUPPORTED', message: 'Ожидалась schemaVersion 1.' })
  if (currentCatalog.source !== SPELL_SOURCE_INDEX) problems.push({ code: 'CATALOG_SOURCE_MISMATCH', field: 'source', message: `Источник списка должен быть ${SPELL_SOURCE_INDEX}.` })
  if (currentCatalog.count !== EXPECTED_SPELL_COUNT) problems.push({ code: 'CATALOG_COUNT_MISMATCH', field: 'count', message: `Каталог должен объявлять ${EXPECTED_SPELL_COUNT} карточек.` })
  if (!Array.isArray(currentCatalog.spells) || currentCatalog.spells.length !== EXPECTED_SPELL_COUNT) problems.push({ code: 'CATALOG_SIZE_MISMATCH', field: 'spells', message: `В каталоге должно быть ${EXPECTED_SPELL_COUNT} карточек.` })
  if (currentCatalog.componentsSchemaVersion !== 1) problems.push({ code: 'COMPONENTS_SCHEMA_UNSUPPORTED', field: 'componentsSchemaVersion', message: 'Ожидалась componentsSchemaVersion 1.' })
  if (!validDate(currentCatalog.generatedAt)) problems.push({ code: 'CATALOG_GENERATED_AT_INVALID', field: 'generatedAt', message: 'generatedAt должен быть ISO-датой.' })

  const spells = Array.isArray(currentCatalog.spells) ? currentCatalog.spells : []
  const seen = new Set()
  for (const spell of spells) {
    const id = spell?.id ?? '<unknown>'
    if (seen.has(id)) problem(problems, id, 'DUPLICATE_ID', 'id', 'ID карточки повторяется.')
    seen.add(id)
    checkSpell(spell, currentDictionary?.descriptions, currentDictionary?.higherLevels, problems, semanticGaps, fieldCounts)
  }
  checkDescriptionDictionary(currentCatalog, currentDictionary, problems)

  if (Object.hasOwn(currentCatalog, 'details')) problems.push({ code: 'DETAILS_IN_SERVER_CATALOG', field: 'details', message: 'Подробные читательские тексты не должны входить в серверный каталог.' })

  const effectiveSemanticGaps = []
  for (const spell of spells) {
    const effective = { ...spell, ...(currentOverrides[spell.id] ?? {}) }
    if (effective.kind?.startsWith('area-') && (!AREA_SHAPES.has(effective.areaShape) || !(Number.isFinite(effective.radius) && effective.radius > 0))) {
      gap(effectiveSemanticGaps, spell.id, 'AREA_GEOMETRY_UNREPRESENTED', ['areaShape', 'radius'], 'Effective card after override merge still has no structural area geometry.')
    }
  }

  const unversionedSourceIds = spells.filter((spell) => {
    const fetchedAt = spell.sourceFetchedAt ?? spell.observedAt
    const hash = spell.sourceHashFnv1a64 ?? spell.sourceHash
    return !validDate(fetchedAt) || !/^[a-f0-9]{8,64}$/iu.test(String(hash ?? ''))
  }).map((spell) => spell.id)
  const provenance = {
    sourceIndex: currentCatalog.source === SPELL_SOURCE_INDEX ? 'pinned' : 'mismatch',
    perCardRevision: unversionedSourceIds.length === 0 ? 'present' : 'missing',
    unversionedSourceIds,
    descriptionSource: currentDictionary?.source ?? null,
    descriptionReviewedAt: currentDictionary?.reviewedAt ?? null,
  }
  const semanticByCode = Object.groupBy(semanticGaps, (entry) => entry.code)
  return {
    ok: problems.length === 0,
    semanticComplete: semanticGaps.length === 0,
    effectiveSemanticComplete: effectiveSemanticGaps.length === 0,
    provenanceComplete: unversionedSourceIds.length === 0,
    strictOk: problems.length === 0 && semanticGaps.length === 0 && unversionedSourceIds.length === 0,
    total: spells.length,
    uniqueIds: seen.size,
    fieldCounts,
    problems,
    semanticGaps,
    semanticGapCounts: Object.fromEntries(Object.entries(semanticByCode).map(([code, entries]) => [code, entries.length])),
    effectiveSemanticGaps,
    effectiveSemanticGapCounts: Object.fromEntries(Object.entries(Object.groupBy(effectiveSemanticGaps, (entry) => entry.code)).map(([code, entries]) => [code, entries.length])),
    provenance,
  }
}

function usage() {
  return 'Usage: node tools/verify-dndsu-spell-catalog.mjs [--strict-semantic] [--strict-effective-semantic] [--strict-provenance]'
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => !['--strict-semantic', '--strict-effective-semantic', '--strict-provenance'].includes(arg)) || new Set(args).size !== args.length) throw new Error(usage())
  const report = auditDndsuSpellCatalog()
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok || (args.includes('--strict-semantic') && !report.semanticComplete) || (args.includes('--strict-effective-semantic') && !report.effectiveSemanticComplete) || (args.includes('--strict-provenance') && !report.provenanceComplete)) process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
