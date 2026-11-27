import '../../../fixtures-env.mjs'
// Эталон server/scene-memory.mjs для Rust:
//
//   node rust/crates/sk-director/fixtures/gen-scene-memory.mjs
//
// Секция `calls` (`scene-memory.json.gz`): `questTitleFromObjective`,
// `ensureSceneWorldMemory`, `sceneWorldMemoryEventId`,
// `sceneWorldMemoryEvents` — вызовы тестов JS (перехват: память сцены,
// переходы движка, три сцены Режиссёра, сценарий, вечерняя кампания) и
// случайные состояния, переходы, заготовки ведущего, тайны сценария и мусор.
// Состояние урезано до полей, которые читает модуль; урезанное проверено тем
// же исходом.
import { argsFrom, argsOf, captureTests, errorOf, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const sm = await import(new URL('server/scene-memory.mjs', root).href)
const { buildCampaignArcPlan } = await import(new URL('server/campaign-loop-policy.mjs', root).href)

const FIXTURE = new URL('./scene-memory.json.gz', import.meta.url)
const { int, pick, chance } = picker(mulberry32(2026_10_16_3))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const FNS = ['questTitleFromObjective', 'ensureSceneWorldMemory', 'sceneWorldMemoryEventId', 'sceneWorldMemoryEvents']
const STATE_KEYS = ['worldMemory', 'scene', 'adventure', 'campaignConcept']

const trimScene = (scene) => (scene && typeof scene === 'object' && !Array.isArray(scene)
  ? Object.fromEntries(Object.entries(scene).filter(([field]) => ['location', 'title', 'objective', 'mood'].includes(field)))
  : scene)
const calls = []
const seen = new Set()
function add(fn, args, label) {
  const run = (encoded) => {
    try {
      const value = sm[fn](...argsFrom(encoded))
      return { out: value === undefined ? null : plain(value) }
    } catch (error) {
      return { error: errorOf(error) }
    }
  }
  let encoded = argsOf(args)
  const key = JSON.stringify([fn, encoded])
  if (seen.has(key)) return
  seen.add(key)
  const outcome = run(encoded)
  const at = fn === 'sceneWorldMemoryEvents' ? 0 : fn === 'ensureSceneWorldMemory' ? 1 : -1
  const state = encoded.args[at]
  if (at >= 0 && state && typeof state === 'object' && !Array.isArray(state)) {
    const trimmed = Object.fromEntries(Object.entries(state).filter(([field]) => STATE_KEYS.includes(field)).map(([field, value]) => [field, field === 'scene' ? trimScene(value) : value]))
    const candidate = { ...encoded, args: encoded.args.map((value, index) => (index === at ? trimmed : value)) }
    if (JSON.stringify(run(candidate)) === JSON.stringify(outcome)) encoded = candidate
  }
  // Переход: из сцены — место, заголовок, цель и настроение; из приключения —
  // глава, нить и история.
  const transition = encoded.args[1]
  if (fn === 'sceneWorldMemoryEvents' && transition && typeof transition === 'object' && !Array.isArray(transition)) {
    const trimmed = { ...transition }
    if ('scene' in trimmed) trimmed.scene = trimScene(trimmed.scene)
    for (const field of Object.keys(trimmed)) if (!['scene', 'adventure', 'transition', 'arrival'].includes(field)) delete trimmed[field]
    const candidate = { ...encoded, args: encoded.args.map((value, index) => (index === 1 ? trimmed : value)) }
    if (JSON.stringify(run(candidate)) === JSON.stringify(outcome)) encoded = candidate
  }
  calls.push({ fn, label, ...encoded, ...outcome })
}

// --- перехват тестов ---------------------------------------------------------------------

const captured = await captureTests(
  ['scene-memory', 'scene-transition-engine', 'director-three-scenes', 'campaign-scenario', 'evening-campaign', 'persistent-campaign'],
  { '/server/scene-memory.mjs': FNS },
  { limit: 150 },
)
console.log(`перехвачено вызовов: ${captured.length}`)
for (const record of captured) add(record.fn, argsFrom(record), `test/${record.test}`)

// --- случайные входы ------------------------------------------------------------------------

const JUNK = [undefined, null, '', '  ', 'строка', 5, 0, 1.5, true, [], {}, ['a'], 'constructor']
const junk = () => pick(JUNK)
const PLACES = ['Старый Брод', 'старый брод', ' Ольшанка ', 'Склеп Норвин', '', undefined, 'Б'.repeat(200), 5]
const OBJECTIVES = ['Найти печать', 'Продолжить квест «Найти печать»', 'Продолжить квест «Продолжить квест «Найти печать»»',
  'Развить последствия победы в квесте «Мост» и приблизить развязку', 'Ответить на последствия провала квеста «Обоз» и найти новый путь', '', undefined, '  Найти   печать ', 5]
const VIS = ['party', 'public', 'gm_only', undefined]

function randomMemory() {
  if (chance(0.08)) return junk()
  return {
    entities: Array.from({ length: int(5) }, (_, index) => ({
      id: pick([`location:${index}`, `npc:${index}`, '']), kind: pick(['location', 'npc', 'faction']), name: pick(PLACES.filter((place) => typeof place === 'string' && place)),
      summary: pick(['Деревня.', '', undefined]), aliases: pick([['Брод'], [], undefined]), visibility: pick(VIS), tags: pick([['visited'], ['old', 'visited'], [], undefined]),
    })),
    quests: Array.from({ length: int(4) }, (_, index) => ({
      id: pick([`quest:chapter:${index + 1}`, `quest:main`, `quest:${index}`]), title: 'Задание', summary: pick(['Итог', '']), status: pick(['active', 'completed', 'failed']),
      visibility: pick(VIS), entity_ids: pick([[], ['location:0']]), objectives: pick([['Найти печать'], ['Другое'], []]),
      clock: { current: 1, max: 4, label: 'Прогресс', triggered: false },
    })),
    facts: Array.from({ length: int(3) }, (_, index) => ({ id: `fact-${index}`, subject_id: 'location:0', predicate: 'state', object: 'x', summary: 'Факт.', status: 'active', visibility: 'party' })),
  }
}

function randomState() {
  if (chance(0.04)) return pick([null, 5, 'state', []])
  const state = {}
  if (chance(0.85)) state.worldMemory = randomMemory()
  if (chance(0.9)) {
    state.scene = chance(0.95) ? {
      ...(chance(0.8) ? { location: pick(PLACES) } : {}), ...(chance(0.5) ? { title: pick(['Глава 1', '', undefined]) } : {}),
      ...(chance(0.6) ? { objective: pick(OBJECTIVES) } : {}), ...(chance(0.4) ? { mood: pick(['Холод', '', undefined]) } : {}),
    } : junk()
  }
  if (chance(0.8)) state.adventure = { chapter: pick([1, 2, 3, '2', 0, 1000, 2.5, null, undefined]), ...(chance(0.5) ? { currentHook: pick(['Нить печати', '', 5]) } : {}) }
  if (chance(0.4)) {
    state.campaignConcept = pick([{ campaign_mode: 'persistent' }, { arc: clone(buildCampaignArcPlan(pick(['a', 'b']), pick([1, 3]))) }, { arc: { chapter_clock_max: pick([2, 0, '3', null]) } }, {}])
  }
  return state
}

function randomTransition() {
  if (chance(0.06)) return junk()
  const transition = {}
  if (chance(0.9)) {
    transition.scene = { ...(chance(0.9) ? { location: pick(PLACES) } : {}), ...(chance(0.4) ? { title: 'Глава 2' } : {}), ...(chance(0.7) ? { objective: pick(OBJECTIVES) } : {}), ...(chance(0.4) ? { mood: 'Ветер' } : {}) }
  }
  if (chance(0.9)) {
    transition.adventure = {
      chapter: pick([2, 3, '4', null, undefined, 0]),
      ...(chance(0.6) ? { currentHook: pick(['Новая нить', '']) } : {}),
      history: Array.from({ length: int(3) }, () => (chance(0.1) ? pick([null, 5]) : { status: pick(['completed', 'abandoned', 'continued', 'unresolved', undefined]), outcome: pick(['Печать найдена.', '', undefined]) })),
    }
  }
  if (chance(0.6)) transition.transition = pick(['Отряд идёт по тракту.', '', 'Т'.repeat(1200)])
  if (chance(0.6)) transition.arrival = pick(['Впереди мост.', '', undefined])
  return transition
}

function randomOptions() {
  if (chance(0.06)) return pick([null, undefined])
  const options = {}
  if (chance(0.8)) options.commandId = pick(['cmd-1', 'cmd-2', '', null, 5, 'к'.repeat(300)])
  if (chance(0.5)) options.sourceEventId = pick(['event-1', '', null])
  if (chance(0.5)) {
    options.secrets = pick([
      [{ clue: 'Под полом таверны спрятан ключ от склепа.', topic: 'ключ', skills: ['investigation', 'Sleight of Hand', 'nope'] }, { clue: 'коротко' }, null, 5],
      [{ clue: 'Мельник видел чужаков у брода ночью.', holder: 'Мельник' }, { clue: 'Ещё одна тайна, длинная достаточно.' }, { clue: 'Третья тайна про старый мост.' }, { clue: 'Четвёртая тайна не войдёт в лимит.' }],
      'x', null,
    ])
  }
  if (chance(0.4)) {
    options.scenarioSecrets = pick([
      [{ fact_id: 'fact:secret:scenario:test:clue-1', clue: 'След ведёт к логову.', topic: 'логово', skills: ['survival'] }],
      [{ clue: 'Без id.' }], [], 'ab', [null],
    ])
  }
  return options
}

for (let index = 0; index < 900; index += 1) {
  const label = `random/${index}`
  const roll = int(10)
  if (roll === 0) add('questTitleFromObjective', [chance(0.8) ? pick(OBJECTIVES) : junk()], label)
  else if (roll === 1) add('sceneWorldMemoryEventId', [chance(0.8) ? pick(['cmd-1', 'advance-scene-3', '  x  ', '']) : junk()], label)
  else if (roll <= 4) {
    const state = randomState()
    add('ensureSceneWorldMemory', chance(0.9) ? [state?.worldMemory ?? randomMemory(), state] : [undefined, state], label)
  } else {
    const args = [randomState(), randomTransition()]
    if (chance(0.9)) args.push(randomOptions())
    add('sceneWorldMemoryEvents', args, label)
  }
}
// Цель продолжается: стартовое задание с той же целью меняет её на остаток,
// скрытое задание — скрытым событием; тайна сценария без id и с навыками.
{
  const quests = [
    { id: 'quest:start', title: 'Старт', summary: '', status: 'active', visibility: 'gm_only', entity_ids: [], objectives: ['Добраться до дамбы', 'Другое'], clock: { current: 0, max: 4, label: 'x', triggered: false } },
    { id: 'quest:open', title: 'Открытое', summary: '', status: 'active', visibility: 'party', entity_ids: [], objectives: [' Добраться   до дамбы '], clock: { current: 0, max: 4, label: 'x', triggered: false } },
    { id: 'quest:done', title: 'Готово', summary: '', status: 'completed', visibility: 'party', entity_ids: [], objectives: ['Добраться до дамбы'], clock: { current: 4, max: 4, label: 'x', triggered: true } },
  ]
  const state = { worldMemory: { entities: [], quests, facts: [] }, scene: { location: 'Тракт', objective: 'Добраться до дамбы' }, adventure: { chapter: 1 } }
  for (const objective of ['Осмотреть дамбу', '']) {
    add('sceneWorldMemoryEvents', [state, { scene: { location: 'Дамба', objective }, adventure: { chapter: 1, history: [{ status: 'continued' }] } },
      { commandId: 'cmd-dam', scenarioSecrets: [{ clue: 'Без id, но с навыком.', skills: ['survival'] }, { fact_id: 'fact:secret:scenario:x:y', clue: 'С id.', skills: ['investigation'] }] }], `continued/${objective || 'empty'}`)
  }
  for (const skills of [undefined, null, 'survival', ['survival', 5]]) {
    add('sceneWorldMemoryEvents', [state, { scene: { location: 'Дамба' } }, { scenarioSecrets: [{ fact_id: 'f', clue: 'Тайна.', ...(skills === undefined ? {} : { skills }) }] }], `scenario-skills/${JSON.stringify(skills)}`)
  }
}
// Обёртка цели любой вложенности.
let wrapped = 'Найти печать'
for (let depth = 0; depth < 10; depth += 1) {
  wrapped = `Продолжить квест «${wrapped}»`
  add('questTitleFromObjective', [wrapped], `wrap/${depth}`)
}

const counts = {}
for (const call of calls) counts[`${call.fn}${call.error ? ':error' : ''}`] = (counts[`${call.fn}${call.error ? ':error' : ''}`] ?? 0) + 1
console.log(counts)
writeFixture(FIXTURE, { calls }, { gzip: true })
