import '../../../fixtures-env.mjs'
// Эталоны задачи А4 (`sk-agents`): `server/npc-social-controller.mjs`.
//
//   node rust/crates/sk-agents/fixtures/gen-a4.mjs [--corpus <каталог corpus-v1>]
//
// Три источника случаев `respond`:
//
// 1. тесты JS, где участвует роль: каждый запускается отдельным процессом с
//    `capture-a4.mjs`, который пишет вход, ответы модели, запросы к ней и итог
//    каждого вызова (`test/npc-social*.test.mjs`, `npc-knowledge-leads`,
//    `gm-secrets`, `world-deeds` и др.);
// 2. те же состояния тестов и состояния корпуса (`corpus-v1/states`, без
//    тяжёлых `locationMaps`/`battleLog`/`messages`) с разными NPC, героями,
//    вопросами, проверками и сценариями модели: корректный ответ, повтор
//    сказанного (повторная попытка и признание), круговая отсылка, лишние
//    поля, битая форма, отказ с кодом и без, обещание за границей, чужие id;
// 3. мусор: состояния и входы неверной формы.
//
// Модель — заглушка по сценарию (`{ value }`, `{ undef }` или `{ error }`).
// Системный промпт в записи — хешем (`sha256:<hex>`). Плюс прямые вызовы
// экспортов: `conversationLeads`, `freshReplyText`, `withoutCircularReferral`,
// `othersSaidNearby`. Состояния — в таблице по хешу. Выход — `a4.json.gz`.
//
// Часть тестов JS строит состояние с часами и `randomUUID`, поэтому повторный
// прогон меняет файл; эталон от этого не теряет силы — Rust сверяется с тем
// состоянием, которое записано рядом со случаем.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config' || specifier === 'dotenv') return { url: 'data:text/javascript,export default {}; export const config = () => ({});', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const storage = mkdtempSync(join(tmpdir(), 'sk-a4-'))
process.env.DND_STORAGE_DIR = storage
delete process.env.ROUTERAI_API_KEY

const controllerModule = await import('../../../../server/npc-social-controller.mjs')
const { NpcSocialController, conversationLeads, freshReplyText, withoutCircularReferral, othersSaidNearby } = controllerModule
const { ensureNpcSocialState, npcProfileAtWorldTime, npcSecretMeta } = await import('../../../../server/npc-social.mjs')

const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpusRoot = flag('--corpus', 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1')
const root = fileURLToPath(new URL('../../../../', import.meta.url))

let seed = 0x00a4_5eed
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
const sha = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({
  name: error?.name ?? 'Error',
  code: error?.code === undefined || error?.code === null ? null : String(error.code),
  message: String(error?.message ?? error),
})

function recordedCall(method, input, options) {
  const copy = plain(input)
  for (const message of copy?.messages ?? []) {
    if (message?.role === 'system') message.content = `sha256:${createHash('sha256').update(String(message.content)).digest('hex')}`
  }
  return { method, input: copy, options: plain(options ?? {}) ?? {} }
}

/** Заглушка модели по сценарию: `{ value }`, `{ undef }`, `{ error }`; кончились ответы — ошибка без кода. */
function scriptedClient(replies, model) {
  const calls = []
  let index = 0
  return {
    ...(model ? { model } : {}),
    calls,
    async completeJson(input, options) {
      calls.push(recordedCall('completeJson', input, options))
      const reply = replies[index++]
      if (!reply) throw new Error('Сценарий модели закончился')
      if (reply.error) throw Object.assign(new Error(reply.error.message ?? 'отказ'), reply.error.name ? { name: reply.error.name } : {}, reply.error.code ? { code: reply.error.code } : {})
      if (reply.undef) return undefined
      return structuredClone(reply.value)
    },
  }
}

// --- таблица состояний ----------------------------------------------------------

const states = {}
function stateRef(state) {
  const key = sha(state)
  if (!Object.hasOwn(states, key)) states[key] = plain(state) ?? null
  return key
}

// --- 1. тесты JS ------------------------------------------------------------------

const testFiles = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => readFileSync(join(root, 'test', name), 'utf8').includes('npc-social-controller'))
  .sort()
const capture = fileURLToPath(new URL('./capture-a4.mjs', import.meta.url))
const captured = []
const testSummary = []
for (const name of testFiles) {
  const out = join(storage, `capture-${name}.json`)
  const testStorage = mkdtempSync(join(tmpdir(), 'sk-a4-test-'))
  const env = { ...process.env, CAPTURE_OUT: out, DND_STORAGE_DIR: testStorage }
  delete env.ROUTERAI_API_KEY
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(capture).href, join('test', name)], { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  rmSync(testStorage, { recursive: true, force: true })
  const pass = /(?:#|ℹ) pass (\d+)/u.exec(run.stdout ?? '')?.[1]
  const fail = /(?:#|ℹ) fail (\d+)/u.exec(run.stdout ?? '')?.[1]
  const records = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
  testSummary.push(`${name}: ${records.length} вызовов, тесты pass ${pass} fail ${fail}`)
  for (const [index, record] of records.entries()) {
    const { state, ...rest } = record.input ?? {}
    captured.push({
      label: `${name}#${index}`,
      stateRef: state === undefined ? null : stateRef(state),
      input: rest,
      hasClient: record.hasClient, className: record.className, model: record.model,
      script: record.script, calls: record.calls,
      ...(Object.hasOwn(record, 'err') ? { err: record.err } : { out: record.out }),
    })
  }
}

// --- 2. корпус и состояния тестов -----------------------------------------------------

function corpusStates(limit, filter, step) {
  const dir = join(corpusRoot, 'states')
  if (!existsSync(dir)) return []
  const out = []
  const names = readdirSync(dir).sort()
  for (let index = 0; index < names.length && out.length < limit; index += step) {
    const file = join(dir, names[index])
    if (statSync(file).size > 400_000) continue
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (filter(state)) out.push(state)
  }
  return out
}

function trim(state) {
  const copy = structuredClone(state)
  for (const key of ['locationMaps', 'battleLog', 'messages', 'mapFeedback']) delete copy[key]
  return copy
}

const richCorpus = corpusStates(70, (state) => (state.social?.npcs?.length ?? 0) > 0
  && ((state.social?.conversations?.length ?? 0) > 0 || (state.worldMemory?.facts ?? []).some((fact) => fact?.predicate === 'gm_secret')), 3)
const plainCorpus = corpusStates(50, (state) => (state.social?.npcs?.length ?? 0) > 0, 41)
const corpus = [...richCorpus, ...plainCorpus].map(trim)

const testStates = [...new Set(captured.map((entry) => entry.stateRef).filter(Boolean))].map((key) => states[key]).filter((state) => state && typeof state === 'object')

const genericQuestions = [
  'Что слышно?', 'Расскажи, что знаешь.', 'Кто здесь главный?', 'Напомни сигнал, о котором договорились.', 'Помоги нам добраться до маяка.',
  'Ещё раз: что ты видела?', 'Обещаю вернуть долг завтра.', 'Где искать пропавший караван?', 'Привет!', '', 'Кто такой Саргат?',
  'Что за баркас без огней ходил ночью?', 'Как пройти к старой башне прямо сейчас?',
]

function questionsFor(state, profile) {
  const out = [...genericQuestions]
  for (const fact of state.worldMemory?.facts ?? []) {
    if (!fact || typeof fact !== 'object') continue
    if (fact.predicate === 'gm_secret') {
      const meta = npcSecretMeta(fact)
      if (meta.topic) out.push(`Что ты знаешь о том: ${meta.topic}?`)
    }
    const words = String(fact.summary ?? '').split(/\s+/u).filter((word) => word.length > 4)
    if (words.length >= 2) out.push(`Расскажи про ${words[int(words.length)]} и ${words[int(words.length)]}`)
  }
  for (const location of state.worldMap?.locations ?? []) {
    for (const hook of location?.storyHooks ?? []) {
      const words = String(hook).split(/\s+/u).filter((word) => word.length > 4)
      if (words.length) out.push(`Что с ${words[int(words.length)]}?`)
    }
  }
  if (profile?.name) out.push(`Обращаюсь к ${profile.name} (${profile.role || 'житель'}): что знаешь о деле?`, `${profile.name}, ты слышала про пропажу?`)
  return out
}

const checks = [
  null, null, null,
  { skill: 'persuasion', ability: 'cha', success: true, degree: 'success', total: 17, dc: 13 },
  { skill: 'intimidation', ability: 'cha', success: false, degree: 'failure' },
  { skill: 'insight', ability: 'wis', success: true, degree: 'success' },
  { skill: 'insight', ability: 'wis', success: false, degree: 'failure' },
  { skill: 'deception', success: true },
]

function earlierRepliesOf(state, npcId) {
  return (state.social?.conversations ?? []).filter((entry) => entry?.npc_id === npcId).map((entry) => String(entry?.npc_reply ?? '')).filter(Boolean)
}

function scriptsFor(state, profile, social) {
  const earlier = earlierRepliesOf(state, profile.id)
  const facts = (state.worldMemory?.facts ?? []).filter((fact) => fact && typeof fact === 'object')
  const claims = (state.worldMemory?.epistemic_claims ?? []).filter((claim) => claim && typeof claim === 'object')
  const factIds = facts.map((fact) => String(fact.id))
  const claimIds = claims.map((claim) => String(claim.id))
  const other = social.npcs.find((npc) => npc.id !== profile.id && social.conversations.some((entry) => entry.npc_id === npc.id))
  const discovery = facts.find((fact) => fact.predicate === 'discovery' && fact.visibility === 'party')
  const secret = facts.find((fact) => fact.predicate === 'gm_secret')
  const repeat = earlier.at(-1) ?? discovery?.summary ?? 'Ничего нового, путник. Всё как прежде у старой мельницы за рекой.'
  const reply = pick([
    'Слушаю.', 'Да, слышала. Баркас без огней ходил к маяку, и стража отворачивалась.', 'Не знаю я ничего. Иди своей дорогой.',
    `Я ${profile.name ?? 'тут'}, и я помню всё. Приходи вечером.`, 'Хм. Может быть. Но не здесь и не сейчас — слишком много ушей.',
    secret ? `${String(secret.summary ?? '').slice(0, 120)} Только никому.` : 'Тайн у меня нет.',
  ])
  return [
    null,
    [{ value: { npc_id: profile.id, reply, stance: pick(['friendly', 'neutral', 'guarded', 'hostile']), disclosed_fact_ids: [], disclosed_claim_ids: [], relationship_delta: pick([0, 1, -1, 2, 3, -5, 1.5]), promise: null, confidence: pick([0, 0.5, 1, 1.7, -1]) } }],
    [{ value: { reply, stance: 'neutral', disclosed_fact_ids: [pick(factIds) ?? 'fact:none', 'fact:bogus', ...(secret ? [String(secret.id)] : [])], disclosed_claim_ids: [pick(claimIds) ?? 'claim:none'] } }],
    [{ value: { reply, promise: { direction: pick(['npc_to_party', 'party_to_npc']), text: pick(['Проведу вас к маяку на рассвете.', 'Я убью любого жителя, который вам мешает.', 'Раскрою тайну старосты.', '   ']), due_hint: pick(['завтра', 'через час', '']) } } }],
    [{ value: { reply: repeat, stance: 'neutral' } }, { value: { reply: 'Ладно, скажу иначе: ищи у старой мельницы, там сухо и тихо.', stance: 'neutral' } }],
    [{ value: { reply: repeat } }, { value: { reply: repeat } }],
    [{ value: { reply: repeat } }, { error: { code: 'LLM_TIMEOUT', message: 'таймаут' } }],
    [{ value: { reply: repeat } }, { value: { reply: 'x', extra: true } }],
    [{ value: { reply: `${other ? `Спроси ${other.name}, он знает.` : 'Спроси Мару.'} А я скажу одно: на пристани ночью было неспокойно, лодки ушли без огней.` } }],
    [{ value: { reply, extra_field: 1 } }],
    [{ value: { reply: '', stance: 'neutral' } }],
    [{ value: { reply, stance: 'angry' } }],
    [{ value: { reply, disclosed_fact_ids: 'fact:1' } }],
    [{ value: { reply, promise: { direction: 'sideways', text: 'x', due_hint: 'y' } } }],
    [{ value: 'просто текст' }], [{ value: null }], [{ undef: true }], [{ value: [reply] }],
    [{ error: { code: 'LLM_TIMEOUT', message: 'таймаут' } }],
    [{ error: { message: 'сеть упала' } }],
    [{ error: { name: 'AbortError', message: 'отмена' } }],
    [{ value: { reply: 'Напомню: сигнал — три удара в колокол. И ещё: ворота закрывают на закате.', stance: 'friendly' } }],
  ]
}

function heroIds(state) {
  const ids = (Array.isArray(state.players) ? state.players : []).map((player) => player?.id).filter(Boolean).slice(0, 3)
  return ids.length ? ids : ['hero']
}

const generated = []
async function runCase(label, state, input, script, model = null) {
  const client = script ? scriptedClient(script, model) : null
  const controller = new NpcSocialController({ llmClient: client })
  const entry = { label, stateRef: state === undefined ? null : stateRef(state), input: plain(input), hasClient: Boolean(client), className: client ? 'Object' : null, model: client?.model ?? null, script: script ?? [] }
  try {
    const out = await controller.respond({ ...(state === undefined ? {} : { state: structuredClone(state) }), ...structuredClone(input) })
    entry.out = out === undefined ? null : plain(out)
  } catch (error) {
    entry.err = errorOf(error)
  }
  entry.calls = client?.calls ?? []
  generated.push(entry)
}

const models = [null, null, null, 'openai/gpt-6-luna', 'z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash']
const leadCases = []
const freshCases = []
const circularCases = []
const othersCases = []
async function explore(prefix, state, perState) {
  const social = ensureNpcSocialState(state.social, state)
  if (!social.npcs.length) return
  const ref = stateRef(state)
  for (let index = 0; index < perState; index += 1) {
    const persisted = pick(social.npcs)
    const profile = npcProfileAtWorldTime(persisted, state)
    const message = pick(questionsFor(state, profile))
    const playerId = pick(heroIds(state))
    const input = {
      playerId, npcId: chance(0.03) ? 'npc:missing' : persisted.id, message, turnId: `turn-${int(1000)}`,
      ...(chance(0.6) ? { checkOutcome: pick(checks) } : {}),
      ...(chance(0.15) ? { justSeen: pick(['творит «Безмолвный образ» с чертами Илы', 'кладёт на стойку серебряную монету', '   ']) } : {}),
    }
    const script = pick(scriptsFor(state, profile, social))
    await runCase(`${prefix}#${index}`, state, input, script, pick(models))
    if (index < 2) {
      try {
        leadCases.push({ stateRef: ref, profile: plain(profile), message, out: plain(conversationLeads(structuredClone(state), structuredClone(profile), message)) })
      } catch (error) {
        leadCases.push({ stateRef: ref, profile: plain(profile), message, err: errorOf(error) })
      }
      othersCases.push({ stateRef: ref, profile: plain(profile), out: plain(othersSaidNearby(structuredClone(state), structuredClone(state.social ?? {}), structuredClone(profile))) })
      const earlier = earlierRepliesOf(state, persisted.id)
      const candidates = [...earlier.slice(-2), 'Слушаю.', `${earlier.at(-1) ?? 'Да.'} А ещё: на пристани ночью было неспокойно, лодки ушли без огней.`]
      for (const reply of candidates) freshCases.push({ reply, earlier: earlier.slice(-12), out: freshReplyText(reply, earlier.slice(-12)) })
      const referral = social.npcs.filter((npc) => npc.id !== persisted.id).map((npc) => `Спроси ${npc.name}, иди к ${String(npc.name).split(/\s+/u)[0]}.`).join(' ')
      for (const reply of [`${referral} Остальное расскажу потом, когда стемнеет за рекой.`, referral, 'Поговори с кем-нибудь ещё. Я устала.']) {
        circularCases.push({ stateRef: ref, profile: plain(profile), reply, out: withoutCircularReferral(reply, structuredClone(state.social ?? {}), structuredClone(profile)) })
      }
    }
  }
}

for (const [index, state] of testStates.entries()) await explore(`test-state-${index}`, state, 6)
for (const [index, state] of corpus.entries()) await explore(`corpus-${index}`, state, 7)

// --- 3. мусор --------------------------------------------------------------------------

const base = testStates.find((state) => (state.social?.npcs?.length ?? 0) > 1 && (state.worldMemory?.facts?.length ?? 0) > 2) ?? testStates[0]
const baseSocial = ensureNpcSocialState(base.social, base)
const baseNpc = baseSocial.npcs[0]?.id ?? 'npc:none'
const baseHero = heroIds(base)[0]
const mutate = (patch) => {
  const copy = structuredClone(base)
  patch(copy)
  return copy
}
const garbageStates = [
  ['facts-object', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), facts: { a: 1 } } }],
  ['facts-string', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), facts: 'abc' } }],
  ['facts-number', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), facts: 5 } }],
  ['facts-null-entry', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), facts: [null, ...(s.worldMemory?.facts ?? [])] } }],
  ['facts-number-entry', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), facts: [5, 'x', ...(s.worldMemory?.facts ?? [])] } }],
  ['claims-object', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), epistemic_claims: { a: 1 } } }],
  ['claims-null-entry', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), epistemic_claims: [null] } }],
  ['entities-object', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), entities: { a: 1 } } }],
  ['entities-string', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), entities: 'abc' } }],
  ['ledger-object', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), knowledge_ledger: { a: 1 } } }],
  ['ledger-number', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), knowledge_revealed: 7 } }],
  ['ledger-string', (s) => { s.worldMemory = { ...(s.worldMemory ?? {}), knowledge_ledger: 'abc' } }],
  ['memory-string', (s) => { s.worldMemory = 'память' }],
  ['memory-number', (s) => { s.worldMemory = 5 }],
  ['memory-array', (s) => { s.worldMemory = [1, 2] }],
  ['memory-null', (s) => { s.worldMemory = null }],
  ['players-object', (s) => { s.players = { a: 1 } }],
  ['players-string', (s) => { s.players = 'abc' }],
  ['players-null-entry', (s) => { s.players = [null, ...(Array.isArray(s.players) ? s.players : [])] }],
  ['social-string', (s) => { s.social = 'abc' }],
  ['social-npcs-string', (s) => { s.social = { ...(s.social ?? {}), npcs: 'abc' } }],
  ['social-conversations-object', (s) => { s.social = { ...(s.social ?? {}), conversations: { a: 1 } } }],
  ['social-conversations-junk', (s) => { s.social = { ...(s.social ?? {}), conversations: [null, 5, { npc_id: baseNpc, hero_id: baseHero, visibility: 'party', npc_reply: 7 }, ...(s.social?.conversations ?? [])] } }],
  ['social-relationships-junk', (s) => { s.social = { ...(s.social ?? {}), relationships: { [baseNpc]: { [baseHero]: '15' } } } }],
  ['scene-string', (s) => { s.scene = 'сцена' }],
  ['scene-null', (s) => { s.scene = null }],
  ['worldmap-array', (s) => { s.worldMap = [1] }],
  ['worldmap-string', (s) => { s.worldMap = 'карта' }],
  ['worldmap-locations-junk', (s) => { s.worldMap = { currentLocationId: 'x', locations: [null, 5, { id: 'x', name: 'Икс', storyHooks: 'не массив' }] } }],
]
for (const [name, patch] of garbageStates) {
  const state = mutate(patch)
  for (const script of [null, [{ value: { reply: 'Слушаю.', stance: 'neutral' } }]]) {
    await runCase(`garbage-${name}-${script ? 'model' : 'none'}`, state, { playerId: baseHero, npcId: baseNpc, message: 'Что ты знаешь о деле?', turnId: 'g-1' }, script)
  }
}
const garbageInputs = [
  ['state-null', null, {}],
  ['state-number', 5, {}],
  ['state-string', 'abc', {}],
  ['state-array', [], {}],
  ['no-state', undefined, {}],
  ['message-object', base, { message: { a: 1 } }],
  ['message-number', base, { message: 42 }],
  ['message-null', base, { message: null }],
  ['message-array', base, { message: ['о', 'деле'] }],
  ['npc-number', base, { npcId: 5 }],
  ['npc-null', base, { npcId: null }],
  ['player-number', base, { playerId: 5 }],
  ['player-null', base, { playerId: null }],
  ['player-object', base, { playerId: { id: 'x' } }],
  ['check-string', base, { checkOutcome: 'x' }],
  ['check-zero', base, { checkOutcome: 0 }],
  ['check-array', base, { checkOutcome: [] }],
  ['check-junk', base, { checkOutcome: { skill: 5, success: 'yes' } }],
  ['turn-object', base, { turnId: { a: 1 } }],
  ['just-seen-number', base, { justSeen: 12345 }],
]
for (const [name, state, patch] of garbageInputs) {
  for (const script of [null, [{ value: { reply: 'Слушаю.', stance: 'neutral', promise: { direction: 'npc_to_party', text: 'Проведу.', due_hint: 'завтра' } } }]]) {
    await runCase(`input-${name}-${script ? 'model' : 'none'}`, state, { playerId: baseHero, npcId: baseNpc, message: 'Что ты знаешь о деле?', turnId: 'g-2', ...patch }, script)
  }
}

// --- выход -----------------------------------------------------------------------------

const out = { respond: [...captured, ...generated], states, leads: leadCases, fresh: freshCases, circular: circularCases, others: othersCases }
const json = JSON.stringify(out)
const gz = gzipSync(json, { level: 9 })
writeFileSync(new URL('./a4.json.gz', import.meta.url), gz)
rmSync(storage, { recursive: true, force: true })
const errors = [...captured, ...generated].filter((entry) => entry.err).length
console.log(testSummary.join('\n'))
console.log(`captured=${captured.length} generated=${generated.length} (err ${errors}) states=${Object.keys(states).length} leads=${leadCases.length} fresh=${freshCases.length} circular=${circularCases.length} others=${othersCases.length}; json ${(json.length / 1e6).toFixed(2)} МБ, gzip ${(gz.length / 1e6).toFixed(2)} МБ`)
