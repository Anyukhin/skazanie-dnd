import '../../../fixtures-env.mjs'
// Эталон задачи А2 (`sk-agents`): npc-controller, scene-architect,
// director-agent, hero-hooks, player-request-router.
//
//   node rust/crates/sk-agents/fixtures/gen-a2.mjs
//
// `a2.json.gz`:
//   - `states` — состояния, на которые ссылаются случаи (`{ "$state": N }`):
//     урезанный корпус `Dnd-narrator-live/tmp/corpus-v1` и синтетика;
//   - `cases` — вызовы функций (`fn`, `args`, `out` или `throws`): перехват
//     тестов JS этих модулей, корпус с реальными фразами игроков
//     (`eval/player-phrases.json`) и синтетикой, мусор старых сохранений;
//   - `roles` — вызовы ролей с заглушкой модели (`cls`, `args`, `replies`):
//     корректные ответы, битый JSON, markdown, лишние поля, отказ, таймаут,
//     `null`, массив; итог роли — `out`, запросы к модели — `calls_hash`
//     (SHA-256 `JSON.stringify` списка `{ input, options }`), у первых случаев
//     роли — и сами запросы (`calls`).
// Модель по сети не зовётся: роли получают записывающую заглушку.
import { registerHooks } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argsFrom, captureTests, DOTENV_STUB, errorOf, hash, mulberry32, picker, plain, writeFixture } from './a2-common.mjs'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config' || specifier === 'dotenv') return { url: DOTENV_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const root = new URL('../../../../', import.meta.url)
const load = (name) => import(new URL(`server/${name}.mjs`, root).href)
const router = await load('player-request-router')
const architect = await load('scene-architect')
const director = await load('director-agent')
const npc = await load('npc-controller')
const hooks = await load('hero-hooks')
const { strictJsonParse, LLMTimeoutError, LLMError } = await load('llm-client')

const FIXTURE = new URL('./a2.json.gz', import.meta.url)
const CORPUS_DIR = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1/states'
const { int, pick, chance } = picker(mulberry32(2026_10_21))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// --- состояния --------------------------------------------------------------------

const states = []
const stateIndex = new Map()
function addState(state) {
  const text = JSON.stringify(state)
  if (stateIndex.has(text)) return stateIndex.get(text)
  states.push(JSON.parse(text))
  stateIndex.set(text, states.length - 1)
  return states.length - 1
}
const ref = (index) => ({ $state: index })
const stateOf = (index) => clone(states[index])

const DROP_KEYS = ['locationMaps', 'battleLog', 'economyLog', 'mapFeedback', 'actors', 'dialogues', 'tavern', 'beasts', 'blessings', 'loot_containers', 'courier_letters', 'world_deeds']
const pickKeys = (value, keys) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) : value)
const ACTOR_KEYS = ['id', 'actor_id', 'character', 'name', 'role', 'characterClass', 'species', 'background', 'backstory', 'bonds', 'ideals', 'traits', 'characterSetupRequired', 'hp', 'maxHp', 'max_hp', 'alive', 'x', 'y', 'size', 'footprint', 'kind', 'type', 'faction', 'speed', 'ownerId', 'owner_id']
const slimActor = (actor) => pickKeys(actor, ACTOR_KEYS)
const slimProp = (prop) => pickKeys(prop, ['id', 'assetId', 'state', 'interaction', 'revealed'])
function trim(state, { keepCells = false } = {}) {
  const result = { ...state }
  for (const key of DROP_KEYS) delete result[key]
  if (result.scene && typeof result.scene === 'object') {
    const scene = { ...result.scene }
    if (!keepCells) {
      delete scene.cells
      if (scene.map && typeof scene.map === 'object') {
        scene.map = { theme: scene.map.theme, props: Array.isArray(scene.map.props) ? scene.map.props.map(slimProp) : scene.map.props }
      }
    }
    result.scene = scene
  }
  if (Array.isArray(result.players)) result.players = result.players.map((hero) => slimActor(hero))
  if (result.autonomy && typeof result.autonomy === 'object') result.autonomy = pickKeys(result.autonomy, ['director_history', 'director_outcomes', 'pacing', 'encounter_outcomes'])
  for (const key of ['director_history', 'director_outcomes']) if (Array.isArray(result.autonomy?.[key])) result.autonomy[key] = result.autonomy[key].slice(-24)
  if (result.npc_world && JSON.stringify(result.npc_world).length > 4000) delete result.npc_world
  return result
}

// Состояние кампании среди аргументов: урезается и уходит в `states` ссылкой.
const isStateLike = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && ['scene', 'players', 'worldMap', 'worldMemory', 'enemies'].some((key) => key in value)

const corpus = []
const combatCorpus = []
if (existsSync(CORPUS_DIR)) {
  const files = readdirSync(CORPUS_DIR).sort()
  for (let index = 0; index < files.length; index += 61) {
    const state = JSON.parse(readFileSync(join(CORPUS_DIR, files[index]), 'utf8'))
    corpus.push(addState(trim(state)))
    if ((state.enemies ?? []).length && Array.isArray(state.scene?.cells) && combatCorpus.length < 45 && index % 2 === 0) {
      combatCorpus.push(addState(trim(state, { keepCells: true })))
    }
  }
}
console.log(`корпус: ${corpus.length} состояний, с клетками ${combatCorpus.length}`)

// --- синтетика ---------------------------------------------------------------------

const PLACES = ['Серый Причал', 'Старый маяк', 'Таверна «Сеть»', 'Каменный Град', 'Чащоба Рун', 'Вейр', 'Пепельная застава', 'Норвин', 'Склеп Норвин', 'Мост у брода', 'Храм Луны', 'Мормар', 'Дормар', 'Айрская башня', 'Озеро Тишины', 'Кленовка']
const KINDS = ['city', 'port', 'town', 'village', 'wilds', 'fortress', 'ruin', 'dungeon', 'landmark', 'capital', '', 'castle']
const NPC_NAMES = ['Борс', 'Марен', 'Клара Вельм', 'Мартен Рыжий', 'Мира Ветрокрыл', 'Ила', 'Стражник Отто', 'Сестра Агния']
const ROLES = ['трактирщик', 'смотритель маяка', 'Стражница', 'проводница', 'торговец', '', 'жрица']
const BACKSTORIES = [
  'Моя сестра Ила пропала в море три месяца назад. Я ищу её следы на побережье.',
  'Бывший стражник. Капитан учил не замечать ночных лодок у маяка.',
  'Не выбрано',
  'Вырос в храме Луны, бежал после пожара. Хочу узнать, кто поджёг храм.',
  'Коротко.',
  'Ищу брата, который ушёл с караваном на север и не вернулся! Говорят, его видели в Вейре.',
  '',
]

function syntheticWorldMap() {
  const count = 3 + int(8)
  const names = [...PLACES].sort(() => (chance(0.5) ? 1 : -1)).slice(0, count)
  const locations = names.map((name, index) => ({
    id: chance(0.9) ? `loc:${index}` : index,
    name: chance(0.05) ? '' : name,
    kind: pick(KINDS),
    ...(chance(0.5) ? { summary: pick(['Порт у гавани.', 'Деревня с колодцем на площади и костром у ворот.', 'Башня на скале над гаванью.', 'Деревня у реки и переправы.', 'Горный кряж и перевал.', 'Лес и роща.', 'Старая крепость.']) } : {}),
    ...(chance(0.3) ? { history: 'Здесь давно не было людей.' } : {}),
    ...(chance(0.3) ? { biome: pick(['forest', 'mountains', 'coast', '']) } : {}),
    ...(chance(0.15) ? { known: false } : {}),
    ...(chance(0.08) ? { hidden: true } : {}),
    ...(chance(0.08) ? { visibility: 'gm_only' } : {}),
    ...(chance(0.3) ? { visited: true } : {}),
    regionId: chance(0.5) ? 'r1' : 'r2',
    ...(chance(0.2) ? { cityOverview: { districts: [{ name: 'Высокие ворота дамбы' }], places: [{ name: 'Рыночная площадь' }] } } : {}),
  }))
  const routes = []
  for (let index = 1; index < locations.length; index += 1) {
    routes.push({ from: locations[int(index)].id, to: locations[index].id, distance: pick([1, 2, 3, 0, '2', null]), danger: pick(['низкая', 'средняя', 'высокая', 'страшная']), ...(chance(0.1) ? { discovered: false } : {}) })
  }
  if (chance(0.5)) routes.push({ from: locations[0].id, to: locations[locations.length - 1].id, distance: 4 })
  return { locations, routes, regions: [{ id: 'r1', biome: 'forest' }, { id: 'r2', biome: 'mountains' }], currentLocationId: chance(0.85) ? locations[0].id : 'nowhere' }
}

function syntheticState() {
  const worldMap = chance(0.85) ? syntheticWorldMap() : undefined
  const here = worldMap?.locations?.[0]?.name || pick(PLACES)
  const npcs = Array.from({ length: int(5) }, (_, index) => ({
    id: `npc:${index}`,
    name: pick(NPC_NAMES),
    role: pick(ROLES),
    location: chance(0.7) ? here : pick(PLACES),
    ...(chance(0.3) ? { location_id: chance(0.5) ? worldMap?.locations?.[0]?.id ?? 'x' : 'other' } : {}),
    public_summary: chance(0.6) ? 'Держит таверну у воды. Говорят, знает всех' : '',
    visibility: pick(['party', 'public', 'gm_only', undefined]),
    available: chance(0.85),
    known_fact_ids: [],
  }))
  const players = Array.from({ length: 1 + int(3) }, (_, index) => ({
    id: pick([`hero-${index}`, `hero ${index}`, `h${index}`]),
    character: chance(0.8) ? pick(['Ила Морская', 'Торвальд', 'Сейра', 'Брон']) : '',
    name: pick(['Антон', 'Оля', 'Игрок']),
    hp: pick([10, 0, 7]),
    maxHp: 12,
    backstory: pick(BACKSTORIES),
    bonds: pick(['Сестра Ила — всё, что у меня осталось.', '', 'Должен храму Луны.', 'не определено']),
    ideals: pick(['Честь', '']),
    ...(chance(0.1) ? { characterSetupRequired: true } : {}),
    x: int(10), y: int(10),
  }))
  const facts = []
  for (let index = 0; index < int(6); index += 1) {
    facts.push({
      id: `fact:${index}`, subject_id: `loc:${int(3)}`, predicate: pick(['discovery', 'gm_secret', 'party_arrived', 'rumor', 'opening_narration']),
      object: pick(['{"topic":"пропавшая сестра","holder":"Марен"}', '{"topic":"лодки","hero_id":"hero-0"}', 'не json', '']),
      summary: pick(['Марен видел лодку у маяка ночью.', 'Хозяин баркаса задолжал Борсу.', 'На маяке горел огонь.', 'Мара внесла в книгу имя Илы.']),
      visibility: pick(['party', 'public', 'gm_only']), status: pick(['active', 'superseded', undefined]), source_event_ids: [],
    })
  }
  return plain({
    campaign_id: pick(['SYN', 'HOOKS', undefined]),
    sessionCode: chance(0.5) ? 'S1' : undefined,
    players,
    partyMemberIds: chance(0.7) ? players.map((hero) => hero.id) : [],
    enemies: chance(0.3) ? [{ id: 'goblin', name: 'Гоблин', hp: 2, maxHp: 10, kind: pick(['гоблин', 'волк', 'скелет']) }] : [],
    scene: {
      title: pick(['Глава 1 · Серый Причал', 'Привал', 'Таверна «Ржавый якорь»', '']),
      location: chance(0.9) ? here : '',
      ...(worldMap && chance(0.4) ? { location_id: worldMap.locations[0].id } : {}),
      objective: pick(['Добраться до Старого маяка и расспросить смотрителя', 'Продолжить путь из Айрская башня к «Дормар»', 'Найти пропавшую сестру', '', 'Отправиться в Вейр']),
      mood: pick(['Тихо', 'Тревожно', '']),
      turn: pick([0, 3, '5', null]),
      theme: pick(['tavern', 'harbor', undefined]),
      danger: pick(['низкая', 'высокая', 'нет', undefined]),
      ...(chance(0.2) ? { level: { label: chance(0.5) ? 'Подвал' : '', index: -1 } } : {}),
      map: { props: chance(0.5) ? [{ id: 'p1', assetId: pick(['chest', 'well', 'barrel', 'unknown']), interaction: { pointOfInterest: chance(0.5) } }, { id: 'p2', assetId: 'table', state: pick(['broken', 'ok']) }] : [] },
    },
    scene_npcs: chance(0.5) ? npcs.slice(0, 2).map((entry) => ({ id: entry.id, name: entry.name, role: entry.role, alive: chance(0.9) })) : undefined,
    social: { npcs, relationships: {}, conversations: npcs.slice(0, 2).map((entry) => ({ npc_id: entry.id, hero_id: players[0].id, visibility: pick(['party', 'private']), npc_reply: 'Видел лодку у маяка. Хозяин баркаса ушёл ночью! Больше не скажу.' })), promises: [{ id: 'p', npc_id: 'npc:0', hero_id: players[0].id, status: pick(['open', 'kept', 'broken']), text: 'Вернуть долг', visibility: pick(['party', undefined, 'private']), consequence_delta: pick([1, -2, 'x']) }] },
    merchants: chance(0.3) ? [{ id: 'm1', name: 'Торговец Гарр', title: 'кузнец', location: here, available: true }] : undefined,
    worldMemory: {
      entities: [{ id: 'loc:0', kind: 'location', name: here, visibility: 'party' }, { id: 'loc:1', kind: 'location', name: 'Старый маяк', visibility: pick(['party', 'gm_only']) }, ...(chance(0.3) ? [{ id: 'loc:2', kind: 'location', name: 'Таверна «Сеть»' }] : [])],
      facts,
      threads: chance(0.4) ? [{ id: 'thread:hero-hook:hero-0', title: 'Найти сестру', status: pick(['active', 'closed']), summary: 's', clock: { current: 1, max: 4 } }] : [],
      quests: chance(0.6) ? [{ id: 'quest:main', title: 'Тайна маяка', status: pick(['active', 'abandoned', 'completed']), objectives: ['Добраться до маяка'], clock: chance(0.5) ? { current: 1, max: 4, triggered: chance(0.2) } : undefined }] : [],
      knowledge_ledger: chance(0.3) ? [{ fact_id: 'fact:1' }] : [],
    },
    adventure: { chapter: pick([1, 2, '3', 0, 'x', undefined]), currentHook: pick(['Огонь на маяке', '', 'Печать архивариуса']), history: [{ outcome: 'Отряд пришёл в порт.' }] },
    autonomy: chance(0.6) ? { director_history: pick([[], [{ intent: { type: 'continue_exploration', reason: 'r' } }], [{ type: 'end_scene' }, { type: 'continue_exploration' }, { intent: { type: 'open_social_scene' } }], [{ intent: { type: 'continue_exploration' } }, { intent: { type: 'open_social_scene' } }, { intent: { type: 'advance_quest_clock' } }, { intent: { type: 'request_encounter' } }]]), pacing: { phase: pick(['rising', '']), tension: pick([150, -5, 40]), beat: 2 }, encounter_outcomes: [{ encounter_id: 'enc1' }] } : undefined,
    mechanics: {
      ...(chance(0.3) ? { encounter: { id: pick(['enc1', 'enc2']), status: pick(['ended', 'active']), outcome: 'victory' } } : {}),
      ...(chance(0.2) ? { combat: { active: true, round: 2 } } : {}),
      world_time: chance(0.5) ? { elapsed_minutes: 600 } : undefined,
      conditions: {},
    },
    worldMap,
    activePlayerId: players[0].id,
  })
}

const synthetic = Array.from({ length: 160 }, () => addState(syntheticState()))

// --- фразы ---------------------------------------------------------------------------

const PHRASES = JSON.parse(readFileSync(new URL('eval/player-phrases.json', root), 'utf8')).phrases.map((entry) => entry.text)
const SYNTH_PHRASES = [
  'Кто такая Клара?', 'А кто это — Марен?', 'Какая сейчас погода?', 'Который час?', 'Есть ли тут стража?', 'Есть ли здесь кузнец?', 'Сколько стоит переправа?',
  'Что будет, если я открою дверь?', 'Что я вижу?', 'Где мы сейчас?', 'Опиши сцену', 'Что мы знаем о хозяине баркаса?', 'Что я знаю о пропавшей сестре?',
  'Расскажи про легенду маяка', 'Куда нам идти дальше?', 'Что теперь?', 'Пусть решит кубик', 'Кубик судьбы', 'Можно ли атаковать дважды?', 'Бросаю кубик на атаку',
  'Уходим в Вейр', 'Покидаем таверну и идём к Старому маяку', 'Иду рядом с Марен к маяку', 'Отправляемся в Каменный Град', 'Иду к колодцу',
  'Иду по свежим следам к провалу у старой арки', 'Идём к смотровой дамбе', 'Продолжим', 'Продолжаем путь', 'Спрашиваю Борса: что ты знаешь про легенду?',
  'Говорю Марен: расскажи мне об этой охоте', 'Рассказываю Марте свою историю', 'ищем бой', 'Перейти', 'атакуем гоблина', 'не хочу боя', 'Уходим отсюда',
  '[РЕШЕНИЕ ГРУППЫ] Уходим из «Серый Причал» и идём в «Вейр»', '[РЕШЕНИЕ ГРУППЫ] Остаться и исследовать дальше', '[ГЛОБАЛЬНАЯ КАРТА] Норвин', '', '   ',
  'Иду в Норвин', 'Идём к Старому маяку', 'Возвращаемся в таверну', 'Что мы уже знаем?', 'Что было раньше?', 'Помню ли я этого человека?',
]

function statePhrases(state) {
  const names = [...(state.social?.npcs ?? []).map((entry) => entry?.name), ...(state.worldMap?.locations ?? []).map((entry) => entry?.name)].filter((name) => typeof name === 'string' && name).slice(0, 6)
  const result = []
  for (const name of names) {
    result.push(pick([`Кто такой ${name}?`, `Идём в ${name}`, `Что мы знаем о ${name}?`, `Уходим к ${name}`, `Есть ли тут ${name}?`, `Иду к ${name}`]))
  }
  return result
}

// Зацепки: ответ модели.
const CLUES = [
  'Марен видел, как в ночь пропажи Илы у маяка горел чужой фонарь.',
  'Капитан стражи брал серебро у хозяина ночных лодок у маяка.',
  'Коротко.',
  'Илу видели на борту баркаса «Чайка» через 3 дня после бури.',
  'Брат ушёл с караваном, который сделал проверку у заставы и исчез в Вейре.',
  'На маяке хранится журнал смотрителя с записями о каждой ночной лодке за последние годы, и в нём есть страница о сестре героя, вырванная кем-то, кто боялся правды о ней; кроме того, журнал описывает три тайника вдоль побережья, а в каждом лежит по карте.',
]

// --- случаи функций -------------------------------------------------------------------

const cases = []
function run(fn, args, invoke, src) {
  const recorded = args.map((value) => (value && typeof value === 'object' && '$state' in value ? value : plain(value)))
  const undef = args.map((value, index) => (value === undefined ? index : -1)).filter((index) => index >= 0)
  const resolved = args.map((value) => (value && typeof value === 'object' && '$state' in value ? stateOf(value.$state) : clone(value)))
  const entry = { fn, src, args: recorded.map((value) => value ?? null), ...(undef.length ? { undef } : {}) }
  try {
    const out = invoke(...resolved)
    entry.out = plain(out) ?? null
  } catch (error) {
    entry.throws = errorOf(error)
  }
  cases.push(entry)
}

const encodeMap = (map) => [...map.entries()].map(([key, value]) => [key, value])

const FUNCTIONS = {
  answerTableQuestion: (...args) => router.answerTableQuestion(...args),
  answerVisibleScene: (...args) => router.answerVisibleScene(...args),
  selectAgentRole: (...args) => router.selectAgentRole(...args),
  roleAllowsWorldTools: (...args) => router.roleAllowsWorldTools(...args),
  partyOptionLabel: (...args) => router.partyOptionLabel(...args),
  unknownDestinationReply: (action, state, options) => router.unknownDestinationReply(action, state, options?.revealedOnly ? { isRevealed: (prop) => prop?.revealed !== false } : {}),
  proposeAgentInteraction: (...args) => router.proposeAgentInteraction(...args),
  proposeRoutedTravel: (...args) => router.proposeRoutedTravel(...args),
  answerKnownLore: (...args) => router.answerKnownLore(...args),
  resolvePartyDecision: (...args) => router.resolvePartyDecision(...args),
  buildDirectorPlanningBrief: (...args) => architect.buildDirectorPlanningBrief(...args),
  interpretResolvedPartyDecision: (...args) => architect.interpretResolvedPartyDecision(...args),
  knownDestinationsFrom: (...args) => architect.knownDestinationsFrom(...args),
  fallbackDirectorIntent: (...args) => director.fallbackDirectorIntent(...args),
  isMoraleMoment: (...args) => npc.isMoraleMoment(...args),
  commandsForMoraleDecision: (...args) => npc.commandsForMoraleDecision(...args),
  heroHookThreadId: (...args) => hooks.heroHookThreadId(...args),
  heroHookIdempotencyKey: (...args) => hooks.heroHookIdempotencyKey(...args),
  heroHookFacts: (...args) => hooks.heroHookFacts(...args),
  heroNeedsHooks: (...args) => hooks.heroNeedsHooks(...args),
  heroesNeedingHooks: (...args) => hooks.heroesNeedingHooks(...args),
  heroHooksBrief: (...args) => hooks.heroHooksBrief(...args),
  normalizeHeroHookProposals: (...args) => encodeMap(hooks.normalizeHeroHookProposals(...args)),
  heroHookCommands: (...args) => hooks.heroHookCommands(...args),
  partyMotivesForDirector: (...args) => hooks.partyMotivesForDirector(...args),
}

// Перехват тестов JS.
const TESTS = [
  'agent-context', 'authored-location-maps', 'campaign-dialogues', 'campaign-loop-policy', 'campaign-scenario', 'combat-entry-routing', 'director-agent', 'director-three-scenes',
  'discovery-content', 'evening-campaign', 'free-text-travel', 'generated-map-consistency', 'hero-hooks', 'injection-surfaces', 'intent-routing', 'journal-quests', 'level-generator',
  'llm-json-schemas', 'llm-refusal-fallback', 'lore-voice', 'narrator-dialogue-routing', 'npc-turn-scheduler', 'objective-continues', 'party-exit-intent', 'player-request-router',
  'playtest-dead-ends', 'post-commit-coordinator', 'prompt-descriptors', 'scenario-attention', 'scenario-finale', 'scenario-items', 'scenario-knight', 'scenario-narrator',
  'scenario-progression', 'scene-architect', 'scene-memory', 'world-memory-delivery', 'world-memory',
]
const TARGETS = {
  '/server/player-request-router.mjs': ['answerTableQuestion', 'answerVisibleScene', 'selectAgentRole', 'partyOptionLabel', 'unknownDestinationReply', 'proposeAgentInteraction', 'proposeRoutedTravel', 'answerKnownLore', 'resolvePartyDecision', 'roleAllowsWorldTools'],
  '/server/scene-architect.mjs': ['buildDirectorPlanningBrief', 'interpretResolvedPartyDecision', 'knownDestinationsFrom', 'SceneArchitectAgent.prototype.plan'],
  '/server/director-agent.mjs': ['fallbackDirectorIntent', 'DirectorAgent.prototype.choose'],
  '/server/npc-controller.mjs': ['isMoraleMoment', 'commandsForMoraleDecision', 'NpcMoraleAgent.prototype.decide'],
  '/server/hero-hooks.mjs': ['heroHookThreadId', 'heroHookIdempotencyKey', 'heroHookFacts', 'heroNeedsHooks', 'heroesNeedingHooks', 'heroHooksBrief', 'normalizeHeroHookProposals', 'heroHookCommands', 'partyMotivesForDirector', 'HeroHookWeaver.prototype.weave'],
}
// `SK_A2_CAPTURE_CACHE=<файл>` — перехват один раз на диск (отладка генератора).
const cacheFile = process.env.SK_A2_CAPTURE_CACHE
const captured = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : await captureTests(TESTS, TARGETS, { limit: 300 })
if (cacheFile && !existsSync(cacheFile)) writeFileSync(cacheFile, JSON.stringify(captured))
const capturedRoles = []
for (const record of captured) {
  const args = argsFrom(record)
  if (record.fn.includes('.prototype.')) {
    capturedRoles.push({ cls: record.fn.split('.')[0], options: args[0] ?? {}, test: record.test })
    continue
  }
  if (!FUNCTIONS[record.fn]) continue
  const keepCells = record.fn === 'isMoraleMoment' || record.fn === 'commandsForMoraleDecision'
  run(record.fn, args.map((value) => (isStateLike(value) ? ref(addState(trim(value, { keepCells }))) : value)), FUNCTIONS[record.fn], `test:${record.test}`)
}
console.log(`перехвачено вызовов: ${captured.length}, ролей: ${capturedRoles.length}`)

// Корпус и синтетика.
const LOOKUP_STATES = [...corpus, ...synthetic]
for (const index of LOOKUP_STATES) {
  const state = states[index]
  const phrases = [...new Set([...Array.from({ length: 6 }, () => pick(PHRASES)), ...Array.from({ length: 8 }, () => pick(SYNTH_PHRASES)), ...statePhrases(state)])]
  const src = corpus.includes(index) ? 'corpus' : 'synthetic'
  const clock = chance(0.5) ? { time_of_day_label: pick(['Вечер', '']), clock: '19:40', indoors: chance(0.5), weather_label: 'Мелкий дождь', weather_summary: pick(['идёт мелкий дождь…', '']) } : undefined
  for (const phrase of phrases) {
    run('selectAgentRole', [phrase], FUNCTIONS.selectAgentRole, src)
    run('answerTableQuestion', [phrase, ref(index), { worldClock: clock }], FUNCTIONS.answerTableQuestion, src)
    run('answerVisibleScene', [phrase, ref(index)], FUNCTIONS.answerVisibleScene, src)
    const viewer = chance(0.5) ? { playerId: state.players?.[0]?.id, isPartyMember: true } : undefined
    run('answerKnownLore', [phrase, ref(index), chance(0.7) ? { viewer, actorId: state.players?.[0]?.id } : undefined], FUNCTIONS.answerKnownLore, src)
    run('proposeAgentInteraction', [phrase, ref(index), { sourceText: chance(0.3) ? phrase : '', actorName: chance(0.5) ? 'Ила' : '' }], FUNCTIONS.proposeAgentInteraction, src)
    run('unknownDestinationReply', [phrase, ref(index), { revealedOnly: chance(0.3) }], FUNCTIONS.unknownDestinationReply, src)
    run('resolvePartyDecision', [phrase, ref(index)], FUNCTIONS.resolvePartyDecision, src)
    run('interpretResolvedPartyDecision', [phrase, ref(index)], FUNCTIONS.interpretResolvedPartyDecision, src)
    run('partyOptionLabel', [`Уходим из «${state.scene?.location ?? ''}» и идём ${phrase} к «${pick(PLACES)}»`, pick([100, 40, 64, undefined])], FUNCTIONS.partyOptionLabel, src)
    if (chance(0.3)) run('fallbackDirectorIntent', [ref(index), phrase], FUNCTIONS.fallbackDirectorIntent, src)
  }
  const destination = pick([...(state.worldMap?.locations ?? []).map((entry) => entry?.name), 'Вейр', 'старый склеп', '', 'смотровая дамба', undefined])
  run('proposeRoutedTravel', [{ route: pick(['travel', 'talk']), destination }, ref(index), pick(PHRASES), pick(['', 'Ила'])], FUNCTIONS.proposeRoutedTravel, src)
  run('knownDestinationsFrom', [ref(index)], FUNCTIONS.knownDestinationsFrom, src)
  run('buildDirectorPlanningBrief', [ref(index)], FUNCTIONS.buildDirectorPlanningBrief, src)
  run('fallbackDirectorIntent', [ref(index), ''], FUNCTIONS.fallbackDirectorIntent, src)
  run('partyMotivesForDirector', [ref(index)], FUNCTIONS.partyMotivesForDirector, src)
  run('heroesNeedingHooks', [ref(index)], FUNCTIONS.heroesNeedingHooks, src)
  const heroIds = (state.players ?? []).map((hero) => hero?.id)
  for (const heroId of heroIds) {
    run('heroNeedsHooks', [ref(index), heroId], FUNCTIONS.heroNeedsHooks, src)
    run('heroHookFacts', [ref(index), heroId], FUNCTIONS.heroHookFacts, src)
    run('heroHookThreadId', [heroId], FUNCTIONS.heroHookThreadId, src)
  }
  run('heroHookFacts', [ref(index), ''], FUNCTIONS.heroHookFacts, src)
  run('heroHooksBrief', [ref(index), heroIds.map(String)], FUNCTIONS.heroHooksBrief, src)
  const raw = heroHookRaw(state)
  run('normalizeHeroHookProposals', [raw, ref(index), heroIds.map(String)], FUNCTIONS.normalizeHeroHookProposals, src)
  for (const [heroId, proposal] of hooks.normalizeHeroHookProposals(raw, stateOf(index), heroIds.map(String))) {
    run('heroHookCommands', [ref(index), heroId, proposal], FUNCTIONS.heroHookCommands, src)
  }
  for (const enemy of (state.enemies ?? []).slice(0, 3)) {
    run('isMoraleMoment', [ref(index), enemy?.id], FUNCTIONS.isMoraleMoment, src)
  }
}

function heroHookRaw(state) {
  const ids = (state.players ?? []).map((hero) => String(hero?.id))
  const npcNames = (state.social?.npcs ?? []).map((entry) => entry?.name)
  const heroes = [...ids, 'stranger'].map((heroId) => ({
    hero_id: chance(0.1) ? ` ${heroId} ` : heroId,
    motive: pick(['Найти сестру Илу', 'Понять, что скрывал капитан', 'Найти журнал смотрителя маяка', '', 'Отомстить за 3 года', 'Ok', undefined]),
    hooks: Array.from({ length: int(4) }, () => ({
      topic: pick(['пропавшая сестра Ила', 'ночные лодки у маяка', '', 'СЛ 15 проверка', 'x'.repeat(130)]),
      clue: pick(CLUES),
      skills: pick([['investigation', 'insight'], ['perception'], [], ['Sleight of Hand', 'bogus']]),
      holder: pick([...npcNames, 'Незнакомец', '']),
    })),
  }))
  if (chance(0.1)) return pick([null, {}, { heroes: 'x' }, []])
  return { heroes }
}

// Мораль: враги на пороге и бегство по настоящим картам корпуса.
for (const index of combatCorpus) {
  const state = stateOf(index)
  for (const enemy of (state.enemies ?? []).slice(0, 2)) {
    if (!enemy?.id) continue
    const low = clone(state)
    const target = low.enemies.find((entry) => entry.id === enemy.id)
    target.hp = Math.max(1, Math.floor((Number(target.maxHp ?? target.max_hp) || 10) * pick([0.1, 0.25, 0.3, 0.5])))
    target.alive = true
    const lowIndex = addState(low)
    run('isMoraleMoment', [ref(lowIndex), enemy.id], FUNCTIONS.isMoraleMoment, 'corpus-morale')
    for (const disposition of ['fight', 'flee', 'surrender', 'bogus']) {
      run('commandsForMoraleDecision', [ref(lowIndex), enemy.id, { disposition }, chance(0.5) ? [{ command_type: 'MakeAttack', actor_id: enemy.id }] : undefined], FUNCTIONS.commandsForMoraleDecision, 'corpus-morale')
    }
  }
}

// Мусор старых сохранений.
const GARBAGE = [{}, { scene: null }, { scene: 'x' }, { players: 'x', enemies: {}, social: [] }, { worldMap: { locations: 'x' } }, { worldMap: { locations: [null, 1, { id: 'a' }], routes: [null, { from: 'a', to: 'b' }] } }, { worldMemory: { facts: [null, 1, 'x'] } }, { agentInteraction: { options: [{ label: 'Уходим в Вейр' }] } }]
for (const garbage of GARBAGE) {
  const index = addState(garbage)
  for (const fn of ['knownDestinationsFrom', 'buildDirectorPlanningBrief', 'fallbackDirectorIntent', 'partyMotivesForDirector', 'heroesNeedingHooks']) run(fn, [ref(index)], FUNCTIONS[fn], 'garbage')
  for (const phrase of ['Что я вижу?', 'Уходим в Вейр', '[РЕШЕНИЕ ГРУППЫ] Уходим', 'Куда нам идти дальше?', 'Что мы знаем о маяке?']) {
    for (const fn of ['answerKnownLore', 'proposeAgentInteraction', 'unknownDestinationReply', 'resolvePartyDecision', 'answerTableQuestion']) run(fn, [phrase, ref(index)], FUNCTIONS[fn], 'garbage')
  }
}
for (const value of [null, undefined, 42, 'x'.repeat(150), '«Таверна «Ржавый Якорь» на краю очень длинного и запутанного названия места, которое никак не помещается в подпись»', 'Уходим   в\nВейр']) {
  run('partyOptionLabel', [value], FUNCTIONS.partyOptionLabel, 'garbage')
  run('heroHookThreadId', [value], FUNCTIONS.heroHookThreadId, 'garbage')
  run('heroHookIdempotencyKey', [value], FUNCTIONS.heroHookIdempotencyKey, 'garbage')
}
for (const role of ['worldkeeper', 'director', 'game_master', '']) run('roleAllowsWorldTools', [role], FUNCTIONS.roleAllowsWorldTools, 'synthetic')
console.log(`случаев функций: ${cases.length}`)

// --- роли с заглушкой модели ---------------------------------------------------------------

class RecordingLLM {
  constructor(replies, model) {
    this.replies = [...replies]
    this.calls = []
    if (model !== undefined) this.model = model
  }

  async completeJson(input, options) {
    this.calls.push({ input: plain(input), options: plain(options ?? {}) })
    const reply = this.replies.shift()
    if (!reply) throw new LLMError('У FakeLLM закончились ответы', 'FAKE_LLM_EXHAUSTED')
    if (reply.error) {
      const error = new Error(reply.error.message)
      error.name = reply.error.name
      if (reply.error.code != null) error.code = reply.error.code
      throw error
    }
    return clone(reply.json)
  }
}

function jsonError(text) {
  try {
    strictJsonParse(text, { label: 'JSON content', expected: 'object' })
    return null
  } catch (error) {
    return errorOf(error)
  }
}
const ERRORS = [
  jsonError('{"type": "continue_expl'),
  jsonError('```json\n{"type":"x"}\n```'),
  jsonError('{"__proto__": {"x": 1}}'),
  errorOf(new LLMTimeoutError(12000)),
  { name: 'LLMError', code: 'LLM_REFUSAL', message: 'Модель отказалась отвечать' },
  { name: 'TypeError', code: null, message: 'fetch failed' },
]
const errorReply = () => ({ error: pick(ERRORS) })

const roles = []
const shown = {}
async function role(cls, args, replies, invoke, src, { model = 'stub-model', withClient = true } = {}) {
  const llm = withClient ? new RecordingLLM(replies, model) : null
  const entry = { cls, src, args: args.map((value) => plain(value) ?? null), replies: withClient ? replies : null, model: withClient ? (model ?? null) : null }
  try {
    entry.out = plain(await invoke(llm)) ?? null
  } catch (error) {
    entry.throws = errorOf(error)
  }
  const calls = llm?.calls ?? []
  entry.calls_hash = hash(calls)
  shown[cls] = (shown[cls] ?? 0) + 1
  if (shown[cls] <= 3) entry.calls = calls
  roles.push(entry)
}
const resolve = (value) => (value && typeof value === 'object' && '$state' in value ? stateOf(value.$state) : clone(value))

// Режиссёр.
const directorReplies = () => pick([
  { json: { type: 'continue_exploration', reason: 'Сначала осмотреться' } },
  { json: { type: 'request_encounter', theme: 'beasts', difficulty: 'hard', reason: 'Засада' } },
  { json: { type: 'offer_next_hook', hook: 'Огонь на маяке', reason: 'Темп' } },
  { json: { type: 'end_scene', destination: 'Вейр', reason: 'Пора' } },
  { json: { type: 'teleport', reason: 'x' } },
  { json: { type: 'continue_exploration', damage: 10 } },
  { json: { type: 'continue_exploration', extra: 'поле' } },
  { json: { type: 'open_social_scene', npc_id: 'bad id!' } },
  { json: null },
  { json: [] },
  errorReply(),
])
const directorStates = [...LOOKUP_STATES.filter(() => chance(0.5)), ...capturedRoles.filter((entry) => entry.cls === 'DirectorAgent').map((entry) => addState(trim(plain(entry.options.state ?? {}), { keepCells: entry.cls === 'NpcMoraleAgent' })))]
for (const index of directorStates) {
  const action = pick(['', 'ищем бой', 'Перейти', 'Осматриваемся', 'не хочу боя', ...PHRASES])
  const mode = pick(['story', 'chaos', undefined, 'CHAOS', 'bogus'])
  const replies = [directorReplies()]
  const withClient = chance(0.85)
  await role('DirectorAgent', [ref(index), action, mode], replies,
    (llm) => new director.DirectorAgent({ llmClient: llm }).choose({ state: resolve(ref(index)), playerAction: action, improvMode: mode }), 'mixed', { withClient })
}

// Мораль NPC.
const moraleReplies = () => pick([
  { json: { disposition: 'flee', reaction: 'Бросает\nщит и бежит', confidence: 0.8 } },
  { json: { disposition: 'surrender', reaction: 'Сдаюсь!', confidence: '2' } },
  { json: { disposition: 'fight', reaction: 'x'.repeat(300), confidence: -1, extra: true } },
  { json: { disposition: 'dance' } },
  { json: null },
  errorReply(),
])
const moraleStates = cases.filter((entry) => entry.fn === 'isMoraleMoment' && entry.out === true).map((entry) => [entry.args[0], entry.args[1]])
for (const entry of capturedRoles.filter((item) => item.cls === 'NpcMoraleAgent')) moraleStates.push([ref(addState(trim(plain(entry.options.state ?? {}), { keepCells: entry.cls === 'NpcMoraleAgent' }))), entry.options.enemyId])
for (const [stateRef, enemyId] of moraleStates.slice(0, 400)) {
  for (const withClient of [true, chance(0.3) ? false : true]) {
    await role('NpcMoraleAgent', [stateRef, enemyId], [moraleReplies()],
      (llm) => new npc.NpcMoraleAgent({ llmClient: llm }).decide({ state: resolve(stateRef), enemyId }), 'morale', { withClient, model: undefined })
  }
}

// Архитектор сцены.
function architectReply(state) {
  const names = (state.worldMap?.locations ?? []).map((entry) => entry?.name).filter(Boolean)
  return {
    json: {
      title: pick(['Глава 7 · Новое место', 'Берег', '', undefined]),
      location: pick([...names, 'Выдуманный утёс', '', undefined, state.scene?.location]),
      mood: pick(['Тревожно', '']),
      objective: pick(['Найти журнал', 'Продолжить путь из Вейр к «Норвин»', '']),
      transition: pick(['Через два часа отряд выходит к берегу.', 'Прежняя цель остаётся незавершённой.', 'Отряд идёт берегом.', '']),
      arrival: pick(['Спустя три дня путники видят башню.', 'Впереди — огни.', '']),
      hook: pick(['Огонь на скале', '']),
      theme: pick(['морской берег', '']),
      danger: pick(['низкая', 'высокая', 'нет']),
      outcome: pick(['Отряд не закрыл прежнюю нить.', 'Пришли.', '']),
      levels: pick([undefined, [{ offset: 1, hint: 'чердак' }, { offset: 0 }, { offset: -1, hint: 'подвал' }, { offset: 1 }], 'x']),
      secrets: pick([undefined, [{ clue: 'Под третьей ступенью маяка спрятан ключ от склада.', topic: 'ключ', skills: ['investigation'], holder: 'Марен' }, { clue: 'коротко' }]]),
      map: pick([undefined, 'x', {
        layout: pick(['rooms', 'streets', 'maze']), scale: pick(['room', 'site', 'stronghold', 'region', 'galaxy']), pattern: pick(['keep', 'crypt', 'spiral']),
        material: pick(['stone', 'ice', 'cheese']), width: pick([5, 30, 100, '20', 18.5, null]), height: pick([5, 30, 100, null]), openness: pick([0.1, 0.5, 0.9, '0.6', null, 'x']),
        water: pick([0.5, 0.1, null]), featureCount: pick([1, 5, 20, null]), theme_id: pick(['tavern', 'bogus', undefined, 5]),
        design: pick([undefined, { landmarks: [{ kind: 'well', role: 'focus' }, { kind: 'campfire', role: 'npc_post', npc: 'Марен', count: 2 }, { id: 'altar', role: 'clue', count: 9 }, { id: 'lighthouse' }] }, { settlement_kind: 'port', landmarks: [{ id: 'market_stall' }] }, { landmarks: 'x' }]),
      }]),
      shop_intent: pick([undefined, { kind: 'general' }, 'x']),
    },
  }
}
const architectStates = [...LOOKUP_STATES.filter(() => chance(0.6)), ...capturedRoles.filter((entry) => entry.cls === 'SceneArchitectAgent').map((entry) => addState(trim(plain(entry.options.state ?? {}), { keepCells: entry.cls === 'NpcMoraleAgent' })))]
const capturedPlans = new Map(capturedRoles.filter((entry) => entry.cls === 'SceneArchitectAgent').map((entry) => [JSON.stringify(trim(plain(entry.options.state ?? {}))), entry.options]))
for (const index of architectStates) {
  const state = states[index]
  const names = (state.worldMap?.locations ?? []).map((entry) => entry?.name).filter((name) => typeof name === 'string' && name)
  const ids = (state.worldMap?.locations ?? []).map((entry) => entry?.id).filter(Boolean)
  const capturedOptions = capturedPlans.get(JSON.stringify(state))
  const hintName = pick([...names, '']) ?? ''
  const options = capturedOptions ? { ...plain(capturedOptions), state: undefined } : {
    action: pick([`[РЕШЕНИЕ ГРУППЫ] Уходим и идём в «${hintName}»`, 'Печать архивариуса', '', ...PHRASES.slice(0, 5)]),
    decision: pick([`Уходим в «${hintName}»`, 'Остаться', '']),
    destinationHint: pick([hintName, hintName ? `к ${hintName}у` : '', 'старый склеп', 'город', 'лес', 'Выдуманный утёс', '']),
    destinationLocationId: pick([...ids.map(String), '', 'bogus']),
    abandonsQuest: chance(0.2),
  }
  for (const withClient of [false, true]) {
    if (!withClient && chance(0.5)) continue
    const replies = [chance(0.85) ? architectReply(state) : errorReply()]
    await role('SceneArchitectAgent', [ref(index), options], replies,
      (llm) => new architect.SceneArchitectAgent({ llmClient: llm }).plan({ ...clone(options), state: resolve(ref(index)) }), 'mixed', { withClient })
  }
}

// Плетение зацепок: два плетения подряд на одном ткаче (попытки, пауза).
const weaveStates = [...synthetic, ...corpus.filter(() => chance(0.3)), ...capturedRoles.filter((entry) => entry.cls === 'HeroHookWeaver').map((entry) => addState(trim(plain(entry.options.state ?? {}), { keepCells: entry.cls === 'NpcMoraleAgent' })))]
for (const index of weaveStates) {
  const state = states[index]
  const heroIds = chance(0.3) ? (state.players ?? []).map((hero) => hero?.id) : undefined
  const times = [1_000, pick([1_500, 70_000, 200_000])]
  const config = { maxAttemptsPerHero: pick([undefined, 1, 3, '2', 0]), retryMs: pick([undefined, 60_000, 0, 'x']) }
  const replies = [chance(0.8) ? { json: heroHookRaw(state) } : errorReply(), { json: heroHookRaw(state) }]
  await role('HeroHookWeaver', [ref(index), 'CAMP', heroIds ?? null, config, times], replies, async (llm) => {
    let tick = 0
    const weaver = new hooks.HeroHookWeaver({ llmClient: llm, ...config, now: () => times[Math.min(tick, times.length - 1)] })
    const first = await weaver.weave({ state: resolve(ref(index)), campaignId: 'CAMP', heroIds })
    tick = 1
    const pending = weaver.pendingHeroIds(resolve(ref(index)), 'CAMP')
    const left = (state.players ?? []).map((hero) => weaver.attemptsLeft('CAMP', String(hero?.id)))
    const second = await weaver.weave({ state: resolve(ref(index)), campaignId: 'CAMP' })
    return { first, pending, left, second }
  }, 'mixed', { withClient: chance(0.9) })
}
console.log(`вызовов ролей: ${roles.length}`)

writeFixture(FIXTURE, { states, cases, roles }, { gzip: true })
