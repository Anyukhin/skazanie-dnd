import '../../../fixtures-env.mjs'
// Эталоны `server/npc-social-check.mjs` для Rust-переноса (`sk-social`).
//
// Реплики — из тестов (`test/npc-social.test.mjs`, `test/underworld.test.mjs`,
// `test/reputation-consequences.test.mjs`) и собранные из частей: навыки,
// отрицания, цитаты, подкуп, флирт, мусор. Политика проверки строится на
// состояниях с отношением, разговорами, репутацией фракций, ручными СЛ и
// неподкупными; исход — из событий `AbilityCheckResolved`, которые настоящий
// Rules Engine бросает детерминированными костями (`rolls` — какие кости
// выпали, чтобы Rust повторил бросок своим `sk_dice`).
//
// Запуск: node rust/crates/sk-social/fixtures/gen-npc-social-check.mjs
import { JUNK, collector, rng, server, write } from './lib.mjs'

const K = await import(server('npc-social-check'))
const { normalizeCampaignState, resolveCommand } = await import(server('rules-engine'))
const { DiceService, SequenceDiceRng } = await import(server('dice-service'))
const { INCORRUPTIBLE_TAG } = await import(server('underworld'))

const R = rng(20261015)
const C = collector()
const pick = R.pick
const chance = R.chance

const MESSAGES = [
  'убеждаю Марту помочь.', 'обманываю Марту.', 'угрожаю Марте.', 'проницательно изучаю её мотивы.',
  'I persuade Marta to open the gate.', 'I lie to Marta about the seal.', 'I threaten Marta.', "I use insight to read Marta's motives.",
  'I ask Marta about the weather.', 'Я не угрожаю и не требую, а спокойно объясняю.', 'Я не обманываю Марту.', 'Я цитирую фразу «я угрожаю страже».',
  'Я не хочу его запугивать.', 'Не только угрожаю, но и предлагаю сделку.', 'Угрожаю: «сейчас уйдите».', 'Убеждаю и подкрепляю слова: монету',
  'Убеждаю и подкрепляю слова: кошель', 'Убеждаю и подкрепляю слова: щедро', 'просто уговариваю', 'Убеждаю его помочь', 'Запугиваю его и сую монету',
  'Убеждаю её рассказать про караван', 'Флиртую с трактирщицей', 'Кокетничаю', 'Предлагаю ему горсть серебра за молчание', 'предлагаю пять монет',
  'Даю взятку стражнику', 'Подкупаю писаря', 'Вру, что мы из гильдии', 'Блефую про печать', 'Солгу ему', 'выдаю себя за гонца', 'Он лжёт ли?',
  'Врёт ли он мне?', 'Распознаю его настоящий мотив', 'Понимаю, какой у него мотив', 'Шантажирую купца', 'Припугну его', 'Склоняю к сделке',
  'Прошу согласиться на обмен', 'Дипломатично предлагаю мир', 'I negotiate a truce', 'I try to convince the guard', 'I coerce him', 'I bluff', 'I deceive the guard',
  'I read his intent', 'Never lie', 'я никогда не буду его запугивать', 'без угроз прошу помочь', 'ни обманывать, ни угрожать не стану', 'Не буду так шантажировать',
  '«Убеждаю» — сказал он', '"угрожаю"', "'обманываю'", 'УГРОЖАЮ!', 'Ｕбеждаю', '', '   ', 'Говорю торговцу: добрый день.', 'I am a liar', 'lie down',
  'Сую ему монету и прошу пропустить', 'Отсчитываю серебро', 'плачу щедро, не скупясь', 'горсть золота сверху', 'увесистый кошель', 'мошну', 'звенящая монета',
  'Подмазываю стражника', 'предлагаю ему деньги', 'предлагаю ему ' + 'очень '.repeat(15) + 'много монет', 'предлагаю. Монет нет', 'очаровываю вдову',
  'Убеждаю ' + 'долго '.repeat(400), 'не только убеждаю', 'не\tугрожаю', 'Я не только угрожаю', 'не очаровываю, а убеждаю',
]

function message() {
  if (chance(0.06)) return pick(JUNK)
  if (chance(0.25)) return `${pick(MESSAGES)} ${pick(MESSAGES)}`
  return pick(MESSAGES)
}

for (const text of [...MESSAGES, ...JUNK]) {
  C.call('affirmativeActionText', K.affirmativeActionText, [text])
  C.call('classifyNpcSocialCheck', K.classifyNpcSocialCheck, [text])
  C.call('classifyBribeTier', K.classifyBribeTier, [text])
}
for (let index = 0; index < 200; index += 1) {
  const text = message()
  C.call('affirmativeActionText', K.affirmativeActionText, [text])
  C.call('classifyNpcSocialCheck', K.classifyNpcSocialCheck, [text])
  C.call('classifyBribeTier', K.classifyBribeTier, [text])
}

// ── Политика проверки ───────────────────────────────────────────────────────

const NPC_IDS = ['marta', 'merchant-1', 'npc:guard', '5', 'ghost']
const HEROES = ['hero', 'rogue', '3', '']

function npc(id) {
  const entry = {
    id, name: pick(['Marta', 'Горазд', 'Стражник', 'Пятый']), role: pick(['merchant', 'купец', 'страж']), location: pick(['Market Square', 'Рынок', '']),
    visibility: pick(['party', 'public', 'gm_only']), available: chance(0.9),
    tags: R.some(['faction:guild', 'faction:watch', INCORRUPTIBLE_TAG, 'скупщик', 'merchant'], 3),
  }
  if (chance(0.3)) entry.social_dcs = pick([{ persuasion: 14 }, { insight: 30, deception: 4 }, { intimidation: '20' }, { persuasion: 2.5 }])
  if (chance(0.2)) entry.schedule = [{ id: 'away', days: [], start_minute: 0, end_minute: 1_440, location: 'Docks', available: chance(0.5) }]
  return entry
}

function checkState() {
  const npcs = NPC_IDS.slice(0, 4).filter(() => chance(0.85)).map(npc)
  const relationships = {}
  for (const entry of npcs) {
    relationships[entry.id] = {}
    for (const hero of HEROES) if (chance(0.6)) relationships[entry.id][hero] = pick([0, 3, 5, -5, -6, 19, 20, -20, -21, 49, 50, -50, 99, -99])
  }
  const conversations = chance(0.4)
    ? Array.from({ length: R.int(1, 3) }, (_, index) => ({ id: `conv:${index}`, npc_id: pick(npcs)?.id ?? 'marta', hero_id: pick(HEROES), player_message: 'Привет', npc_reply: 'Здравствуй', stance: pick(['friendly', 'neutral', 'guarded', 'hostile']), visibility: 'party' }))
    : []
  return {
    sessionCode: pick(['UNDER-0', 'UNDER-1', 'UNDER-2', 'NPC-SOCIAL', 'X']),
    worldMap: chance(0.5) ? { currentLocationId: pick(['market', 'docks']) } : undefined,
    scene: { location: pick(['Market Square', 'Рынок']) },
    mechanics: { world_time: { elapsed_minutes: pick([0, 600, 1_050]) }, combat: { active: chance(0.1) } },
    autonomy: chance(0.6) ? { reputations: { guild: pick([-80, -30, 0, 30, 80, '40']), watch: pick([-60, 10, 70]) } } : undefined,
    social: { npcs, relationships, conversations, promises: [] },
    merchants: chance(0.4) ? [{ id: 'merchant-1', name: 'Горазд', location: 'Рынок', available: true }] : [],
    ...(chance(0.1) ? { npc_world: { vitals: { marta: { hp: 0, alive: false } } } } : {}),
  }
}

for (let index = 0; index < 260; index += 1) {
  const state = checkState()
  const params = {
    state,
    npcId: pick([...NPC_IDS, undefined, null, 5]),
    heroId: pick([...HEROES, undefined, null]),
    message: message(),
    turnId: pick(['t1', 'turn-policy', '', undefined, 42]),
  }
  if (chance(0.3)) params.bribeTierId = pick(['coin', 'purse', 'generous', 'bogus', '', null])
  if (chance(0.5)) params.bribeReferenceCp = pick([0, 10_000, 100_000_000, '500', -5, null])
  C.call('buildNpcSocialCheckPolicy', K.buildNpcSocialCheckPolicy, [params])
}
for (const params of [undefined, {}, { state: undefined, npcId: 'marta', message: 'убеждаю' }, { state: 'state', message: 'убеждаю' }]) {
  C.call('buildNpcSocialCheckPolicy', K.buildNpcSocialCheckPolicy, [params])
}

// Сцена test/npc-social.test.mjs: проверка через настоящий движок на детерминированных костях.
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

const rolls = []
const engineState = marketCampaign()
const engineView = { sessionCode: engineState.sessionCode, scene: { location: engineState.scene.location }, mechanics: { world_time: engineState.mechanics.world_time, combat: { active: false } }, social: engineState.social, merchants: engineState.merchants }
for (let index = 0; index < 60; index += 1) {
  const heroId = pick(['hero', 'rogue'])
  const text = pick(['I persuade Marta to help.', 'I lie to Marta about the seal.', 'I threaten Marta.', "I use insight to read Marta's motives.", 'убеждаю Марту помочь.'])
  const policy = K.buildNpcSocialCheckPolicy({ state: engineState, npcId: 'marta', heroId, message: text, turnId: `turn-${index}` })
  C.call('buildNpcSocialCheckPolicy', K.buildNpcSocialCheckPolicy, [{ state: engineView, npcId: 'marta', heroId, message: text, turnId: `turn-${index}` }])
  const die = R.int(1, 20)
  let roll = 0
  const diceService = new DiceService({ rng: new SequenceDiceRng([die]), idFactory: () => `roll-${index}-${++roll}`, now: () => '2026-07-26T12:00:00.000Z' })
  const result = resolveCommand(
    { command_type: 'MakeAbilityCheck', actor_id: heroId, modifier: 99, difficulty: 1, social_check: { check_id: 'forged', npc_id: 'forged', skill: 'deception' } },
    engineState,
    { diceService, context: { isSocialController: true, socialCheck: policy, allowedActorIds: [heroId] } },
  )
  const event = result.events.find((candidate) => candidate.event_type === 'AbilityCheckResolved')
  rolls.push({ die, policy, event: JSON.parse(JSON.stringify(event)) })
  C.call('npcSocialCheckOutcome', K.npcSocialCheckOutcome, [event])
  C.call('assertNpcSocialCheckFingerprint', K.assertNpcSocialCheckFingerprint, [event, policy], { expectThrow: true })
  C.call('assertNpcSocialCheckFingerprint', K.assertNpcSocialCheckFingerprint, [event, { request_fingerprint: 'other' }], { expectThrow: true })
}

for (let index = 0; index < 80; index += 1) {
  const payload = {
    skill: pick(['persuasion', 'insight', 'stealth', undefined]),
    ability: pick(['cha', 'wis', undefined, 'x'.repeat(20)]),
    roll_id: pick(['roll-1', undefined]),
    total: pick([0, 7, 12, 22, -3, '15', null, undefined, 2.5, 'abc']),
    difficulty: pick([12, 15, '10', null, undefined, 'abc']),
    modifier: pick([4, -1, null, undefined, '2']),
    success: pick([true, false, 'true', 1]),
    social_check: pick([undefined, null, 'check', {}, { check_id: 'social-check:abc', npc_id: 'marta', skill: pick(['persuasion', 'deception', '', undefined]), request_fingerprint: pick(['abc', '', undefined]) }]),
  }
  const event = pick([{ event_type: 'AbilityCheckResolved', payload }, { event_type: 'AttackResolved', payload }, { event_type: 'AbilityCheckResolved' }, null, undefined])
  C.call('npcSocialCheckOutcome', K.npcSocialCheckOutcome, [event])
  C.call('assertNpcSocialCheckFingerprint', K.assertNpcSocialCheckFingerprint, [event, pick([{ request_fingerprint: 'abc' }, {}, undefined, null, { request_fingerprint: 5 }])], { expectThrow: true })
}

const constants = {
  NPC_SOCIAL_CHECK_SKILLS: [...K.NPC_SOCIAL_CHECK_SKILLS],
  BRIBEABLE_SOCIAL_SKILLS: [...K.BRIBEABLE_SOCIAL_SKILLS],
}

write('npc-social-check.json', { constants, rolls, cases: C.cases, values: C.values, skipped: C.skipped })
