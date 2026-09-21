import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE_URL = 'https://www.dnd.su'
const LIST_URL = `${BASE_URL}/piece/spells/index-list/`
const OUTPUT = resolve('data/dndsu-spells-0-6.json')
const DESCRIPTION_SOURCE = resolve('data/spell-descriptions-ru.json')

const CLASS_IDS = Object.freeze({
  12: 'bard',
  13: 'cleric',
  16: 'paladin',
  17: 'ranger',
  19: 'sorcerer',
  20: 'warlock',
  21: 'wizard',
  22: 'druid',
})

const DAMAGE_TYPES = Object.freeze({
  10: 'bludgeoning',
  11: 'slashing',
  12: 'piercing',
  13: 'fire',
  14: 'cold',
  15: 'lightning',
  16: 'poison',
  17: 'acid',
  18: 'thunder',
  19: 'radiant',
  20: 'force',
  21: 'necrotic',
  22: 'psychic',
})

const ABILITIES = Object.freeze({
  'сил': 'str',
  'ловкост': 'dex',
  'телосложен': 'con',
  'интеллект': 'int',
  'мудрост': 'wis',
  'харизм': 'cha',
})

const CONDITIONS = Object.freeze([
  ['сбит с ног', 'prone'],
  ['сбито с ног', 'prone'],
  ['испуган', 'frightened'],
  ['очарован', 'charmed'],
  ['ослеп', 'blinded'],
  ['оглох', 'deafened'],
  ['парализован', 'paralyzed'],
  ['отравлен', 'poisoned'],
  ['опутан', 'restrained'],
  ['удерживаем', 'restrained'],
  ['оглуш', 'stunned'],
  ['невидим', 'invisible'],
  ['недееспособ', 'incapacitated'],
  ['без сознания', 'unconscious'],
])

const decodeEntities = (value) => String(value ?? '')
  .replace(/&nbsp;|&#160;/giu, ' ')
  .replace(/&quot;/giu, '"')
  .replace(/&#39;|&apos;/giu, "'")
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>')
  .replace(/&amp;/giu, '&')
  .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))

const plainText = (html) => decodeEntities(String(html ?? ''))
  .replace(/<br\s*\/?>/giu, ' ')
  .replace(/<[^>]+>/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

const slugify = (value) => String(value ?? '')
  .toLocaleLowerCase('en')
  .normalize('NFKD')
  .replace(/[^a-z0-9]+/gu, '-')
  .replace(/^-+|-+$/gu, '')

function extractJsonList(html) {
  const match = String(html).match(/window\.LIST\s*=\s*(\{.*?\});<\/script>/su)
  if (!match) throw new Error('DnD.su spell list payload was not found')
  return JSON.parse(match[1]).cards
}

export function field(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const whitespace = '(?:\\s|&nbsp;|&#160;)*'
  const marker = `<strong\\b[^>]*>\\s*${escaped}${whitespace}:${whitespace}</strong>`
  const source = String(html)

  // Most pages use list items. A few older/exceptional cards wrap the same
  // label in a paragraph or a div, so do not make the parser depend on one
  // exact tag or attribute order.
  for (const container of ['li', 'p', 'div']) {
    const match = source.match(new RegExp(`<${container}\\b[^>]*>\\s*${marker}([\\s\\S]*?)<\\/${container}\\s*>`, 'iu'))
    if (match) return plainText(match[1])
  }

  // Last-resort fallback for a label inside a custom container. Stop at the
  // next common row boundary instead of consuming the whole document.
  const match = source.match(new RegExp(marker, 'iu'))
  if (!match || match.index == null) return ''
  const rest = source.slice(match.index + match[0].length)
  const boundary = rest.search(/<\/(?:li|p|div)\s*>/iu)
  return plainText(boundary < 0 ? rest : rest.slice(0, boundary))
}

export function descriptionText(html) {
  return plainText(String(html).match(/<div\b[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1])
}

const COMPONENT_MARKER = /^(?:\s*)([ВСМАVSMA](?:\s*,\s*[ВСМАVSMA])*)(?:\s*\(([\s\S]*)\))?\s*$/iu
const COMPONENT_COST = /(?<![\d])([\d]+(?:[\s,]\d{3})*(?:[.,]\d+)?)\s*(зм|см|мм|золот(?:ых|ые|ой)?(?:\s+монет)?|серебрян(?:ых|ые|ой)?(?:\s+монет)?|gp|sp|cp)(?![\p{L}])/giu
const COMPONENT_CONSUMED = /(?:расходу[а-яё]*|потребля(?:ется|ются)|поглощ(?:ается|аются)|consum(?:e|ed|es|ing)|destroy(?:ed|s)?\s+by\s+the\s+spell)/iu

function componentField(html) {
  const beforeComments = String(html ?? '').split(/##\s*Комментарии|<h[1-6][^>]*>\s*Комментарии/iu)[0]
  const descriptionStart = beforeComments.search(/<div\b[^>]*itemprop=["']description["']/iu)
  const source = descriptionStart < 0 ? beforeComments : beforeComments.slice(0, descriptionStart)
  const htmlValue = field(source, 'Компоненты')
  if (htmlValue) return htmlValue

  // Кэш аудита может содержать Markdown; читаем только подписанную строку,
  // а не слова о компонентах в произвольном описании или комментарии.
  const marker = '**Компоненты:**'
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return ''
  const rest = source.slice(markerIndex + marker.length)
  const boundary = rest.search(/\r?\n\s*\*\s+\*\*/u)
  return plainText(boundary < 0 ? rest : rest.slice(0, boundary))
}

function requirementNoteForMaterial(description, costMatches, consumed) {
  const text = String(description ?? '').trim()
  if (!text) return 'В источнике не указано содержимое материального компонента.'
  // Количество и альтернативы обычного нерасходуемого M не мешают замене фокусом.
  if (!costMatches.length && !consumed) return null
  const notes = []
  if (costMatches.length > 1) notes.push('Указано несколько стоимостей или предметов; одна сумма не описывает весь набор.')
  if (/(?:кажд(?:ый|ого|ому|ом|ые|ых)|пара|два|две|несколько|for each|each|pair|two)/iu.test(text)) {
    notes.push('Источник задаёт количество или повторяемое требование, которого нет в компактной схеме.')
  }
  if (/(?:либо|или|either|\bor\b|зависит|var(?:ies|y)|according)/iu.test(text)) {
    notes.push('Источник содержит альтернативный или зависящий от варианта компонент.')
  }
  if (/(?:может быть|при желании|optional|optionally)/iu.test(text)) {
    notes.push('Условие компонента зависит от выбора или варианта применения.')
  }
  if (consumed && /(?:расход|потребл|поглощ|consum|destroy)/iu.test(text) && /(?:часть|some|частично|part)/iu.test(text)) {
    notes.push('Расходование описано для части составного компонента.')
  }
  if (consumed && /расходу[^,;]*[,;]\s*(?:и|а также)\s/iu.test(text)) {
    notes.push('Часть набора расходуется, а следующий предмет имеет отдельное требование.')
  }
  return notes.length ? notes.join(' ') : null
}

/**
 * Разбирает отдельную строку компонентов dnd.su. Описание заклинания не
 * заменяет отсутствующую строку источника.
 */
export function parseComponents(sourceText) {
  const source = String(sourceText ?? '').trim().replace(/^\*?\s*Компоненты:\s*/iu, '')
  const match = source.match(COMPONENT_MARKER)
  if (!match) return null
  const tokens = match[1].split(',').map((token) => token.trim().toLocaleUpperCase('ru'))
  const verbal = tokens.includes('В') || tokens.includes('V')
  const somatic = tokens.includes('С') || tokens.includes('S')
  const hasMaterial = tokens.includes('М') || tokens.includes('M')
  if (tokens.includes('А') || tokens.includes('A')) {
    return { verbal, somatic, material: null, special: [{ kind: 'royalty', description: String(match[2] ?? '').trim() }] }
  }
  if (!hasMaterial) return { verbal, somatic, material: null }

  const description = String(match[2] ?? '').trim()
  const costMatches = [...description.matchAll(COMPONENT_COST)]
  const numericCosts = costMatches
    .map((item) => {
      const digits = String(item[1]).replace(/\s/gu, '')
      const normalized = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(digits) ? digits.replace(/,/gu, '') : digits.replace(',', '.')
      const unit = item[2].toLocaleLowerCase('ru')
      const multiplier = /^(?:см|серебр|sp)/u.test(unit) ? 0.1 : /^(?:мм|cp)/u.test(unit) ? 0.01 : 1
      return Number(normalized) * multiplier
    })
    .filter((value) => Number.isFinite(value))
  const consumed = COMPONENT_CONSUMED.test(description) && !/(?:не\s+расходу|not\s+consum)/iu.test(description)
  const requirementNote = requirementNoteForMaterial(description, costMatches, consumed)
  const costGp = numericCosts.length === 1 && !requirementNote
    ? numericCosts[0]
    : null
  const unresolved = Boolean(requirementNote) || (numericCosts.length > 1 && costGp == null)
  return {
    verbal,
    somatic,
    material: {
      description,
      costGp,
      consumed,
      focusSubstitutable: !unresolved && costGp == null && !consumed,
      ...(requirementNote ? { requirementNote } : {}),
      ...(unresolved ? { unresolved: true } : {}),
    },
  }
}

export function componentsFromPage(html) {
  return parseComponents(componentField(html))
}

export function numberFromFeet(text, fallback = 60) {
  const normalized = String(text ?? '').toLocaleLowerCase('ru')
  if (/на себя|касание/u.test(normalized)) return /касание/u.test(normalized) ? 5 : 0
  // A range written only as a shape (for example «15-футовый конус») starts
  // at the caster. It is an area size, not a 15-foot point range.
  if (/(?:конус|линия|куб|цилиндр|сфер|радиус)/u.test(normalized)) return 0
  const miles = normalized.match(/(\d+)\s*(?:мил|миль|мили)/u)
  if (miles) return Number(miles[1]) * 5280
  const feet = normalized.match(/(\d+)\s*(?:-\s*)?(?:фут|фт)/u)
  if (feet) return Number(feet[1])
  if (/видимост/u.test(normalized)) return 600
  if (/без ограничен|неогранич/u.test(normalized)) return 99999
  return fallback
}

function diceNear(text, words) {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
  const source = String(text)
  const before = source.match(new RegExp(`(\\d+)\\s*[кd]\\s*(\\d+)(?:\\s*\\+\\s*(\\d+))?[^.!?]{0,90}(?:${escaped})`, 'iu'))
  const after = source.match(new RegExp(`(?:${escaped})[^.!?]{0,90}?(\\d+)\\s*[кd]\\s*(\\d+)(?:\\s*\\+\\s*(\\d+))?`, 'iu'))
  const match = before ?? after
  if (!match) return null
  return `${match[1]}d${match[2]}${match[3] ? `+${match[3]}` : ''}`
}

function saveAbility(text) {
  const match = String(text).toLocaleLowerCase('ru').match(/спасброс(?:ок|ка|ку|ком)[^.!?]{0,35}(силы|ловкости|телосложения|интеллекта|мудрости|харизмы)/u)
  if (!match) return null
  const key = Object.keys(ABILITIES).find((fragment) => match[1].startsWith(fragment))
  return key ? ABILITIES[key] : null
}

function actionType(card, castingTime) {
  const filter = Array.isArray(card.filter_casttime) ? card.filter_casttime[0] : card.filter_casttime
  if (filter === 'bonus_action') return 'bonus_action'
  if (filter === 'reaction') return 'reaction'
  if (filter === 'action') return 'action'
  return /бонусн/u.test(castingTime) ? 'bonus_action' : /реакц/u.test(castingTime) ? 'reaction' : /минут|час/u.test(castingTime) ? 'long_cast' : 'action'
}

export function areaFacts(text) {
  const normalized = String(text).toLocaleLowerCase('ru')
  const distance = '(\\d+)\\s*(?:-\\s*)?(?:фут|фт)'
  const between = '[^.!?]{0,40}?'
  const patterns = [
    ['cone', new RegExp(`(?:конус\\p{L}*)${between}${distance}|${distance}${between}(?:конус\\p{L}*)`, 'iu')],
    ['line', new RegExp(`(?:лини\\p{L}*)${between}${distance}|${distance}${between}(?:лини\\p{L}*)`, 'iu')],
    ['cube', new RegExp(`(?:куб\\p{L}*)${between}${distance}|${distance}${between}(?:куб\\p{L}*)`, 'iu')],
    ['cylinder', new RegExp(`(?:цилиндр\\p{L}*)${between}${distance}|${distance}${between}(?:цилиндр\\p{L}*)`, 'iu')],
    ['sphere', new RegExp(`(?:сфер\\p{L}*|радиус\\p{L}*)${between}${distance}|${distance}${between}(?:сфер\\p{L}*|радиус\\p{L}*)`, 'iu')],
  ]
  for (const [shape, pattern] of patterns) {
    const match = normalized.match(pattern)
    if (match) {
      const value = match[1] ?? match[2]
      return { areaShape: shape, radius: Number(value) }
    }
  }
  return {}
}

export function pageFacts(html) {
  const duration = field(html, 'Длительность').toLocaleLowerCase('ru')
  return {
    castingTime: field(html, 'Время накладывания'),
    rangeText: field(html, 'Дистанция'),
    duration,
    description: descriptionText(html),
  }
}

export function classify(card, facts) {
  const text = facts.description.toLocaleLowerCase('ru')
  const castingTime = facts.castingTime.toLocaleLowerCase('ru')
  const rangeText = facts.rangeText.toLocaleLowerCase('ru')
  const damage = diceNear(text, ['урон', 'урона'])
  const healing = diceNear(text, ['хит', 'хитов', 'хиты'])
  const save = saveAbility(text)
  const damageTypes = [...new Set((card.filter_damtype ?? []).map((id) => DAMAGE_TYPES[id]).filter(Boolean))]
  const conditions = [...new Set(CONDITIONS.filter(([phrase]) => text.includes(phrase)).map(([, condition]) => condition))]
  const area = areaFacts(text)
  const spellAttack = /атак[а-яё\s-]{0,24}заклинани|бросок атаки заклинанием/u.test(text)
  const restoresHp = /восстанавлив[а-яё]*[^.!?]{0,80}хит|лечен/u.test(text)
  const summons = /призываете|созда[её]те[^.!?]{0,80}(существо|дух)|появляется[^.!?]{0,50}существо/u.test(text)
  const teleport = /телепорт/u.test(text)
  const isArea = Boolean(area.areaShape) || /все(?:х)? существ|каждое существо|выбранн[а-яё]+ точк/u.test(text)
  const hasDamage = Boolean(damage || damageTypes.length)
  let kind = 'utility'
  if (summons) kind = 'summon'
  else if (teleport) kind = 'teleport'
  else if (restoresHp && healing) kind = 'healing'
  else if (hasDamage && spellAttack) kind = 'attack'
  else if (hasDamage && save && isArea) kind = 'area-save'
  else if (hasDamage && save) kind = 'save'
  else if (hasDamage) kind = isArea ? 'area-damage' : 'damage'
  else if (conditions.length) kind = save ? 'debuff' : 'buff'
  else if (/кд|класс[а-яё\s]+доспех|преимуществ|помех|сопротивлен|бонус/u.test(text)) kind = 'buff'

  let target = 'point'
  if (/на себя/u.test(rangeText)) target = 'self'
  else if (kind === 'healing' || kind === 'buff') target = /себя/u.test(text) && !/существо/u.test(text) ? 'self' : 'ally'
  else if (['attack', 'save', 'damage', 'debuff'].includes(kind)) target = 'enemy'
  else if (kind === 'area-save' || kind === 'area-damage' || kind === 'summon' || kind === 'teleport') target = 'point'
  else if (/существо, которое вы видите|выбранн[а-яё]+ существ/u.test(text)) target = 'creature'

  const duration = facts.duration
  const durationRounds = /до конца (?:вашего|следующего) хода/u.test(text) ? 1
    : Number(duration.match(/(\d+)\s*(?:раунд|минут)/u)?.[1] ?? 0) * (/минут/u.test(duration) ? 10 : 1)
  const summaryParts = []
  if (damage) summaryParts.push(`${damage} ${damageTypes.join('/') || 'урона'}`)
  if (healing && restoresHp) summaryParts.push(`лечение ${healing}`)
  if (save) summaryParts.push(`спасбросок ${save.toUpperCase()}`)
  if (conditions.length) summaryParts.push(`состояние: ${conditions.join(', ')}`)
  if (area.areaShape) summaryParts.push(`область ${area.areaShape} ${area.radius} фт.`)
  if (!summaryParts.length) summaryParts.push(kind === 'utility' ? 'особый или внебоевой эффект' : kind)

  return {
    kind,
    target,
    damage,
    damageTypes,
    damageType: damageTypes[0] ?? null,
    healing: restoresHp ? healing : null,
    saveAbility: save,
    halfOnSave: /половин[а-яё\s]+урон/u.test(text),
    conditions,
    durationRounds: durationRounds || null,
    addAbilityModifier: /модификатор[^.!?]{0,40}(базов|характеристик)/u.test(text),
    ...area,
    actionType: actionType(card, castingTime),
    description: summaryParts.join(' · '),
  }
}

async function fetchText(url, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'Skazanie combat catalog generator/1.0' } })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.text()
    } catch (error) {
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 350))
    }
  }
  throw lastError
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

async function main() {
  const descriptionPayload = JSON.parse(await readFile(DESCRIPTION_SOURCE, 'utf8'))
  const descriptions = descriptionPayload.descriptions ?? {}
  const listHtml = await fetchText(LIST_URL)
  const cards = extractJsonList(listHtml).filter((card) => {
    const level = card.level === 'Заговор' ? 0 : Number(card.level)
    const ids = [...(card.filter_class ?? []), ...(card.filter_class_tce ?? [])]
    return level <= 6 && ids.some((id) => CLASS_IDS[id])
  })

  const spells = await mapConcurrent(cards, 8, async (card, index) => {
    const sourceUrl = new URL(card.link, BASE_URL).toString()
    const html = await fetchText(sourceUrl)
    const level = card.level === 'Заговор' ? 0 : Number(card.level)
    const id = slugify(card.title_en) || `dndsu-${String(card.link).match(/\d+/u)?.[0] ?? index}`
    const classes = [...new Set([...(card.filter_class ?? []), ...(card.filter_class_tce ?? [])].map((id) => CLASS_IDS[id]).filter(Boolean))].sort()
    const facts = pageFacts(html)
    const mechanics = classify(card, facts)
    const components = componentsFromPage(html)
    if ((index + 1) % 50 === 0 || index + 1 === cards.length) process.stdout.write(`\r${index + 1}/${cards.length}`)
    return {
      id,
      name: card.title,
      englishName: card.title_en,
      level,
      school: card.school,
      classes,
      ritual: Boolean(card.item_tags?.ritual),
      concentration: Boolean(card.item_tags?.concentration) || /концентрац/u.test(facts.duration),
      range: numberFromFeet(facts.rangeText),
      rangeText: facts.rangeText,
      castingTime: facts.castingTime,
      duration: facts.duration,
      sourceUrl,
      slotResource: level > 0 ? `spell_slots_${level}` : null,
      components,
      ...mechanics,
      description: descriptions[id],
    }
  })

  const missingDescriptions = spells.filter((spell) => typeof spell.description !== 'string' || spell.description.trim().length < 20)
  if (missingDescriptions.length) {
    throw new Error(`Spell description dictionary is missing: ${missingDescriptions.map((spell) => spell.id).join(', ')}`)
  }
  const missingComponents = spells.filter((spell) => !spell.components)
  if (missingComponents.length) throw new Error(`Не прочитана строка компонентов: ${missingComponents.map((spell) => spell.id).join(', ')}`)

  spells.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'ru'))
  await mkdir(resolve('data'), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify({
    schemaVersion: 1,
    componentsSchemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: LIST_URL,
    scope: 'Официальные заклинания dnd.su уровней 0–6 для базовых классов D&D 5e',
    count: spells.length,
    spells,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`\nSaved ${spells.length} spells to ${OUTPUT}\n`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
