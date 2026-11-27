import '../../../fixtures-env.mjs'
// Эталоны `server/npc-social.mjs` для Rust-переноса (`sk-social`).
//
// Три источника состояний:
// - случайные социальные состояния, в том числе мусор старых сохранений
//   (`JUNK`, неверные расписания, запасы, досье, отношения с ключами-индексами);
// - случайные миры для границы знания: места, жители, факты отряда, тайны
//   ведущего, прибытия и пролог;
// - сцены из тестов (`test/npc-social.test.mjs`, `test/npc-knowledge-leads.test.mjs`,
//   `test/npc-retention.test.mjs`), прогнанные настоящим движком.
// Каждое состояние проходит через все экспортируемые функции; цепочки событий
// идут через `applyNpcSocialEvent` шаг за шагом в режимах `current` и `legacy`.
//
// Запуск: node rust/crates/sk-social/fixtures/gen-npc-social.mjs
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const S = await import(server('npc-social'))
const { withRetentionMode } = await import(server('retention-context'))
const { normalizeCampaignState, resolveCommand, applyGameEvent } = await import(server('rules-engine'))
const { DiceService, SequenceDiceRng } = await import(server('dice-service'))

const R = rng(20261014)
const C = collector()
const pick = R.pick
const chance = R.chance

const dice = (values = []) => new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let n = 0; return () => `roll-${++n}` })(), now: () => '2026-07-26T12:00:00.000Z' })

// ── Пулы ────────────────────────────────────────────────────────────────────

const NPC_IDS = ['marta', 'npc:mira', 'npc:orin', 'npc:bors', 'npc:helga', 'merchant-1', '5', '12', ' marta ', 'Ｍarta', 'npc bad', '', 'z1', `n${'x'.repeat(125)}`, 'npc:ёж']
const HERO_IDS = ['hero', 'rogue', 'wizard', 'hero:1', '3', ' hero ', '', 'fighter']
const NAMES = ['Marta', 'Мира', 'Орин', 'Борс', 'Хельга', 'Марен', '', ' ', 'Ольга  Петровна', 'Ｂorin']
const ROLES = ['merchant', 'хозяйка трактира', 'архивариус', 'купец', 'писарь', 'рыбачка', 'смотритель маяка', 'страж', '', 'учёный летописец', 'торговец лавки']
const LOCATIONS = ['Market Square', 'market square', '  Market   Square ', 'Docks', 'Трактир «Пустой кубок»', 'Таверна «Сеть»', 'Пирс Серого Причала', 'Старый маяк', 'Ёлочный двор', 'Елочный двор', '']
const LOCATION_IDS = ['loc:tavern', 'loc:pier', 'loc:market', 'loc:lighthouse', 'loc:yard', '', ' loc:pier ']
const VOICES = ['Говорит быстро, с прибаутками.', 'Медленно, с паузами.', 'Коротко и лаконично.', 'Brief and direct.', 'Басит, отвечает коротко.', 'Торопливо, скороговоркой', 'жаргон докеров', 'книжно, как архив', '', 'Тихий, медленный.']
const GOALS = ['Защитить жителей и сохранить порядок', 'Узнать, кто пугает поставщиков', 'Продать сведения с максимальной выгодой', 'Сохранить тайну семьи', 'Find the hidden crown', 'Никому не говорить', 'Разобраться в долгах', '', '  ', 'Обмен золота']
const BELIEFS = ['The duke is a traitor', 'Каждый договор должен быть взаимным', 'Скрытое лучше молчания', 'Стража продажна']
const TAGS = ['merchant', 'скупщик', 'неподкупный', 'faction:guild', 'faction:watch', 'trader', '', ' tag ', 'x'.repeat(70)]
const VISIBILITIES = ['public', 'party', 'gm_only', 'specific_player', 'bad', undefined, null]
const STANCES = ['friendly', 'neutral', 'guarded', 'hostile', 'angry', undefined]
const SKILLS = ['persuasion', 'deception', 'intimidation', 'insight', 'stealth', '', ' persuasion ']
const DEGREES = ['strong_success', 'success', 'failure', 'severe_failure', 'meh', undefined]
const HINTS = [
  'через 2 часа', 'in 3 days', 'завтра', 'tomorrow', 'next day', 'tonight', 'сегодня вечером', 'Сегодня', 'скоро', 'soon', 'через 15 минут',
  'через 1 день', 'через 999 дней', '5 min', '12hr', 'in 0 hours', 'after the ledger arrives', 'до рассвета', 'через 3 недели', 'In 2 Hours',
  'ЗАВТРА', 'через 100 минуту', 'sooner', 'нескоро', 'через 91 час', 'in 7 minutes', '30мин', 'через  4   дня', 'день', 'After the ledger is delivered.',
  'after finding it', '1234 hours', 'Через 2 Часа', 'через 2 ч',
]
const MESSAGES = ['Can you help us?', 'Что говорят о герцоге?', 'Bring me the ledger and I will help.', 'Под восточной башней есть запечатанный архив.', '', '  ', 'Да', 'Нет']
const LONG = 'Длинная  реплика '.repeat(70)

const junk = () => pick(JUNK)
const maybe = (p, make) => (chance(p) ? make() : undefined)
const listOf = (make, max) => Array.from({ length: R.int(0, max) }, make)
const sometimesJunk = (make, p = 0.12) => (chance(p) ? junk() : make())

function scheduleEntry() {
  const start = pick([0, 60, 480, 540, 700, 1_020, 1_439, 1_440, -5, '540', 2.5, null])
  const end = pick([60, 720, 800, 1_020, 1_140, 1_440, 1_441, 30, '1020', undefined])
  return sometimesJunk(() => ({
    id: pick(['market-hours', 'private-errand', 'morning', 'overlap', 'night', 'bad id', '', 'a'.repeat(121), '9x']),
    days: pick([[], [0], [0, 1, 2, 3, 4], [6, 6, 2], [7], ['3', 1.5, -0, true, null], 'mon', undefined]),
    start_minute: start,
    end_minute: end,
    location: pick(LOCATIONS),
    available: pick([true, false, undefined, 0]),
    summary: pick(['Open market hours.', 'PRIVATE_ARCHIVE_ROUTE', '', undefined]),
    visibility: pick(VISIBILITIES),
  }))
}

function inventoryEntry() {
  return sometimesJunk(() => ({
    id: pick(['map', 'ledger', 'coin', 'bad id', '', 'map']),
    name: pick(['Town map', 'SECRET_LEDGER', 'Coin', '', ' ']),
    quantity: pick([0, 1, 2, -1, 9_999, 10_000, '3', 1.5, null]),
    description: pick(['A public route map.', 'PRIVATE_DEBT_LIST', undefined]),
    visibility: pick(VISIBILITIES),
  }))
}

function dossierEntry() {
  return sometimesJunk(() => ({
    id: pick(['dossier:1', 'dossier:2', 'interaction:conversation:one', '', 'dossier:1']),
    hero_id: pick(HERO_IDS),
    summary: pick(['Запись', 'Герой сказал: «Привет».', '', '  длинная   запись  ']),
    stance: pick(STANCES),
    visibility: pick(VISIBILITIES),
    disclosed_fact_ids: maybe(0.6, () => listOf(() => pick(['fact:route', 'fact:a', '', 'fact:a']), 4)),
    disclosed_claims: maybe(0.6, () => listOf(() => pick([{ id: 'claim:1' }, { id: '' }, null, 'claim:x', { id: 'claim:2', truth_status: 'verified' }]), 4)),
    provenance: maybe(0.9, () => ({
      source_conversation_id: pick(['conversation:one', 'conversation:dossier:1', '', undefined]),
      source_event_ids: maybe(0.8, () => listOf(() => pick(['event:1', 'event:2', '', null]), 10)),
    })),
  }))
}

function speechProfile() {
  return pick([
    undefined, null, 'быстро', [],
    { pace: 'быстро, короткими фразами', lexicon: 'торговые термины', mannerism: 'перед ценой говорит «счёт любит точность»' },
    { pace: 'быстро' },
    { pace: '', lexicon: '  ', mannerism: 'кивает' },
    { pace: 'x'.repeat(150), lexicon: 'y'.repeat(200), mannerism: 'z'.repeat(200) },
  ])
}

function profile(ids = NPC_IDS) {
  return sometimesJunk(() => {
    const npc = {
      id: pick(ids),
      name: pick(NAMES),
      role: pick(ROLES),
      location: pick(LOCATIONS),
      public_summary: pick(['A careful trader.', 'Держит трактир двадцать лет.', '', undefined]),
      voice: pick(VOICES),
      goals: maybe(0.7, () => sometimesJunk(() => listOf(() => pick(GOALS), 14), 0.1)),
      beliefs: maybe(0.5, () => listOf(() => pick(BELIEFS), 3)),
      known_fact_ids: maybe(0.6, () => listOf(() => pick(['fact:opening', 'fact:route', 'fact:secret:owner', 'fact:found-mark', '', 'fact:route']), 5)),
      visibility: pick(VISIBILITIES),
      available: pick([true, false, undefined, 'no']),
      tags: maybe(0.6, () => listOf(() => pick(TAGS), 5)),
    }
    if (chance(0.3)) npc.location_id = pick(LOCATION_IDS)
    if (chance(0.1)) npc.locationId = pick(LOCATION_IDS)
    if (chance(0.3)) npc.speech_profile = speechProfile()
    if (chance(0.3)) npc.social_dcs = pick([{ persuasion: 14, deception: '40', insight: 2.5, intimidation: -3, bogus: 10 }, { insight: 30 }, 'dc', [12], { persuasion: null }])
    if (chance(0.2)) npc.reveal_on_presence = pick([true, 'yes', false])
    if (chance(0.5)) npc.schedule = sometimesJunk(() => listOf(scheduleEntry, 5), 0.1)
    if (chance(0.4)) npc.inventory = sometimesJunk(() => listOf(inventoryEntry, 5), 0.1)
    if (chance(0.4)) npc.dossier = sometimesJunk(() => listOf(dossierEntry, 6), 0.1)
    return npc
  }, 0.08)
}

function socialCheck() {
  return pick([
    undefined, null, 'check',
    { check_id: 'social-check:abc', npc_id: pick(NPC_IDS), skill: pick(SKILLS), ability: pick(['cha', 'wis', 'charisma!']), roll_id: 'roll-1', total: pick([14, 120, -60, '7', 2.5]), modifier: pick([4, 40, -40, null]), success: pick([true, false, 'true']), degree: pick(DEGREES) },
  ])
}

function conversation(npcIds = NPC_IDS) {
  return sometimesJunk(() => ({
    id: pick(['conversation:one', 'conversation:two', 'conv-1', '', 'conversation:one', `conversation:${R.int(1, 9)}`]),
    npc_id: pick(npcIds),
    hero_id: pick(HERO_IDS),
    player_message: chance(0.03) ? LONG : pick(MESSAGES),
    npc_reply: chance(0.03) ? LONG : pick(MESSAGES),
    stance: pick(STANCES),
    disclosed_fact_ids: maybe(0.6, () => listOf(() => pick(['fact:route', 'fact:a', '']), 3)),
    disclosed_claim_ids: maybe(0.6, () => listOf(() => pick(['claim:1', 'rumor:marta-key', '']), 3)),
    visibility: pick(VISIBILITIES),
    check: maybe(0.3, socialCheck),
  }), 0.06)
}

function promise(npcIds = NPC_IDS) {
  return sometimesJunk(() => ({
    id: pick(['promise:one', 'promise:two', 'promise:deadline', '', 'promise:one']),
    npc_id: pick(npcIds),
    hero_id: pick(HERO_IDS),
    direction: pick(['npc_to_party', 'party_to_npc', 'sideways', undefined]),
    text: pick(['Marta will help.', 'Обещание', '', undefined]),
    due_hint: pick(HINTS),
    status: pick(['open', 'fulfilled', 'broken', 'cancelled', 'maybe', undefined]),
    visibility: pick(VISIBILITIES),
    source_conversation_id: pick(['', 'conversation:one', 'conv-1', 'conversation:missing', undefined]),
    created_at_minutes: pick([0, 30, -5, '60', 1.5, undefined]),
    deadline_minutes: pick([null, 120, 1_440, -3, '200', 2.5, undefined, 2 ** 60]),
    resolved_at_minutes: pick([null, 60, undefined, '5']),
    resolution_reason: pick(['manual', 'deadline', 'magic', null, undefined]),
    consequence_delta: pick([0, 8, -15, 30, -40, '4', undefined]),
  }), 0.06)
}

function relationships(npcIds = NPC_IDS) {
  const result = {}
  for (const id of listOf(() => pick([...npcIds, 'unknown', '7']), 6)) {
    result[id] = sometimesJunk(() => {
      const heroes = {}
      for (const hero of listOf(() => pick([...HERO_IDS, '10', '2']), 4)) heroes[hero] = pick([0, 3, -4, 19, 20, -20, 49, 50, -50, 150, -150, '12', 2.5, null, 'abc'])
      return heroes
    }, 0.1)
  }
  return chance(0.05) ? pick([[{ hero: 1 }], 'marta', 5, null]) : result
}

function socialState(npcIds = NPC_IDS) {
  return sometimesJunk(() => ({
    schema_version: pick([4, 3, undefined]),
    npcs: sometimesJunk(() => listOf(() => profile(npcIds), 4), 0.05),
    relationships: relationships(npcIds),
    conversations: sometimesJunk(() => listOf(() => conversation(npcIds), 6), 0.05),
    promises: sometimesJunk(() => listOf(() => promise(npcIds), 4), 0.05),
  }), 0.04)
}

function worldTime() {
  return pick([
    undefined, {}, { elapsed_minutes: 600 }, { elapsed_minutes: 1_050 }, { elapsed_minutes: '120' }, { elapsed_minutes: -5 },
    { elapsed_minutes: 2.5, amount: 3, unit: 'hours' }, { amount: 2, unit: 'час' }, { amount: 1.5, unit: 'Часа' }, { amount: 3, unit: 'дней' },
    { amount: 2, unit: 'day' }, { amount: 45, unit: 'minute' }, { amount: -3, unit: 'hour' }, { amount: 'abc' }, { amount: 'Infinity', unit: 'day' },
    { elapsed_minutes: 10_079 }, { elapsed_minutes: 1_440 * 6 + 500 }, { elapsed_minutes: null, amount: 7 }, 'noon', 12,
  ])
}

// ── Миры для границы знания ─────────────────────────────────────────────────

const PLACES = [
  { id: 'loc:tavern', name: 'Таверна «Сеть»' },
  { id: 'loc:pier', name: 'Пирс Серого Причала' },
  { id: 'loc:market', name: 'Market Square' },
  { id: 'loc:lighthouse', name: 'Старый маяк' },
  { id: 'loc:yard', name: 'Ёлочный двор' },
]
const KNOW_NPCS = [
  { id: 'npc:bors', name: 'Борс', role: 'трактирщик', public_summary: 'Держит таверну у воды и знает баркасы.' },
  { id: 'npc:helga', name: 'Хельга', role: 'рыбачка', public_summary: 'Чинит сети на пирсе, видела тайник.' },
  { id: 'npc:maren', name: 'Марен', role: 'смотритель маяка', public_summary: 'Живёт на маяке один.' },
  { id: 'marta', name: 'Marta', role: 'merchant', public_summary: 'A careful trader of maps.' },
  { id: 'npc:elka', name: 'Елена', role: 'сторож двора', public_summary: 'Сторожит ёлочный двор.' },
]

function knowledgeWorld() {
  const placeOf = () => pick(PLACES)
  const entities = [
    ...PLACES.filter(() => chance(0.85)).map((place) => ({ id: place.id, kind: 'location', name: chance(0.95) ? place.name : '', summary: '', aliases: [], visibility: 'party', tags: [] })),
    ...KNOW_NPCS.filter(() => chance(0.4)).map((npc) => ({ id: chance(0.8) ? npc.id : `entity:${npc.id}`, kind: 'npc', name: chance(0.9) ? npc.name : npc.name.toUpperCase(), summary: npc.public_summary, visibility: pick(['party', 'public', 'gm_only']), tags: chance(0.3) ? ['faction:guild'] : [] })),
  ]
  if (chance(0.1)) entities.push(null, 'entity', { kind: 'location', id: 'loc:x' })
  const facts = []
  let minute = 0
  const factCount = R.int(0, 12)
  for (let index = 0; index < factCount; index += 1) {
    minute += pick([0, 5, 10, 30, 600])
    const place = placeOf()
    const predicate = pick(['opening_narration', 'party_arrived', 'discovery', 'knows', 'gm_secret', 'gm_secret', 'rumor'])
    const npcSubject = chance(0.2) ? pick(KNOW_NPCS).id : null
    const fact = {
      id: pick([`fact:${index}`, `fact:${index}`, 'fact:found-mark', `fact:secret:${place.id}`, `fact:secret:scenario:${index}`, '']),
      subject_id: npcSubject ?? (chance(0.9) ? place.id : 'loc:nowhere'),
      predicate,
      object: predicate === 'gm_secret'
        ? pick([
          JSON.stringify({ topic: pick(['тайник под пирсом', 'чей баркас «Чайка»', 'пропавшая сестра Ила', 'карты рынка']), holder: pick(['', 'Борс', 'Хельга', 'борс', 'Unknown']), hero_id: pick(['', 'wizard']) }),
          '{bad json', '', JSON.stringify('строка'), JSON.stringify(null), JSON.stringify([1]),
        ])
        : pick(['clue', 'Пролог', '']),
      summary: pick(['Под настилом пирса спрятан ящик с сетями чужаков.', 'Баркас пришёл пустой на рассвете.', 'Отряд на месте.', 'Карты рынка ведёт торговец.', undefined]),
      visibility: predicate === 'gm_secret' ? pick(['gm_only', 'gm_only', 'party']) : pick(['party', 'party', 'public', 'gm_only']),
      status: pick(['active', 'active', 'active', 'superseded']),
      source_event_ids: [],
      recorded_at_minutes: pick([minute, minute, '30', -5, 2.5, undefined]),
    }
    if (chance(0.15) && facts.length) fact.supersedes_fact_id = pick(facts).id
    facts.push(fact)
  }
  if (chance(0.08)) facts.push(null, 'fact')
  const npcs = KNOW_NPCS.filter(() => chance(0.75)).map((npc) => {
    const place = placeOf()
    const entry = {
      ...npc,
      location: pick([place.name, place.name.toUpperCase(), place.name.replace('Ё', 'Е'), '', 'Market Square']),
      visibility: pick(['party', 'party', 'public', 'gm_only']),
      available: chance(0.9),
      known_fact_ids: listOf(() => pick(facts)?.id ?? 'fact:none', 2),
    }
    if (chance(0.3)) entry.location_id = pick([place.id, 'loc:pier', ''])
    if (chance(0.25)) {
      entry.schedule = [{ id: 'shift', days: pick([[], [0], [1, 2]]), start_minute: pick([0, 20, 480]), end_minute: pick([60, 600, 1_440]), location: pick(PLACES).name, available: chance(0.8), visibility: pick(['party', 'gm_only']) }]
    }
    return entry
  })
  const claims = [
    { id: 'rumor:marta-key', kind: 'rumor', holder_entity_id: 'marta', claim: 'The key is in the market.' },
    { id: 'belief:other', kind: 'belief', holder_entity_id: 'npc:other', claim: 'Another private belief.' },
    { id: 'rumor:bors', kind: 'rumor', holder_entity_id: 'npc:bors', claim: 'Баркас чужой.' },
  ]
  return {
    sessionCode: pick(['GREY-PIER', 'NPC-SOCIAL', 'S']),
    partyMemberIds: pick([['wizard', 'fighter'], ['hero', 'rogue'], ['hero', 'wizard', 3], undefined]),
    scene: { title: 'Сцена', location: pick([...PLACES.map((place) => place.name), 'Market Square', '', 'market square']) },
    mechanics: { world_time: pick([{ elapsed_minutes: minute }, { elapsed_minutes: R.int(0, 2_000) }, undefined]), combat: { active: chance(0.1) } },
    worldMemory: { entities, facts, epistemic_claims: chance(0.7) ? claims : [] },
    social: { npcs, relationships: {}, conversations: [], promises: [] },
    merchants: chance(0.3) ? [{ id: 'marta', name: 'Marta', location: 'Market Square', available: chance(0.8), title: pick(['', 'Картограф']), greeting: 'Здравствуйте' }] : [],
    ...(chance(0.15) ? { npc_world: { vitals: { 'npc:helga': pick([{ hp: 0, max_hp: 4, alive: false }, { hp: null }, { hp: 3, alive: true }]) } } } : {}),
  }
}

// ── Сцены из тестов ─────────────────────────────────────────────────────────

function marketCampaign() {
  return normalizeCampaignState({
    sessionCode: 'NPC-SOCIAL',
    activePlayerId: 'hero',
    partyMemberIds: ['hero', 'rogue'],
    scene: { title: 'Market', location: 'Market Square', cells: [] },
    players: [
      { id: 'hero', character: 'Ada', hp: 10, maxHp: 10, abilities: { cha: 14, wis: 12 }, proficiency: 2, inventory: [] },
      { id: 'rogue', character: 'Ren', hp: 10, maxHp: 10, abilities: { cha: 8, wis: 14 }, proficiency: 2, inventory: [] },
    ],
    merchants: [{ id: 'marta', name: 'Marta', location: 'Market Square', available: true, stock: [] }],
    social: {
      npcs: [{
        id: 'marta', name: 'Marta', role: 'merchant', location: 'Market Square',
        public_summary: 'A careful trader.', voice: 'Brief and direct.',
        goals: ['Find the hidden crown'], beliefs: ['The duke is a traitor'],
        known_fact_ids: [], visibility: 'party', available: true,
      }],
      relationships: { marta: { hero: 3, rogue: -4 } },
      conversations: [],
      promises: [],
    },
  })
}

function greyPier() {
  return {
    sessionCode: 'GREY-PIER',
    partyMemberIds: ['wizard', 'fighter'],
    scene: { title: 'Таверна «Сеть»', location: 'Таверна «Сеть»' },
    mechanics: { world_time: { elapsed_minutes: 60 }, combat: { active: false } },
    worldMemory: {
      entities: [
        { id: 'loc:tavern', kind: 'location', name: 'Таверна «Сеть»', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'loc:pier', kind: 'location', name: 'Пирс Серого Причала', summary: '', aliases: [], visibility: 'party', tags: [] },
        { id: 'loc:lighthouse', kind: 'location', name: 'Старый маяк', summary: '', aliases: [], visibility: 'party', tags: [] },
      ],
      facts: [
        { id: 'fact:opening', subject_id: 'loc:tavern', predicate: 'opening_narration', object: 'Пролог', summary: 'В таверне «Сеть» пахнет рыбой и дымом.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 0 },
        { id: 'fact:arrive-pier', subject_id: 'loc:pier', predicate: 'party_arrived', object: 'Пирс', summary: 'Отряд на пирсе.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 20 },
        { id: 'fact:found-mark', subject_id: 'loc:pier', predicate: 'discovery', object: 'clue', summary: 'На борту баркаса выжжен знак — рыба с тремя глазами.', visibility: 'party', status: 'active', source_event_ids: ['event:search'], recorded_at_minutes: 30 },
        { id: 'fact:arrive-tavern', subject_id: 'loc:tavern', predicate: 'party_arrived', object: 'Таверна', summary: 'Отряд вернулся в таверну.', visibility: 'party', status: 'active', source_event_ids: [], recorded_at_minutes: 50 },
        {
          id: 'fact:secret:owner', subject_id: 'loc:tavern', predicate: 'gm_secret',
          object: JSON.stringify({ topic: 'чей баркас «Чайка»', skills: ['investigation', 'insight'], holder: 'Борс' }),
          summary: 'Баркас «Чайка» ушёл к маяку той ночью без огней, и правил им чужак.', visibility: 'gm_only', status: 'active', source_event_ids: [], recorded_at_minutes: 0,
        },
        {
          id: 'fact:secret:pier', subject_id: 'loc:pier', predicate: 'gm_secret',
          object: JSON.stringify({ topic: 'тайник под пирсом', skills: ['investigation'], holder: '' }),
          summary: 'Под настилом пирса спрятан ящик с сетями чужаков.', visibility: 'gm_only', status: 'active', source_event_ids: [], recorded_at_minutes: 0,
        },
      ],
      epistemic_claims: [],
    },
    social: {
      npcs: [
        { id: 'npc:bors', name: 'Борс', role: 'трактирщик', location: 'Таверна «Сеть»', public_summary: 'Держит таверну у воды.', voice: 'Басит, отвечает коротко.', visibility: 'party', available: true, known_fact_ids: ['fact:opening'] },
        { id: 'npc:helga', name: 'Хельга', role: 'рыбачка', location: 'Пирс Серого Причала', public_summary: 'Чинит сети на пирсе.', voice: 'Говорит быстро, ворчливо.', visibility: 'party', available: true, known_fact_ids: [] },
        { id: 'npc:maren', name: 'Марен', role: 'смотритель маяка', location: 'Старый маяк', public_summary: 'Живёт на маяке один.', voice: 'Тихий, медленный.', visibility: 'party', available: true, known_fact_ids: [] },
      ],
      relationships: {},
      conversations: [],
      promises: [],
    },
  }
}

/** Только поля, которые читают модули sk-social: состояние кампании без карты. */
function reduced(state) {
  const keep = ['sessionCode', 'partyMemberIds', 'scene', 'merchants', 'worldMemory', 'social', 'npc_world', 'enemies', 'actors', 'worldMap', 'autonomy', 'law']
  const result = {}
  for (const key of keep) if (state?.[key] !== undefined) result[key] = state[key]
  if (result.scene) result.scene = { title: result.scene.title, location: result.scene.location, ...(result.scene.location_id ? { location_id: result.scene.location_id } : {}) }
  if (state?.mechanics) result.mechanics = { world_time: state.mechanics.world_time, combat: state.mechanics.combat ? { active: state.mechanics.combat.active } : undefined }
  return plain(result)
}

// ── Случаи ──────────────────────────────────────────────────────────────────

const constants = {
  NPC_DOSSIER_PROFILE_LIMIT: S.NPC_DOSSIER_PROFILE_LIMIT,
  NPC_NARRATOR_DOSSIER_LIMITS: S.NPC_NARRATOR_DOSSIER_LIMITS,
  NPC_SOCIAL_COMMAND_TYPES: [...S.NPC_SOCIAL_COMMAND_TYPES],
}

for (const value of [...JUNK, -50, -49, -20, -19, 19, 20, 49, 50, 100, 101, -101, '50', '-20.0']) C.call('relationshipTier', S.relationshipTier, [value])
for (const hint of [...HINTS, ...JUNK]) C.call('promiseDueOffsetMinutes', S.promiseDueOffsetMinutes, [hint])
for (let index = 0; index < 60; index += 1) C.call('campaignElapsedMinutes', S.campaignElapsedMinutes, [{ mechanics: { world_time: worldTime() } }])
for (const state of [undefined, {}, 'state', 5, { mechanics: 'x' }, { mechanics: { world_time: [] } }]) C.call('campaignElapsedMinutes', S.campaignElapsedMinutes, [state])

for (let index = 0; index < 250; index += 1) {
  const npc = profile()
  C.call('npcSpeechProfile', S.npcSpeechProfile, [npc])
  C.call('npcBehaviorPolicy', S.npcBehaviorPolicy, [npc, pick([undefined, 0, 25, -25, -10, -5, 20, '30', null, 'abc', [25], true])])
  const time = pick([pick([0, 600, 1_050, 1_440 * 3 + 600, -5, 2.5, 10_079]), { mechanics: { world_time: worldTime() } }, undefined, 'later'])
  C.call('npcScheduleEntryAt', S.npcScheduleEntryAt, [npc, time])
  const state = {
    mechanics: { world_time: worldTime(), combat: { active: chance(0.3) } },
    ...(chance(0.3) ? { npc_world: { vitals: pick([{ [npc?.id ?? 'x']: { hp: 0, alive: false } }, { [npc?.id ?? 'x']: { hp: null } }, { [npc?.id ?? 'x']: { hp: 2 } }, [], 'v']) } } : {}),
    ...(chance(0.3) ? { enemies: [{ id: 'e', origin: { npc_id: npc?.id } }, null], actors: [{ origin: { npc_id: 'other' } }] } : {}),
  }
  C.call('npcProfileAtWorldTime', S.npcProfileAtWorldTime, [npc, pick([state, time])])
  const viewer = pick([
    {}, { isAdmin: true }, { playerId: 'hero', isPartyMember: true, state }, { playerId: pick(HERO_IDS), isPartyMember: false, elapsed_minutes: pick([600, 1_050]) },
    { playerId: 'hero', state: { mechanics: { world_time: { elapsed_minutes: 1_050 } } } }, undefined,
  ])
  C.call('npcProfileForViewerAt', S.npcProfileForViewerAt, [npc, viewer])
}

const VIEWERS = [
  undefined, {}, { isAdmin: true }, { isAdmin: 1 },
  { playerId: 'hero', isPartyMember: true }, { playerId: 'rogue', isPartyMember: true }, { playerId: 'hero', isPartyMember: false },
  { playerId: ' hero ', state: { scene: { location: 'Market Square' }, mechanics: { world_time: { elapsed_minutes: 600 } } } },
  { playerId: '3', state: { scene: { location_id: 'loc:pier', location: 'Docks' } } },
  { playerId: 'hero:1', state: { scene: { locationId: 'loc:market' }, mechanics: { world_time: { elapsed_minutes: 1_050 } } } },
]

const legacyNormalize = (input) => withRetentionMode('legacy', () => S.normalizeNpcSocialState(input))
const legacyEnsure = (input, state) => withRetentionMode('legacy', () => S.ensureNpcSocialState(input, state))

for (let index = 0; index < 200; index += 1) {
  const social = socialState()
  C.call('normalizeNpcSocialState', S.normalizeNpcSocialState, [social])
  if (index % 3 === 0) C.call('normalizeNpcSocialState', S.normalizeNpcSocialState, [social, pick([{ isLegacy: true }, { retention: 'legacy' }, { retention: 'current' }, { isLegacy: false, retention: 'legacy' }, null, 'legacy'])])
  if (index % 4 === 0) C.call('normalizeNpcSocialState@legacy', legacyNormalize, [social])
  if (index % 5 === 0) C.call('normalizeNpcSocialStateLegacy', S.normalizeNpcSocialStateLegacy, [social])
  const state = {
    merchants: pick([undefined, [], 'shop', [{ id: 'marta', name: 'Marta', location: 'Docks', available: false, title: 'Картограф', description: 'Торгует картами.', voice: '', greeting: 'Добро пожаловать!' }], [{ id: 'merchant-1', name: 'Борин' }, 'x', { id: '', name: 'Без id' }], [{ id: '5', name: 'Пятый', location: ' Market  Square ' }]]),
    worldMemory: pick([undefined, {}, { entities: [{ id: 'npc:orin', kind: 'npc', name: 'Орин', summary: 'Сверяет записи.', visibility: 'public', tags: ['faction:guild'] }, { id: 'marta', kind: 'npc', name: 'Marta' }, { id: ' npc:x', kind: 'npc', name: 'Икс', visibility: 'party' }, null, { id: 'loc', kind: 'location', name: 'Где-то' }] }]),
  }
  C.call('ensureNpcSocialState', S.ensureNpcSocialState, [social, state])
  if (index % 6 === 0) C.call('ensureNpcSocialState', S.ensureNpcSocialState, [social, state, { isLegacy: true }])
  if (index % 7 === 0) C.call('ensureNpcSocialState@legacy', legacyEnsure, [social, state])
  C.call('npcSocialForViewer', S.npcSocialForViewer, [social, pick(VIEWERS)])
}

// Удержание истории (test/npc-retention.test.mjs): 501 NPC, 501 разговор, 13 записей досье.
{
  const dossier = (index) => ({ id: `dossier:${index}`, hero_id: 'hero:1', summary: `Запись ${index}`, stance: 'neutral', visibility: 'party', disclosed_fact_ids: [], disclosed_claims: [], provenance: { source_kind: 'NpcConversationRecorded', source_conversation_id: `conversation:dossier:${index}`, source_event_ids: [`event:dossier:${index}`] } })
  const conversationOf = (index, npcId = 'npc:0') => ({ id: `conversation:${index}`, npc_id: npcId, hero_id: 'hero:1', player_message: `Вопрос ${index}`, npc_reply: `Ответ ${index}`, stance: 'neutral', disclosed_fact_ids: [], disclosed_claim_ids: [], visibility: 'party' })
  const promiseOf = (id, source) => ({ id, npc_id: 'npc:0', hero_id: 'hero:1', direction: 'npc_to_party', text: `Обещание ${id}`, due_hint: '', status: 'open', visibility: 'party', source_conversation_id: source })
  const rich = (index) => ({
    id: `npc:${index}`, name: `NPC ${index}`, location: 'Market',
    known_fact_ids: Array.from({ length: 101 }, (_, fact) => `fact:${fact}`),
    dossier: Array.from({ length: 13 }, (_, entry) => dossier(entry)),
    inventory: Array.from({ length: 101 }, (_, item) => ({ id: `item-${item}`, name: `Вещь ${item}`, quantity: 1 })),
  })
  // Много NPC — лёгкие: предел числа NPC и отношений; один — тяжёлый: пределы внутри профиля.
  const npcs = Array.from({ length: 501 }, (_, index) => (index === 0 || index === 500 ? rich(index) : { id: `npc:${index}`, name: `N${index}` }))
  const relationships = Object.fromEntries(npcs.map((npc) => [npc.id, { 'hero:1': 1 }]))
  relationships['npc:0'] = Object.fromEntries(Array.from({ length: 101 }, (_, hero) => [`hero:${hero}`, hero - 50]))
  const crowd = { npcs, relationships, promises: [promiseOf('promise:first', 'conversation:0')] }
  C.call('normalizeNpcSocialState', S.normalizeNpcSocialState, [crowd])
  C.call('normalizeNpcSocialStateLegacy', S.normalizeNpcSocialStateLegacy, [crowd])
  const talk = {
    npcs: [rich(0)],
    conversations: Array.from({ length: 501 }, (_, index) => conversationOf(index)),
    promises: [promiseOf('promise:first', 'conversation:0'), promiseOf('promise:last', 'conversation:500')],
  }
  C.call('normalizeNpcSocialState', S.normalizeNpcSocialState, [talk])
  C.call('normalizeNpcSocialStateLegacy', S.normalizeNpcSocialStateLegacy, [talk])
  C.call('normalizeNpcSocialState@legacy', legacyNormalize, [talk])
  C.call('npcSocialForViewer', S.npcSocialForViewer, [{ npcs: [rich(0)] }, { playerId: 'hero:1', isPartyMember: true }])
  let social = S.normalizeNpcSocialState({ npcs: [{ id: 'npc:0', name: 'NPC', location: 'Market' }] })
  for (let index = 0; index < 13; index += 1) {
    social = C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, [social, { event_type: 'NpcConversationRecorded', event_id: `event:conversation:${index}`, payload: { conversation: conversationOf(`added:${index}`) } }])
  }
  C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, [social, { event_type: 'NpcSocialProfileUpserted', payload: { npc: { id: 'npc:0', name: 'NPC', location: 'Market', known_fact_ids: Array.from({ length: 101 }, (_, index) => `fact:${index}`) } } }])
  const legacyApply = (input, event) => withRetentionMode('legacy', () => S.applyNpcSocialEvent(input, event))
  let legacySocial = S.normalizeNpcSocialStateLegacy({ npcs: [{ id: 'npc:0', name: 'NPC', location: 'Market' }] })
  for (let index = 0; index < 14; index += 1) {
    legacySocial = C.call('applyNpcSocialEvent@legacy', legacyApply, [legacySocial, { event_type: 'NpcConversationRecorded', event_id: `event:legacy:${index}`, payload: { conversation: conversationOf(`legacy:${index}`) } }])
  }
  // Предел журнала разговоров legacy-редьюсера: 500 последних.
  const full = S.normalizeNpcSocialState({ npcs: [{ id: 'npc:0', name: 'NPC' }], conversations: Array.from({ length: 500 }, (_, index) => conversationOf(index)) })
  C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, [full, { event_type: 'NpcConversationRecorded', event_id: 'event:overflow', payload: { conversation: conversationOf('overflow') } }, {}, { isLegacy: true }])
}

// ── Граница знания ──────────────────────────────────────────────────────────

const implicitEntries = (state, social) => [...S.implicitSecretHolderIds(state, social)]
const knownList = (state, npc) => [...S.npcKnownFactIds(state, npc)]
const implicitWithSocial = (state) => [...S.implicitSecretHolderIds(state, S.ensureNpcSocialState(state?.social, state))]

for (let index = 0; index < 130; index += 1) {
  const state = index === 0 ? greyPier() : knowledgeWorld()
  C.call('implicitSecretHolderIds', implicitEntries, [state])
  if (index % 4 === 0) C.call('implicitSecretHolderIds@social', implicitWithSocial, [state])
  for (const fact of (state.worldMemory.facts ?? []).slice(0, 3)) C.call('npcSecretMeta', S.npcSecretMeta, [fact])
  const npcs = [...(state.social.npcs ?? []), { id: '', name: 'Новый житель', location: pick(PLACES).name }, { name: 'Борс', location: 'Таверна «Сеть»', known_fact_ids: ['fact:extra', ''] }]
  for (const npc of npcs) {
    C.call('npcKnownFactIds', knownList, [state, npc])
    C.call('npcWitnessedFactIds', S.npcWitnessedFactIds, [state, npc])
  }
}
for (const fact of [undefined, null, {}, { object: '{"topic":" Тема ","holder":"Борс","hero_id":"wizard"}' }, { object: 5 }, { object: { topic: 'x' } }, { object: '[]' }, { object: ' {"holder": "  Хельга  "} ' }, { object: '{"topic":1e400}' },
  // `~` — обратная косая черта в JSON-тексте (escape-последовательности JSON).
  ...[
    '{"topic":-1e400,"holder":1e-400}', '{"topic":"a","topic":"b"}', '{"topic":[1,null,"x",[2,[3]]]}', '{"topic":{"a":1}}', '{"topic":true,"holder":false,"hero_id":null}',
    '{"topic":"~u0041~ud83d~ude00~n~/ ~u00e9"}', ' {"topic":1} x', '{"topic":01}', '{"topic":1.}', '{"topic":"a\tb"}', '{"topic":-0}', '{"topic":1e21,"holder":0.1}',
    '{"topic":123456789012345678901234567890}', '{"topic":"x",}', '[{"topic":"x"}]', '{"topic":"~x"}', '"{~"topic~":1}"', '{"holder":"  Борс  ","topic":"  "}', '\n\t{"topic":"ok"}\r\n',
    '{"holder":"~u0411~u043e~u0440~u0441","topic":"ok"', '{"topic" "x"}', '{"topic":nul}', '{"topic":"x"}{}', '{"hero_id":[]}', '{"holder":"~u0411~u043e~u0440~u0441"}',
  ].map((object) => ({ object: object.replaceAll('~', '\\') }))]) {
  C.call('npcSecretMeta', S.npcSecretMeta, [fact])
}

// ── Команды, события, редьюсер ──────────────────────────────────────────────

const CONTEXTS = [
  undefined, {}, { isAdmin: true }, { isDirector: true }, { isSocialController: true }, { isAdmin: 'yes' }, { isSocialController: true, isAdmin: false },
]

function upsertCommand(state) {
  const npc = profile(state.social?.npcs?.map((entry) => entry.id) ?? NPC_IDS)
  if (npc && typeof npc === 'object' && !Array.isArray(npc)) {
    if (chance(0.5)) {
      for (const key of ['schedule', 'inventory']) if (npc[key] && chance(0.6)) npc[key] = (Array.isArray(npc[key]) ? npc[key] : []).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      if (chance(0.5)) delete npc.locationId
      if (npc.speech_profile !== undefined && chance(0.5)) npc.speech_profile = { pace: 'быстро', lexicon: 'торговые слова', mannerism: 'кивает' }
      if (chance(0.4)) npc.id = pick(['marta', 'npc:new', 'npc:bors'])
      if (chance(0.4)) npc.name = pick(['Марта', 'Новенький'])
    }
    if (chance(0.1)) npc.secret_field = 'x'
    if (chance(0.1)) npc.known_fact_ids = Array.from({ length: 101 }, (_, index) => `fact:${index}`)
    if (chance(0.1)) npc.schedule = Array.from({ length: 65 }, (_, index) => ({ id: `s${index}`, days: [], start_minute: index, end_minute: index + 1, location: 'X' }))
    if (chance(0.1)) npc.dossier = [{ id: 'forged' }]
  }
  return { command_type: 'UpsertNpcSocialProfile', command_id: `cmd:${R.int(1, 99)}`, actor_id: 'hero', npc }
}

function recordCommand(state) {
  const npcIds = (state.social?.npcs ?? []).map((npc) => npc?.id).filter(Boolean)
  const facts = (state.worldMemory?.facts ?? []).map((fact) => fact?.id).filter(Boolean)
  const claims = (state.worldMemory?.epistemic_claims ?? []).map((claim) => claim.id)
  const conversation = {
    id: pick(['conversation:one', 'conversation:two', 'bad id', '', `conversation:${R.int(1, 50)}`]),
    npc_id: pick([...npcIds, ...npcIds, 'npc:ghost', '']),
    hero_id: pick([...(Array.isArray(state.partyMemberIds) ? state.partyMemberIds : ['hero']), 'stranger', '', undefined]),
    player_message: pick(['Can you help us?', 'Что за знак?', '', 'Помоги нам.']),
    npc_reply: pick(['Bring me the ledger and I will help.', 'Знак тот я видела.', '', 'Не могу.']),
    stance: pick(STANCES),
    disclosed_fact_ids: pick([[], [], [pick([...facts, 'fact:unknown'])], undefined, Array.from({ length: 21 }, () => 'f')]),
    disclosed_claim_ids: pick([[], undefined, [pick([...claims, 'claim:x'])]]),
    relationship_delta: pick([0, 1, 2, 5, -1, -9, '1', undefined]),
    visibility: pick(['party', 'specific_player', undefined]),
  }
  if (chance(0.5)) {
    conversation.promise = pick([
      { id: 'promise:one', direction: 'npc_to_party', text: 'Marta will provide help after receiving the ledger.', due_hint: pick(HINTS), visibility: pick(['party', 'specific_player']) },
      { id: 'promise:deadline', direction: 'party_to_npc', text: 'The hero will deliver the ledger.', due_hint: 'через 2 часа', visibility: 'specific_player' },
      { id: 'promise:bad', direction: 'sideways', text: 'x' },
      { id: 'promise:empty', direction: 'npc_to_party', text: '   ' },
      { id: 'bad id', direction: 'npc_to_party', text: 'x' },
      { id: 'promise:x', direction: 'npc_to_party', text: 'x', extra: 1 },
      null, 'promise',
    ])
  }
  let context = pick(CONTEXTS)
  if (chance(0.35)) {
    const npcId = chance(0.8) ? conversation.npc_id : 'npc:other'
    const outcome = { check_id: 'social-check:abc', npc_id: npcId, skill: pick(['persuasion', 'insight', 'deception', 'intimidation']), ability: 'cha', roll_id: 'roll-1', total: pick([7, 14, 22]), modifier: 4, success: chance(0.5), degree: pick(DEGREES) }
    context = { ...(context ?? {}), isSocialController: true, socialCheckOutcome: outcome }
    if (chance(0.7)) conversation.check = chance(0.8) ? { ...outcome } : { ...outcome, success: !outcome.success }
  } else if (chance(0.1)) {
    conversation.check = { check_id: 'forged', npc_id: conversation.npc_id, skill: 'deception', success: true }
  }
  if (chance(0.05)) conversation.forged = true
  return { command: { command_type: 'RecordNpcSocialTurn', command_id: `cmd:${R.int(1, 99)}`, actor_id: pick(['hero', 'wizard', undefined]), conversation: chance(0.04) ? 'conversation' : conversation }, context }
}

function resolveCommandFor(state) {
  const promises = (state.social?.promises ?? []).map((entry) => entry?.id).filter(Boolean)
  return {
    command_type: 'ResolveNpcPromise',
    command_id: `cmd:${R.int(1, 99)}`,
    promise_id: pick([...promises, ...promises, 'promise:none', 'bad id']),
    status: pick(['fulfilled', 'broken', 'cancelled', 'open', ' fulfilled ', '']),
  }
}

/** Шаги редьюсера: каждое событие — отдельный случай, выход идёт входом следующего. */
function applyChain(initialState, events, mode) {
  let state = plain(initialState)
  const apply = mode === 'legacy'
    ? (input, event, context) => withRetentionMode('legacy', () => S.applyNpcSocialEvent(input, event, context))
    : (input, event, context) => S.applyNpcSocialEvent(input, event, context)
  const name = mode === 'legacy' ? 'applyNpcSocialEvent@legacy' : 'applyNpcSocialEvent'
  for (const event of events) {
    // Редьюсер читает из состояния только торговцев и память мира.
    const context = { merchants: state.merchants, worldMemory: state.worldMemory }
    const next = C.call(name, apply, [state.social, event, context])
    if (next === undefined) break
    state = { ...state, social: plain(next) }
  }
  return state
}

function socialRound(baseState, rounds) {
  let state = plain(baseState)
  for (let round = 0; round < rounds; round += 1) {
    const kind = pick(['upsert', 'record', 'record', 'record', 'resolve', 'deadline', 'drafts'])
    let command
    let context
    if (kind === 'upsert') {
      command = upsertCommand(state)
      context = pick([{ isDirector: true }, { isAdmin: true }, {}, { isSocialController: true }])
    } else if (kind === 'record') {
      ({ command, context } = recordCommand(state))
    } else if (kind === 'resolve') {
      command = resolveCommandFor(state)
      context = pick([{ isDirector: true }, { isSocialController: true }, {}])
    } else if (kind === 'deadline') {
      const minutes = pick([0, 60, 120, 1_440, 10_000, -5, '30', undefined])
      const events = C.call('npcPromiseDeadlineEvents', S.npcPromiseDeadlineEvents, [state, minutes]) ?? []
      state = applyChain(state, plain(events).map((event, index) => ({ ...event, event_id: `event:deadline:${round}:${index}` })), chance(0.2) ? 'legacy' : 'current')
      continue
    } else {
      const npcIds = (state.social?.npcs ?? []).map((npc) => npc?.id)
      C.call('npcRelationshipEventDrafts', S.npcRelationshipEventDrafts, [state, pick([undefined, {}, { npcId: pick(npcIds) ?? 'marta', heroId: pick(HERO_IDS), delta: pick([5, -30, 0, '3', 1.5]), reason: pick(['letter', undefined, 'x'.repeat(100)]), promiseId: pick([undefined, 'promise:one']) }])])
      continue
    }
    const validated = C.call('validateNpcSocialCommand', S.validateNpcSocialCommand, [command, state, context], { expectThrow: true })
    if (!validated) continue
    const events = C.call('npcSocialEvents', S.npcSocialEvents, [validated, state]) ?? []
    C.call('npcConversationNarration', S.npcConversationNarration, [events, state])
    const stamped = plain(events).map((event, index) => ({ event_id: `event:${round}:${index}`, ...event }))
    state = applyChain(state, stamped, chance(0.2) ? 'legacy' : 'current')
  }
  return state
}

for (let index = 0; index < 64; index += 1) {
  const base = index % 3 === 0 ? reduced(marketCampaign()) : index % 3 === 1 ? greyPier() : knowledgeWorld()
  if (index % 3 !== 0 && chance(0.5)) {
    base.social.promises = [
      { id: 'promise:one', npc_id: base.social.npcs?.[0]?.id ?? 'npc:bors', hero_id: pick(base.partyMemberIds ?? ['hero']), direction: 'party_to_npc', text: 'Принесу карту.', due_hint: 'через 2 часа', status: 'open', visibility: 'specific_player', source_conversation_id: '', created_at_minutes: 0, deadline_minutes: pick([60, 120, 3_000]) },
      { id: 'promise:two', npc_id: base.social.npcs?.[0]?.id ?? 'npc:bors', hero_id: pick(base.partyMemberIds ?? ['hero']), direction: 'npc_to_party', text: 'Сохраню реестр.', due_hint: 'завтра', status: 'open', visibility: 'party', source_conversation_id: '', created_at_minutes: 0, deadline_minutes: pick([30, 120]) },
    ]
    base.social.relationships = { [base.social.npcs?.[0]?.id ?? 'npc:bors']: { [pick(base.partyMemberIds ?? ['hero'])]: pick([-10, 19, 50]) } }
  }
  socialRound(base, R.int(2, 9))
}

// Мусорные события и необычные входы редьюсера.
const EVENT_TYPES = ['NpcSocialProfileUpserted', 'NpcConversationRecorded', 'NpcRelationshipAdjusted', 'NpcRelationshipTierChanged', 'NpcPromiseRecorded', 'NpcPromiseResolved', 'TimeAdvanced', undefined]
for (let index = 0; index < 110; index += 1) {
  const social = socialState()
  const state = pick([undefined, {}, { merchants: [{ id: 'marta', name: 'Marta', location: 'Market Square' }] }, knowledgeWorld()])
  const events = Array.from({ length: R.int(1, 5) }, () => {
    const type = pick(EVENT_TYPES)
    const payload = pick([
      undefined, null, {},
      { npc: profile() },
      { conversation: conversation() },
      { npc_id: pick(NPC_IDS), hero_id: pick([...HERO_IDS, '10', '2']), delta: pick([1, -3, 40, -40, '5', 2.5, undefined]) },
      { promise: promise() },
      { promise_id: pick(['promise:one', 'promise:two', 'promise:deadline']), status: pick(['fulfilled', 'broken', 'bad', undefined]), resolved_at_minutes: pick([60, undefined, '7', -1]), resolution_reason: pick(['manual', 'deadline', 'x', undefined]), consequence_delta: pick([4, -15, 99, undefined]) },
    ])
    return { event_type: type, event_id: pick([`event:${index}`, undefined, '']), ...(payload === undefined ? {} : { payload }) }
  })
  let current = social
  const options = pick([undefined, { isLegacy: true }, { retention: 'current' }, null])
  for (const event of events) {
    const next = C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, options === undefined ? [current, event, state] : [current, event, state, options])
    if (next === undefined) break
    current = plain(next)
  }
}

// Настоящий движок: события с конвертом Rules Engine.
{
  const initial = marketCampaign()
  const result = resolveCommand({
    command_type: 'RecordNpcSocialTurn', actor_id: 'hero',
    conversation: {
      id: 'conversation:one', npc_id: 'marta', hero_id: 'hero', player_message: 'Can you help us?', npc_reply: 'Bring me the ledger and I will help.',
      stance: 'friendly', disclosed_fact_ids: [], relationship_delta: 1, visibility: 'party',
      promise: { id: 'promise:one', direction: 'npc_to_party', text: 'Marta will provide help after receiving the ledger.', due_hint: 'через 2 часа', visibility: 'party' },
    },
  }, initial, { diceService: dice(), context: { isSocialController: true } })
  let state = initial
  for (const event of result.events) {
    C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, [state.social, event, reduced(state)])
    state = applyGameEvent(state, event)
  }
  const deadline = resolveCommand({ command_type: 'AdvanceTime', amount: 120, unit: 'minute' }, state, { diceService: dice(), context: { isDirector: true } })
  for (const event of deadline.events) {
    if (!String(event.event_type).startsWith('Npc')) { state = applyGameEvent(state, event); continue }
    C.call('applyNpcSocialEvent', S.applyNpcSocialEvent, [state.social, event, reduced(state)])
    state = applyGameEvent(state, event)
  }
  C.call('npcSocialForViewer', S.npcSocialForViewer, [state.social, { playerId: 'hero', isPartyMember: true }])
  C.call('npcConversationNarration', S.npcConversationNarration, [result.events, reduced(state)])
}

// ── Досье для Рассказчика и реплика в ленту ────────────────────────────────

function dossierBrief() {
  const present = listOf(() => pick([
    { id: 'npc:marta', name: 'Марта', visibility: pick(['party', 'gm_only', undefined, 'npcPrivate']) },
    { id: 'npc:other', name: 'Орвин' }, { id: '', name: 'Без id' }, { id: 'npc:x' }, null, { id: 5, name: 'Число' },
  ]), 6)
  const interaction = () => sometimesJunk(() => ({
    id: pick(['interaction:1', 'interaction:2', '', undefined, 'interaction:1']),
    hero_id: pick(['hero:ada', 'hero:other', '']),
    hero: pick(['Ада', 'ада', 'Чужой', undefined]),
    summary: pick(['Разговор о реестре.', '', 'Разговор о реестре.', chance(0.1) ? 'x'.repeat(700) : 'Короткий']),
    stance: pick(['guarded', '', undefined, 'x'.repeat(50)]),
    visibility: pick(['party', 'specific_player', 'gm_only', 'gmOnly', undefined]),
    epistemic_status: pick(['contains_unverified_claims', 'verified', undefined]),
    disclosed_claims: maybe(0.5, () => listOf(() => pick([{ id: 'claim:1', truth_status: 'verified' }, { id: '' }, null]), 14)),
    provenance: maybe(0.8, () => ({ source_conversation_id: pick(['conversation:1', '', undefined]), source_event_ids: listOf(() => pick(['event:1', '', null]), 10) })),
  }), 0.05)
  const promiseEntry = () => sometimesJunk(() => ({
    id: pick(['promise:1', 'promise:2', '', 'promise:1']),
    direction: pick(['npc_to_party', '', undefined]),
    text: pick(['Сохранит реестр.', '', chance(0.1) ? 'y'.repeat(300) : 'Сохранит']),
    due_hint: pick(['до рассвета', undefined]),
    source_conversation_id: pick(['conversation:1', undefined]),
    visibility: pick(['party', 'specific_player', undefined]),
    hero_id: pick(['hero:ada', 'hero:other']),
  }), 0.05)
  return {
    known_environment: sometimesJunk(() => ({
      story_context: sometimesJunk(() => ({
        present_npcs: present,
        heroes: pick([[{ id: 'hero:ada', name: 'Ада', is_viewer: true }, { id: 'hero:other', name: 'Чужой', is_viewer: false }], [{ name: 'Ада', is_viewer: 1 }], undefined]),
        npc_dossiers: listOf(() => sometimesJunk(() => ({
          npc_id: pick(['npc:marta', 'npc:other', 'npc:none', 5, undefined]),
          name: 'Марта',
          visibility: pick(['party', 'specific_player', 'gm_only', undefined]),
          hero_id: pick(['hero:ada', undefined]),
          relationship: pick([undefined, { tier: 'friendly', provenance: { source_event_ids: ['event:relationship:1', '', 'event:2'] } }, { tier: '' }, { tier: 'neutral' }]),
          interactions: listOf(interaction, 7),
          promises: listOf(promiseEntry, 5),
        }), 0.05), 4),
      }), 0.05),
    }), 0.03),
  }
}

for (let index = 0; index < 120; index += 1) C.call('npcDossiersForNarrator', S.npcDossiersForNarrator, [dossierBrief()])
C.call('npcDossiersForNarrator', S.npcDossiersForNarrator, [undefined])
C.call('npcDossiersForNarrator', S.npcDossiersForNarrator, [{ known_environment: { story_context: 'story' } }])

for (let index = 0; index < 80; index += 1) {
  const conversationPayload = sometimesJunk(() => ({
    npc_id: pick(['marta', 'npc:mira', undefined, 5]),
    npc_reply: pick(['Слушаю.', '', 7, undefined, 'Под восточной башней есть запечатанный архив.']),
    check: pick([undefined, null, 'check', { skill: pick(['persuasion', 'deception', 'intimidation', 'insight', 'stealth', undefined, ['persuasion']]), success: pick([true, false, 1]), total: pick([14, undefined, 2.5, null]) }]),
  }), 0.05)
  const events = [
    ...(chance(0.3) ? [{ event_type: 'AbilityCheckResolved', payload: {} }] : []),
    ...(chance(0.9) ? [{ event_type: 'NpcConversationRecorded', payload: { conversation: conversationPayload } }] : []),
    ...(chance(0.2) ? [{ event_type: 'NpcConversationRecorded', payload: { conversation: { npc_reply: 'Второй.' } } }] : []),
  ]
  const state = pick([undefined, {}, { social: { npcs: [{ id: 'marta', name: 'Marta' }, { id: 'npc:mira', name: '  Мира  ' }, { id: 5, name: 'x'.repeat(90) }] } }, { social: { npcs: [] } }])
  C.call('npcConversationNarration', S.npcConversationNarration, [events, state])
}

write('npc-social.json', { constants, cases: C.cases, values: C.values, skipped: C.skipped })
