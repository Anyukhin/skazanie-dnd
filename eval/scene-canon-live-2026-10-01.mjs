// Живой замер канона сцены ДО и ПОСЛЕ на openai/gpt-6-luna (reasoning выключен).
// node eval/scene-canon-live-2026-10-01.mjs --part narrator|bootstrap|anchors|summarize --output eval/scene-canon-live-2026-10-01.json --budget-rub 15 [--repeats 2] [--bootstrap-runs 3]
//
// ДО — модули из git HEAD (narrator/v9 + прежние сенсорные якоря + прежний
// verifier; campaign_creator/v5 без часов), поднятые во временный каталог; их
// относительные импорты указывают на текущие модули сервера, кроме security.mjs,
// который тоже берётся из HEAD. ПОСЛЕ — текущие модули (narrator/v10 с
// `scene_canon`, campaign_creator/v6 с часами и небом по краям).
//
// Brief «ДО» собран так, как его собирал оркестратор до изменения: сцена,
// world_clock и story_context. «ПОСЛЕ» — то же плюс `scene_canon` из sceneCanonFor.
// Судья у обоих один: sceneCanonContradictions с каноном ПОСЛЕ — по сырому
// ответу модели (до отката на шаблон) и по тексту, который увидел бы игрок.
// Ключ берётся из .env и нигде не печатается; storage не используется.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.loadEnvFile(new URL('../.env', import.meta.url))
const root = new URL('../', import.meta.url)
const args = process.argv.slice(2)
const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const part = opt('--part', 'narrator')
const output = opt('--output', 'eval/scene-canon-live-2026-10-01.json')
const budgetRub = Number(opt('--budget-rub', '15'))
const repeats = Number(opt('--repeats', '2'))
const bootstrapRuns = Number(opt('--bootstrap-runs', '3'))
assert.ok(budgetRub > 0 && budgetRub <= 15, 'бюджет задачи — не больше 15 ₽')

const MODEL = 'openai/gpt-6-luna'
const REASONING = { enabled: false }
const server = (name) => new URL(`server/${name}`, root).href
const { RouterAIClient } = await import(server('llm-client.mjs'))
const after = {
  narrator: await import(server('narrator.mjs')),
  security: await import(server('security.mjs')),
  bootstrap: await import(server('campaign-bootstrap.mjs')),
}
const { sceneCanonFor, sceneCanonContradictions, campaignStartCanon, sensoryAnchorConflicts } = await import(server('scene-canon.mjs'))
const { worldClockForAgents, weatherOnDay, campaignDayOf } = await import(server('weather.mjs'))
const { sceneContextForAgent } = await import(server('agent-context.mjs'))

// ---------- модули ДО ----------
function beforeModules() {
  const dir = mkdtempSync(join(tmpdir(), 'scene-canon-live-before-'))
  const show = (path) => execFileSync('git', ['show', `HEAD:${path}`], { cwd: new URL('.', root), encoding: 'utf8' })
  const write = (path, content) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content) }
  for (const file of ['narrator.mjs', 'security.mjs', 'campaign-bootstrap.mjs']) {
    write(`server/${file}`, show(`server/${file}`).replace(/from '\.\/([A-Za-z0-9_.-]+\.mjs)'/gu, (whole, name) => (
      name === 'security.mjs' ? whole : `from '${server(name)}'`
    )))
  }
  for (const path of ['prompts/narrator/v9.txt', 'prompts/narrator/few-shot-v2.json', 'prompts/campaign_creator/v5.txt']) write(path, show(path))
  return dir
}
const beforeDir = beforeModules()
const before = {
  narrator: await import(pathToFileURL(join(beforeDir, 'server/narrator.mjs')).href),
  security: await import(pathToFileURL(join(beforeDir, 'server/security.mjs')).href),
  bootstrap: await import(pathToFileURL(join(beforeDir, 'server/campaign-bootstrap.mjs')).href),
}
assert.equal(before.narrator.NARRATOR_PROMPT_VERSION, 'narrator/v9')
assert.equal(after.narrator.NARRATOR_PROMPT_VERSION, 'narrator/v10')

// ---------- учёт расходов ----------
const catalog = JSON.parse(readFileSync(new URL('eval/routerai-catalog-2026-10-01.json', root), 'utf8'))
const pricing = catalog.data.find((entry) => entry.id === MODEL).pricing
const report = existsSync(new URL(output, root)) ? JSON.parse(readFileSync(new URL(output, root), 'utf8')) : {
  schema_version: 1, created_at: new Date().toISOString(), model: MODEL, reasoning: REASONING,
  note: 'ДО — git HEAD (narrator/v9, campaign_creator/v5), ПОСЛЕ — рабочее дерево (narrator/v10 + scene_canon, campaign_creator/v6). Судья — sceneCanonContradictions с каноном ПОСЛЕ.',
  calls: [], narrator: [], bootstrap: [],
}
const save = () => writeFileSync(new URL(output, root), `${JSON.stringify(report, null, 2)}\n`)
const spent = () => report.calls.reduce((sum, call) => sum + (call.cost_rub ?? 0), 0)

class EvalClient {
  constructor(role, condition, maxTokensCeiling) {
    this.inner = new RouterAIClient({ model: MODEL, reasoning: REASONING, timeoutMs: 75_000, maxTokens: 3600 })
    this.model = MODEL
    this.role = role
    this.condition = condition
    this.maxTokensCeiling = maxTokensCeiling
    this.last = null
  }

  async complete(input, options = {}) {
    const ceiling = (Buffer.byteLength(JSON.stringify(input.messages)) / 2) * pricing.prompt + this.maxTokensCeiling * pricing.completion
    assert.ok(spent() + ceiling < budgetRub, `бюджет ${budgetRub} ₽ исчерпан: потрачено ${spent().toFixed(3)} ₽`)
    const started = performance.now()
    const call = { role: this.role, condition: this.condition, model: MODEL, requested_at: new Date().toISOString() }
    this.last = call
    try {
      const result = await this.inner.complete({ ...input, timeoutMs: 75_000 }, { ...options, timeoutMs: 75_000 })
      const catalogCost = result.usage ? (Number(result.usage.prompt_tokens) || 0) * pricing.prompt + (Number(result.usage.completion_tokens) || 0) * pricing.completion : null
      Object.assign(call, {
        ok: true, usage: result.usage ?? null,
        usage_cost: typeof result.usage?.cost === 'number' ? result.usage.cost : null,
        catalog_cost_rub: catalogCost,
        cost_rub: typeof result.usage?.cost === 'number' ? result.usage.cost : catalogCost,
        raw_text: String(result.content ?? '').slice(0, 20_000),
      })
      return result
    } catch (error) {
      Object.assign(call, { ok: false, error_code: String(error?.code ?? error?.name ?? 'ERROR').slice(0, 80), cost_rub: 0 })
      throw error
    } finally {
      call.latency_ms = Math.round(performance.now() - started)
      report.calls.push(call)
      save()
    }
  }

  async completeJson(input, options = {}) {
    const result = await this.complete({ ...input, jsonExpected: input.jsonExpected ?? 'object' }, { ...options, json: true })
    return result.json
  }
}

// ---------- сцены ----------
const SCENARIOS = [
  { id: 'pier-fog-morning', location: 'Причал Аквилона', theme: 'портовый причал на сваях', mood: 'Тревожное ожидание у сходней', kind: 'port', biome: 'coast', minutes: 0, weather: 'fog', npc: 'Иара', action: false },
  { id: 'tavern-storm-evening', location: 'Трактир «Пустой кубок»', theme: 'таверна', mood: 'Шумно и тесно', kind: 'town', biome: 'plains', minutes: 11 * 60, weather: 'storm', npc: 'Брен', action: true },
  { id: 'gate-rain-night', location: 'Северные ворота Эйрхольма', theme: 'городские ворота', mood: 'Стража насторожена', kind: 'town', biome: 'plains', minutes: 17 * 60, weather: 'rain', npc: 'сержант Хольт', action: false },
  { id: 'market-clear-day', location: 'Рыночная площадь Ривермарка', theme: 'рыночная площадь города', mood: 'Торговый гомон', kind: 'city', biome: 'plains', minutes: 5 * 60, weather: 'clear', npc: 'Олла', action: true },
  { id: 'forest-overcast-morning', location: 'Лесная дорога у Чёрного ручья', theme: 'лесная дорога', mood: 'Настороженная тишина', kind: 'wilds', biome: 'forest', minutes: 90, weather: 'overcast', npc: 'лесничий Тарв', action: false },
  { id: 'crypt-rain-day', location: 'Склеп под часовней', theme: 'склеп', mood: 'Затхлый холод', kind: 'ruin', biome: 'forest', minutes: 6 * 60, weather: 'rain', npc: 'послушник Элан', action: false },
  { id: 'marsh-fog-evening', location: 'Гать через Туманные топи', theme: 'болотная гать', mood: 'Вязкая тревога', kind: 'wilds', biome: 'marsh', minutes: 10 * 60 + 30, weather: 'fog', npc: 'проводник Мелс', action: true },
  { id: 'camp-clear-night', location: 'Стоянка у сухого колодца', theme: 'дорога через пустыню', mood: 'Пустота и ветер', kind: 'wilds', biome: 'desert', minutes: 15 * 60 + 30, weather: 'clear', npc: 'погонщик Сайрах', action: false },
  { id: 'shipyard-storm-day', location: 'Верфь Солёных Свай', theme: 'портовая верфь', mood: 'Суета перед штормом', kind: 'port', biome: 'coast', minutes: 4 * 60, weather: 'storm', npc: 'мастер Корр', action: true },
  { id: 'village-clear-morning', location: 'Деревня Тихий Брод', theme: 'тихая деревня у реки', mood: 'Сонное утро', kind: 'village', biome: 'plains', minutes: 0, weather: 'clear', npc: 'старуха Веда', action: false },
]

function seedFor(scenario) {
  const day = campaignDayOf(scenario.minutes)
  for (let index = 0; index < 5_000; index += 1) {
    const seed = `scene-canon-live-${scenario.id}-${index}`
    if (weatherOnDay({ seed, day, biome: scenario.biome }) === scenario.weather) return seed
  }
  throw new Error(`нет сида для ${scenario.id}`)
}

function stateFor(scenario) {
  const seed = seedFor(scenario)
  const npcId = `npc-${scenario.id}`
  return {
    sessionCode: `CANON-${scenario.id}`.toUpperCase().slice(0, 24),
    state_version: 3,
    worldMap: {
      seed, currentLocationId: 'here',
      regions: [{ id: 'region-here', name: 'Край', biome: scenario.biome, x: 500, y: 320, radius: 200 }],
      locations: [{ id: 'here', name: scenario.location, kind: scenario.kind, regionId: 'region-here', x: 500, y: 320, known: true, visited: true }],
    },
    mechanics: { world_time: { elapsed_minutes: scenario.minutes } },
    scene: { title: scenario.location, location: scenario.location, location_id: 'here', theme: scenario.theme, mood: scenario.mood, objective: 'Найти пропавший груз', turn: 2 },
    players: [{ id: 'ada', character: 'Ада', hp: 12, maxHp: 12 }, { id: 'ren', character: 'Рен', hp: 10, maxHp: 10 }],
    social: { npcs: [{ id: npcId, name: scenario.npc, role: 'местный житель', location_id: 'here', location: scenario.location, available: true, visibility: 'public' }] },
    activePlayerId: 'ada',
  }
}

function briefFor(module, scenario, state, { withCanon }) {
  const viewer = { playerId: 'ada', isPartyMember: true }
  const events = scenario.action
    ? [{ event_type: 'ActorMoved', actor_id: 'ada', visibility: 'public', payload: { from: { x: 1, y: 1 }, to: { x: 3, y: 1 } }, source_rule_ids: [] }]
    : []
  return module.buildNarrationBrief({
    visible_events: events,
    visible_state_changes: [],
    known_environment: {
      scene: { ...sceneContextForAgent(state, 'ada'), arrival: !scenario.action },
      world_clock: worldClockForAgents(state, 'ada'),
      ...(withCanon ? { scene_canon: sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' }) } : {}),
      story_context: {
        heroes: [{ id: 'ada', name: 'Ада', is_viewer: true }, { id: 'ren', name: 'Рен' }],
        present_npcs: [{ id: `npc-${scenario.id}`, name: scenario.npc, role: 'местный житель', public_summary: 'Знает место.' }],
        open_promises: [], recent_interactions: [],
      },
    },
    permitted_npc_reactions: [],
    viewer,
  })
}

async function runNarrator() {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const scenario of SCENARIOS) {
      const state = stateFor(scenario)
      const canon = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
      for (const condition of repeat % 2 ? ['before', 'after'] : ['after', 'before']) {
        if (report.narrator.some((row) => row.repeat === repeat && row.scenario === scenario.id && row.condition === condition)) continue
        const modules = condition === 'before' ? before : after
        const client = new EvalClient('narrator', condition, 700)
        const narrator = new modules.narrator.Narrator({ llmClient: client, asyncFeedback: false })
        const brief = briefFor(modules.security, scenario, state, { withCanon: condition === 'after' })
        let rendered = null
        let error = null
        try {
          rendered = await narrator.render(brief, { timeoutMs: 60_000 })
        } catch (caught) { error = String(caught?.code ?? caught?.message ?? caught).slice(0, 120) }
        const raw = client.last?.raw_text ?? ''
        const rawFlags = sceneCanonContradictions(raw, canon)
        const shownFlags = sceneCanonContradictions(rendered?.narration ?? '', canon)
        report.narrator.push({
          repeat, scenario: scenario.id, condition,
          canon: { clock: canon.time.clock, phase: canon.time.phase, weather: canon.weather.id, indoors: canon.indoors, wetness: canon.surfaces.wetness, water_nearby: canon.surfaces.water_nearby, kind: canon.location.kind },
          prompt_version: rendered?.prompt_version ?? null,
          provider: rendered?.provider ?? null,
          raw_text: raw,
          shown_text: rendered?.narration ?? '',
          verifier_codes: [...new Set((rendered?.verification?.repaired_from ?? rendered?.verification?.violations ?? []).map((violation) => violation.code))],
          raw_canon_contradictions: rawFlags.map((flag) => ({ kind: flag.kind, match: flag.match })),
          shown_canon_contradictions: shownFlags.map((flag) => ({ kind: flag.kind, match: flag.match })),
          error,
        })
        save()
        console.log(JSON.stringify({ repeat, scenario: scenario.id, condition, provider: rendered?.provider, raw_flags: rawFlags.length, shown_flags: shownFlags.length, spent: Number(spent().toFixed(3)) }))
      }
    }
  }
}

const BOOTSTRAP_WORLDS = [
  { id: 'aquilon', world: { premise: 'Портовый город Аквилон стоит на сваях; туманы с моря кормят контрабандистов, а пропавший груз соли рушит торговлю.', tone: 'приземлённое тёмное фэнтези', startingLocation: 'Причал Аквилона' } },
  { id: 'frontier', world: { premise: 'Приграничный город живёт торговлей и слухами; северный тракт опустел после пропажи каравана.', tone: 'приземлённое тёмное фэнтези' } },
  { id: 'desert', world: { premise: 'Караванный город у края пустыни ждёт воду из старого акведука, но акведук пересох за одну ночь.', tone: 'приключенческое фэнтези с тайной' } },
]
const BOOTSTRAP_HEROES = [
  { id: 'hero', character: 'Ада', role: 'Следопыт', backstory: 'Выросла в приграничье, водила караваны.' },
  { id: 'rogue', character: 'Рен', role: 'Плут', backstory: 'Бывший карманник, должен денег гильдии.' },
]

async function runBootstrap() {
  for (const [index, entry] of BOOTSTRAP_WORLDS.slice(0, bootstrapRuns).entries()) {
    for (const condition of index % 2 ? ['after', 'before'] : ['before', 'after']) {
      if (report.bootstrap.some((row) => row.world === entry.id && row.condition === condition)) continue
      const modules = condition === 'before' ? before : after
      const client = new EvalClient('campaign_creator', condition, 3600)
      const created = await new modules.bootstrap.CampaignBootstrapper({ llmClient: client }).create({
        code: `CANON-BOOT-${index + 1}`, name: 'Проверка канона', partyName: 'Отряд', world: entry.world, players: BOOTSTRAP_HEROES,
      })
      const canon = sceneCanonFor(created, { playerId: 'hero', actorId: 'hero' })
      const opening = String(created.messages?.[0]?.text ?? '')
      const flags = sceneCanonContradictions(opening, canon)
      const moodFlags = sceneCanonContradictions(String(created.scene?.mood ?? ''), canon)
      report.bootstrap.push({
        world: entry.id, condition, generated_by: created.campaignConcept?.generatedBy ?? null,
        canon: { clock: canon.time.clock, phase: canon.time.phase, weather: canon.weather.id, biome: canon.location.biome, indoors: canon.indoors },
        promised_weather_table: condition === 'after' ? Object.fromEntries(Object.entries(campaignStartCanon(created.worldMap.seed).weather_by_biome).map(([biome, value]) => [biome, value.id])) : null,
        scene_location: created.scene?.location ?? '', scene_mood: created.scene?.mood ?? '',
        opening,
        opening_canon_contradictions: flags.map((flag) => ({ kind: flag.kind, match: flag.match })),
        mood_canon_contradictions: moodFlags.map((flag) => ({ kind: flag.kind, match: flag.match })),
      })
      save()
      console.log(JSON.stringify({ world: entry.id, condition, generated_by: created.campaignConcept?.generatedBy, flags: flags.length, weather: canon.weather.id, biome: canon.location.biome, spent: Number(spent().toFixed(3)) }))
    }
  }
}

if (part === 'narrator') await runNarrator()
else if (part === 'bootstrap') await runBootstrap()
else if (part === 'anchors') {
  // Без сети: сколько сенсорных якорей во входе Рассказчика уже спорили с
  // каноном ДО (палитра по названию места) и ПОСЛЕ (палитра под канон).
  report.anchors = SCENARIOS.map((scenario) => {
    const state = stateFor(scenario)
    const canon = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
    const sides = {}
    for (const [condition, modules] of [['before', before], ['after', after]]) {
      const anchors = modules.narrator.sensoryAnchorsFor(briefFor(modules.security, scenario, state, { withCanon: condition === 'after' }))
      sides[condition] = {
        anchors,
        // Судья якорей один на обе стороны: sensoryAnchorConflicts из текущего scene-canon.
        conflicts: Object.entries(anchors).flatMap(([slot, anchor]) => sensoryAnchorConflicts(anchor, canon).map((reason) => ({ slot, anchor, reason }))),
      }
    }
    return { scenario: scenario.id, canon: canon.summary, ...sides }
  })
} else if (part === 'summarize') {
  const manual = JSON.parse(readFileSync(new URL('eval/scene-canon-live-manual-2026-10-01.json', root), 'utf8'))
  report.manual_review = manual
  const narratorRows = (condition) => report.narrator.filter((row) => row.condition === condition)
  const manualCount = (condition, severity) => manual.narrator.filter((entry) => entry.condition === condition && entry.severity === severity).length
  const bootRows = (condition) => report.bootstrap.filter((row) => row.condition === condition)
  const bootManual = (condition, field) => manual.bootstrap.filter((entry) => entry.condition === condition && entry[field] === true).length
  report.summary = {
    narrator: Object.fromEntries(['before', 'after'].map((condition) => [condition, {
      calls: narratorRows(condition).length,
      automatic_raw_contradictions: narratorRows(condition).filter((row) => row.raw_canon_contradictions.length).length,
      automatic_shown_contradictions: narratorRows(condition).filter((row) => row.shown_canon_contradictions.length).length,
      manual_hard_contradictions: manualCount(condition, 'hard'),
      manual_soft_contradictions: manualCount(condition, 'soft'),
      fallback_to_template: narratorRows(condition).filter((row) => String(row.provider).startsWith('deterministic')).length,
    }])),
    anchors: report.anchors ? {
      before_conflicting_anchors: report.anchors.reduce((sum, row) => sum + new Set(row.before.conflicts.map((conflict) => conflict.slot)).size, 0),
      after_conflicting_anchors: report.anchors.reduce((sum, row) => sum + new Set(row.after.conflicts.map((conflict) => conflict.slot)).size, 0),
      before_scenes_with_conflict: report.anchors.filter((row) => row.before.conflicts.length).length,
      after_scenes_with_conflict: report.anchors.filter((row) => row.after.conflicts.length).length,
      scenarios: report.anchors.length,
    } : null,
    bootstrap: Object.fromEntries(['before', 'after_v6_draft', 'after'].map((condition) => [condition, {
      runs: bootRows(condition).length,
      automatic_contradictions: bootRows(condition).filter((row) => row.opening_canon_contradictions.length || row.mood_canon_contradictions.length).length,
      manual_time_contradictions: bootManual(condition, 'time_contradiction'),
      manual_weather_contradictions: bootManual(condition, 'weather_contradiction'),
      time_of_day_stated: bootManual(condition, 'time_stated'),
      fully_consistent: bootManual(condition, 'consistent'),
    }])),
  }
  console.log(JSON.stringify(report.summary, null, 2))
} else if (part === 'dry') {
  // Без сети: какие каноны получились у сцен и что видит старый и новый brief.
  for (const scenario of SCENARIOS) {
    const state = stateFor(scenario)
    const canon = sceneCanonFor(state, { playerId: 'ada', actorId: 'ada' })
    console.log(scenario.id, canon.summary)
    briefFor(before.security, scenario, state, { withCanon: false })
    briefFor(after.security, scenario, state, { withCanon: true })
  }
} else throw new Error('--part narrator|bootstrap|anchors|summarize|dry')
report.spent_rub = Number(spent().toFixed(4))
save()
console.log(JSON.stringify({ spent_rub: report.spent_rub }))
