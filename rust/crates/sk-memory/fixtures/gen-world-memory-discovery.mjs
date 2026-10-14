import '../../../fixtures-env.mjs'
// Эталоны находок и заготовок ведущего `server/world-memory.mjs` для
// sk-memory: `node gen-world-memory-discovery.mjs`.
//
// Состояния — настоящие кампании авторских миров (`CampaignBootstrapper` без
// модели) и кампания заготовок из `test/gm-secrets.test.mjs` (FakeLLM); на них
// случайно накладываются правки: погашенные и личные тайны, свидетельства
// хранителей, пересказ в разговоре, журнал знаний, поручения по теме, NPC в
// сцене, враги и бой, культ в замысле. Каждое состояние сводится к полям,
// которые читает модуль, и прогоняется через фразы тестов, слова самих тайн,
// имена NPC и мусор.
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const M = await import(server('world-memory'))
const { CampaignBootstrapper } = await import(server('campaign-bootstrap'))
const { FakeLLM } = await import(server('llm-client'))
const { listWorldTemplates } = await import(server('world-template-catalog'))

const random = rng(4242)
const c = collector()

const hero = {
  id: 'hero', character: 'Брам', name: 'Игрок', role: 'Жрец · ур. 1',
  characterClass: 'cleric', level: 1, hp: 11, maxHp: 11, armor: 18, speed: 25,
  proficiency: 2, abilities: { str: 10, dex: 14, con: 15, int: 12, wis: 16, cha: 8 },
  inventory: [], x: 3, y: 2,
}

const gmOpening = {
  campaignName: 'Журнал не того берега', partyName: 'Двое',
  worldSummary: 'Речной край с мытнями.',
  openingNarration: 'У мытни Клара Вельм прижимает к груди запертый футляр с картой.\n\nНа столе раскрыт журнал поисков.',
  scene: { title: 'Мытня', location: 'Мытарский Двор', mood: 'Дождливое утро', objective: 'Понять, почему искали не там', theme: 'мытня', danger: 'низкая', map: { layout: 'streets', width: 13, height: 11, openness: 0.6, water: 0, featureCount: 4 } },
  npcs: [{ name: 'Клара Вельм', role: 'хранительница карты', summary: 'Держит карту в футляре.', voice: 'Ровно.', goals: ['Сохранить порядок'], beliefs: ['Записи не лгут'] }],
  secrets: [
    { clue: 'На футляре свежая царапина от ножа: его уже вскрывали этой ночью.', topic: 'футляр карта замок', skills: ['investigation', 'perception'], holder: '' },
    { clue: 'Клара сама переписала отметки в журнале: её почерк на последних строках другой.', topic: 'журнал отметки почерк', skills: ['insight', 'investigation'], holder: 'Клара Вельм' },
    { clue: 'пусто', topic: 'не годится', skills: ['athletics'], holder: '' },
  ],
  hook: 'Почему искали не там',
}

const novaHero = { id: 'nova', name: 'Анна', character: 'Нова', role: 'Плут · ур. 1', species: 'Человек', background: 'Шарлатан', backstory: 'Ищет брата.', speed: 30, maxHp: 12, armor: 13, online: true }

function trim(state) {
  return plain({
    scene: { location: state.scene?.location, location_id: state.scene?.location_id },
    worldMemory: {
      entities: state.worldMemory?.entities,
      facts: state.worldMemory?.facts,
      quests: state.worldMemory?.quests,
      knowledge_ledger: state.worldMemory?.knowledge_ledger,
      knowledge_revealed: state.worldMemory?.knowledge_revealed,
    },
    social: {
      npcs: (state.social?.npcs ?? []).map((npc) => ({
        id: npc.id, name: npc.name, role: npc.role, location: npc.location, goals: npc.goals,
        ...(npc.available === false ? { available: false } : {}), ...(npc.visibility ? { visibility: npc.visibility } : {}),
      })),
      conversations: [],
    },
    campaignConcept: {
      premise: state.campaignConcept?.premise, hook: state.campaignConcept?.hook,
      worldSummary: state.campaignConcept?.worldSummary, world_summary: state.campaignConcept?.world_summary,
    },
    mechanics: { combat: { active: false } },
    enemies: [],
  })
}

const bases = []
for (const template of listWorldTemplates()) {
  bases.push(trim(await new CampaignBootstrapper().create({ code: `MEM-${template.id.slice(0, 12).toUpperCase()}`, worldTemplateId: template.id, players: [hero] })))
}
bases.push(trim(await new CampaignBootstrapper({ llmClient: new FakeLLM([{ content: JSON.stringify(gmOpening) }]) }).create({
  code: 'GM-SECRETS', name: 'Секреты', partyName: 'Двое', world: {}, players: [novaHero],
})))
// Сцена без заготовок из `test/discovery-content.test.mjs`.
bases.push(plain({
  scene: { location: 'Смотровая дамба', objective: 'Понять, кто открывает шлюзы' },
  social: { npcs: [
    { id: 'mara', name: 'Мара', role: 'смотрительница дамбы', location: 'Смотровая дамба', goals: ['удержать людей подальше от главного шлюза', 'найти тех, кто подменил карту прилива'] },
    { id: 'oswald', name: 'Освальд', role: 'купец', location: 'Вельдбург', goals: ['не пускать никого к шлюзу'] },
    { id: 'ghost', name: 'Тень', role: 'тайный враг', location: 'Смотровая дамба', visibility: 'gm_only', goals: ['открыть шлюз ночью'] },
  ] },
  worldMemory: M.normalizeWorldMemory({ entities: [{ id: 'location:dam', kind: 'location', name: 'Смотровая дамба', visibility: 'public' }], quests: [], facts: [] }),
}))

const words = (value) => String(value ?? '').split(/[^\p{L}-]+/u).filter((word) => word.length >= 4)
const secretsOf = (state) => (state.worldMemory?.facts ?? []).filter((fact) => fact.predicate === 'gm_secret')
const hereOf = (state) => (state.worldMemory?.entities ?? []).find((entity) => entity.name === state.scene?.location)

const TESTIMONIES = [
  { topic: 'канат стражник', skills: ['perception', 'insight'], summary: (name) => `${name} видел, как стражник с баронским жетоном помог незнакомцам перерезать канат.` },
  { topic: 'зарубка баркас', skills: ['insight', 'perception'], summary: (name) => `${name} видел такую же зарубку на другом баркасе, но молчал.` },
  { topic: 'сеть берег лодка', skills: ['investigation'], summary: (name) => `${name} помнит, что сеть сушили на берегу, а не в море.` },
  { topic: 'следы телега дорога', skills: ['survival'], summary: () => 'У колодца видны следы тяжёлых сапог, остановившиеся у телеги.' },
  { topic: 'сестра баркас чайка', skills: ['investigation', 'perception'], summary: () => 'Ила ушла в море на баркасе «Чайка», и баркас видели у маяка в ночь её исчезновения.' },
]

const CULTS = [
  'Береговые деревни шепчутся о культ «Утопленной Матери», что зовёт рыбаков в море.',
  'Здесь орудует культ Утопленной Матери с маяка.',
  'Ходят слухи о культистах, но имени у них нет.',
  'Культ «Ока Бездны» прячется в катакомбах.',
  '',
]

function variant(base) {
  const state = structuredClone(base)
  state.mechanics ??= { combat: { active: false } }
  state.social ??= { npcs: [] }
  state.campaignConcept ??= {}
  const memory = state.worldMemory
  const npcs = state.social?.npcs ?? []
  const here = hereOf(state)
  for (const fact of memory.facts ?? []) {
    if (fact.predicate === 'gm_secret' && random.chance(0.2)) fact.status = 'superseded'
  }
  if (random.chance(0.6)) {
    const template = random.pick(TESTIMONIES)
    const holder = random.chance(0.8) ? random.pick(npcs)?.name ?? 'Йорен Келл' : 'Йорен Келл'
    memory.facts.push({
      id: `fact:secret:test-${random.int(1, 9999)}`, subject_id: random.chance(0.8) ? here?.id ?? 'location:x' : random.pick(memory.entities ?? [])?.id,
      predicate: 'gm_secret', status: random.chance(0.9) ? 'active' : 'superseded', visibility: 'gm_only',
      object: JSON.stringify({ topic: template.topic, skills: template.skills, holder: random.chance(0.7) ? holder : '', ...(random.chance(0.25) ? { hero_id: random.pick(['hero', 'nova', 'other']) } : {}) }),
      summary: template.summary(holder), recorded_at_minutes: 0, source_event_ids: [],
    })
  }
  if (random.chance(0.15)) memory.facts.push({ id: 'fact:secret:broken', subject_id: here?.id, predicate: 'gm_secret', status: 'active', object: random.pick(['не json', '{"topic":', '"строка"', '[1,2]', 'null', '{"skills":"investigation"}']), summary: 'Под половицей тайник с письмами, которые никто не должен был найти.' })
  const secrets = secretsOf(state)
  if (secrets.length && random.chance(0.25)) {
    const secret = random.pick(secrets)
    memory.knowledge_ledger = [...(memory.knowledge_ledger ?? []), { id: `k-${random.int(1, 99)}`, fact_id: secret.id, hero_id: 'hero' }]
  }
  if (secrets.length && random.chance(0.3)) {
    const secret = random.pick(secrets)
    const reply = random.chance(0.5) ? `${secret.summary} Клянусь.` : words(secret.summary).slice(0, random.int(1, 8)).join(' ')
    state.social.conversations = [{ id: 'c1', npc_id: 'npc', npc_reply: reply, disclosed_fact_ids: [] }]
  }
  if (random.chance(0.3)) {
    const npc = random.pick(npcs)
    const goal = npc?.goals?.[0]
    if (goal) memory.facts.push({ id: `fact-discovery-old-${random.int(1, 999)}`, subject_id: here?.id, predicate: 'discovery', object: 'clue', status: 'active', visibility: 'party', summary: `${npc.name} явно знает больше — и хочет ${goal.toLowerCase()}.`, source_event_ids: ['old'] })
  }
  if (random.chance(0.5)) {
    const npc = random.pick(npcs)
    memory.quests = [...(memory.quests ?? []), {
      id: `quest:extra-${random.int(1, 99)}`, title: random.pick(['Пропавшие рыбаки', 'Найти тех, кто подменил карту', 'Тайна маяка', npc?.goals?.[1] ?? 'Странные огни']),
      summary: random.pick(['Найти тех, кто не вернулся с промысла.', 'Узнать, кто открывает шлюзы по ночам.', '']),
      status: random.pick(['active', 'active', 'offered', 'completed']), visibility: random.pick(['party', 'party', 'gm_only', 'public']),
      entity_ids: random.chance(0.8) ? [here?.id ?? 'location:x'] : ['missing'], objectives: random.chance(0.5) ? ['Осмотреть дамбу и шлюзы'] : [],
      clock: { current: 0, max: 3, label: '' }, recorded_at_minutes: 0,
    }]
  }
  if (random.chance(0.3)) state.scene.location = random.pick([...(memory.entities ?? []).map((entity) => entity.name), 'Нигде', ''])
  if (random.chance(0.9)) {
    state.scene_npcs = npcs.slice(0, random.int(1, Math.max(1, npcs.length))).map((npc) => ({
      id: npc.id, name: npc.name, location_id: random.chance(0.8) ? state.scene.location_id : 'elsewhere', alive: random.chance(0.9),
    }))
    if (random.chance(0.3)) state.scene_npcs.push({ id: 'tom', name: 'Том Рыбак', location_id: state.scene.location_id, alive: true })
  }
  if (random.chance(0.3)) state.mechanics.combat.active = random.chance(0.4)
  if (random.chance(0.4)) {
    state.enemies = Array.from({ length: random.int(1, 3) }, (_, index) => ({
      id: `enemy-${index}`, name: random.pick(['Культист 2', 'Фанатик культа', 'Бандит', 'Аколит 13']),
      stat_block_id: random.pick(['mm14:cultist', 'cult-fanatic', 'srd:acolyte', 'bandit', '']),
      hp: random.pick([0, 5, '3', null, undefined]), alive: random.chance(0.7), hidden: random.chance(0.2),
    }))
  }
  if (random.chance(0.5)) state.campaignConcept = { ...state.campaignConcept, premise: random.pick(CULTS) }
  if (random.chance(0.1)) state.autonomy = { director_history: [{ intent: { type: 'advance_quest_clock', quest_id: 'quest:extra-1' } }] }
  return plain(state)
}

const states = []
for (const base of bases) {
  states.push(base)
  for (let index = 0; index < 22; index += 1) states.push(variant(base))
}

const PHRASES = [
  'Изучаю футляр с картой', 'Осматриваюсь', 'Осматриваю футляр и замок', 'Методично осматриваю футляр и замок',
  'Слежу, не врёт ли Клара про журнал', 'Ищу следы у колодца и телеги', 'Иду по следам, которые мы нашли, и пытаюсь понять, куда они ведут',
  'Осматриваю обелиск и символы на нём', 'Прислушиваюсь у двери, есть ли кто-то внутри', 'Осматриваю корму баркаса и ищу метку владельца',
  'Слежу за лицом Клары, когда спрашиваю про журнал и отметки', 'Спрашиваю Клару про журнал и слежу за её лицом', 'Слежу за лицом Клары, когда говорю о погоде на реке',
  'Слежу за Томом, когда спрашиваю про журнал', 'Слежу за лицом незнакомца', 'Смотрю на воду', 'Осматриваюсь у причала',
  'Слежу, как Эда смотрит на зарубку на баркасе', 'Смотрю, как Орен отводит глаза, когда речь о зарубке на баркасе',
  'Благодарю Орена и осматриваю баркас: зарубка на борту, сеть, палуба', 'Слежу, как Клара смотрит на журнал',
  'Проталкиваюсь сквозь толпу к шлюзам и смотрю, кто пытается их открыть', 'Смотрю, кто возится у шлюза', 'Смотрю на чаек над водой',
  'Простукиваю стены в поисках тайника', 'Обшариваю каждый ящик не спеша', 'Перебираю всё, дюйм за дюймом', 'Быстро осматриваю футляр',
  'Ищу след сестры', 'Ищу метку на корме', 'Изучаю повестку', 'Выслеживаю беглеца', 'Смотрю по сторонам', 'Приглядываюсь к Маре',
  'Что известно о пропавших рыбаках?', 'Узнать, кто открывает шлюзы', 'Осматриваю дамбу и шлюзы', 'Ищу улики о Тайне маяка',
  'ОСМАТРИВАЮСЬ!', 'осмотр', 'шаг за шагом обыскиваю', 'каждую доску простукиваю', '', ' ', 'abc', 'ёлки-палки ищу',
]

function phrasesFor(state) {
  const secrets = secretsOf(state)
  const npcs = state.social?.npcs ?? []
  const list = [...PHRASES]
  for (const secret of secrets) {
    const meta = M.parseGmSecretObject(secret.object)
    const ws = words(`${meta.topic} ${secret.summary}`)
    list.push(`Ищу ${random.some(ws, 3).join(' ')}`)
    list.push(`Осматриваю ${ws.slice(0, 2).join(' и ')}`)
    if (meta.holder) list.push(`Слежу за ${meta.holder.split(' ')[0]}ой, когда спрашиваю про ${random.pick(ws) ?? 'это'}`)
  }
  for (const npc of npcs.slice(0, 6)) {
    const first = String(npc.name ?? '').split(' ')[0]
    list.push(`Спрашиваю ${first.slice(0, -1)}у про ${random.pick(words(npc.goals?.join(' ')))} и слежу за лицом`)
    list.push(`Ищу, кто хочет ${random.pick(npc.goals ?? ['ничего'])}`)
    list.push(`Слежу за лицом ${first}, когда спрашиваю про ${random.pick(words(secretsOf(state).map((fact) => fact.summary).join(' '))) ?? 'шлюзы'}`)
    list.push(`Смотрю, как ${first} отводит глаза`)
  }
  for (const quest of state.worldMemory?.quests ?? []) list.push(`Ищу зацепки: ${random.some(words(`${quest.title} ${quest.summary}`), 3).join(' ')}`)
  return list
}

const SKILLS = ['perception', 'investigation', 'insight', 'survival', 'history', 'arcana', 'religion', 'nature', 'medicine', 'athletics', 'stealth', 'sleight_of_hand', 'animal_handling', 'Perception', '', null, undefined, 7]
const checkEvent = (skill, id) => random.chance(0.55) ? { event_id: id, event_type: 'AbilityCheckResolved', payload: { success: true, skill } } : random.pick([
  { event_id: id, event_type: 'AbilityCheckResolved', payload: { success: true, skill } },
  { event_id: id, event_type: 'AbilityCheckResolved', payload: { success: true, skill }, actor_id: random.pick(['hero', 'nova', 'other']) },
  { event_id: id, event_type: 'AbilityCheckResolved', payload: { success: false, skill } },
  { event_id: id, event_type: 'RulingRecorded', payload: { ruling: { outcome: 'success' } } },
  { event_id: id, event_type: 'RulingRecorded', payload: { ruling: { outcome: 'failure' } } },
  { event_type: 'AbilityCheckResolved', payload: { success: true, skill } },
  { event_id: '', payload: { success: true } },
  null, undefined, 'check', { event_id: 5, payload: { success: 'true' } },
])
const DETAILS = [undefined, '', 'На корме выжжена чайка с перебитым крылом — так метят лодки семьи Ворониных.', 'На футляре клеймо мастерской.',
  'Клара бледнеет и прижимает футляр к груди — вопрос ей неприятен.', 'Сеть на корме сложена аккуратно, будто её укладывали на берегу, а не в море.', null, 42, '   ']
const GOALS = [undefined, '', 'Добраться сквозь толпу к шлюзам и заметить, кто пытается их открыть', 'Найти пропавших рыбаков.', null, 'Узнать правду о маяке!']

let counter = 0
for (const state of states) {
  const phrases = phrasesFor(state)
  for (let index = 0; index < 18; index += 1) {
    counter += 1
    const skill = random.pick(SKILLS)
    const input = {
      checkEvent: checkEvent(random.chance(0.8) ? skill : random.pick(SKILLS), `check-${counter}`),
      skill,
      actionText: random.chance(0.95) ? random.pick(phrases) : random.pick(JUNK),
      ...(random.chance(0.4) ? { goalSummary: random.pick(GOALS) } : {}),
      ...(random.chance(0.3) ? { skillLabel: random.pick(['Внимательность', '', 'Анализ', null]) } : {}),
      ...(random.chance(0.4) ? { successDetail: random.pick(DETAILS) } : {}),
      ...(random.chance(0.4) ? { surfaceDetail: random.pick(DETAILS) } : {}),
    }
    c.call('freeActionDiscoveryCommands', M.freeActionDiscoveryCommands, [state, input])
    if (index % 3 === 0) c.call('freeActionSurfaceCommands', M.freeActionSurfaceCommands, [state, input])
    if (index % 2 === 0) c.call('thoroughSearchOutcome', M.thoroughSearchOutcome, [state, { ...input, checkEvent: random.chance(0.8) ? { event_id: `fail-${counter}`, payload: { success: false, skill } } : input.checkEvent }])
    if (index % 2 === 1 || skill === 'insight') c.call('insightRead', M.insightRead, [state, { actionText: input.actionText, ...(random.chance(0.5) ? { actorId: random.pick(['hero', 'nova', '', null, 5]) } : {}) }])
  }
  c.call('cultNameFrom', M.cultNameFrom, [state])
  for (const enemy of state.enemies ?? []) {
    c.call('corpseClueCommand', M.corpseClueCommand, [state, {
      id: `container-${random.int(1, 50)}`, kind: random.pick(['corpse', 'corpse', 'chest', undefined]),
      source_enemy_id: random.chance(0.7) ? enemy.id : undefined, source_enemy_ids: random.chance(0.5) ? [enemy.id, 'enemy-9'] : undefined,
      encounter_id: random.pick([undefined, '', 'enc-1', 'enc-2']),
    }])
  }
  c.call('corpseClueCommand', M.corpseClueCommand, [state, { id: 'c', kind: 'corpse', source_enemy_ids: ['enemy-0', 'enemy-1', 'enemy-2'] }])
}

// Минимальные состояния: мусор на границах.
const minimal = [{}, { worldMemory: {} }, { scene: { location: 'Дом' }, worldMemory: { entities: [{ id: 'loc', name: 'Дом' }], facts: [{ id: 's', predicate: 'gm_secret', status: 'active', subject_id: 'loc', object: '{"skills":["perception"]}', summary: 'Под порогом дома зарыт кошель.' }] } }]
for (const state of minimal) {
  for (const actionText of [...PHRASES.slice(0, 12), ...JUNK]) {
    for (const skill of ['perception', 'insight', 'investigation']) {
      c.call('freeActionDiscoveryCommands', M.freeActionDiscoveryCommands, [state, { checkEvent: { event_id: 'e', payload: { success: true } }, skill, actionText, successDetail: 'Деталь места', surfaceDetail: 'Видимая деталь' }])
    }
    c.call('insightRead', M.insightRead, [state, { actionText }])
    c.call('thoroughSearchOutcome', M.thoroughSearchOutcome, [state, { checkEvent: { event_id: 'e', payload: { success: false } }, skill: 'investigation', actionText }])
  }
}

for (const value of [...PHRASES, ...JUNK, 'Методично', 'тщательно', 'не торопясь', 'не спеша осматриваю', 'кажд ую доску', 'каждый угол', 'каждую половицу', 'пядь за пядью', 'сантиметр за сантиметром', 'перебираю всё', 'перебирая все']) {
  c.call('isThoroughSearch', M.isThoroughSearch, [value])
}
for (const outcome of [undefined, null, {}, { found: true }, { found: false }, { found: 1 }, 'x']) {
  for (const name of [undefined, null, '', 'Нова', 'Очень длинное имя героя, которое заметно превышает восемьдесят знаков и обрезается ровно на них', 0, 7]) {
    c.call('thoroughSearchDetail', M.thoroughSearchDetail, [outcome, name])
  }
}

const SECRET_INPUTS = [
  [], [{}], null, 'x', 5, [{ clue: 'Короткая', topic: 't', skills: ['perception'] }],
  [{ clue: 'На футляре свежая царапина от ножа: его уже вскрывали этой ночью.', topic: 'футляр карта', skills: ['Investigation', 'sleight-of-hand', 'animal handling', 'perception', 'perception', 'insight', 'history'], holder: 'Клара' }],
  [{ clue: '  Длинная   заготовка\nс переносами и  пробелами.  ', topic: 7, skills: 'perception', holder: null }],
  [null, 'строка', ['массив'], { clue: 'Ещё одна достаточно длинная находка.', skills: [null, 1, 'NATURE', ' survival '] }],
]
for (const value of SECRET_INPUTS) {
  for (const limit of [undefined, 0, 1, 3, 4, -2]) c.call('normalizeGmSecrets', (input, max) => M.normalizeGmSecrets(input, max === undefined ? {} : { limit: max }), [value, limit])
}
for (let index = 0; index < 80; index += 1) {
  const secrets = Array.from({ length: random.int(0, 7) }, () => ({
    clue: random.pick(['Под половицей тайник с письмами.', 'коротко', random.pick(DETAILS), 'Следы ведут к старой мельнице за рекой.']),
    topic: random.pick(['мельница следы', '', undefined, 5]),
    skills: random.some(SKILLS, 5),
    holder: random.pick(['', 'Мара', undefined, null]),
  }))
  const limit = random.int(0, 6)
  c.call('normalizeGmSecrets', (input, max) => M.normalizeGmSecrets(input, { limit: max }), [secrets, limit])
}
for (let index = 0; index < 120; index += 1) {
  const secret = {
    clue: random.pick(['Под половицей тайник с письмами.', 'Ключ спрятан в бочке', '']),
    topic: random.pick(['тайник', 'бочка', '', undefined, 3]),
    skills: random.some(['investigation', 'sleight_of_hand', 'perception', 'animal_handling'], 3),
    holder: random.pick(['', 'Мара', undefined]),
  }
  c.call('gmSecretFact', M.gmSecretFact, [secret, {
    subjectId: random.pick(['location:x', undefined, 'npc:1']), salt: random.pick(['opening', 'scene:2', undefined, 7]), index: random.int(0, 4),
    ...(random.chance(0.5) ? { sourceCommandId: random.pick(['cmd', '', null]) } : {}),
    ...(random.chance(0.5) ? { recordedAtMinutes: random.pick([0, 15, null, '30']) } : {}),
  }])
}
for (const value of [undefined, null, '', 'не json', '{}', '[]', '"x"', '5', 'null', '{"topic":"т","skills":["a_b","",null,"c"],"holder":"  Мара  Вельм ","hero_id":"hero"}',
  '{"skills":"x"}', '{"topic":{"a":1}}', ' {"topic":"пробел"} ', '{"topic":"дубль","topic":"второй"}', 5, {}, ['a']]) {
  c.call('parseGmSecretObject', M.parseGmSecretObject, [value])
}
for (const value of [...JUNK, 'success', 'abandoned', 'failure']) c.call('questStatusForOutcome', M.questStatusForOutcome, [value])

// Подтверждения продвижения поручения.
for (let index = 0; index < 400; index += 1) {
  const entities = ['parcel', 'witness', 'place']
  const quests = Array.from({ length: random.int(1, 3) }, (_, number) => ({
    id: number === 0 ? 'supplies' : random.pick(['supplies', 'q2', 5, undefined]), status: number === 0 && random.chance(0.7) ? 'active' : random.pick(['active', 'active', 'active', 'offered', 'completed']),
    entity_ids: random.chance(0.9) ? ['parcel', ...random.some(entities, 2)] : 'parcel',
    ...(random.chance(0.4) ? { progress_fact_ids: random.some(['clue', 'clue2', 'clue3'], 2) } : {}),
    ...(random.chance(0.4) ? { progress_source_event_ids: random.some(['source-check', 'other'], 2) } : {}),
    _n: number,
  }))
  const facts = Array.from({ length: random.int(1, 7) }, (_, number) => ({
    id: random.pick(['clue', 'clue2', 'clue3', `f${number}`, '']), subject_id: random.chance(0.6) ? 'parcel' : random.pick([...entities, 5]),
    predicate: random.pick(['discovery', 'discovery', 'quest_progress', 'note']), status: random.pick(['active', 'active', 'superseded', undefined]),
    source_event_ids: random.pick([['source-check'], ['other', 'source-check'], ['fresh'], ['fresh', 'other'], [], 'source-check', undefined]),
  }))
  const state = {
    worldMemory: { quests, facts },
    ...(random.chance(0.3) ? { autonomy: { director_history: random.some([
      { intent: { type: 'advance_quest_clock', quest_id: 'supplies' } },
      { type: 'advance_quest_clock', quest_id: 'supplies' },
      { intent: { type: 'advance_quest_clock', quest_id: 'supplies' }, proof_fact_ids: ['clue'] },
      { intent: { type: 'advance_quest_clock', quest_id: 5 } },
    ], 3) } } : {}),
  }
  const questId = random.pick(['supplies', 'supplies', 'supplies', 'q2', '5', 'undefined', 'missing'])
  const include = random.chance(0.4)
  c.call('questProgressEvidenceFor', (s, id, consumed) => M.questProgressEvidenceFor(s, id, { includeConsumed: consumed }), [state, questId, include])
}

write('world-memory-discovery.json', {
  constants: {
    DISCOVERY_SKILLS: [...M.DISCOVERY_SKILLS], GM_SECRET_SKILLS: [...M.GM_SECRET_SKILLS], THOROUGH_SEARCH_MINUTES: M.THOROUGH_SEARCH_MINUTES,
    WORLD_MEMORY_COMMAND_TYPES: [...M.WORLD_MEMORY_COMMAND_TYPES], CLOSED_QUEST_STATUSES: [...M.CLOSED_QUEST_STATUSES],
    QUEST_ABANDONMENT_NEXT_OBJECTIVE: M.QUEST_ABANDONMENT_NEXT_OBJECTIVE,
  },
  states: states.length,
  cases: c.cases, values: c.values, skipped: c.skipped,
})
