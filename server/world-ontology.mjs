// @ts-check
/**
 * Онтология памяти мира: какие предикаты фактов и отношения между сущностями
 * существуют, кто их пишет и кто читает.
 *
 * Память мира (`server/world-memory.mjs`) хранит триплеты: факт
 * `{subject_id, predicate, object}`, отношение `{from_entity_id, relation,
 * to_entity_id}`, утверждение NPC `{holder_entity_id, predicate, claim}`. Сама
 * память предикаты не ограничивает: строка проходит, если она не пуста. Поэтому
 * словарь живёт в коде модулей — каждый пишет свои литералы, а читатели
 * сравнивают с ними строки. Разрыв между ними незаметен: так `discovery`
 * читался `questProgressEvidenceFor`, но не создавался никем, и поручение не
 * могло продвинуться уликой.
 *
 * Этот модуль — реестр такого словаря и статический сканер исходников. Он
 * детерминирован, ничего не импортирует и не читает файлов: тексты ему передают
 * тест (`test/world-ontology.test.mjs`) и аудит
 * (`eval/ontology-audit-2026-10-01.mjs`). В рантайме сервера он ничего не
 * исполняет и не ограничивает — это сторож соответствия, а не валидатор команд.
 */

/**
 * @typedef {'fact'|'claim'} OntologyRecord
 * @typedef {{
 *   record: OntologyRecord,
 *   family?: boolean,
 *   subject_kinds: string[],
 *   object: string,
 *   producers: string[],
 *   consumers: string[],
 *   external_producers?: string[],
 *   visibility: 'public'|'party'|'gm_only'|'mixed',
 *   description_ru: string,
 * }} PredicateEntry
 * @typedef {{
 *   from_kinds: string[],
 *   to_kinds: string[],
 *   producers: string[],
 *   consumers: string[],
 *   external_producers?: string[],
 *   visibility: 'public'|'party'|'gm_only'|'mixed',
 *   description_ru: string,
 * }} RelationEntry
 */

/**
 * Предикаты. Ключ с двоеточием на конце — семейство (`party_deed:<kind>`).
 * `producers`/`consumers` — имена модулей `server/` без расширения, ровно те,
 * что находит сканер; тест сверяет их с исходниками и не даёт описанию
 * устареть. Общие читатели (Рассказчик, Режиссёр, поиск по памяти), которые
 * передают любой предикат как есть, перечислены в `GENERIC_PREDICATE_CONSUMERS`.
 *
 * @type {Readonly<Record<string, Readonly<PredicateEntry>>>}
 */
export const PREDICATES = Object.freeze({
  died: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id локации, где NPC погиб',
    producers: ['npc-positioning'], consumers: ['game-orchestrator', 'npc-positioning', 'quest-consequences'],
    visibility: 'party',
    description_ru: 'NPC погиб. Делает поручение невозможным, убирает NPC из сцен, попадает в список известных мёртвых Рассказчика.',
  }),
  discovery: Object.freeze({
    record: 'fact', subject_kinds: ['npc', 'faction', 'location', 'concept'], object: '«clue»',
    producers: ['world-memory'], consumers: ['campaign-scenario', 'game-orchestrator', 'narrator', 'player-request-router', 'world-memory'],
    visibility: 'party',
    description_ru: 'Находка свободного действия: открытая заготовка ведущего, знающий собеседник или улика по теме активного поручения. Рассказчик обязан её назвать; для часов поручения — доказательство; для сценария — найденная улика узла сюжета (по `supersedes_fact_id`).',
  }),
  quest_progress: Object.freeze({
    record: 'fact', subject_kinds: ['npc', 'faction', 'location', 'concept'], object: 'что именно продвинуло дело',
    producers: [], consumers: ['world-memory'],
    external_producers: ['admin_command'],
    visibility: 'party',
    description_ru: 'Продвижение поручения, записанное ведущим через административную команду `RecordWorldFact`. Ни один модуль сервера его не пишет.',
  }),
  scene_change: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'перечень сменившихся обстоятельств сцены',
    producers: ['autonomous-orchestrator'], consumers: ['scene-summary'],
    visibility: 'party',
    description_ru: 'Режиссёр сменил сцену; сводка сцены берёт отсюда переход.',
  }),
  quest_outcome: Object.freeze({
    record: 'fact', subject_kinds: ['npc', 'faction', 'location', 'event'], object: 'исход поручения (completed/failed/…)',
    producers: ['autonomous-orchestrator'], consumers: [],
    visibility: 'mixed',
    description_ru: 'Итог поручения, закрытого Режиссёром. Подлежащее — первая сущность поручения, иначе текущая сцена или сущность-развязка. Читается только общими читателями.',
  }),
  encounter_outcome: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'исход встречи',
    producers: ['autonomous-orchestrator'], consumers: [],
    visibility: 'party',
    description_ru: 'Итог боевой или социальной встречи. Механика читает `autonomy.encounter_outcomes`, а не этот факт.',
  }),
  promise_condition: Object.freeze({
    record: 'fact', subject_kinds: ['location', 'concept'], object: 'JSON { promise_id, condition }',
    producers: ['autonomous-orchestrator'], consumers: ['autonomous-orchestrator'],
    visibility: 'gm_only',
    description_ru: 'Условие, при котором обещание NPC исполняется или нарушается.',
  }),
  opening_narration: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'подтверждённый пролог сцены',
    producers: ['campaign-bootstrap'], consumers: ['action-adjudicator', 'player-request-router'],
    visibility: 'party',
    description_ru: 'Абзацы пролога кампании; NPC стартовой локации знают их как свои факты, а судья свободных действий читает их как описание места.',
  }),
  gm_secret: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'JSON { topic, skills, holder }',
    producers: ['world-memory'], consumers: ['world-memory'],
    visibility: 'gm_only',
    description_ru: 'Заготовка ведущего: то, что уже правда в первой сцене (campaign_creator/v7 или авторский мир), в новой области (map_architect/v7) или в месте сценария (`campaign-scenario`, стабильный id) и скрыто от героев. Факт строит `gmSecretFact`. Удачная проверка подходящего навыка заменяет её фактом отряда discovery; знающий NPC может выдать её в разговоре.',
  }),
  band_camp: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id ватаги',
    producers: ['captives'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Зацепка пленного: где лагерь ватаги. Раскрывается допросом.',
  }),
  band_paid: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id ватаги',
    producers: ['captives'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Зацепка пленного: у налёта был заказчик.',
  }),
  band_reinforcements: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id ватаги',
    producers: ['captives'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Зацепка пленного: ватага ждёт подкрепления.',
  }),
  band_cache: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id ватаги',
    producers: ['captives'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Зацепка пленного: схрон ватаги.',
  }),
  courier_letter_delivered: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'JSON { letter_id, hero_id, at_minutes }',
    producers: ['courier-letters'], consumers: [],
    visibility: 'party',
    description_ru: 'Письмо отряда дошло до адресата.',
  }),
  courier_letter_unanswered: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'JSON письма',
    producers: ['courier-letters'], consumers: [],
    visibility: 'party',
    description_ru: 'Адресат не ответил на письмо.',
  }),
  courier_letter_answered: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'JSON ответа',
    producers: ['courier-letters'], consumers: [],
    visibility: 'party',
    description_ru: 'Ответ на письмо дошёл до отряда.',
  }),
  quest_deadline_missed: Object.freeze({
    record: 'fact', subject_kinds: ['concept'], object: 'JSON { quest_id, at_minutes }',
    producers: ['offscreen-world'], consumers: [],
    visibility: 'party',
    description_ru: 'Срок поручения истёк, пока отряд был занят другим. Подлежащее — служебная сущность offscreen-quest-*, а не сущности самого поручения.',
  }),
  'faction_offscreen_move:': Object.freeze({
    record: 'fact', family: true, subject_kinds: ['faction'], object: 'JSON хода фракции',
    producers: ['offscreen-world'], consumers: [],
    visibility: 'party',
    description_ru: 'Ход фракции за кадром; суффикс — вид хода.',
  }),
  party_traveled_to: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'имя локации назначения (подлежащее — откуда ушли)',
    producers: ['scene-memory'], consumers: [],
    visibility: 'party',
    description_ru: 'Отряд вышел к новой локации.',
  }),
  party_arrived: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'текст прибытия',
    producers: ['scene-memory'], consumers: [],
    visibility: 'party',
    description_ru: 'Отряд прибыл в локацию.',
  }),
  blessed_by_priest: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'id героя',
    producers: ['rules-engine'], consumers: [],
    visibility: 'party',
    description_ru: 'Герой получил благословение жреца; без сущности-локации факт не пишется.',
  }),
  blessed_at_shrine: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'id героя',
    producers: ['rules-engine'], consumers: [],
    visibility: 'party',
    description_ru: 'Герой получил благословение у святилища; без сущности-локации факт не пишется.',
  }),
  spared_by_party: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'исход пощады (ally/informant/…)',
    producers: ['rules-engine'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Отряд пощадил сдавшегося врага.',
  }),
  handed_to_watch: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'id поселения',
    producers: ['rules-engine'], consumers: [],
    visibility: 'party',
    description_ru: 'Пленный передан страже.',
  }),
  parley_oath: Object.freeze({
    record: 'fact', subject_kinds: ['npc'], object: 'исход переговоров (withdraw/tribute)',
    producers: ['rules-engine'], consumers: [],
    visibility: 'party',
    description_ru: 'Клятва вожака противника, данная на переговорах.',
  }),
  party_deed: Object.freeze({
    record: 'fact', subject_kinds: ['location'], object: 'JSON поступка',
    producers: ['world-deeds'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Поступок отряда в летописи мира. Его разносит молва, а не факт.',
  }),
  'party_deed:': Object.freeze({
    record: 'claim', family: true, subject_kinds: ['npc'], object: 'пересказ поступка',
    producers: ['world-deeds'], consumers: [],
    visibility: 'gm_only',
    description_ru: 'Слух о поступке отряда у конкретного NPC (утверждение, не факт); суффикс — вид поступка. Репутацию считает id слуха, а не предикат.',
  }),
})

/**
 * Отношения между сущностями. Ни один модуль сервера сейчас не создаёт
 * `RecordWorldRelationship`: отношения приходят из административных команд,
 * импорта кампании и фикстур. Поэтому литералов здесь нет, а словарь отношений
 * свободен; сторож требует лишь, чтобы новый литерал в коде появился вместе с
 * записью здесь. Единственный читатель — поиск по памяти: шаг по графу в
 * `retrieveWorldMemory` проходит по любому видимому отношению, не глядя на
 * его название.
 *
 * @type {Readonly<Record<string, Readonly<RelationEntry>>>}
 */
export const RELATIONS = Object.freeze({})

/**
 * Модули, которые читают любой предикат как есть, не сравнивая его со
 * значением: они не нуждаются в конкретном производителе.
 */
export const GENERIC_PREDICATE_CONSUMERS = Object.freeze({
  'world-memory': 'поиск по памяти: предикат и отношение входят в текст для ранжирования, шаг по графу идёт по любому видимому отношению',
  'director-agent': 'передаёт предикат факта Режиссёру как есть',
  'game-orchestrator': 'передаёт предикат факта Рассказчику как есть',
  'player-request-router': 'Хранитель знаний подставляет предикат, если у факта нет текста',
  'campaign-lifecycle': 'экспорт и импорт кампании переносят предикат без изменений',
})

/**
 * Предикаты, у которых нет производителя в коде сознательно: их пишет только
 * ведущий. Список закрыт — тест сравнивает его целиком, поэтому новая «дыра»
 * не пройдёт молча, даже если её объявить внешней.
 */
export const EXTERNAL_ONLY_PREDICATES = Object.freeze(['quest_progress'])

/**
 * Модули, где слова `predicate`/`relation` означают другое (фильтр трасс,
 * отбор целей заклинания, отношение к опасности, граф правил).
 */
const NON_MEMORY_FILES = new Set([
  'trace-store', 'combat-spells', 'campaign-controls', 'rule-pack', 'rule-retriever', 'free-action-adjudication',
])

/** Строки, где `predicate:` — аргумент фильтра трасс, а не поле факта. */
const NON_MEMORY_LINE = /traceStore\.|\{\s*predicate\s*:\s*is[A-Z]\w*\s*\}/u

/** Объект-образец для сравнения («нужен факт с таким предикатом»), а не запись. */
const MATCH_SPEC_LINE = /\b(?:required_?[Ff]act|match(?:Spec)?|pattern|query)\b/u

/**
 * @typedef {{ file: string, line: number, name: string, family: boolean, record: OntologyRecord }} Occurrence
 * @typedef {{ file: string, line: number, expression: string, kind: 'passthrough'|'dynamic' }} DynamicSite
 * @typedef {{
 *   produced: { predicates: Occurrence[], relations: Occurrence[] },
 *   consumed: { predicates: Occurrence[], relations: Occurrence[] },
 *   dynamic: { produced: DynamicSite[], consumed: DynamicSite[] },
 * }} ScanResult
 */

/** @param {string} expression */
function literalsIn(expression) {
  /** @type {Array<{ name: string, family: boolean }>} */
  const found = []
  for (const match of expression.matchAll(/'([a-z][a-z0-9_]*:?)'|"([a-z][a-z0-9_]*:?)"/gu)) found.push({ name: match[1] ?? match[2], family: false })
  for (const match of expression.matchAll(/`([a-z][a-z0-9_]*:)\$\{/gu)) found.push({ name: match[1], family: true })
  return found
}

/**
 * Запись утверждения или факта: смотрим на несколько строк вверх, в какую
 * команду или событие вложен объект.
 *
 * @param {string[]} lines
 * @param {number} index
 * @returns {OntologyRecord}
 */
function recordKindAt(lines, index) {
  for (let cursor = index; cursor >= Math.max(0, index - 10); cursor -= 1) {
    const line = lines[cursor]
    if (/RecordRumor|RecordNpcBelief|\bclaim\s*:\s*\{/u.test(line)) return 'claim'
    if (/RecordWorldFact|WorldFactRecorded|\bfact\s*:\s*\{/u.test(line)) return 'fact'
  }
  return 'fact'
}

/**
 * Статический разбор одного модуля. Ищет:
 * - запись: `predicate: '…'`, `predicate: cond ? '…' : '…'`, шаблон
 *   `` `prefix:${…}` `` (семейство), то же для `relation:` рядом с
 *   `from_entity_id`;
 * - чтение: `.predicate === '…'` (и `!==`, и через `String(… ?? '')`),
 *   `.predicate.startsWith('…')`, `SET.has(x.predicate)` с литеральным
 *   `new Set([...])`, `[...].includes(x.predicate)`;
 * - динамику: присваивания и сравнения без литерала.
 *
 * Сканер построчный и сознательно простой: он не строит AST, поэтому
 * многострочные выражения и косвенные ссылки видит только как динамику.
 *
 * @param {string} file имя модуля без расширения
 * @param {string} source текст модуля
 * @returns {ScanResult}
 */
export function scanOntologyUsage(file, source) {
  /** @type {ScanResult} */
  const result = {
    produced: { predicates: [], relations: [] },
    consumed: { predicates: [], relations: [] },
    dynamic: { produced: [], consumed: [] },
  }
  if (NON_MEMORY_FILES.has(file)) return result
  const lines = String(source).split(/\r?\n/u)
  /** @type {Map<string, string[]>} */
  const setConstants = new Map()
  for (const match of String(source).matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?new Set\(\[([^\]]*)\]/gu)) {
    setConstants.set(match[1], literalsIn(match[2]).map((entry) => entry.name))
  }
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (NON_MEMORY_LINE.test(line)) return
    for (const field of /** @type {const} */ (['predicate', 'relation'])) {
      const bucket = field === 'predicate' ? 'predicates' : 'relations'
      // Отношение — поле записи памяти, только если рядом есть from_entity_id.
      if (field === 'relation') {
        const window = lines.slice(Math.max(0, index - 4), index + 5).join('\n')
        if (!/from_entity_id/u.test(window)) continue
      }
      // Запись: `field: <выражение>` до запятой, закрывающей скобки или конца строки.
      for (const match of line.matchAll(new RegExp(`(?<![\\w.])${field}\\s*:\\s*([^,}\\n]+)`, 'gu'))) {
        const expression = match[1].trim()
        // В тернарнике значение — ветви после `?`, условие (`source === 'priest'`) не в счёт.
        const conditional = expression.match(/\?(.+)$/u)
        const literals = literalsIn(conditional ? conditional[1] : expression)
        const asSpec = MATCH_SPEC_LINE.test(line)
        if (literals.length) {
          const target = asSpec ? result.consumed[bucket] : result.produced[bucket]
          for (const literal of literals) target.push({ file, line: lineNumber, name: literal.name, family: literal.family, record: recordKindAt(lines, index) })
        } else {
          result.dynamic.produced.push({ file, line: lineNumber, expression: expression.slice(0, 120), kind: new RegExp(`\\.${field}\\b`, 'u').test(expression) ? 'passthrough' : 'dynamic' })
        }
      }
      // Сокращённая запись `{ predicate, … }` в объекте-черновике.
      if (new RegExp(`^\\s*${field},\\s*$`, 'u').test(line)) {
        result.dynamic.produced.push({ file, line: lineNumber, expression: field, kind: 'passthrough' })
      }
      // Чтение сравнением.
      const compare = new RegExp(`\\.${field}\\b[^=\\n]{0,24}?[!=]==?\\s*(\\S+)`, 'gu')
      for (const match of line.matchAll(compare)) {
        const literals = literalsIn(match[1])
        if (literals.length) for (const literal of literals) result.consumed[bucket].push({ file, line: lineNumber, name: literal.name, family: false, record: 'fact' })
        else result.dynamic.consumed.push({ file, line: lineNumber, expression: line.trim().slice(0, 160), kind: 'dynamic' })
      }
      for (const match of line.matchAll(new RegExp(`(['"])([a-z][a-z0-9_]*)\\1\\s*[!=]==?\\s*[\\w?.]+\\.${field}\\b`, 'gu'))) {
        result.consumed[bucket].push({ file, line: lineNumber, name: match[2], family: false, record: 'fact' })
      }
      for (const match of line.matchAll(new RegExp(`\\.${field}\\??\\.startsWith\\(\\s*(['"])([a-z][a-z0-9_]*:?)\\1`, 'gu'))) {
        result.consumed[bucket].push({ file, line: lineNumber, name: match[2], family: true, record: 'fact' })
      }
      for (const match of line.matchAll(new RegExp(`([A-Z][A-Z0-9_]*)\\.has\\([^)]*\\.${field}\\)`, 'gu'))) {
        const names = setConstants.get(match[1])
        if (names?.length) for (const name of names) result.consumed[bucket].push({ file, line: lineNumber, name, family: false, record: 'fact' })
        else result.dynamic.consumed.push({ file, line: lineNumber, expression: line.trim().slice(0, 160), kind: 'dynamic' })
      }
      for (const match of line.matchAll(new RegExp(`\\[([^\\]]*)\\]\\.includes\\([^)]*\\.${field}\\)`, 'gu'))) {
        for (const literal of literalsIn(match[1])) result.consumed[bucket].push({ file, line: lineNumber, name: literal.name, family: false, record: 'fact' })
      }
      if (new RegExp(`\\/[^/\\n]+\\/[a-z]*\\.test\\([^)]*\\.${field}\\b`, 'u').test(line)) {
        result.dynamic.consumed.push({ file, line: lineNumber, expression: line.trim().slice(0, 160), kind: 'dynamic' })
      }
    }
  })
  return result
}

/**
 * Сводка по нескольким модулям: кто что пишет и читает, и где разрывы.
 *
 * @param {Array<{ file: string, source: string }>} files
 */
export function auditOntology(files) {
  /** @type {Map<string, { family: boolean, record: Set<string>, producers: Set<string>, consumers: Set<string>, sites: string[] }>} */
  const predicates = new Map()
  /** @type {Map<string, { family: boolean, record: Set<string>, producers: Set<string>, consumers: Set<string>, sites: string[] }>} */
  const relations = new Map()
  /** @type {DynamicSite[]} */
  const dynamicProduced = []
  /** @type {DynamicSite[]} */
  const dynamicConsumed = []
  /**
   * @param {typeof predicates} table
   * @param {Occurrence} occurrence
   * @param {'producers'|'consumers'} role
   */
  const add = (table, occurrence, role) => {
    const entry = table.get(occurrence.name) ?? { family: occurrence.family, record: new Set(), producers: new Set(), consumers: new Set(), sites: [] }
    entry.family ||= occurrence.family
    if (role === 'producers') entry.record.add(occurrence.record)
    entry[role].add(occurrence.file)
    entry.sites.push(`${role === 'producers' ? 'W' : 'R'} server/${occurrence.file}.mjs:${occurrence.line}`)
    table.set(occurrence.name, entry)
  }
  for (const { file, source } of files) {
    const scan = scanOntologyUsage(file, source)
    for (const occurrence of scan.produced.predicates) add(predicates, occurrence, 'producers')
    for (const occurrence of scan.consumed.predicates) add(predicates, occurrence, 'consumers')
    for (const occurrence of scan.produced.relations) add(relations, occurrence, 'producers')
    for (const occurrence of scan.consumed.relations) add(relations, occurrence, 'consumers')
    dynamicProduced.push(...scan.dynamic.produced)
    dynamicConsumed.push(...scan.dynamic.consumed)
  }
  /** @param {typeof predicates} table */
  const serialize = (table) => Object.fromEntries([...table.keys()].sort().map((name) => {
    const entry = /** @type {NonNullable<ReturnType<typeof table.get>>} */ (table.get(name))
    return [name, {
      family: entry.family, record: [...entry.record].sort(),
      producers: [...entry.producers].sort(), consumers: [...entry.consumers].sort(), sites: entry.sites,
    }]
  }))
  /** @param {typeof predicates} table */
  const consumedWithoutProducer = (table) => [...table].filter(([name, entry]) => entry.consumers.size && !entry.producers.size
    && !(name.endsWith(':') ? [...table].some(([other, candidate]) => other.startsWith(name) && candidate.producers.size) : false))
    .map(([name]) => name).sort()
  /** @param {typeof predicates} table */
  const producedWithoutConsumer = (table) => [...table].filter(([, entry]) => entry.producers.size && !entry.consumers.size).map(([name]) => name).sort()
  return {
    predicates: serialize(predicates),
    relations: serialize(relations),
    gaps: {
      consumed_but_never_produced: { predicates: consumedWithoutProducer(predicates), relations: consumedWithoutProducer(relations) },
      produced_but_never_consumed: { predicates: producedWithoutConsumer(predicates), relations: producedWithoutConsumer(relations) },
    },
    dynamic: {
      produced: dynamicProduced.map((site) => ({ ...site, at: `server/${site.file}.mjs:${site.line}` })),
      consumed: dynamicConsumed.map((site) => ({ ...site, at: `server/${site.file}.mjs:${site.line}` })),
    },
  }
}
