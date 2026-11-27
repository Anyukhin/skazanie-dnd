// Сценарии генератора эталонов А5 (подключает `gen-a5.mjs` после хуков
// загрузчика): брифы из состояний и ходов корпуса, синтетика и мусор;
// рассказчик — записывающая обёртка, модель — заглушка по сценарию. Всё,
// что вызвано, попадает в журнал `RECORDS` обёртки в порядке вызова.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import * as N from './narrator-recording.mjs'
import { buildNarrationBrief } from '../../../../server/security.mjs'
import { agentContextMetadata, campaignConceptForAgent, sceneCanonFor, sceneContextForAgent } from '../../../../server/agent-context.mjs'
import { worldClockForAgents } from '../../../../server/weather.mjs'
import { runWithCampaignAiSettings } from '../../../../server/campaign-ai-context.mjs'

let seed = 0x00a5_5eed
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quiet = (operation) => { try { return operation() } catch { return undefined } }

// --- корпус -----------------------------------------------------------------------------

function* corpusRecords(corpusRoot, limit) {
  if (!existsSync(corpusRoot)) return
  const files = readdirSync(corpusRoot).filter((name) => /^corpus-\d+\.jsonl$/u.test(name)).sort()
  const signatures = new Map()
  let taken = 0
  for (const file of files) {
    if (taken >= limit) return
    const path = join(corpusRoot, file)
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    let fromFile = 0
    for (const line of text.split('\n')) {
      if (!line.trim() || fromFile >= 4 || taken >= limit) break
      let record
      try { record = JSON.parse(line) } catch { continue }
      const events = record?.outcome?.ok ? record.outcome.events : null
      if (!Array.isArray(events) || !events.length) continue
      const signature = [...new Set(events.map((event) => event?.event_type))].sort().join(',')
      const seen = signatures.get(signature) ?? 0
      if (seen >= 2) continue
      const statePath = join(corpusRoot, 'states', `${record.state}.json`)
      if (!existsSync(statePath)) continue
      let state
      try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { continue }
      signatures.set(signature, seen + 1)
      fromFile += 1
      taken += 1
      yield { record, state, source: file }
    }
  }
}

const REACTIONS = ['alarmed', 'persuaded', 'unconvinced', 'welcoming', 'attentive', 'watchful', 'cold', 'reacts_to_act', 'curious']
const TONES = ['', 'Мрачный и напряжённый', 'Тёплый, дружелюбный', 'Героический, полный надежды', 'Таинственный', 'Печальный, суровый', 'tense and grim']
const THEMES = ['', 'Память и долг', 'Доверие между союзниками', 'Свобода и правда', 'Справедливость; цена выбора', 'memory, trust']
const BOUNDARIES = ['', 'Без пыток', 'Без сексуального насилия', 'Без натуралистичного насилия и расчленения', 'Никакого насилия над детьми', 'Без пыток; без gore']
const LANDMARK_KINDS = [['well', 'колодец'], ['altar', 'алтарь'], ['statue', 'статуя'], ['campfire', 'костёр'], ['cart', 'телега'], ['mooring', 'причал'], ['barrels', 'бочки']]
const SCENE_TITLES = ['Трактир «Хромой гусь»', 'Старый маяк', 'Лесная тропа', 'Пещера у ручья', 'Храм рассвета', 'Деревня Митглайд', 'Склеп под часовней', 'Перекрёсток дорог', 'Портретная галерея']

function heroesOf(state) {
  return (Array.isArray(state?.players) ? state.players : []).slice(0, 4).map((player, index) => ({
    id: String(player?.id ?? `hero-${index}`),
    name: String(player?.character ?? player?.name ?? `Герой ${index + 1}`),
    is_viewer: index === 0,
  }))
}

function npcsOf(state) {
  const source = [
    ...(Array.isArray(state?.actors) ? state.actors : []),
    ...(Array.isArray(state?.enemies) ? state.enemies : []),
  ].filter((actor) => actor?.name)
  const names = ['Мара Трижды-Мерная', 'Борин', 'Клара Вельм', 'Старый Тобиас', 'Вея']
  const npcs = source.slice(0, 3).map((actor) => ({ id: String(actor.id), name: String(actor.name), role: String(actor.role ?? ''), public_summary: String(actor.description ?? '').slice(0, 100), relationship: pick(['neutral', 'friendly', 'hostile']) }))
  while (npcs.length < 2) {
    const name = names[(npcs.length + int(names.length)) % names.length]
    npcs.push({ id: `npc-${npcs.length}`, name, role: 'хозяйка', public_summary: 'Держит лавку у дороги.', voice: 'хриплый', speech_profile: { pace: 'медленно', lexicon: 'простые слова', mannerism: 'щурится' }, relationship: 'neutral', ...(chance(0.2) ? { known_by_name: false } : {}) })
  }
  return npcs
}

function storyContext(heroes, npcs) {
  const npc = npcs[0]
  return {
    heroes,
    present_npcs: npcs,
    ...(chance(0.5) ? { open_promises: [{ id: 'promise-1', npc: npc.name, hero_id: heroes[0]?.id, direction: 'npc_to_party', text: pick(['Оставить ключ от погреба под камнем у порога', 'Принести карту старого маяка к рассвету', 'Показать тропу к часовне']), due_hint: 'к рассвету', ...(chance(0.3) ? { visibility: pick(['gm_only', 'specific_player', 'party']) } : {}) }] } : {}),
    ...(chance(0.5) ? { recent_interactions: [{ npc: npc.name, hero: heroes[0]?.name, hero_id: heroes[0]?.id, player_message: 'Что ты знаешь о маяке?', npc_reply: pick(['Маяк погас три ночи назад. Смотритель пропал.', 'Ключ от погреба я оставила у порога.', 'Не лезь туда, где стонет ветер.']), stance: 'guarded' }] } : {}),
    ...(chance(0.5) ? { recent_summaries: [{ id: 'summary-1', title: 'Ночь у маяка', summary: 'Отряд нашёл следы на мокрых ступенях маяка и обрывок карты.' }, { id: 'summary-2', title: 'Торг в трактире', summary: 'Хозяйка трактира рассказала о пропавшем смотрителе маяка.' }] } : {}),
    ...(chance(0.4) ? { recent_decisions: [{ title: 'Митглайд · перекрёсток дорог', location: 'Перекрёсток', objective: 'Найти смотрителя маяка', outcome: pick(['Отряд решил идти к маяку ночью', '']) }] } : {}),
    ...(chance(0.4) ? { active_quests: [{ id: 'quest-1', title: 'Погасший маяк' }] } : {}),
    ...(chance(0.3) ? { known_dead_npcs: [{ id: 'dead-1', name: 'Смотритель Арнольд' }] } : {}),
    ...(chance(0.2) ? { npc_dossiers: [{ id: npc.id, name: npc.name }] } : {}),
  }
}

function premiseFor(state) {
  let premise = {}
  try { premise = campaignConceptForAgent(state) ?? {} } catch { premise = {} }
  const arc = chance(0.3) ? 2 + int(2) : null
  return {
    ...premise,
    tone: pick(TONES),
    themes: pick(THEMES),
    boundaries: pick(BOUNDARIES),
    ...(arc ? {
      current_arc_number: arc,
      current_chapter: chance(0.7) ? 1 : 2,
      arc_history: [{ arc_number: arc - 1, title: 'Погасший маяк', epilogue: 'Маяк снова горит, смотритель найден живым, а контрабандисты ушли морем.' }],
    } : {}),
  }
}

function playerIntent(heroes, events) {
  const intent = {
    action: pick(['Осматриваюсь вокруг', 'Подхожу к бочкам и проверяю, что внутри', 'Говорю Борину: держись ближе к стене', 'Открываю дверь и вхожу первым', 'Пою песню о море', 'Читаю Безмолвный образ и слежу за её реакцией', 'Иду к причалу']),
    goal: 'Понять, что здесь случилось',
    approach: pick(['', 'Внимательно', 'Заклинание']),
    outcome: pick(['auto_success', 'check_success', 'check_failure']),
  }
  if (chance(0.25)) intent.roleplay_speech = true
  if (chance(0.3)) intent.outcome_detail = pick(['Борин не торопясь перебирает всё содержимое ящиков, но находит только мокрую солому.', 'Дверь подаётся с третьего толчка, петли визжат.', 'Иллюзия появляется, но женщина даже не моргает.'])
  if (chance(0.15)) intent.thorough_search = pick(['found', 'nothing'])
  if (chance(0.15)) intent.spell_cast = { name: pick(['Безмолвный образ', 'Свет', 'Малая иллюзия']) }
  return intent
}

function syntheticEvents(heroes, npcs) {
  const hero = heroes[0]?.id ?? 'hero'
  const npc = npcs[0]?.id ?? 'npc-0'
  const pool = [
    () => ({ event_type: 'RulingRecorded', actor_id: hero, payload: { ruling: { outcome: pick(['success', 'failure', 'pending']), question: 'Спеть песню о море.', interpretation: { skill: pick(['performance', 'persuasion', 'athletics', 'sleight-of-hand']) } } } }),
    () => ({ event_type: 'AbilityCheckResolved', actor_id: hero, payload: { skill: pick(['perception', 'investigation', 'athletics', 'animal_handling']), ability: pick(['wis', 'int', 'str']), success: pick([true, false, undefined]), total: 14, difficulty: 12 } }),
    () => ({ event_type: 'WorldFactRecorded', actor_id: hero, payload: { fact: { predicate: pick(['discovery', 'rumor']), subject: 'ключ', subject_id: 'item-key', summary: pick(['Под камнем у порога спрятан ржавый ключ.', 'На ступенях маяка следы мокрых сапог.']) } } }),
    () => ({ event_type: 'ActionDeclared', actor_id: hero, payload: { action: 'Открываю дверь' } }),
    () => ({ event_type: 'DoorStateChanged', actor_id: hero, payload: { state: pick(['open', 'closed', 'locked']) } }),
    () => ({ event_type: 'ActorMoved', actor_id: hero, payload: { from: { x: 1, y: 1 }, to: { x: 2, y: 1 } } }),
    () => ({ event_type: 'NpcConversationRecorded', actor_id: hero, target_ids: [npc], payload: { conversation: { npc_id: npc, npc_reply: 'Ключ я оставила у порога. Бери и уходи.' } } }),
    () => ({ event_type: 'SocialSceneOpened', target_ids: [npc], payload: { npc_id: npc } }),
    () => ({ event_type: 'NpcPlaced', target_ids: [npc], payload: { npc_id: npc, npc_name: 'Вея' } }),
    () => ({ event_type: 'CampaignArcCompleted', payload: { closed_arc: { arc_number: 1 } } }),
    () => ({ event_type: 'NpcPromiseResolved', payload: { promise_id: 'promise-1' } }),
    () => ({ event_type: 'QuestClockAdvanced', payload: { quest_id: 'quest-1', ticks: 1 } }),
    () => ({ event_type: 'ItemAcquired', actor_id: hero, payload: { item: { id: 'item-key', name: 'Ржавый ключ' } } }),
    () => ({ event_type: 'DamageApplied', actor_id: hero, target_ids: [npc], payload: { applied_amount: pick([0, 5, -1]), damage_type: pick(['slashing', 'piercing', 'fire']), hp_after: pick([0, 3]) } }),
    () => ({ event_type: 'HitPointsReducedToZero', target_ids: [npc], payload: pick([{}, { successes: 0, failures: 0 }]) }),
    () => ({ event_type: 'TimeOfDayChanged', payload: { phase_before: 'day', phase_after: 'evening', day: 2, minute_of_day: 1080 } }),
    () => ({ event_type: 'ResourceSpent', actor_id: hero, payload: { resource: pick(['spell_slots_1', 'ki', '']) } }),
    () => ({ event_type: 'ReactionWindowOpened', actor_id: npc, target_ids: [hero], payload: { action_id: pick(['opportunity-attack', 'cast:shield', 'unknown']), source_actor_id: npc } }),
    () => ({ event_type: 'CombatActionUsed', actor_id: hero, payload: { name: pick(['Рывок', 'Dash', '']), action_type: pick(['action', 'reaction']) } }),
    () => ({ event_type: 'SpellSavingThrowResolved', target_ids: [npc], payload: { spell_id: pick(['sacred-flame', 'unknown-spell']), saved: pick([true, false]) } }),
    () => ({ event_type: 'ScenarioPurseGranted', target_ids: [hero], payload: { hero_id: hero, amount_gp: 50 } }),
    () => ({ event_type: 'TravelResolved', payload: { from: 'Митглайд', to: 'Старый маяк' } }),
    () => ({ event_type: 'NpcDied', target_ids: [npc], payload: { npc_id: npc } }),
  ]
  return Array.from({ length: int(4) }, () => pick(pool)())
}

function sceneFor(state, actorId, heroes) {
  let scene = {}
  try { scene = sceneContextForAgent(state, actorId) ?? {} } catch { scene = {} }
  const title = pick(SCENE_TITLES)
  const absent = chance(0.4) ? [pick(LANDMARK_KINDS)].map(([kind, label]) => ({ kind, label })) : []
  return {
    ...scene,
    ...(chance(0.6) ? { title, location: title } : {}),
    ...(chance(0.4) ? { mood: pick(['Тихо, только волны бьют о камни', 'деловая суета под навесами и нарастающий гул голосов у прилавков, где торгуются за рыбу и соль до хрипоты', 'Тревожно.']) } : {}),
    ...(chance(0.3) ? { theme: pick(['coast', 'forest', 'dungeon', 'tavern']) } : {}),
    ...(chance(0.2) ? { sensory_anchors: { smell: 'запах соли', sound: 'крики чаек', light: 'серый рассвет', touch: chance(0.5) ? 'мокрый камень' : '' } } : {}),
    ...(chance(0.5) ? { landmarks: [{ label: 'Старый колодец', where: 'у северной стены' }, { label: 'Бочки с водой', where: '' }, { label: 'Ко', where: 'x' }] } : {}),
    ...(absent.length ? { landmarks_absent: absent } : {}),
    ...(chance(0.3) ? { field: { heroes: heroes.map((hero) => ({ name: hero.name, area: 'у двери', condition: pick(['цел', 'ранен']) })) }, spatial_context: { current_area: { name: 'Нижний зал', indoors: chance(0.5) } }, canon: ['Дождь идёт третий день.'] } : {}),
    ...(chance(0.2) ? { transition: true } : {}),
  }
}

function briefFromCorpus({ record, state }) {
  const actorId = String(record?.command?.actor_id ?? state?.players?.[0]?.id ?? 'hero')
  const heroes = heroesOf(state)
  const npcs = npcsOf(state)
  const events = [...record.outcome.events.slice(0, 10), ...(chance(0.4) ? syntheticEvents(heroes, npcs) : [])]
  const story = storyContext(heroes, npcs)
  const scene = sceneFor(state, actorId, heroes)
  const environment = {
    context_metadata: quiet(() => agentContextMetadata(state, { role: 'narrator', actorId, contractVersion: N.NARRATOR_PROMPT_VERSION })),
    scene,
    campaign_premise: premiseFor(state),
    player_intent: playerIntent(heroes, events),
    world_clock: quiet(() => worldClockForAgents(state, actorId)),
    scene_canon: chance(0.8) ? quiet(() => sceneCanonFor(state, { playerId: actorId, actorId })) : undefined,
    world_memory: { facts: chance(0.5) ? [{ subject: 'ключ', subject_id: 'item-key', summary: 'Ключ спрятан под камнем у порога.' }] : [] },
    story_context: story,
    ...(chance(0.3) ? { scenario: { phase: 'opening', node: 'lighthouse', summary: 'Отряд ищет смотрителя.' } } : {}),
  }
  const permitted = npcs.slice(0, int(3)).map((npc) => ({ npc_id: npc.id, name: npc.name, reaction: pick(REACTIONS), description: pick(['Молча наблюдает за разговором', 'Встревожена и отступает к стене', 'Принимает довод героя', 'Кивает']), ...(chance(0.2) ? { text: 'Без пропуска доступ закрыт.' } : {}) }))
  return buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: environment,
    permitted_npc_reactions: permitted,
    narration_constraints: chance(0.3) ? ['no-unconfirmed-world-changes'] : [],
    viewer: { isPartyMember: true, playerId: actorId, partyIds: heroes.map((hero) => hero.id) },
  })
}

function syntheticBrief() {
  const heroes = [{ id: 'hero', name: pick(['Ада', 'Мирель', 'Борин Дубощит', 'Ила']), is_viewer: true }, { id: 'hero-2', name: 'Кирем Двухпалый', is_viewer: false }]
  const npcs = [{ id: 'npc-0', name: pick(['Мара Трижды-Мерная', 'Клара Вельм', 'Вея']), role: 'хозяйка' }, { id: 'npc-1', name: 'Тобиас', role: 'стражник' }]
  const events = syntheticEvents(heroes, npcs)
  return buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: {
      scene: sceneFor({}, 'hero', heroes),
      campaign_premise: premiseFor({}),
      player_intent: playerIntent(heroes, events),
      ...(chance(0.5) ? { scene_canon: { summary: 'Ночь, дождь, под открытым небом.', time: { phase: pick(['night', 'day']), phase_label: 'ночь', clock: '23:10' }, weather: { id: pick(['rain', 'fog', 'clear', 'storm']), label: 'дождь' }, indoors: chance(0.3), light: { label: 'темно' }, surfaces: { label: 'мокрый камень', water_nearby: true, materials: ['камень', 'дерево'] }, location: { kind_label: 'побережье' } } } : {}),
      world_memory: { facts: [] },
      story_context: storyContext(heroes, npcs),
      participants: { heroes: [{ id: 'hero', name: heroes[0].name }], enemies: [{ id: 'foe', name: 'Хобгоблин' }] },
    },
    permitted_npc_reactions: npcs.slice(0, int(3)).map((npc) => ({ npc_id: npc.id, name: npc.name, reaction: pick(REACTIONS), description: 'Кивает и молча наблюдает' })),
    narration_constraints: [],
    viewer: { isPartyMember: true, playerId: 'hero' },
  })
}

/** Мусор: бриф проходит форму, внутри — значения не тех типов. */
function garbageBrief() {
  const junk = () => pick([null, 5, 'строка', true, [], {}, [null], { name: 7 }, { event_type: 5 }, { event_type: 'DamageApplied', payload: null }, { event_type: 'RulingRecorded', payload: { ruling: 'x' } }])
  return {
    visible_events: Array.from({ length: 1 + int(3) }, () => pick([{ event_type: 'AbilityCheckResolved', payload: 'x' }, { event_type: 'WorldFactRecorded', payload: { fact: null } }, { event_type: 'NpcConversationRecorded', payload: { conversation: 5 } }, { event_type: 'TravelResolved' }, { event_type: 'UnknownThing', payload: { a: 1 } }, { event_type: 7 }])),
    visible_state_changes: [],
    known_environment: {
      scene: pick([null, 'сцена', { title: 5, location: ['a', 'b'], landmarks: [null, { label: 7 }], landmarks_absent: [null, { kind: 5 }] }]),
      campaign_premise: pick([null, { tone: 5, themes: ['память', null], boundaries: { x: 1 }, current_arc_number: '3', current_chapter: '1', arc_history: [null, { arc_number: '2', epilogue: 5 }] }]),
      player_intent: pick([null, 'действие', { action: 5, outcome_detail: null }]),
      story_context: pick([null, { heroes: [junk(), { id: 'h', name: 'Ада' }], present_npcs: [junk(), { name: 'Мара' }], open_promises: [junk()], recent_interactions: [junk()], known_dead_npcs: [junk()] }]),
      world_memory: pick([null, { facts: [junk(), junk()] }]),
    },
    permitted_npc_reactions: [junk(), { name: 'Мара', reaction: pick(['toString', 'attentive', 5]) }],
    narration_constraints: [],
  }
}

// --- тексты-кандидаты -------------------------------------------------------------------

function candidates(brief) {
  const story = brief?.known_environment?.story_context ?? {}
  const hero = story.heroes?.[0]?.name ?? 'Ада'
  const npc = story.present_npcs?.[0]?.name ?? 'Мара'
  const action = String(brief?.known_environment?.player_intent?.action ?? 'Осматриваюсь')
  const deterministic = quiet(() => N.deterministicNarration(brief)?.narration) ?? 'Здесь всё по-прежнему.'
  return [
    deterministic,
    `${hero} осматривается. ${npc} кивает и молча наблюдает.`,
    `${npc} падает замертво, и кровь растекается по полу.`,
    'Ты наносишь 7 урона, у врага осталось 3 ОЗ, бросок 15 против СЛ 12.',
    `${hero} берёт ключ и уходит к двери.`,
    'Незнакомец Тарвин кивает и улыбается.',
    'У колодца шумит вода, рядом алтарь и старая статуя.',
    'Пытка продолжается до рассвета.',
    `${action}. Ветер стихает, и в темноте проступает силуэт лодки.`,
    'В прошлый раз: маяк снова горит, смотритель найден. Теперь: волны бьют о камни.',
    'В воздухе пахнет пылью и дымом; она бросает взгляд на дверь, мир плывёт.',
    'Обещанный ключ на месте, под камнем у порога лежит ржавый ключ.',
    'Дождь стучит по крыше, туман ползёт с моря. Что ты сделаешь дальше?',
    `«За Илу!» — рычит ${hero}, но ${npc} остаётся при своём.`,
    `${hero} подходит к бочкам и наклоняется. Ловушка удалась, взгляд нашёл то, что искал.`,
    `${npc} не пропускает: без пропуска проход закрыт.`,
    'Смотритель Арнольд идёт к причалу и говорит с рыбаками.',
    'Никому нельзя доверять; память ничего не значит, надежды нет.',
    'Холодный, враждебный, жестокий ветер. Безопасно и спокойно.',
  ]
}

function scriptedClient(kind, text, brief) {
  const usage = { prompt_tokens: 100 + int(50), completion_tokens: 20 + int(30), cost_rub: 0.5 }
  const chunks = (value) => {
    const pieces = []
    let rest = String(value)
    while (rest.length) {
      const size = 3 + int(25)
      pieces.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
    return pieces
  }
  const valid = quiet(() => N.deterministicNarration(brief)?.narration) ?? 'Здесь всё по-прежнему.'
  const make = (answers) => {
    let index = 0
    return {
      model: pick([undefined, 'openai/gpt-6-luna', 'z-ai/glm-5.3-flash', 'meta/muse-spark-1.3']),
      async complete(request) {
        const answer = answers[Math.min(index, answers.length - 1)]
        index += 1
        return answer(request)
      },
    }
  }
  const stream = (value, extra = {}) => async (request) => {
    if (typeof request.onDelta === 'function') for (const piece of chunks(value)) request.onDelta(piece)
    return { content: value, usage, ...extra }
  }
  const plainAnswer = (value) => async () => ({ content: value, usage })
  const fail = (code) => async () => { throw Object.assign(new Error('сбой модели'), code ? { code } : {}) }
  switch (kind) {
    case 'valid': return make([plainAnswer(text)])
    case 'stream': return make([stream(text)])
    case 'repair-ok': return make([stream(text), plainAnswer(valid)])
    case 'repair-bad': return make([plainAnswer(text), plainAnswer(text)])
    case 'repair-error': return make([plainAnswer(text), fail('LLM_TIMEOUT')])
    case 'error': return make([fail(pick(['LLM_PROVIDER_ERROR', 'LLM_RESPONSE_INVALID', null]))])
    case 'empty': return make([async () => pick([{ content: '' }, { content: null }, {}, { content: 42 }, { content: { x: 1 } }, null])])
    case 'huge': return make([stream('а'.repeat(13_000))])
    case 'pending': return make([() => new Promise(() => {})])
    case 'abort-aware': return make([(request) => new Promise((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true }))])
    case 'slow': return make([async () => { await sleep(3); return { content: text, usage: null } }])
    case 'json-only': return { async completeJson() { return pick([{ narration: text }, { narration: 5 }, {}, null]) } }
    case 'class': {
      class RouterAIClient { constructor() { this.model = 'openai/gpt-6-luna' } async complete(request) { return stream(text, { usage: [1, 2] })(request) } }
      return new RouterAIClient()
    }
    default: return make([plainAnswer(text)])
  }
}

const CLIENT_KINDS = ['valid', 'stream', 'repair-ok', 'repair-bad', 'repair-error', 'error', 'empty', 'huge', 'pending', 'abort-aware', 'slow', 'json-only', 'class']

async function exerciseFunctions(brief, recent) {
  const texts = candidates(brief)
  const attempt = (operation) => { try { return operation() } catch { return undefined } }
  attempt(() => N.narratorResponsePlan(brief))
  attempt(() => N.narratorMomentFor(brief))
  attempt(() => N.selectNarratorFewShotExamples(brief, chance(0.5) ? { style: pick(['neutral', 'formal', 'ironic', 'odd', null]), count: pick([undefined, 2, 1, 5, '3', 0]) } : undefined))
  attempt(() => N.narratorContentDirectives(brief))
  attempt(() => N.narratorArcRecap(brief, { includeOpeningArc: chance(0.6), recentNarrations: recent, ...(chance(0.2) ? { recappedArcKeys: new Set(['x']) } : {}) }))
  attempt(() => N.narratorMemoryFocus(brief))
  attempt(() => N.freshSceneElement(brief, recent))
  attempt(() => N.sensoryAnchorsFor(brief, chance(0.5) ? { rotation: pick([0, 1, 2, 7, -3, 2.5, '4', null]) } : undefined))
  attempt(() => N.deterministicNarration(brief, undefined, { recentNarrations: recent }))
  if (chance(0.2)) attempt(() => N.deterministicNarration(brief, (id) => (id === 'hero' ? 'Ада Светлая' : id), { recentNarrations: recent }))
  for (const text of texts) {
    attempt(() => N.verifyNarratorCraft(text, brief, { valid: true, violations: chance(0.1) ? [{ code: 'X', message: 'm', match: '' }] : [] }, recent))
    if (chance(0.3)) attempt(() => N.verifyNarratorFeedback(text, brief, { recentNarrations: recent, ...(chance(0.5) ? { sensoryAnchors: {} } : {}), ...(chance(0.3) ? { contentDirectives: { tone: pick(TONES), themes: pick(THEMES), boundaries: pick(BOUNDARIES) } } : {}) }))
    if (chance(0.3)) attempt(() => N.withoutEchoOfPlayer(text, brief))
    if (chance(0.2)) attempt(() => N.confirmedOutcomeDetailSentence(text, brief))
  }
  attempt(() => N.weatherRecentlyMentioned(recent))
  attempt(() => N.recentClicheReminders([...recent, texts[10]]))
  attempt(() => N.narrationRepairNote(pick([[], [{ code: 'A', message: 'Сообщение', match: 'фрагмент' }, { code: 'B' }, null, { message: 'x'.repeat(300), match: 'y'.repeat(300) }, {}], undefined])))
  for (const event of Array.isArray(brief?.visible_events) ? brief.visible_events : []) attempt(() => N.freeActionRulingOutcome(event))
}

async function renderSequence(brief, recent) {
  const texts = candidates(brief)
  const kind = pick(CLIENT_KINDS)
  const narrator = new N.Narrator({
    ...(chance(0.85) ? { llmClient: scriptedClient(kind, pick(texts), brief) } : {}),
    ...(chance(0.25) ? { asyncFeedback: false } : {}),
    ...(chance(0.05) ? { feedbackVerifier: null } : {}),
  })
  const steps = 1 + int(3)
  let history = [...recent]
  for (let step = 0; step < steps; step += 1) {
    const shown = []
    const timeoutMs = kind === 'pending' || kind === 'abort-aware' ? pick([20, 35]) : pick([undefined, undefined, null, 0, 5_000, -1, 'abc'])
    const options = {
      ...(chance(0.5) ? { knownRuleIds: pick([[], ['phb-2014:dodge'], null]) } : {}),
      ...(chance(0.3) ? { style: pick(['Подробно', null, 'Кратко']) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      recentNarrations: history,
      ...(chance(0.7) ? { onProgress: (text) => shown.push(text) } : {}),
    }
    const settings = chance(0.3) ? { model: pick(['z-ai/glm-5.3-flash', 'openai/gpt-6-luna']), narratorStyle: pick(['neutral', 'formal', 'ironic', 'wild']), improvMode: pick(['story', 'chaos']) } : null
    let result
    try {
      result = settings ? await runWithCampaignAiSettings(settings, () => narrator.render(brief, options)) : await narrator.render(brief, options)
    } catch {
      result = null
    }
    if (result?.narration) history = [...history, result.narration].slice(-4)
  }
  if (chance(0.3)) await narrator.awaitFeedback(history[history.length - 1])
  if (chance(0.3)) await narrator.drainFeedback()
}

export async function generatedProcess({ corpusRoot }) {
  const cases = []
  for (const entry of corpusRecords(corpusRoot, 260)) {
    const brief = quiet(() => briefFromCorpus(entry))
    if (brief) cases.push(brief)
  }
  for (let index = 0; index < 120; index += 1) {
    const brief = quiet(() => syntheticBrief())
    if (brief) cases.push(brief)
  }
  for (let index = 0; index < 40; index += 1) cases.push(garbageBrief())
  let recent = []
  for (const brief of cases) {
    if (chance(0.3)) recent = []
    await exerciseFunctions(brief, recent)
    await renderSequence(brief, recent)
    const narration = quiet(() => N.deterministicNarration(brief)?.narration)
    if (narration) recent = [...recent, narration, 5, null].filter((entry) => entry !== 5 || chance(0.5)).slice(-5)
  }
  console.error(`сценарии: брифов ${cases.length}`)
  return { source: 'generator', events: N.RECORDS }
}
