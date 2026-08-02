/**
 * Набор импровизаций для замера Арбитра свободного действия (задача 1.3 плана
 * `docs/experience-upgrade-plan.md`).
 *
 * Цель замера — не «угадала ли модель мой вариант», а выполняется ли контракт
 * владельца: на любое физически возможное действие приходит осмысленный разбор
 * с проверкой и последствиями, а не отказ, игнор или занижение до тривиальности.
 *
 * Поэтому ожидания заданы **множествами и диапазонами**, а не одним значением:
 * «прыгаю с люстры на огра» законно судить и Акробатикой от Ловкости, и
 * Атлетикой от Силы. Промах засчитывается только там, где ответ выходит за
 * границы допустимого — например, выполнимая задумка получает
 * `impossible_without_means`.
 *
 * Сцены синтетические, storage не читается и не меняется.
 */

export const PLAUSIBILITY_ORDER = Object.freeze(['trivial', 'plausible', 'strenuous', 'impossible_without_means'])
export const RISK_ORDER = Object.freeze(['none', 'minor', 'serious', 'deadly'])

const ABILITIES = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const SKILLS = Object.freeze([
  'acrobatics', 'animal_handling', 'arcana', 'athletics', 'deception', 'history',
  'insight', 'intimidation', 'investigation', 'medicine', 'nature', 'perception',
  'performance', 'persuasion', 'religion', 'sleight_of_hand', 'stealth', 'survival',
])
const ACTION_COSTS = Object.freeze(['action', 'bonus_action', 'free'])
const EFFECTS = Object.freeze(['none', 'prone', 'help_ally', 'distract', 'blind', 'restrain', 'hazard_damage'])
const PROFICIENCY_LEVELS = Object.freeze(['none', 'proficient', 'expertise'])
const CONSEQUENCE_TYPES = Object.freeze(['time', 'noise', 'exposure', 'lost_opportunity'])

const hero = () => ({
  id: 'hero-1',
  character: 'Ада',
  role: 'следопыт',
  characterSheet: { abilities: { str: 14, dex: 16, con: 13, int: 10, wis: 15, cha: 12 } },
  classSkillProficiencies: ['athletics', 'perception', 'survival', 'stealth'],
  knownSpellIds: [],
  preparedSpellIds: [],
  selectedFeatureIds: [],
  speed: 30,
  inventory: [
    { id: 'item-rope', name: 'Верёвка пеньковая, 50 футов', equipped: false },
    { id: 'item-oil', name: 'Фляга масла', equipped: false },
    { id: 'item-torch', name: 'Факел', equipped: false },
    { id: 'item-dagger', name: 'Кинжал', equipped: true },
    { id: 'item-crowbar', name: 'Лом', equipped: false },
    { id: 'item-caltrops', name: 'Калтропы', equipped: false },
  ],
})

/** Трактир: высота, мебель, разлитое масло, огр в общем зале. */
export const TAVERN_STATE = Object.freeze({
  sessionCode: 'IMPROVEVAL',
  players: [hero()],
  enemies: [
    { id: 'enemy-ogre', name: 'Огр', role: 'громила', hp: 42, alive: true, x: 6, y: 4 },
    { id: 'enemy-bandit', name: 'Разбойник', role: 'наёмник', hp: 11, alive: true, x: 4, y: 5 },
  ],
  scene: {
    title: 'Драка в «Пустом кубке»',
    location: 'Трактир «Пустой кубок»',
    mood: 'опрокинутые столы, с балки свисает тяжёлая люстра, под ногами растеклось масло из разбитой лампы',
    objective: 'Выбить огра из общего зала',
    cells: [{ x: 6, y: 4, revealed: true }],
  },
  mechanics: { combat: { active: true, round: 2, action_economy: { 'hero-1': { action: true, bonus_action: true, movement_spent: 0 } } } },
  social: { npcs: [] },
})

/** Застава: разговоры, стражник, знатная гостья, купец. */
export const GATE_STATE = Object.freeze({
  sessionCode: 'IMPROVEVAL',
  players: [hero()],
  enemies: [],
  scene: {
    title: 'Досмотр у Северных ворот',
    location: 'Северные ворота',
    mood: 'очередь торговцев, стражники проверяют подорожные, накрапывает дождь',
    objective: 'Пройти за ворота до закрытия',
    cells: [],
  },
  mechanics: { combat: { active: false } },
  social: {
    npcs: [
      { id: 'npc-guard', name: 'Стражник Хальд', role: 'начальник караула', location: 'Северные ворота', available: true },
      { id: 'npc-lady', name: 'Госпожа Вельта', role: 'знатная путешественница', location: 'Северные ворота', available: true },
      { id: 'npc-merchant', name: 'Купец Тавис', role: 'торговец солью', location: 'Северные ворота', available: true },
    ],
  },
})

/** Подземелье: пропасть, решётка, затопленный ход, запертая дверь. */
export const VAULT_STATE = Object.freeze({
  sessionCode: 'IMPROVEVAL',
  players: [hero()],
  enemies: [
    { id: 'enemy-guardian', name: 'Каменный страж', role: 'конструкт', hp: 30, alive: true, x: 9, y: 7 },
  ],
  scene: {
    title: 'Затопленная сокровищница',
    location: 'Старая сокровищница',
    mood: 'через зал идёт трещина в двадцать футов, вход перекрыт опускной решёткой, дальний ход затоплен по потолок',
    objective: 'Добраться до запертой двери хранилища',
    cells: [{ x: 9, y: 7, revealed: true }],
  },
  mechanics: { combat: { active: false } },
  social: { npcs: [] },
})

const range = (from, to) => Object.freeze([from, to])

/**
 * Кейсы. `expect.no_refusal` — это и есть требование владельца: выполнимая
 * задумка обязана получить проверку, а не `impossible_without_means`.
 */
export const IMPROVISATION_CASES = Object.freeze([
  // --- Акробатика и среда (6) ---
  {
    id: 'acro-chandelier-ogre',
    category: 'acrobatics_environment',
    state: TAVERN_STATE,
    text: 'Прыгаю с люстры прямо на огра, чтобы сбить его с ног',
    expect: { ability: ['dex', 'str'], skill: ['acrobatics', 'athletics'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'acro-table-vault',
    category: 'acrobatics_environment',
    state: TAVERN_STATE,
    text: 'Перекатываюсь через опрокинутый стол и оказываюсь за спиной у разбойника',
    expect: { ability: ['dex'], skill: ['acrobatics', 'athletics', 'stealth'], plausibility: range('plausible', 'strenuous'), risk: range('none', 'serious'), no_refusal: true },
  },
  {
    id: 'acro-oil-slip',
    category: 'acrobatics_environment',
    state: TAVERN_STATE,
    text: 'Толкаю огра так, чтобы он поскользнулся на разлитом масле',
    expect: { ability: ['str', 'dex'], skill: ['athletics', 'acrobatics'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'acro-swing-beam',
    category: 'acrobatics_environment',
    state: TAVERN_STATE,
    text: 'Цепляюсь за балку и раскачиваюсь, чтобы перелететь через весь зал',
    expect: { ability: ['dex', 'str'], skill: ['acrobatics', 'athletics'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'acro-chasm-jump',
    category: 'acrobatics_environment',
    state: VAULT_STATE,
    text: 'Разбегаюсь и прыгаю через трещину в полу',
    expect: { ability: ['str', 'dex'], skill: ['athletics', 'acrobatics'], plausibility: range('plausible', 'strenuous'), risk: range('serious', 'deadly'), no_refusal: true },
  },
  {
    id: 'acro-squeeze-portcullis',
    category: 'acrobatics_environment',
    state: VAULT_STATE,
    text: 'Протискиваюсь между прутьями опускной решётки',
    expect: { ability: ['dex', 'str'], skill: ['acrobatics', 'athletics'], plausibility: range('plausible', 'impossible_without_means'), risk: range('none', 'serious'), no_refusal: false },
  },

  // --- Социальные дерзости (6) ---
  {
    id: 'social-seduce-guard',
    category: 'social_audacity',
    state: GATE_STATE,
    text: 'Соблазняю стражника, чтобы он забыл про мою подорожную',
    expect: { ability: ['cha'], skill: ['persuasion', 'deception', 'performance'], plausibility: range('trivial', 'strenuous'), risk: range('minor', 'serious'), no_refusal: true },
  },
  {
    id: 'social-intimidate-captain',
    category: 'social_audacity',
    state: GATE_STATE,
    text: 'Запугиваю начальника караула, нависая над ним и обещая проблемы',
    expect: { ability: ['cha', 'str'], skill: ['intimidation'], plausibility: range('trivial', 'strenuous'), risk: range('minor', 'serious'), no_refusal: true },
  },
  {
    id: 'social-bluff-noble',
    category: 'social_audacity',
    state: GATE_STATE,
    text: 'Вру знатной госпоже, что я её новая охранница и должна идти рядом',
    expect: { ability: ['cha'], skill: ['deception', 'performance'], plausibility: range('trivial', 'strenuous'), risk: range('minor', 'serious'), no_refusal: true },
  },
  {
    id: 'social-bribe-merchant',
    category: 'social_audacity',
    state: GATE_STATE,
    text: 'Предлагаю купцу долю, если он проведёт меня в своей повозке',
    expect: { ability: ['cha'], skill: ['persuasion', 'deception'], plausibility: range('trivial', 'strenuous'), risk: range('none', 'serious'), no_refusal: true },
  },
  {
    id: 'social-insult-ogre',
    category: 'social_audacity',
    state: TAVERN_STATE,
    text: 'Ору на огра самые обидные оскорбления, чтобы он бросил разбойника и пошёл на меня',
    expect: { ability: ['cha'], skill: ['intimidation', 'persuasion', 'performance'], plausibility: range('trivial', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'social-read-guard',
    category: 'social_audacity',
    state: GATE_STATE,
    text: 'Присматриваюсь к стражнику: он врёт про приказ или правда боится?',
    expect: { ability: ['wis'], skill: ['insight', 'perception'], plausibility: range('trivial', 'plausible'), risk: range('none', 'minor'), no_refusal: true },
  },

  // --- Предметы из инвентаря (5) ---
  {
    id: 'item-oil-fire',
    category: 'inventory_items',
    state: TAVERN_STATE,
    text: 'Бросаю флягу масла под ноги огру и поджигаю факелом',
    expect: { ability: ['dex'], skill: ['sleight_of_hand', 'athletics', 'survival'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true, item: ['item-oil', 'item-torch'] },
  },
  {
    id: 'item-rope-portcullis',
    category: 'inventory_items',
    state: VAULT_STATE,
    text: 'Привязываю верёвку к решётке и тяну её вверх всем весом',
    expect: { ability: ['str'], skill: ['athletics'], plausibility: range('plausible', 'strenuous'), risk: range('none', 'serious'), no_refusal: true, item: ['item-rope'] },
  },
  {
    id: 'item-crowbar-door',
    category: 'inventory_items',
    state: VAULT_STATE,
    text: 'Поддеваю ломом дверь хранилища и налегаю',
    expect: { ability: ['str'], skill: ['athletics'], plausibility: range('plausible', 'strenuous'), risk: range('none', 'serious'), no_refusal: true, item: ['item-crowbar'] },
  },
  {
    id: 'item-caltrops-retreat',
    category: 'inventory_items',
    state: TAVERN_STATE,
    text: 'Рассыпаю калтропы позади себя, отступая от огра',
    expect: { ability: ['dex'], skill: ['sleight_of_hand', 'acrobatics', 'survival'], plausibility: range('trivial', 'plausible'), risk: range('none', 'serious'), no_refusal: true, item: ['item-caltrops'] },
  },
  {
    id: 'item-rope-chasm',
    category: 'inventory_items',
    state: VAULT_STATE,
    text: 'Закидываю верёвку с петлёй на выступ по ту сторону трещины и перебираюсь по ней',
    expect: { ability: ['dex', 'str'], skill: ['athletics', 'acrobatics', 'survival'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true, item: ['item-rope'] },
  },

  // --- Безумные, но возможные (6) ---
  {
    id: 'wild-ride-ogre',
    category: 'wild_but_possible',
    state: TAVERN_STATE,
    text: 'Запрыгиваю огру на плечи и закрываю ему глаза руками',
    expect: { ability: ['dex', 'str'], skill: ['acrobatics', 'athletics'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'wild-tablecloth',
    category: 'wild_but_possible',
    state: TAVERN_STATE,
    text: 'Срываю скатерть и набрасываю её разбойнику на голову',
    expect: { ability: ['dex', 'str'], skill: ['sleight_of_hand', 'athletics', 'acrobatics'], plausibility: range('trivial', 'strenuous'), risk: range('none', 'serious'), no_refusal: true },
  },
  {
    id: 'wild-dagger-lamp',
    category: 'wild_but_possible',
    state: TAVERN_STATE,
    text: 'Метаю кинжал в крепление люстры, чтобы она рухнула на огра',
    expect: { ability: ['dex'], skill: ['sleight_of_hand', 'acrobatics', 'athletics'], plausibility: range('plausible', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'wild-pretend-corpse',
    category: 'wild_but_possible',
    state: TAVERN_STATE,
    text: 'Падаю и притворяюсь мёртвой, чтобы огр потерял ко мне интерес',
    expect: { ability: ['cha', 'dex'], skill: ['deception', 'performance', 'stealth'], plausibility: range('trivial', 'strenuous'), risk: range('minor', 'deadly'), no_refusal: true },
  },
  {
    id: 'wild-sing-guards',
    category: 'wild_but_possible',
    state: GATE_STATE,
    text: 'Начинаю громко петь похабную песню, чтобы вся очередь смотрела на меня, а не на купца',
    expect: { ability: ['cha'], skill: ['performance', 'deception'], plausibility: range('trivial', 'plausible'), risk: range('none', 'serious'), no_refusal: true },
  },
  {
    id: 'wild-dive-flooded',
    category: 'wild_but_possible',
    state: VAULT_STATE,
    text: 'Набираю воздуха и ныряю в затопленный ход, надеясь доплыть до конца на одном дыхании',
    expect: { ability: ['con', 'str', 'dex'], skill: ['athletics', 'survival', 'acrobatics'], plausibility: range('plausible', 'strenuous'), risk: range('serious', 'deadly'), no_refusal: true },
  },

  // --- Честный impossible_without_means (5) ---
  {
    id: 'means-fly-chasm',
    category: 'honest_impossible_without_means',
    state: VAULT_STATE,
    text: 'Взлетаю и перелетаю трещину по воздуху',
    expect: { plausibility: range('impossible_without_means', 'impossible_without_means'), risk: range('none', 'deadly'), requires_means: true },
  },
  {
    id: 'means-breathe-water',
    category: 'honest_impossible_without_means',
    state: VAULT_STATE,
    text: 'Дышу под водой и спокойно исследую весь затопленный ход без спешки',
    expect: { plausibility: range('impossible_without_means', 'impossible_without_means'), risk: range('none', 'deadly'), requires_means: true },
  },
  {
    id: 'means-teleport-vault',
    category: 'honest_impossible_without_means',
    state: VAULT_STATE,
    text: 'Телепортируюсь сквозь решётку внутрь хранилища',
    expect: { plausibility: range('impossible_without_means', 'impossible_without_means'), risk: range('none', 'deadly'), requires_means: true },
  },
  {
    id: 'means-charm-spell',
    category: 'honest_impossible_without_means',
    state: GATE_STATE,
    text: 'Накладываю на стражника чары очарования, чтобы он пропустил меня',
    expect: { plausibility: range('impossible_without_means', 'impossible_without_means'), risk: range('none', 'deadly'), requires_means: true },
  },
  {
    id: 'means-invisible',
    category: 'honest_impossible_without_means',
    state: GATE_STATE,
    text: 'Становлюсь невидимой и прохожу мимо караула',
    expect: { plausibility: range('impossible_without_means', 'impossible_without_means'), risk: range('none', 'deadly'), requires_means: true },
  },

  // --- Физически невозможное в этой обстановке (3) ---
  {
    id: 'impossible-moon',
    category: 'physically_impossible',
    state: GATE_STATE,
    text: 'Прыгаю с места на луну',
    expect: { plausibility: range('strenuous', 'impossible_without_means'), risk: range('none', 'deadly'), no_refusal: false },
  },
  {
    id: 'impossible-stop-time',
    category: 'physically_impossible',
    state: TAVERN_STATE,
    text: 'Останавливаю время во всём трактире',
    expect: { plausibility: range('strenuous', 'impossible_without_means'), risk: range('none', 'deadly'), no_refusal: false },
  },
  {
    id: 'impossible-become-dragon',
    category: 'physically_impossible',
    state: VAULT_STATE,
    text: 'Превращаюсь в дракона и разношу стену',
    expect: { plausibility: range('strenuous', 'impossible_without_means'), risk: range('none', 'deadly'), no_refusal: false },
  },
])

export const CATEGORY_LABELS = Object.freeze({
  acrobatics_environment: 'акробатика и среда',
  social_audacity: 'социальные дерзости',
  inventory_items: 'предметы из инвентаря',
  wild_but_possible: 'безумные, но возможные',
  honest_impossible_without_means: 'честный impossible_without_means',
  physically_impossible: 'физически невозможное',
})

const inRange = (order, value, [from, to]) => {
  const index = order.indexOf(String(value))
  return index >= 0 && index >= order.indexOf(from) && index <= order.indexOf(to)
}

/**
 * Структурная валидность сырого ответа модели — до `normalizeFreeActionReading`.
 * Нормализатор молча чинит мусор, поэтому замерять после него бессмысленно:
 * любой ответ выглядел бы корректным.
 */
export function structuralIssues(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['ответ не является JSON-объектом']
  const issues = []
  const enumField = (field, values) => {
    if (!values.includes(String(raw[field]))) issues.push(`${field}=${JSON.stringify(raw[field])} вне перечисления`)
  }
  for (const field of ['goal_summary', 'approach_summary', 'obstacle']) {
    if (!String(raw[field] ?? '').trim()) issues.push(`${field} пустое`)
  }
  enumField('ability', ABILITIES)
  enumField('skill', SKILLS)
  enumField('plausibility', PLAUSIBILITY_ORDER)
  enumField('risk', RISK_ORDER)
  enumField('action_cost', ACTION_COSTS)
  enumField('effect', EFFECTS)
  enumField('proficiency', PROFICIENCY_LEVELS)
  enumField('consequence_type', CONSEQUENCE_TYPES)
  if (!Array.isArray(raw.required_means)) issues.push('required_means не массив')
  // Контракт v2/v3: числа и текст исхода — работа сервера, не модели.
  for (const field of ['difficulty', 'dc', 'damage', 'outcome', 'narration', 'result']) {
    if (raw[field] !== undefined) issues.push(`${field} не должно приходить от модели`)
  }
  return issues
}

/** Промахи по ожиданиям кейса. Пустой список — кейс в ожиданиях. */
export function expectationMisses(testCase, raw) {
  const expect = testCase.expect
  const misses = []
  if (!raw || typeof raw !== 'object') return ['нет разбора']
  const plausibility = String(raw.plausibility)
  if (expect.ability && !expect.ability.includes(String(raw.ability))) {
    misses.push(`ability=${raw.ability}, ожидалось одно из ${expect.ability.join('/')}`)
  }
  if (expect.skill && !expect.skill.includes(String(raw.skill))) {
    misses.push(`skill=${raw.skill}, ожидалось одно из ${expect.skill.join('/')}`)
  }
  if (expect.plausibility && !inRange(PLAUSIBILITY_ORDER, plausibility, expect.plausibility)) {
    misses.push(`plausibility=${plausibility}, ожидалось ${expect.plausibility.join('..')}`)
  }
  if (expect.risk && !inRange(RISK_ORDER, String(raw.risk), expect.risk)) {
    misses.push(`risk=${raw.risk}, ожидалось ${expect.risk.join('..')}`)
  }
  // Главный критерий владельца: выполнимое не получает отказ.
  if (expect.no_refusal && plausibility === 'impossible_without_means') {
    misses.push('отказ на выполнимой задумке: impossible_without_means')
  }
  if (expect.requires_means) {
    if (plausibility !== 'impossible_without_means') misses.push(`ожидался impossible_without_means, пришло ${plausibility}`)
    else if (!Array.isArray(raw.required_means) || raw.required_means.length === 0) {
      misses.push('impossible_without_means без required_means')
    }
  }
  if (expect.item && String(raw.item_id ?? '') && !expect.item.includes(String(raw.item_id))) {
    misses.push(`item_id=${raw.item_id}, ожидалось одно из ${expect.item.join('/')}`)
  }
  return misses
}

/** Сводка по всем кейсам: доли и список промахов, включая разрез по категориям. */
export function scoreImprovisationRun(samples) {
  const byCategory = new Map()
  let structural = 0
  let inExpectation = 0
  let refusals = 0
  const misses = []
  for (const sample of samples) {
    const category = sample.category
    const bucket = byCategory.get(category) ?? { total: 0, structural: 0, in_expectation: 0, refusals: 0 }
    bucket.total += 1
    if (sample.structural_issues.length === 0) { bucket.structural += 1; structural += 1 }
    if (sample.expectation_misses.length === 0) { bucket.in_expectation += 1; inExpectation += 1 }
    if (sample.wrong_refusal) { bucket.refusals += 1; refusals += 1 }
    byCategory.set(category, bucket)
    if (sample.structural_issues.length || sample.expectation_misses.length) {
      misses.push({
        id: sample.id,
        category,
        plausibility: sample.raw?.plausibility ?? null,
        ability: sample.raw?.ability ?? null,
        skill: sample.raw?.skill ?? null,
        risk: sample.raw?.risk ?? null,
        structural_issues: sample.structural_issues,
        expectation_misses: sample.expectation_misses,
      })
    }
  }
  const percent = (part, total) => (total === 0 ? 0 : Math.round((part / total) * 1000) / 10)
  return {
    total: samples.length,
    structural_valid_pct: percent(structural, samples.length),
    in_expectation_pct: percent(inExpectation, samples.length),
    wrong_refusals: refusals,
    categories: Object.fromEntries([...byCategory].map(([category, bucket]) => [category, {
      label: CATEGORY_LABELS[category] ?? category,
      total: bucket.total,
      structural_valid_pct: percent(bucket.structural, bucket.total),
      in_expectation_pct: percent(bucket.in_expectation, bucket.total),
      wrong_refusals: bucket.refusals,
    }])),
    misses,
  }
}
