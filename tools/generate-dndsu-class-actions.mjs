import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const BASE_URL = 'https://www.dnd.su'
const OUTPUT = resolve('data/dndsu-class-actions-1-12.json')

const CLASSES = Object.freeze({
  barbarian: { path: '87-barbarian', label: 'Варвар', subclassHeader: 'Пути дикости', subclassLevel: 3 },
  bard: { path: '88-bard', label: 'Бард', subclassHeader: 'Коллегии бардов', subclassLevel: 3 },
  cleric: { path: '89-cleric', label: 'Жрец', subclassHeader: 'Божественные домены', subclassLevel: 1 },
  druid: { path: '90-druid', label: 'Друид', subclassHeader: 'Круги друидов', subclassLevel: 2 },
  fighter: { path: '91-fighter', label: 'Воин', subclassHeader: 'Воинские архетипы', subclassLevel: 3 },
  monk: { path: '93-monk', label: 'Монах', subclassHeader: 'Монастырские традиции', subclassLevel: 3 },
  paladin: { path: '94-paladin', label: 'Паладин', subclassHeader: 'Священные клятвы', subclassLevel: 3 },
  ranger: { path: '97-ranger', label: 'Следопыт', subclassHeader: 'Архетипы следопыта', subclassLevel: 3 },
  rogue: { path: '99-rogue', label: 'Плут', subclassHeader: 'Архетипы плута', subclassLevel: 3 },
  sorcerer: { path: '101-sorcerer', label: 'Чародей', subclassHeader: 'Происхождения чародея', subclassLevel: 1 },
  warlock: { path: '104-warlock', label: 'Колдун', subclassHeader: 'Потусторонние покровители', subclassLevel: 1 },
  wizard: { path: '105-wizard', label: 'Волшебник', subclassHeader: 'Магические традиции', subclassLevel: 2 },
})

const NOT_SUBCLASSES = new Set(['Спутники повелителя зверей'])
const SKIP_HEADINGS = /^(?:ограничение|примечани|заметки|комментар|галере|классовые умения|использование заклинаний|заклинания |увеличение характеристик|дополнительные владения|бонусные владения|известные руны|углублённая предыстория|дополнительная атака|ячейки заклинаний|известные заклинания|подготовка и |фокусировка заклинания|ваша книга заклинаний|формулы заговоров)/iu
const SKIP_SUBTREE = /^(?:использование заклинаний|подготовка и (?:сотворение|накладывание) заклинаний|ваша книга заклинаний)/iu
const ACTIVE_LANGUAGE = /(?:бонусн(?:ое|ым) действ|в качестве действия|своим действием|действием можете|использовать действие|реакци|можете потратить|можете совершить|можете активировать|когда .{0,180} можете|если .{0,180} можете|при попадании .{0,160} можете|после того как .{0,160} можете|раз за (?:ход|раунд)|телепортир|переместиться|призвать)/iu

const CONDITIONS = Object.freeze([
  [/сбит(?:о|а)? с ног|становится сбит/u, 'prone'], [/становится испуган|испуганн/u, 'frightened'], [/становится очарован|очарованн/u, 'charmed'], [/становится ослепл|ослеплён/u, 'blinded'],
  [/становится оглох|оглохш/u, 'deafened'], [/становится парализован|парализованн/u, 'paralyzed'], [/становится отравлен|отравленн/u, 'poisoned'], [/становится опутан|опутанн/u, 'restrained'],
  [/становится удерживаем|удерживаемым/u, 'restrained'], [/становится оглуш|оглушён/u, 'stunned'], [/становитесь невидим|становится невидим/u, 'invisible'], [/становится недееспособ|недееспособн/u, 'incapacitated'],
  [/теряет сознание|без сознания/u, 'unconscious'], [/становится схвачен|схваченн/u, 'grappled'],
])

const TRANSLIT = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ъ: '', ь: '',
})

const decodeEntities = (value) => String(value ?? '')
  .replace(/&nbsp;|&#160;/giu, ' ')
  .replace(/&quot;/giu, '"')
  .replace(/&#39;|&apos;/giu, "'")
  .replace(/&laquo;/giu, '«')
  .replace(/&raquo;/giu, '»')
  .replace(/&ndash;|&#8211;/giu, '–')
  .replace(/&mdash;|&#8212;/giu, '—')
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>')
  .replace(/&amp;/giu, '&')
  .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))

const plainText = (html) => decodeEntities(String(html ?? ''))
  .replace(/<script[\s\S]*?<\/script>/giu, ' ')
  .replace(/<style[\s\S]*?<\/style>/giu, ' ')
  .replace(/<br\s*\/?>/giu, ' ')
  .replace(/<[^>]+>/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()

function slugify(value) {
  const transliterated = [...String(value ?? '').toLocaleLowerCase('ru')]
    .map((letter) => TRANSLIT[letter] ?? letter)
    .join('')
  return transliterated.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'feature'
}

function stableId(parts) {
  const raw = parts.filter(Boolean).map(slugify).join('-')
  if (raw.length <= 108) return raw
  let hash = 2166136261
  for (const character of raw) hash = Math.imul(hash ^ character.codePointAt(0), 16777619)
  return `${raw.slice(0, 98).replace(/-+$/u, '')}-${(hash >>> 0).toString(36)}`
}

function headingsFrom(html) {
  const matches = [...String(html).matchAll(/<(h[2-4])([^>]*)>([\s\S]*?)<\/\1>/giu)]
  return matches.map((match, index) => ({
    index,
    tag: match[1].toLocaleLowerCase('en'),
    name: plainText(match[3]),
    anchor: decodeEntities(match[2].match(/\bid=["']([^"']+)["']/iu)?.[1] ?? ''),
    start: match.index,
    contentStart: match.index + match[0].length,
    end: matches[index + 1]?.index ?? html.length,
  }))
}

function minimumLevel(text, fallback) {
  const matches = [...String(text).matchAll(/(?:^|\D)(\d{1,2})(?:-?[йяе]|-?го)?\s+уров(?:ень|ня|не)/giu)].map((match) => Number(match[1]))
  const valid = matches.filter((level) => level >= 1 && level <= 20)
  return valid.length ? valid[0] : fallback
}

function actionType(text) {
  if (/реакци/iu.test(text)) return 'reaction'
  if (/бонусн(?:ое|ым) действ/iu.test(text)) return 'bonus_action'
  if (/в качестве действия|своим действием|действием можете|использовать действие/iu.test(text)) return 'action'
  return 'free'
}

function numberFromFeet(text, fallback = 0) {
  const feet = String(text).match(/(\d{1,4})\s*(?:фут|фт)/iu)
  return feet ? Number(feet[1]) : fallback
}

function diceExpression(text, keyword) {
  const source = String(text)
  const before = source.match(new RegExp(`(\\d+)\\s*[кd]\\s*(\\d+)(?:\\s*\\+\\s*(\\d+))?[^.!?]{0,90}${keyword}`, 'iu'))
  const after = source.match(new RegExp(`${keyword}[^.!?]{0,90}?(\\d+)\\s*[кd]\\s*(\\d+)(?:\\s*\\+\\s*(\\d+))?`, 'iu'))
  const match = before ?? after
  return match ? `${match[1]}d${match[2]}${match[3] ? `+${match[3]}` : ''}` : null
}

function saveAbility(text) {
  const match = String(text).match(/спасброс(?:ок|ка|ку|ком)[^.!?]{0,50}(Силы|Ловкости|Телосложения|Интеллекта|Мудрости|Харизмы)/iu)
  return match ? ({ силы: 'str', ловкости: 'dex', телосложения: 'con', интеллекта: 'int', мудрости: 'wis', харизмы: 'cha' })[match[1].toLocaleLowerCase('ru')] : null
}

function targetFor(text, effect) {
  const normalized = String(text).toLocaleLowerCase('ru')
  if (/радиус|конус|линия|точк/u.test(normalized)) return effect.kind === 'heal' ? 'ally' : 'enemy'
  if (effect.kind === 'weapon_attack' || effect.kind === 'save' || /враг|противник|враждебн|цель атаки/u.test(normalized)) return 'enemy'
  if (/союзник|другое существо|существо, которое вы видите|выбранное существо/u.test(normalized)) return /урон|атак|спасброс/u.test(normalized) ? 'enemy' : 'ally'
  return 'self'
}

function effectFor(text) {
  const normalized = String(text).toLocaleLowerCase('ru')
  const damage = diceExpression(text, 'урон')
  const healing = diceExpression(text, '(?:хит|лечен|восстанов)')
  const save = saveAbility(text)
  const conditions = [...new Set(CONDITIONS.filter(([pattern]) => pattern.test(normalized)).map(([, condition]) => condition))]
  if (healing && /восстанов|лечен|хит/u.test(normalized)) return { kind: 'heal', dice: healing }
  if (/совершить атаку|атак[ауи] оружием|безоружн.*атак/u.test(normalized)) return { kind: 'weapon_attack', attacks: 1, ...(damage ? { extraDamage: damage } : {}), ...(save ? { saveAbility: save } : {}), ...(conditions[0] ? { condition: conditions[0] } : {}) }
  if (save) return { kind: 'save', saveAbility: save, ...(conditions[0] ? { condition: conditions[0] } : {}) }
  if (/телепорт|переместиться/u.test(normalized)) return { kind: 'condition', condition: 'feature-movement', duration: 'until-next-turn' }
  if (/призват|создаёте.*существо/u.test(normalized)) return { kind: 'special', mode: 'summon' }
  if (conditions[0]) return { kind: 'condition', condition: conditions[0], duration: 'until-next-turn' }
  return { kind: 'special' }
}

function usageFor(text) {
  const normalized = String(text).toLocaleLowerCase('ru')
  const recovery = /коротк/u.test(normalized) && /продолжительн/u.test(normalized) ? 'short_or_long'
    : /коротк/u.test(normalized) ? 'short'
      : /продолжительн/u.test(normalized) ? 'long'
        : null
  if (!recovery) return null
  if (/бонус[ау]? мастерства|равное вашему бонусу мастерства/u.test(normalized)) return { maximum: 'proficiency', recovery }
  const ability = normalized.match(/равн(?:ое|ое количеству|ое модификатору)[^.!?]{0,60}модификатор[ау]? (силы|ловкости|телосложения|интеллекта|мудрости|харизмы)/u)?.[1]
  if (ability) return { maximum: `ability:${({ силы: 'str', ловкости: 'dex', телосложения: 'con', интеллекта: 'int', мудрости: 'wis', харизмы: 'cha' })[ability]}`, recovery }
  const fixed = normalized.match(/(?:можете использовать[^.!?]{0,100}?|использовать[^.!?]{0,100}?)(один|два|три|\d+) раз/u)?.[1]
  const wordNumber = { один: 1, два: 2, три: 3 }
  return { maximum: fixed ? (wordNumber[fixed] ?? Number(fixed)) : 1, recovery }
}

function shortSummary(action, text) {
  const labels = { action: 'Действие', bonus_action: 'Бонусное действие', reaction: 'Реакция', free: 'Особый момент' }
  const target = { self: 'на себя', ally: 'на союзника', enemy: 'на противника' }[action.target]
  const parts = [labels[action.actionType], target]
  if (action.range) parts.push(`${action.range} фт.`)
  if (action.effect.dice) parts.push(`лечение ${action.effect.dice}`)
  if (action.effect.extraDamage) parts.push(`доп. урон ${action.effect.extraDamage}`)
  if (action.effect.saveAbility) parts.push(`спасбросок ${action.effect.saveAbility.toUpperCase()}`)
  if (action.effect.condition) parts.push(`состояние: ${action.effect.condition}`)
  if (action.uses) parts.push(`лимит: ${action.uses.maximum}`)
  if (parts.length <= 2 && /телепорт/u.test(text)) parts.push('телепортация')
  if (parts.length <= 2 && /призват/u.test(text)) parts.push('призыв')
  if (parts.length <= 2) parts.push('особый классовый эффект')
  return parts.join(' · ')
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
      await new Promise((done) => setTimeout(done, attempt * 350))
    }
  }
  throw lastError
}

function scrapeClass(classKey, config, html) {
  const sourceUrl = `${BASE_URL}/class/${config.path}/`
  const headings = headingsFrom(html)
  const classStart = headings.findIndex((heading) => heading.tag === 'h2' && heading.name === 'Классовые умения')
  const subclassStart = headings.findIndex((heading) => heading.tag === 'h2' && heading.name === config.subclassHeader)
  const officialEnd = headings.findIndex((heading, index) => index > subclassStart && heading.tag === 'h2' && /Unearthed Arcana|Homebrew|Неофициаль/iu.test(heading.name))
  if (classStart < 0 || subclassStart < 0 || officialEnd < 0) throw new Error(`Unexpected heading structure for ${classKey}`)

  const subclasses = []
  let currentSubclass = null
  const actions = []
  const candidates = []
  let currentH3 = null
  let currentH3Level = 1
  const usedIds = new Set()
  for (let index = classStart + 1; index < officialEnd; index += 1) {
    const heading = headings[index]
    if (index === subclassStart) continue
    if (index > subclassStart && heading.tag === 'h2') {
      if (!NOT_SUBCLASSES.has(heading.name)) {
        currentSubclass = heading.name
        subclasses.push({ id: stableId([classKey, heading.name]), name: heading.name, sourceUrl: heading.anchor ? `${sourceUrl}#${heading.anchor}` : sourceUrl })
      }
      continue
    }
    if (!['h3', 'h4'].includes(heading.tag)) continue
    const content = plainText(html.slice(heading.contentStart, heading.end))
    if (heading.tag === 'h3') {
      currentH3 = heading.name
      currentH3Level = minimumLevel(`${heading.name} ${content.slice(0, 420)}`, currentSubclass ? config.subclassLevel : 1)
    }
    if (SKIP_HEADINGS.test(heading.name) || (heading.tag === 'h4' && SKIP_SUBTREE.test(currentH3 ?? ''))) continue
    const active = ACTIVE_LANGUAGE.test(content)
    candidates.push({ name: heading.name, subclass: currentSubclass, active })
    if (!active) continue
    const fallbackLevel = heading.tag === 'h4' ? currentH3Level : currentSubclass ? config.subclassLevel : 1
    const level = minimumLevel(`${heading.name} ${content.slice(0, 420)}`, fallbackLevel)
    if (level > 12) continue
    const effect = effectFor(content)
    const baseId = stableId([classKey, currentSubclass, heading.name])
    const id = usedIds.has(baseId) ? stableId([baseId, heading.anchor || index]) : baseId
    usedIds.add(id)
    const rawAction = {
      id,
      name: heading.name.replace(/\s+/gu, ' ').trim(),
      classKey,
      subclass: currentSubclass,
      minimumLevel: level,
      category: 'class',
      actionType: actionType(content),
      target: 'self',
      range: numberFromFeet(content),
      effect,
      uses: usageFor(content),
      sourceUrl: heading.anchor ? `${sourceUrl}#${heading.anchor}` : sourceUrl,
    }
    rawAction.target = targetFor(content, effect)
    if (rawAction.target !== 'self' && !rawAction.range) rawAction.range = 60
    rawAction.description = shortSummary(rawAction, content)
    actions.push(rawAction)
  }
  return {
    classKey,
    label: config.label,
    subclassLevel: config.subclassLevel,
    sourceUrl,
    subclasses,
    actions,
    coverage: {
      officialFeatureHeadings: candidates.length,
      activatableCandidates: candidates.filter((entry) => entry.active).length,
      includedThroughLevel12: actions.length,
      excludedAboveLevel12: candidates.filter((entry) => entry.active).length - actions.length,
      excludedSections: ['Unearthed Arcana', 'Homebrew', 'Unofficial'],
    },
  }
}

const classEntries = []
for (const [classKey, config] of Object.entries(CLASSES)) {
  const url = `${BASE_URL}/class/${config.path}/`
  const html = await fetchText(url)
  classEntries.push(scrapeClass(classKey, config, html))
  process.stdout.write(`${classKey}: ${classEntries.at(-1).subclasses.length} subclasses, ${classEntries.at(-1).actions.length} actions\n`)
}

const payload = {
  schemaVersion: 1,
  rulesProfile: 'dndsu-5e-2014-official',
  generatedAt: new Date().toISOString(),
  maximumCharacterLevel: 12,
  source: {
    site: 'DnD.su',
    indexUrl: `${BASE_URL}/class/`,
    note: 'Структурированные факты и короткие производные сводки; полные тексты умений не копируются.',
  },
  classes: classEntries,
}

await mkdir(resolve('data'), { recursive: true })
await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
process.stdout.write(`Wrote ${classEntries.reduce((sum, entry) => sum + entry.actions.length, 0)} actions to ${OUTPUT}\n`)
