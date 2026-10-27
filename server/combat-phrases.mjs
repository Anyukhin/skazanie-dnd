// @ts-check
import { createHash } from 'node:crypto'

/**
 * Голос боевой хроники без модели: варианты реплик, их выбор и склонения.
 *
 * Живой плейтест 2026-10-10: бой читался журналом — каждое событие печаталось
 * одним и тем же шаблоном («атакует …: попадание», «получает N урона»), и
 * независимый судья оценил подачу боя в 2–3 балла из 10. Модель в горячий путь
 * боя не идёт (AGENTS.md §6), поэтому разнообразие даёт этот словарь: у
 * каждого частого события несколько формулировок, и выбор между ними — хеш
 * идентификатора события.
 *
 * Выбор **детерминированный**: одно и то же событие при повторе запроса,
 * повторной проекции и replay даёт ровно ту же строку. На этом держится
 * идемпотентность летописи — запись с тем же идентификатором не удваивается и
 * не переписывается другим текстом.
 *
 * Правила языка, которые держит каждая формулировка:
 * - рода у героев и существ в данных нет, поэтому только настоящее время,
 *   существительные и безличные обороты — без «упал/упала», «стабилизирован»;
 * - косвенный падеж имени — только когда склонение надёжно
 *   (`confidentAccusative`), иначе фраза строится с именем в именительном;
 * - числа чужого листа (КД, ОЗ, модификаторы врага) сюда не приходят вовсе:
 *   решение о видимости принимает вызывающий (`server/combat-narration.mjs`).
 */

/**
 * @typedef {{
 *   event_id?: unknown,
 *   event_type?: unknown,
 *   actor_id?: unknown,
 *   target_ids?: unknown,
 *   command_id?: unknown,
 *   state_version_after?: unknown,
 *   payload?: any,
 * }} PhraseEvent
 */

/**
 * Зерно выбора формулировки. Идентификатор события устойчив между повтором и
 * replay; у события без идентификатора (тестовые потоки, старые журналы) зерно
 * собирается из его же полей, а не из позиции в пакете.
 *
 * @param {PhraseEvent | null | undefined} event
 * @returns {string}
 */
export function phraseSeed(event) {
  const id = String(event?.event_id ?? '').trim()
  if (id) return id
  const targets = Array.isArray(event?.target_ids) ? event.target_ids.join(',') : ''
  return [event?.event_type, event?.actor_id, targets, event?.command_id, event?.state_version_after]
    .map((part) => String(part ?? ''))
    .join('|')
}

/**
 * @param {number} count
 * @param {string} seed
 * @param {string} salt
 * @returns {number}
 */
function variantIndex(count, seed, salt) {
  const hex = createHash('sha256').update(`${seed}\u0000${salt}`).digest('hex').slice(0, 8)
  return Number.parseInt(hex, 16) % count
}

/**
 * Выбор формулировок в пределах одного рассказа. Две соседние строки одного
 * вида не получают одну и ту же формулировку: «бьёт … — попадание» трижды
 * подряд и было тем журналом, от которого уходим. Сдвиг зависит только от
 * пакета событий, поэтому повтор того же пакета даёт тот же текст.
 */
export class Phrasebook {
  constructor() {
    /** @type {Map<string, number>} */
    this.last = new Map()
  }

  /**
   * @param {string} kind
   * @param {readonly string[]} variants
   * @param {PhraseEvent | null | undefined} event
   * @returns {string}
   */
  pick(kind, variants, event) {
    const options = variants.filter(Boolean)
    if (!options.length) return ''
    let index = variantIndex(options.length, phraseSeed(event), kind)
    if (options.length > 1 && this.last.get(kind) === index) index = (index + 1) % options.length
    this.last.set(kind, index)
    return options[index]
  }
}

// ---------------------------------------------------------------------------
// Склонения
// ---------------------------------------------------------------------------

const MASCULINE_CONSONANT = /[бвгджзклмнпрстфхцчшщ]$/u

/**
 * Винительный падеж имени цели для «атакует …»: «Разбойника 1», «Гоблина-воина»,
 * «Гиену». Склоняется только однословное имя (через дефис — по частям, номер
 * не трогается) с однозначным окончанием: мужское на согласную и женское на
 * «-а/-я». Многословные имена, мягкий знак и прочее остаются как есть —
 * лучше «атакует Тень», чем «атакует Теня». Плейтест 2026-10-02: «атакует
 * Разбойник 1».
 *
 * Правило общее с запасным рассказчиком (`server/narrator.mjs`) и с клиентской
 * копией (`src/app-shared.tsx`), поэтому оно не расширяется молча: расширенное
 * склонение для реплик боя живёт в `confidentAccusative`.
 *
 * @param {string} name
 * @returns {string}
 */
export function accusativeName(name) {
  const match = /^([А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*)(\s+\d+)?$/u.exec(String(name ?? '').trim())
  if (!match) return String(name ?? '')
  const parts = match[1].split('-')
  const declined = parts.map((part) => {
    const lower = part.toLocaleLowerCase('ru')
    if (MASCULINE_CONSONANT.test(lower)) return `${part}а`
    if (/[^и]а$/u.test(lower)) return `${part.slice(0, -1)}у`
    if (/я$/u.test(lower) && lower.length > 2) return `${part.slice(0, -1)}ю`
    return null
  })
  if (declined.some((part) => part == null)) return String(name ?? '')
  return `${declined.join('-')}${match[2] ?? ''}`
}

/** Несклоняемые имена существ: винительный совпадает с именительным. */
const INDECLINABLE_NAMES = new Set(['зомби'])

/**
 * @param {string} word
 * @returns {'m' | 'f' | null}
 */
function adjectiveGender(word) {
  const lower = word.toLocaleLowerCase('ru')
  if (lower.length < 4 || !/^[а-яё]+$/u.test(lower)) return null
  if (/(?:ый|ий|ой)$/u.test(lower)) return 'm'
  if (/(?:ая|яя)$/u.test(lower)) return 'f'
  return null
}

/**
 * Одушевлённый винительный прилагательного: «Лютого», «Гигантскую».
 *
 * @param {string} word
 * @param {'m' | 'f'} gender
 * @returns {string}
 */
function adjectiveAccusative(word, gender) {
  if (gender === 'f') return /яя$/u.test(word) ? `${word.slice(0, -2)}юю` : `${word.slice(0, -2)}ую`
  if (/[ыо]й$/u.test(word) || /[гкх]ий$/u.test(word)) return `${word.slice(0, -2)}ого`
  return `${word.slice(0, -2)}его`
}

/**
 * Винительный существительного, род которого уже известен по прилагательному.
 *
 * @param {string} word
 * @param {'m' | 'f'} gender
 * @returns {string | null}
 */
function nounAccusative(word, gender) {
  const parts = word.split('-')
  const declined = parts.map((part) => {
    const lower = part.toLocaleLowerCase('ru')
    if (!/^[а-яё]+$/u.test(lower)) return null
    // Средний род: винительный совпадает с именительным.
    if (/[оеё]$/u.test(lower)) return part
    if (gender === 'm') {
      if (MASCULINE_CONSONANT.test(lower)) return `${part}а`
      if (/[ьй]$/u.test(lower)) return `${part.slice(0, -1)}я`
      if (/[^и]а$/u.test(lower)) return `${part.slice(0, -1)}у`
      return null
    }
    if (/ая$/u.test(lower)) return `${part.slice(0, -2)}ую`
    if (/яя$/u.test(lower)) return `${part.slice(0, -2)}юю`
    if (/[^и]а$/u.test(lower)) return `${part.slice(0, -1)}у`
    if (/я$/u.test(lower)) return `${part.slice(0, -1)}ю`
    if (/ь$/u.test(lower)) return part
    return null
  })
  return declined.some((part) => part == null) ? null : declined.join('-')
}

/**
 * Винительный падеж имени существа, когда склонение надёжно, иначе `null`.
 *
 * Сверх `accusativeName` понимает два частых в бестиарии вида: прилагательные
 * перед существительным («Лютого волка», «Гигантскую крысу», «Бурого медведя»,
 * «Чёрную слизь» — род берётся у прилагательного) и существительное с
 * несогласованным определением в родительном («Скелета минотавра»,
 * «Капитана разбойников»). Имя героя с прозвищем («Брам Тихий Молот») и всё
 * прочее — `null`: реплика тогда строится с именем в именительном.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
export function confidentAccusative(name) {
  const source = String(name ?? '').replace(/\s+/gu, ' ').trim()
  if (!source) return null
  const single = accusativeName(source)
  if (single !== source) return single
  const match = /^(.+?)((?:\s+\d+)?)$/u.exec(source)
  if (!match) return null
  const words = match[1].split(' ')
  const number = match[2]
  if (words.length === 1) {
    const lower = words[0].toLocaleLowerCase('ru')
    if (INDECLINABLE_NAMES.has(lower) || /^[а-яё]+[оеё]$/u.test(lower)) return source
    return null
  }
  const head = words.at(-1) ?? ''
  const adjectives = words.slice(0, -1)
  const genders = adjectives.map(adjectiveGender)
  const gender = genders[0]
  if (gender && genders.every((value) => value === gender)) {
    const noun = nounAccusative(head, gender)
    if (noun != null) return `${[...adjectives.map((word) => adjectiveAccusative(word, gender)), noun].join(' ')}${number}`
  }
  // «Скелет минотавра»: склоняется первое слово, определение в родительном — нет.
  const [first, ...tail] = words
  if (tail.every((word) => /^[а-яё]+$/u.test(word) && !adjectiveGender(word))) {
    const declined = accusativeName(first)
    if (declined !== first) return `${[declined, ...tail].join(' ')}${number}`
  }
  return null
}

/**
 * «1 час», «2 часа», «8 часов».
 *
 * @param {unknown} value
 * @returns {string}
 */
export function hoursLabelRu(value) {
  const count = Math.max(0, Math.round(Number(value) || 0))
  const lastTwo = count % 100
  const last = count % 10
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'часов' : last === 1 ? 'час' : last >= 2 && last <= 4 ? 'часа' : 'часов'
  return `${count} ${word}`
}

/**
 * Первая буква строчная, если это не аббревиатура: «Боевой посох» → «боевой посох».
 *
 * @param {unknown} value
 * @returns {string}
 */
export function lowerFirst(value) {
  const text = String(value ?? '').trim()
  if (text.length > 1 && /^[А-ЯЁ][а-яё]/u.test(text)) return `${text[0].toLocaleLowerCase('ru')}${text.slice(1)}`
  return text
}

/**
 * «а, б и в».
 *
 * @param {unknown} items
 * @returns {string}
 */
export function joinRu(items) {
  const list = (Array.isArray(items) ? items : []).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} и ${list.at(-1)}`
}

// ---------------------------------------------------------------------------
// Оружие и способ атаки
// ---------------------------------------------------------------------------

/** Чем бьют вблизи: творительный падеж. Ключ — название без регистра и «+1». */
const MELEE_WEAPON_INSTRUMENTAL = new Map([
  ['дубинка', 'дубинкой'], ['большая дубинка', 'большой дубинкой'], ['дубина', 'дубиной'], ['палица', 'палицей'],
  ['кинжал', 'кинжалом'], ['ручной топор', 'ручным топором'], ['боевой топор', 'боевым топором'], ['топор', 'топором'],
  ['лёгкий молот', 'лёгким молотом'], ['боевой молот', 'боевым молотом'], ['молот', 'молотом'], ['булава', 'булавой'],
  ['боевой посох', 'боевым посохом'], ['посох', 'посохом'], ['серп', 'серпом'], ['копьё', 'копьём'],
  ['метательное копьё', 'копьём'], ['кистень', 'кистенём'], ['глефа', 'глефой'], ['секира', 'секирой'],
  ['двуручный меч', 'двуручным мечом'], ['длинный меч', 'длинным мечом'], ['короткий меч', 'коротким мечом'], ['меч', 'мечом'],
  ['алебарда', 'алебардой'], ['пика всадника', 'пикой'], ['длинная пика', 'длинной пикой'], ['пика', 'пикой'],
  ['моргенштерн', 'моргенштерном'], ['рапира', 'рапирой'], ['скимитар', 'скимитаром'], ['трезубец', 'трезубцем'],
  ['боевой клевец', 'боевым клевцом'], ['кнут', 'кнутом'],
])

/** Из чего стреляют: родительный падеж после «из». */
const RANGED_WEAPON_GENITIVE = new Map([
  ['короткий лук', 'короткого лука'], ['длинный лук', 'длинного лука'], ['лук', 'лука'],
  ['лёгкий арбалет', 'лёгкого арбалета'], ['тяжёлый арбалет', 'тяжёлого арбалета'], ['ручной арбалет', 'ручного арбалета'],
  ['арбалет', 'арбалета'], ['праща', 'пращи'], ['духовая трубка', 'духовой трубки'], ['мушкет', 'мушкета'], ['пистолет', 'пистолета'],
])

/** Что мечут: неодушевлённый винительный совпадает с именительным. */
const THROWN_WEAPON_ACCUSATIVE = new Map([
  ['дротик', 'дротик'], ['метательный дротик', 'дротик'], ['копьё', 'копьё'], ['метательное копьё', 'копьё'],
  ['ручной топор', 'топор'], ['кинжал', 'кинжал'], ['камень', 'камень'], ['лёгкий молот', 'молот'], ['трезубец', 'трезубец'],
])

/**
 * Естественное оружие существа: глагол с прямым дополнением в винительном.
 * Ключ — имя действия стат-блока без регистра.
 */
const NATURAL_ATTACK_VERBS = new Map([
  ['укус', ['кусает', 'вцепляется зубами в']],
  ['клык', ['кусает', 'вцепляется клыками в']],
  ['когти', ['полосует когтями', 'рвёт когтями']],
  ['коготь', ['полосует когтем', 'бьёт когтем']],
  ['бодание', ['бодает', 'с разбегу бодает']],
  ['рога', ['бодает', 'поддевает рогами']],
  ['жало', ['жалит']],
  ['клюв', ['клюёт', 'бьёт клювом']],
  ['клешня', ['хватает клешнёй', 'бьёт клешнёй']],
  ['щупальце', ['хлещет щупальцем']],
  ['щупальца', ['хлещет щупальцами']],
  ['хвост', ['хлещет хвостом']],
  ['захлёст', ['хлещет']],
  ['копыта', ['бьёт копытами']],
  ['ложноножка', ['хлещет ложноножкой']],
  ['кулак', ['бьёт кулаком']],
  ['разлагающий кулак', ['бьёт гниющим кулаком']],
  ['размашистый удар', ['с размаху бьёт', 'наотмашь бьёт']],
  ['раздирание', ['раздирает']],
  ['сжимание', ['сдавливает']],
  ['растаптывание', ['топчет']],
])

/**
 * @param {Map<string, any>} table
 * @param {unknown} name
 * @returns {any}
 */
function lookupWeapon(table, name) {
  const key = String(name ?? '').toLocaleLowerCase('ru').replace(/\s*\+\d+\s*$/u, '').replace(/\s+/gu, ' ').trim()
  if (!key) return null
  if (table.has(key)) return table.get(key)
  // «Жестокий длинный меч», «Длинный меч предупреждения»: ищется самое длинное
  // известное название в конце или в начале.
  const known = [...table.keys()].sort((left, right) => right.length - left.length)
  const suffix = known.find((candidate) => key.endsWith(` ${candidate}`))
  if (suffix) return table.get(suffix)
  const prefix = known.find((candidate) => key.startsWith(`${candidate} `))
  return prefix ? table.get(prefix) : null
}

/** Глаголы ближнего удара по виду урона: «рубит», «колет», «бьёт». */
const MELEE_VERBS = Object.freeze({
  slashing: ['рубит', 'полосует', 'бьёт'],
  piercing: ['колет', 'бьёт', 'целит остриём в'],
  bludgeoning: ['бьёт', 'обрушивает удар на', 'с размаху бьёт'],
  default: ['бьёт', 'атакует', 'обрушивает удар на'],
})

/**
 * @typedef {object} AttackPhraseInput
 * @property {string} actor            имя атакующего
 * @property {string} target           имя цели
 * @property {boolean} targetIsEnemy   цель — противник отряда: числа её листа закрыты
 * @property {any} payload             payload `AttackResolved`
 * @property {string} [reason]         пояснение броска: преимущество, укрытие, высота
 * @property {string} [numbers]        разбор броска, например 15 против КД 12; только для цели-героя
 * @property {string} [damage]         хвост урона, например «, 7 урона» или «, 9 урона; ОЗ 9 → 0»
 * @property {boolean} [opportunity]   атака по возможности вдогонку
 * @property {string} [lead]           вступление по тактике существа: «Почуяв слабину, »
 */

/**
 * Вид атаки одним словом: рука, выстрел, бросок или чары.
 *
 * @param {any} payload
 * @returns {'melee' | 'ranged' | 'thrown' | 'spell'}
 */
function attackMode(payload) {
  if (payload?.spell_id || payload?.spell_name) return 'spell'
  const kind = String(payload?.attack_kind ?? '')
  if (kind === 'ranged' || kind === 'thrown') return kind
  return 'melee'
}

/**
 * Переходные глаголы атаки: «X <глагол> <цель в винительном>».
 *
 * @param {any} payload
 * @returns {string[]}
 */
function transitiveAttackVerbs(payload) {
  const mode = attackMode(payload)
  const weaponName = payload?.item_name || payload?.action_name
  if (mode === 'spell') return ['направляет чары в', 'обрушивает магию на']
  if (mode === 'ranged') {
    const from = lookupWeapon(RANGED_WEAPON_GENITIVE, weaponName)
    const source = from ? ` из ${from}` : ''
    return [`стреляет${source} в`, `целится и стреляет${source} в`, `посылает выстрел${source} в`]
  }
  if (mode === 'thrown') {
    const thrown = lookupWeapon(THROWN_WEAPON_ACCUSATIVE, weaponName)
    return thrown ? [`метает ${thrown} в`, `с размаху бросает ${thrown} в`] : ['метает оружие в', 'бросает оружие в']
  }
  const natural = lookupWeapon(NATURAL_ATTACK_VERBS, payload?.action_name)
  if (natural) return natural
  const instrument = lookupWeapon(MELEE_WEAPON_INSTRUMENTAL, weaponName)
  const verbs = ownEntry(MELEE_VERBS, String(payload?.damage_type ?? '')) ?? MELEE_VERBS.default
  // Оружие называется там, где глагол оставляет ему место: «рубит Волка
  // длинным мечом», но не «обрушивает удар на Волка длинным мечом».
  return verbs.map((verb) => (instrument && !/ (?:в|на)$/u.test(verb) ? `${verb} {target} ${instrument}` : verb))
}

/** Непереходный оборот того же действия: «бьёт», «стреляет», «метает оружие». */
const INTRANSITIVE_ATTACK = Object.freeze({
  melee: ['атакует', 'наносит удар', 'бросается в атаку'],
  ranged: ['стреляет', 'посылает выстрел', 'бьёт издали'],
  thrown: ['метает оружие', 'бросает оружие'],
  spell: ['направляет чары', 'пускает в ход магию'],
})

/** Существительное удара — для «уходит от …». */
const ATTACK_NOUN_GENITIVE = Object.freeze({ melee: 'удара', ranged: 'выстрела', thrown: 'броска', spell: 'чар' })

const HIT_WORDS = Object.freeze({
  melee: ['попадание', 'удар достигает цели', 'точно в цель'],
  ranged: ['попадание', 'выстрел достигает цели', 'точно в цель'],
  thrown: ['попадание', 'бросок достигает цели', 'точно в цель'],
  spell: ['попадание', 'чары достигают цели', 'точно в цель'],
})

const MISS_WORDS = Object.freeze({
  melee: ['промах', 'мимо', 'удар уходит в пустоту'],
  ranged: ['промах', 'мимо', 'выстрел уходит в сторону'],
  thrown: ['промах', 'мимо', 'бросок уходит в сторону'],
  spell: ['промах', 'мимо', 'чары рассеиваются впустую'],
})

/**
 * Начало реплики об атаке — кто, кого и чем, без исхода. `null` — имя цели
 * надёжно не склоняется, и реплику строит `attackPhrase` с целью в
 * именительном падеже.
 *
 * @param {Phrasebook} book
 * @param {AttackPhraseInput} input
 * @param {PhraseEvent} event
 * @returns {string | null}
 */
function attackLead(book, input, event) {
  const mode = attackMode(input.payload)
  const accusative = confidentAccusative(input.target)
  if (input.opportunity) {
    const variants = [
      `${input.target} выходит из досягаемости, и ${input.actor} бьёт вдогонку`,
      `Отступая, ${input.target} открывается, и ${input.actor} успевает ударить`,
      ...(accusative ? [`${input.actor} ловит ${accusative} на отходе`] : []),
    ]
    return book.pick('attack-opportunity', variants, event)
  }
  if (!accusative) return null
  const variants = transitiveAttackVerbs(input.payload).map((candidate) => (candidate.includes('{target}')
    ? `${input.actor} ${candidate.replace('{target}', accusative)}`
    : `${input.actor} ${candidate} ${accusative}`))
  return `${input.lead ?? ''}${book.pick(`attack-${mode}`, variants, event)}`
}

/**
 * @param {any} payload
 * @returns {string}
 */
function heroTargetOutcome(payload) {
  if (!payload.hit) return 'промах'
  if (payload.automatic_critical) return 'критическое попадание — цель не может защищаться'
  return payload.critical ? 'критическое попадание' : 'попадание'
}

/**
 * Реплика атаки целиком. Цель-противник — исход словами и нанесённый урон;
 * цель-герой — тот же разбор броска, что и раньше: «15 против КД 12 — попадание».
 *
 * @param {Phrasebook} book
 * @param {AttackPhraseInput} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function attackPhrase(book, input, event) {
  const payload = input.payload ?? {}
  const mode = attackMode(payload)
  const lead = attackLead(book, input, event)
  const reason = input.reason ?? ''
  const damage = input.damage ?? ''
  const numbers = !input.targetIsEnemy && input.numbers ? input.numbers : ''
  if (lead == null) {
    // Имя без надёжного склонения: «Огр атакует, цель — Мирель», «Борин
    // стреляет — Тень не успевает уйти от выстрела».
    const subject = `${input.lead ?? ''}${input.actor} ${book.pick(`attack-${mode}-plain`, INTRANSITIVE_ATTACK[mode], event)}${reason}`
    const noun = ATTACK_NOUN_GENITIVE[mode]
    if (numbers) return `${subject}, цель — ${input.target}: ${numbers} — ${heroTargetOutcome(payload)}${damage}.`
    if (payload.hit) return `${subject} — ${input.target} не успевает уйти от ${noun}: ${heroTargetOutcome(payload)}${damage}.`
    return book.pick('miss-plain', [
      `${subject}, но ${input.target} уходит от ${noun}.`,
      `${subject} — мимо: ${input.target} успевает увернуться.`,
    ], event)
  }
  if (numbers) return `${lead}${reason}: ${numbers} — ${heroTargetOutcome(payload)}${damage}.`
  if (payload.hit) {
    const outcome = payload.automatic_critical
      ? 'критическое попадание — цель не может защищаться'
      : payload.critical
        ? book.pick(`crit-${mode}`, ['критическое попадание', mode === 'melee' ? 'сокрушительный удар, критическое попадание' : 'критическое попадание в уязвимое место'], event)
        : book.pick(`hit-${mode}`, HIT_WORDS[mode], event)
    return `${lead}${reason} — ${outcome}${damage}.`
  }
  return book.pick('miss-shape', [
    `${lead}${reason} — ${book.pick(`miss-${mode}`, MISS_WORDS[mode], event)}.`,
    `${lead}${reason}, но промахивается.`,
  ], event)
}

// ---------------------------------------------------------------------------
// Урон, падение, спасение
// ---------------------------------------------------------------------------

/**
 * Урон без удара рядом — заклинание, область, ловушка. Форма одна и
 * намеренно простая: строку берут и как часть чужой фразы — исход свободного
 * действия печатается «Дробящий удар: Ада получает 3 урона»
 * (`freeActionEffectText`, `server/game-orchestrator.mjs`), и вступление
 * стихией там удвоилось бы. Урон удара идёт в строку самого удара.
 *
 * @param {{ target: string, amount: number, hp?: string }} input
 * @returns {string}
 */
export function damagePhrase({ target, amount, hp = '' }) {
  return `${target} получает ${amount} урона${hp}.`
}

/**
 * Ноль ОЗ. Герой падает без сознания и бросает спасброски от смерти; противник
 * просто выбывает — спасбросков от смерти у чудовищ нет, и смерть здесь не
 * объявляется.
 *
 * @param {Phrasebook} book
 * @param {{ target: string, side: 'hero' | 'enemy' | 'other' }} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function downedPhrase(book, { target, side }, event) {
  if (side === 'hero') {
    return book.pick('downed-hero', [
      `${target} падает без сознания — теперь всё решат спасброски от смерти.`,
      `${target} оседает на землю без сознания: начинаются спасброски от смерти.`,
      `${target} теряет сознание и падает. Дальше — спасброски от смерти.`,
    ], event)
  }
  if (side === 'enemy') {
    return book.pick('downed-enemy', [
      `${target} падает и выбывает из боя.`,
      `${target} рушится наземь — этот противник выбыл.`,
      `${target} валится с ног и больше не сражается.`,
    ], event)
  }
  return `${target} выбывает из боя.`
}

/**
 * @param {Phrasebook} book
 * @param {string} target
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function stabilizedPhrase(book, target, event) {
  return book.pick('stabilized', [
    `${target} без сознания, но кровь остановлена — жизнь вне опасности.`,
    `Кровь остановлена: ${target} без сознания, но вне опасности.`,
  ], event)
}

/**
 * Источник спасброска: «от заклинания «Священное пламя»» или «от заклинания».
 *
 * @param {string} spellLabel «Священное пламя» в кавычках-ёлочках или пусто
 * @returns {string}
 */
export function spellSourceText(spellLabel) {
  return spellLabel ? `от заклинания ${spellLabel}` : 'от заклинания'
}

/**
 * @param {Phrasebook} book
 * @param {{ target: string, saved: boolean | null, source?: string }} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function savePhrase(book, { target, saved, source = '' }, event) {
  const from = source ? ` ${source}` : ''
  if (saved === true) {
    return book.pick('save-success', source
      ? [`${target} успешно проходит спасбросок${from}.`, `${target} выдерживает: спасбросок${from} успешен.`]
      : [`${target} успешно проходит спасбросок.`, `${target} выдерживает — спасбросок успешен.`], event)
  }
  if (saved === false) {
    return book.pick('save-fail', source
      ? [`${target} проваливает спасбросок${from}.`, `${target} не может устоять: спасбросок${from} провален.`]
      : [`${target} проваливает спасбросок.`, `${target} не выдерживает — спасбросок провален.`], event)
  }
  return `${target} делает спасбросок${from}.`
}

// ---------------------------------------------------------------------------
// Перемещение и ход
// ---------------------------------------------------------------------------

/** Публичная тактика существа (`npc-turn-scheduler.mjs`) → оборот перемещения. */
const TACTIC_MOVES = Object.freeze({
  'сокращает дистанцию': ['{actor} сокращает дистанцию — {feet} фт.', '{actor} рвётся вперёд на {feet} фт.'],
  'выходит на линию атаки': ['{actor} выходит на линию атаки — {feet} фт.', '{actor} занимает позицию для выстрела ({feet} фт).'],
  'держит дистанцию': ['{actor} разрывает дистанцию — {feet} фт.', '{actor} отходит на {feet} фт, держа дистанцию.'],
  'пытается спастись': ['{actor} пытается вырваться из боя — {feet} фт.'],
})

/** Та же тактика → вступление к первой атаке существа в ходе. */
const TACTIC_LEADS = Object.freeze({
  'тактика стаи': 'Пользуясь поддержкой стаи, ',
  'давит на раненого': 'Почуяв слабину, ',
  'загнан в угол': 'Отступать некуда — ',
})

/** @param {unknown} tactic */
export function tacticLead(tactic) {
  return ownEntry(TACTIC_LEADS, String(tactic ?? '')) ?? ''
}

/**
 * @param {Phrasebook} book
 * @param {{ actor: string, feet: number, tactic?: unknown, mode?: unknown }} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function movePhrase(book, { actor, feet, tactic, mode }, event) {
  if (String(mode ?? '') === 'long_jump') return `${actor} прыгает на ${feet} фт.`
  if (String(mode ?? '') === 'swing') return `${actor} перелетает на люстре ${feet} фт.`
  const tacticVariants = ownEntry(TACTIC_MOVES, String(tactic ?? ''))
  const variants = tacticVariants ?? ['{actor} перемещается на {feet} фт.', '{actor} проходит {feet} фт.', '{actor} смещается на {feet} фт.']
  return book.pick(tacticVariants ? 'move-tactic' : 'move', variants, event)
    .replace('{actor}', actor)
    .replace('{feet}', String(feet))
}

/** Обычные боевые действия, у которых есть свой оборот вместо «использует «…»». */
const ACTION_PHRASES = Object.freeze({
  dash: ['{actor} срывается с места — «{name}».', '{actor} бросается вперёд: «{name}».'],
  disengage: ['{actor} осторожно выходит из ближнего боя — «{name}».', '{actor} отступает, не подставляясь: «{name}».'],
  dodge: ['{actor} уходит в глухую оборону — «{name}».', '{actor} сосредотачивается на защите: «{name}».'],
  help: ['{actor} приходит на помощь союзнику — «{name}».'],
  hide: ['{actor} ищет укрытие — «{name}».'],
})

/**
 * @param {Phrasebook} book
 * @param {{ actor: string, actionId: unknown, name: string }} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function actionPhrase(book, { actor, actionId, name }, event) {
  const variants = ACTION_PHRASES[/** @type {keyof typeof ACTION_PHRASES} */ (String(actionId ?? ''))]
  if (!variants?.length) return `${actor} использует «${name}».`
  return book.pick(`action-${String(actionId)}`, variants, event).replace('{actor}', actor).replace('{name}', name)
}

/**
 * @param {Phrasebook} book
 * @param {string} actor
 * @param {PhraseEvent} event
 */
export function turnEndPhrase(book, actor, event) {
  return book.pick('turn-end', [`${actor} завершает ход.`, `${actor} заканчивает ход.`, `${actor} передаёт ход дальше.`], event)
}

/**
 * @param {Phrasebook} book
 * @param {string} actor
 * @param {number} round
 * @param {PhraseEvent} event
 */
export function turnStartPhrase(book, actor, round, event) {
  return book.pick('turn-start', [`Раунд ${round}: ходит ${actor}.`, `Раунд ${round}. Теперь ходит ${actor}.`], event)
}

// ---------------------------------------------------------------------------
// Начало и конец столкновения
// ---------------------------------------------------------------------------

/**
 * @typedef {'underground' | 'night' | 'forest' | 'road' | 'graveyard' | 'settlement' | 'ambush' | 'generic'} EncounterSetting
 */

/** Вступления к составу: [множественное, единственное]. */
const ENCOUNTER_INTROS = Object.freeze({
  underground: [['Из темноты выходят', 'Из темноты выходит'], ['В глубине прохода шевелятся тени — это', 'В глубине прохода шевелится тень — это'], ['Из мрака показываются', 'Из мрака показывается']],
  night: [['Из ночной темноты выступают', 'Из ночной темноты выступает'], ['В темноте вспыхивают глаза — это', 'В темноте вспыхивают глаза — это']],
  forest: [['Из-за деревьев выходят', 'Из-за деревьев выходит'], ['Кусты раздвигаются — навстречу выходят', 'Кусты раздвигаются — навстречу выходит']],
  road: [['Путь преграждают', 'Путь преграждает'], ['На дороге показываются', 'На дороге показывается']],
  graveyard: [['Между надгробиями показываются', 'Между надгробиями показывается'], ['Среди могил шевелятся тени — это', 'Среди могил шевелится тень — это']],
  settlement: [['Навстречу выходят', 'Навстречу выходит'], ['Путь преграждают', 'Путь преграждает']],
  ambush: [['Засада! Из укрытий выскакивают', 'Засада! Из укрытия выскакивает'], ['Засада: со всех сторон появляются', 'Засада: из укрытия появляется']],
  generic: [['Путь преграждают', 'Путь преграждает'], ['Навстречу выходят', 'Навстречу выходит'], ['Перед отрядом вырастают', 'Перед отрядом вырастает']],
})

/**
 * Вступление столкновения: где, кто и сколько. Обстановка — тема сцены,
 * тема встречи и время суток, а не догадка модели.
 *
 * @param {Phrasebook} book
 * @param {{ names: string[], setting: EncounterSetting }} input
 * @param {PhraseEvent} event
 * @returns {string}
 */
export function encounterIntroPhrase(book, { names, setting }, event) {
  const roster = names.length ? joinRu(names) : 'противники'
  const plural = names.length !== 1
  const intros = ENCOUNTER_INTROS[setting] ?? ENCOUNTER_INTROS.generic
  const [many, one] = /** @type {[string, string]} */ (intros[variantIndex(intros.length, phraseSeed(event), `intro-${setting}`)])
  return `${plural ? many : one} ${roster}.`
}

/**
 * @param {Phrasebook} book
 * @param {{ endText: string }} input
 * @param {PhraseEvent} event
 */
export function encounterEndPhrase(book, { endText }, event) {
  return book.pick('encounter-end', [
    `Столкновение завершено: ${endText}.`,
    `Бой стихает: ${endText}.`,
    `Всё кончено: ${endText}.`,
  ], event)
}

/**
 * Запись таблицы по собственному ключу: ключи `Object.prototype` (`constructor`,
 * `toString`…) записями не считаются.
 *
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {unknown} key
 * @returns {T | undefined}
 */
function ownEntry(table, key) {
  return Object.hasOwn(table, String(key)) ? table[String(key)] : undefined
}
