// Замер кэширования промпта у провайдера (usage.prompt_tokens_details.cached_tokens)
// для Рассказчика, Режиссёра, арбитра свободного действия и NPC на openai/gpt-6-luna.
// node eval/prompt-caching-2026-10-01.mjs --output eval/prompt-caching-2026-10-01.json [--budget-rub 4] [--passes 2]
// node eval/prompt-caching-2026-10-01.mjs --dump        — без сети: раскладка сообщений по ролям
//
// Каждая роль проходит шесть последовательных «ходов» одной сцены: меняются
// действие игрока или события, растёт state_version — как в живой партии. На
// каждом ходе по очереди вызываются варианты раскладки (чередование уравнивает
// шансы попасть на тёплый кэш):
//   as-is                  — сообщения ровно такие, какие собирает модуль;
//   stable-first           — те же данные, но внутри UNTRUSTED_DATA сначала
//                            устойчивые ключи и блоки, а меняющиеся каждый ход
//                            (context_metadata, действие, события…) — в конце;
//                            у Рассказчика примеры стиля перенесены в конец
//                            системного промпта;
//   stable-first+cache-key — то же плюс prompt_cache_key роли в теле запроса.
// Варианты stable-first — что-если в стенде: модули ролей не меняются.
// Ключ берётся из .env и нигде не печатается; storage не используется.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d
const dump = args.includes('--dump')
if (!dump) process.loadEnvFile(new URL('../.env', import.meta.url))
const root = new URL('../', import.meta.url).href
const { RouterAIClient } = await import(`${root}server/llm-client.mjs`)
const { DirectorAgent } = await import(`${root}server/director-agent.mjs`)
const { ActionAdjudicator } = await import(`${root}server/action-adjudicator.mjs`)
const { interpretFreeAction } = await import(`${root}server/free-action-adjudication.mjs`)
const { NpcSocialController } = await import(`${root}server/npc-social-controller.mjs`)
const { Narrator } = await import(`${root}server/narrator.mjs`)
const { normalizeCampaignState } = await import(`${root}server/rules-engine.mjs`)
const { buildNarrationBrief, UNTRUSTED_DATA_START, UNTRUSTED_DATA_END } = await import(`${root}server/security.mjs`)
const { reasoningProfileFor } = await import(`${root}server/model-style-profiles.mjs`)

const MODEL = opt('--model', 'openai/gpt-6-luna')
const output = opt('--output')
const budgetRub = Number(opt('--budget-rub', '4'))
const passes = Number(opt('--passes', '2'))
const VARIANTS = (opt('--variants') ?? 'as-is,stable-first,stable-first+cache-key').split(',')
const ROLES = (opt('--roles') ?? 'narrator,director,adjudicator,npc_social').split(',')
if (!dump) assert.ok(output && budgetRub > 0 && budgetRub <= 6)
const catalog = JSON.parse(readFileSync(new URL('./routerai-catalog-2026-10-01.json', import.meta.url), 'utf8'))
const pricing = catalog.data.find(e => e.id === MODEL).pricing

// ---------- раскладка «устойчивое сначала» ----------
const DYNAMIC_KEYS = new Set([
  'context_metadata', 'state_version', 'turn', 'round',
  'PLAYER_ACTION', 'player_action', 'player_message', 'player_intent', 'structured_result', 'resolved_check', 'dialogue',
  'RECENT_EVENTS', 'RECENT_OUTCOMES', 'pacing', 'world_clock',
  'visible_events', 'visible_state_changes', 'permitted_npc_reactions', 'narration_constraints',
  'recent_conversation', 'recent_party_conversation',
])
const DYNAMIC_SECTIONS = ['response_plan', 'confirmed_event_summaries', 'avoid_repeated_phrases', 'previous_narration_feedback']
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const SAFE = { '<': String.raw`\u003c`, '>': String.raw`\u003e`, '&': String.raw`\u0026`, [LS]: String.raw`\u2028`, [PS]: String.raw`\u2029` }
const promptSafeJson = value => JSON.stringify(value ?? null).replace(new RegExp(`[<>&${LS}${PS}]`, 'g'), ch => SAFE[ch])
function stableFirst(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return value
  if (Array.isArray(value)) return value.map(item => stableFirst(item, depth + 1))
  const entries = Object.entries(value).map(([k, v]) => [k, stableFirst(v, depth + 1)])
  return Object.fromEntries([...entries.filter(([k]) => !DYNAMIC_KEYS.has(k)), ...entries.filter(([k]) => DYNAMIC_KEYS.has(k))])
}
const SECTION = new RegExp(`${UNTRUSTED_DATA_START}:([A-Za-z0-9_.-]+)>>>\\n([^]*?)\\n${UNTRUSTED_DATA_END}:\\1>>>`, 'g')
function restructureUser(content) {
  const sections = [...content.matchAll(SECTION)].map(m => ({ label: m[1], value: JSON.parse(m[2]) }))
  if (!sections.length) return content
  const head = content.slice(0, content.indexOf(UNTRUSTED_DATA_START)).replace(/\n+$/, '')
  const ordered = [...sections.filter(s => !DYNAMIC_SECTIONS.includes(s.label)), ...sections.filter(s => DYNAMIC_SECTIONS.includes(s.label))]
  return [head, ...ordered.map(s => `${UNTRUSTED_DATA_START}:${s.label}>>>\n${promptSafeJson(stableFirst(s.value))}\n${UNTRUSTED_DATA_END}:${s.label}>>>`)].join('\n\n')
}
function restructureSystem(content) {
  // Блок, который вставляет narratorPromptWithExamples, — не упоминание примеров в тексте промпта.
  const match = content.match(/\nCURATED_STYLE_EXAMPLES \([^]*?NarrationBrief\.\n/u)
  return match ? `${content.replace(match[0], '')}${match[0]}` : content
}
// split: устойчивое и меняющееся — в разные сообщения. Системный промпт без
// примеров стиля остаётся отдельным неизменным сообщением, примеры — вторым
// системным; данные хода — первым пользовательским сообщением устойчивая
// часть каждого блока, вторым — меняющиеся ключи и блоки (метка `<label>_turn`).
function splitUser(content) {
  const sections = [...content.matchAll(SECTION)].map(m => ({ label: m[1], value: JSON.parse(m[2]) }))
  if (!sections.length) return [content]
  const head = content.slice(0, content.indexOf(UNTRUSTED_DATA_START)).replace(/\n+$/, '')
  const block = (label, value) => `${UNTRUSTED_DATA_START}:${label}>>>\n${promptSafeJson(value)}\n${UNTRUSTED_DATA_END}:${label}>>>`
  const stable = []
  const dynamic = []
  for (const s of sections) {
    if (DYNAMIC_SECTIONS.includes(s.label) || !s.value || typeof s.value !== 'object' || Array.isArray(s.value)) { dynamic.push(block(s.label, s.value)); continue }
    const value = stableFirst(s.value)
    const keep = Object.fromEntries(Object.entries(value).filter(([k]) => !DYNAMIC_KEYS.has(k)))
    const turn = Object.fromEntries(Object.entries(value).filter(([k]) => DYNAMIC_KEYS.has(k)))
    stable.push(block(s.label, keep))
    if (Object.keys(turn).length) dynamic.push(block(`${s.label}_turn`, turn))
  }
  return [[head, ...stable].join('\n\n'), [head, ...dynamic].join('\n\n')]
}
function transform(variant, messages) {
  if (variant === 'as-is') return messages
  // examples-user: системный блок Рассказчика без примеров стиля (он одинаков
  // на каждом ходе), примеры — отдельным пользовательским сообщением перед данными хода.
  if (variant === 'examples-user') {
    const system = messages.find(m => m.role === 'system')
    const match = system?.content.match(/\nCURATED_STYLE_EXAMPLES \([^]*?NarrationBrief\.\n/u)
    if (!match) return messages
    return messages.flatMap(m => m === system
      ? [{ ...m, content: m.content.replace(match[0], '') }, { role: 'user', content: match[0].trim() }]
      : [m])
  }
  if (variant === 'split') {
    return messages.flatMap(m => {
      if (m.role === 'system') {
        const match = m.content.match(/\nCURATED_STYLE_EXAMPLES \([^]*?NarrationBrief\.\n/u)
        return match ? [{ ...m, content: m.content.replace(match[0], '') }, { ...m, content: match[0].trim() }] : [m]
      }
      return m.role === 'user' ? splitUser(m.content).map(content => ({ ...m, content })) : [m]
    })
  }
  return messages.map(m => m.role === 'system' ? { ...m, content: restructureSystem(m.content) } : m.role === 'user' ? { ...m, content: restructureUser(m.content) } : m)
}
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i }

// ---------- отчёт ----------
const report = !dump && existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {
  schema_version: 1, created_at: new Date().toISOString(), model: MODEL, reasoning: reasoningProfileFor(MODEL), variants: VARIANTS, passes,
  note: 'Шесть ходов одной сцены на роль; на каждом ходе варианты раскладки вызываются по очереди. stable-first — перестановка тех же данных в стенде, модули не менялись.',
  dynamic_keys: [...DYNAMIC_KEYS], dynamic_sections: DYNAMIC_SECTIONS, calls: [],
}
const save = () => { if (!dump) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`) }
const spent = () => report.calls.reduce((s, c) => s + (c.usage_cost ?? 0), 0)
const lastContent = new Map()

class CachingClient {
  constructor(role, variant, pass, turn) {
    this.role = role
    this.variant = variant
    this.pass = pass
    this.turn = turn
    this.model = MODEL
    this.timeoutMs = 60_000
    const cacheKey = variant.endsWith('+cache-key') ? `skazanie-${role}` : null
    this.inner = dump ? null : new RouterAIClient({
      model: MODEL, reasoning: reasoningProfileFor(MODEL), timeoutMs: 60_000, maxTokens: 1200,
      fetchImpl: (url, init) => {
        if (!cacheKey) return fetch(url, init)
        const body = JSON.parse(init.body)
        body.prompt_cache_key = cacheKey
        return fetch(url, { ...init, body: JSON.stringify(body) })
      },
    })
  }
  async complete(input, options = {}) {
    const messages = transform(this.variant, input.messages)
    const serialized = messages.map(m => `${m.role}\n${m.content}`).join('\n')
    const key = `${this.role}|${this.variant}`
    const previous = lastContent.get(key)
    lastContent.set(key, serialized)
    const call = { role: this.role, variant: this.variant, pass: this.pass, turn: this.turn,
      system_chars: messages.filter(m => m.role === 'system').reduce((s, m) => s + m.content.length, 0),
      total_chars: serialized.length, common_prefix_chars_with_previous: previous ? commonPrefix(previous, serialized) : null }
    if (dump) {
      call.user_head = messages.find(m => m.role === 'user')?.content.slice(0, 400)
      if (opt('--dump-file')) call.messages = messages
      report.calls.push(call)
      throw Object.assign(new Error('dump'), { code: 'DUMP' })
    }
    const ceiling = (Buffer.byteLength(serialized) + 1024) * pricing.prompt + 1200 * pricing.completion
    assert.ok(spent() + ceiling < budgetRub, `бюджет ${budgetRub} ₽ исчерпан`)
    const started = performance.now()
    try {
      const result = await this.inner.complete({ ...input, messages, timeoutMs: 60_000 }, { ...options, timeoutMs: 60_000 })
      const usage = result.usage ?? {}
      Object.assign(call, { ok: true, usage, usage_cost: typeof usage.cost === 'number' ? usage.cost : null,
        prompt_tokens: usage.prompt_tokens ?? null, cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0, completion_tokens: usage.completion_tokens ?? null })
      return result
    } catch (error) {
      Object.assign(call, { ok: false, error_code: String(error?.code ?? error?.name ?? 'ERROR').slice(0, 80), status: error?.status ?? null })
      throw error
    } finally {
      call.latency_ms = Math.round(performance.now() - started)
      report.calls.push(call)
      save()
      console.log(JSON.stringify({ role: call.role, variant: call.variant, pass: call.pass, turn: call.turn, pt: call.prompt_tokens, cached: call.cached_tokens, ms: call.latency_ms, spent: Number(spent().toFixed(3)) }))
    }
  }
  async completeJson(input, options = {}) {
    return (await this.complete(input, { ...options, json: true })).json
  }
}

// ---------- ходы ----------
function directorState(turn) {
  return {
    state_version: 100 + turn,
    scene: { title: 'Старая дорога', location: 'Старая дорога', objective: 'Найти пропавший караван', turn: 3 + turn, mood: 'сырой туман над колеями' },
    adventure: { chapter: 1, currentHook: 'Караван пропал на северной дороге', visitedLocations: ['Трактир «Пустой кубок»', 'Старая дорога'] },
    players: [{ id: 'hero', character: 'Ада', hp: 12, maxHp: 12 }, { id: 'rogue', character: 'Рен', hp: 9, maxHp: 10 }],
    mechanics: { combat: { active: false }, encounter: null },
    autonomy: { director_history: Array.from({ length: turn + 1 }, () => ({ intent: { type: 'continue_exploration' } })), encounter_outcomes: [] },
    worldMemory: { quests: [{ id: 'quest-road', title: 'Пропавший караван', status: 'active', objectives: ['Найти след', 'Узнать, кто открыл заставу'], clock: { current: 1, max: 4 } }] },
    social: { npcs: [{ id: 'guide', name: 'Мира', role: 'проводница', location: 'Старая дорога', available: true }] },
  }
}
const DIRECTOR_ACTIONS = [
  'Идём по следу телеги к сгоревшей мельнице',
  'Спрашиваю у проводницы, кто ещё видел караван',
  'Разбиваем лагерь у дороги и обсуждаем, что делать дальше',
  'Осматриваем колеи: куда свернула телега?',
  'Договорились с проводницей: она ведёт нас к заставе за долю находок, идём',
  'Караван нашли, возвращаемся в трактир и сдаём след страже',
]
function adjudicatorState(turn) {
  const state = normalizeCampaignState({
    players: [{
      id: 'hero', character: 'Ада', characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 15, speed: 30, x: 0, y: 0,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 },
      classSkillProficiencies: ['athletics', 'perception'],
      inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1, equipped: false }],
    }, { id: 'rogue', character: 'Рен', characterClass: 'rogue', level: 1, hp: 9, maxHp: 10, armor: 14, speed: 30, x: 0, y: 1,
      abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 14 } }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 25, maxHp: 25, armor: 12, alive: true, x: 1, y: 0 }],
    scene: { title: 'Мост', location: 'Мост через овраг', mood: 'Ветрено, доски скрипят', objective: 'Удержать мост', turn: 1 + turn, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: true, round: 2 + turn, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }, { actor_id: 'rogue' }],
      action_economy: { hero: { action: true, bonus_action: true, movement: true, movement_spent: 0 } } } },
  })
  state.state_version = 200 + turn
  return state
}
const ADJUDICATOR_ACTIONS = [
  'Набрасываю верёвку огру на ноги, чтобы повалить его',
  'Ору на огра и корчу рожи, чтобы он отвлёкся от Рена',
  'Раскачиваю доски моста, чтобы огр потерял равновесие',
  'Бросаю горсть песка огру в глаза',
  'Прыгаю на перила моста и бегу по ним за спину огру',
  'Подрубаю ножом доску под огром, чтобы она треснула',
]
function socialState(turn) {
  return {
    state_version: 300 + turn,
    scene: { title: 'Тишина у Северных ворот', location: 'Северные ворота', mood: 'настороженно', objective: 'Узнать, кто открыл старую заставу' },
    players: [{ id: 'hero:ada', character: 'Ада', characterClass: 'ranger', background: 'бывшая проводница караванов' }, { id: 'hero:ren', character: 'Рен', characterClass: 'rogue' }],
    campaignConcept: { tone: 'приземлённое тёмное фэнтези без пафоса', premise: 'Пограничный город зависит от северного тракта.' },
    worldMemory: {
      entities: [
        { id: 'npc:mira', kind: 'npc', name: 'Мира', summary: 'Хозяйка трактира.', visibility: 'party' },
        { id: 'location:gates', kind: 'location', name: 'Северные ворота', summary: 'Старая застава.', visibility: 'party' },
      ],
      facts: [{ id: 'fact:watch', subject_id: 'location:gates', predicate: 'witnessed', object: 'Начальник стражи открыл ворота после третьего колокола.',
        summary: 'Начальник стражи открыл ворота после третьего колокола.', visibility: 'party', status: 'active', source_event_ids: ['event:watch'], recorded_at_minutes: 0 }],
      relationships: [], quests: [], threads: [], epistemic_claims: [], summaries: [], knowledge_ledger: [],
    },
    social: {
      npcs: [{ id: 'npc:mira', name: 'Мира', role: 'хозяйка трактира', public_summary: 'Двадцать лет знает путников северного тракта.', voice: 'Живая разговорная манера.',
        speech_profile: { pace: 'быстро, короткими фразами', lexicon: 'простые дорожные слова и прибаутки', mannerism: 'важную мысль начинает словами «Ну-ка»' }, relationship: 'friendly',
        location: 'Северные ворота', known_fact_ids: ['fact:watch'], visibility: 'party', available: true }],
      relationships: { 'npc:mira': { 'hero:ada': 25 } }, promises: [], conversations: [],
    },
  }
}
const SOCIAL_MESSAGES = [
  'Кто открыл ворота после третьего колокола?',
  'А начальника стражи ты давно знаешь?',
  'Найдётся у тебя комната на ночь? Заплачу утром.',
  'Что говорят возчики про пропавший караван?',
  'Если узнаешь что-то про заставу, шепнёшь мне?',
  'Спасибо, Мира. Сколько с меня за ужин?',
]
const baseEnvironment = {
  scene: { title: 'Караульная', location: 'Караульная', mood: 'На стене тёмное пятно сырости.', objective: 'Найти пропавшего курьера' },
  campaign_premise: { tone: 'приземлённое тёмное фэнтези', themes: 'долг, граница, слухи', boundaries: 'без натурализма' },
  story_context: {
    heroes: [{ id: 'hero:ada', name: 'Ада', is_viewer: true }, { id: 'hero:ren', name: 'Рен', is_viewer: false }],
    present_npcs: [{ id: 'npc:borin', name: 'Борин', role: 'архивариус заставы', speech_profile: { pace: 'медленно', lexicon: 'книжные слова', mannerism: 'Заметьте' } }],
    open_promises: [{ id: 'promise:map', direction: 'npc_to_party', text: 'Борин обещал карту старых троп', due_hint: 'к вечеру' }],
    recent_interactions: [{ npc: 'Борин', summary: 'Борин показал журнал ворот с вырванной страницей.' }],
  },
}
const ev = (event_type, payload = {}) => ({ event_type, payload, actor_id: 'hero:ada', visibility: 'public', source_rule_ids: [] })
const NARRATOR_TURNS = [
  { visible_events: [ev('AbilityCheckResolved', { ability: 'wis', skill: 'perception', success: true })] },
  { visible_events: [ev('AbilityCheckResolved', { ability: 'int', skill: 'investigation', success: false })] },
  { visible_events: [ev('MovementResolved', { from: 'дверь', to: 'стол с журналом' })] },
  { visible_events: [ev('ActionDeclared'), ev('RulingRecorded')], player_intent: { action: 'Расспросить Борина о курьере', goal: 'Получить новые показания', constraints: [] } },
  { visible_events: [ev('AbilityCheckResolved', { ability: 'dex', skill: 'sleight_of_hand', success: true })] },
  { visible_events: [ev('ItemInspected', { item: 'журнал ворот' })] },
]
function narratorBrief(turn) {
  const t = NARRATOR_TURNS[turn]
  const known = { ...baseEnvironment, ...(t.player_intent ? { player_intent: t.player_intent, structured_result: { status: 'ruling', confirmed: false } } : {}) }
  return buildNarrationBrief({ known_environment: known, visible_events: t.visible_events, visible_state_changes: [], permitted_npc_reactions: [] })
}

async function runTurn(role, variant, pass, turn) {
  const client = new CachingClient(role, variant, pass, turn)
  try {
    if (role === 'director') await new DirectorAgent({ llmClient: client }).choose({ state: directorState(turn), playerAction: DIRECTOR_ACTIONS[turn], improvMode: 'story' })
    else if (role === 'adjudicator') {
      const action = ADJUDICATOR_ACTIONS[turn]
      await new ActionAdjudicator({ llmClient: client, timeoutMs: 60_000 }).read(adjudicatorState(turn), 'hero', action, interpretFreeAction(action))
    } else if (role === 'npc_social') await new NpcSocialController({ llmClient: client }).respond({ state: socialState(turn), playerId: 'hero:ada', npcId: 'npc:mira', message: SOCIAL_MESSAGES[turn], turnId: `cache-${pass}-${turn}` })
    else await new Narrator({ llmClient: client }).render(narratorBrief(turn), { knownRuleIds: ['srd:ability-check'], timeoutMs: 61_000 })
  } catch (error) {
    if (error?.code !== 'DUMP') throw error
  }
}

for (let pass = 1; pass <= (dump ? 1 : passes); pass += 1) {
  for (const role of ROLES) {
    for (let turn = 0; turn < 6; turn += 1) {
      for (const variant of VARIANTS) {
        if (!dump && report.calls.some(c => c.role === role && c.variant === variant && c.pass === pass && c.turn === turn && c.ok)) continue
        await runTurn(role, variant, pass, turn)
      }
    }
  }
}

if (dump) {
  for (const c of report.calls) console.log(JSON.stringify({ role: c.role, variant: c.variant, turn: c.turn, system_chars: c.system_chars, total_chars: c.total_chars, common_prefix: c.common_prefix_chars_with_previous, head: c.user_head?.slice(0, 260) }))
  if (opt('--dump-file')) writeFileSync(opt('--dump-file'), JSON.stringify(report.calls, null, 1))
  process.exit(0)
}

// ---------- сводка ----------
const summary = {}
for (const role of ROLES) {
  for (const variant of VARIANTS) {
    const calls = report.calls.filter(c => c.role === role && c.variant === variant && c.ok)
    // Проход 2 повторяет запросы прохода 1 байт в байт (как повтор после сбоя) и
    // кэшируется почти целиком; «новые ходы» — проход 1 без первого хода.
    const warm = calls.filter(c => c.turn > 0 && c.pass === 1)
    const repeat = calls.filter(c => c.pass > 1)
    const sum = (list, f) => list.reduce((s, c) => s + (f(c) ?? 0), 0)
    const pt = sum(calls, c => c.prompt_tokens)
    const cached = sum(calls, c => c.cached_tokens)
    const inputRub = c => ((c.prompt_tokens - c.cached_tokens) * pricing.prompt + c.cached_tokens * (pricing.input_cache_read ?? pricing.prompt))
    summary[`${role}|${variant}`] = {
      role, variant, calls: calls.length,
      prompt_tokens_avg: calls.length ? Math.round(pt / calls.length) : null,
      cached_tokens_avg: calls.length ? Math.round(cached / calls.length) : null,
      cached_ratio: pt ? Number((cached / pt).toFixed(3)) : null,
      cached_ratio_new_turns: sum(warm, c => c.prompt_tokens) ? Number((sum(warm, c => c.cached_tokens) / sum(warm, c => c.prompt_tokens)).toFixed(3)) : null,
      cached_ratio_exact_repeat: sum(repeat, c => c.prompt_tokens) ? Number((sum(repeat, c => c.cached_tokens) / sum(repeat, c => c.prompt_tokens)).toFixed(3)) : null,
      rub_per_100_new_turns: warm.length ? Number((sum(warm, c => c.usage_cost) / warm.length * 100).toFixed(3)) : null,
      input_rub_per_100_new_turns: warm.length ? Number((sum(warm, inputRub) / warm.length * 100).toFixed(3)) : null,
      common_prefix_share_avg: Number((sum(calls.filter(c => c.common_prefix_chars_with_previous != null), c => c.common_prefix_chars_with_previous / c.total_chars) / Math.max(1, calls.filter(c => c.common_prefix_chars_with_previous != null).length)).toFixed(3)),
      system_chars: calls[0]?.system_chars ?? null,
      rub_per_100_calls: calls.length ? Number((sum(calls, c => c.usage_cost) / calls.length * 100).toFixed(3)) : null,
      input_rub_per_100_calls: calls.length ? Number((sum(calls, inputRub) / calls.length * 100).toFixed(3)) : null,
      latency_p50_ms: calls.length ? [...calls.map(c => c.latency_ms)].sort((a, b) => a - b)[Math.floor((calls.length - 1) / 2)] : null,
    }
  }
}
report.summary = summary
report.spent_rub = spent()
save()
console.table(Object.values(summary))
console.log(JSON.stringify({ output, calls: report.calls.length, spent_rub: report.spent_rub }))
