/**
 * Замер «рассказчик как живой ведущий»: одна и та же партия в своём мире,
 * проигранная через HTTP так же, как её играл человек в браузере
 * (плейтест 2026-10-10, «Серый Причал»). В отличие от прогона Асстохана здесь
 * не проверяется, дойдёт ли кампания до финала, — меряется, как ведущий
 * отвечает на типичные ходы живого стола: личная зацепка героя, обыск, подкуп,
 * вопрос ведущему, творческое заклинание, отыгрыш без механики, переход в новое
 * место, ночь, короткий бой.
 *
 *   node eval/gm-session.mjs                 # с моделью из .env и судьями (стоит денег)
 *   node eval/gm-session.mjs --offline       # без модели: проверить сам сценарий
 *   node eval/gm-session.mjs --no-judge      # без судей
 *   node eval/gm-session.mjs --out tmp/gm-session/run1 --keep
 *
 * Итог — `<out>/report.md` (оценки судей, служебные фразы, повторы),
 * `<out>/transcript.md` (вся партия), `<out>/report.json`.
 * Хранилище временное, `storage/` не трогается. Ключ в отчёт не пишется.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { abilityScoreChoiceLevelsFor, classSkillRuleFor, featureChoiceGroupsFor, normalizedClassSkillProficiencies } from '../server/character-progression.mjs'
import { characterCreationChoicesComplete } from '../server/character-lifecycle.mjs'
import { combatClassCatalogInfo, combatSubclassOptionsFor, normalizedCombatSubclassFor } from '../server/combat-actions.mjs'
import { combatSpellsFor, spellSelectionRulesFor } from '../server/combat-spells.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const LIVE = !flag('offline')
const JUDGE = LIVE && !flag('no-judge')
const KEEP = flag('keep')
const PORT = Number(option('port', 8800 + Math.floor(Math.random() * 90)))
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const OUT = resolve(ROOT, option('out', join('tmp', 'gm-session', `${STAMP}${LIVE ? '-live' : ''}`)))
const CODE = 'GM-SESSION'
const RULESET_ID = 'dnd_5e_2014'
const START_LEVEL = 3
const HOLISTIC_MODEL = option('holistic-model', 'anthropic/claude-sonnet-5.5')
const base = `http://127.0.0.1:${PORT}`
const setupToken = `gm-${randomUUID()}`

if (LIVE) {
  const envText = (() => { try { return readFileSync(join(ROOT, '.env'), 'utf8') } catch { return '' } })()
  if (!process.env.ROUTERAI_API_KEY && !/^ROUTERAI_API_KEY=\S+/mu.test(envText)) {
    console.error(`Нужен ROUTERAI_API_KEY в ${join(ROOT, '.env')} (или --offline).`)
    process.exit(2)
  }
}
mkdirSync(OUT, { recursive: true })
const storage = mkdtempSync(join(tmpdir(), 'skazanie-gm-'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const short = (value, limit = 240) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

// ---------------------------------------------------------------------------
// Мир и герои — как в браузерной партии

const WORLD = {
  preset: 'Тёмное приморское фэнтези',
  premise: 'Северное приморское баронство. Туманный порт Серый Причал живёт контрабандой и рыбой. На скале над гаванью — заброшенный маяк, который снова загорается по ночам. В городе тайно действует культ «Утопленной Матери», приносящий людей в жертву морю. Барон слаб, стража продажна. Тон — мрачное фэнтези, но с живыми людьми и долей юмора.',
  openingSituation: 'Ночь, гроза. Герои сидят в портовой таверне «Ржавый якорь», когда в гавань без огней заходит рыбацкий баркас без единого человека на борту.',
}

const HEROES = [
  {
    key: 'wizard', name: 'Мирель',
    document: {
      character: 'Мирель', name: 'Ведущий стола', role: 'Волшебник · ур. 1', characterClass: 'wizard', species: 'Скальный гном',
      background: 'Мудрец', backgroundId: 'sage', backgroundChoices: { tools: [], languages: ['elvish', 'draconic'] },
      starterEquipmentChoices: { weapon: ['quarterstaff'], focus: ['arcane-focus'], pack: ['scholars-pack'] },
      level: 1, experience: 0,
      abilities: { str: 8, dex: 13, con: 15, int: 17, wis: 12, cha: 10 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
        baseScores: { str: 8, dex: 13, con: 14, int: 15, wis: 12, cha: 10 },
        originBonusProfileId: 'gnome-rock', originBonuses: { str: 0, dex: 0, con: 1, int: 2, wis: 0, cha: 0 }, speciesOptionId: 'gnome-rock',
      },
      baseSpeed: 25, hitPointIncreases: [], classSkillProficiencies: ['insight', 'investigation'], selectedFeatureIds: [],
      knownSpellIds: ['fire-bolt', 'mage-hand', 'ray-of-frost', 'magic-missile', 'shield', 'silent-image', 'sleep', 'burning-hands'],
      preparedSpellIds: ['magic-missile', 'shield', 'silent-image', 'burning-hands'],
      traits: 'Вежливая, сухо ироничная, всё записывает в тетрадь; чернильные пятна на пальцах.',
      bonds: 'Младшая сестра Ила — единственный родной человек.',
      backstory: 'Младшая сестра Мирели, Ила, три месяца назад ушла в море на рыбацком баркасе из Серого Причала и не вернулась. Портовые сказали — шторм. Мирель не верит и приехала в Серый Причал искать правду.',
    },
    skills: ['insight', 'investigation', 'arcana', 'history'],
    subclass: ['Школа Воплощения', 'Воплощ'],
    asi: ['int', 'int'],
    cantrips: ['fire-bolt', 'mage-hand', 'ray-of-frost'],
    spells: ['magic-missile', 'shield', 'silent-image', 'burning-hands', 'sleep', 'scorching-ray', 'misty-step', 'detect-magic'],
  },
  {
    key: 'fighter', name: 'Борин',
    document: {
      character: 'Борин', name: 'Второй игрок', role: 'Воин · ур. 1', characterClass: 'fighter', species: 'Холмовой дварф',
      background: 'Солдат', backgroundId: 'soldier', backgroundChoices: { tools: ['dice_set'], languages: [] },
      speciesChoices: { 'artisan-tool': ['smiths_tools'] },
      starterEquipmentChoices: { armor: ['chain-mail'], 'melee-loadout': ['longsword-shield'], secondary: ['light-crossbow'], pack: ['explorers-pack'] },
      level: 1, experience: 0,
      abilities: { str: 15, dex: 14, con: 15, int: 12, wis: 11, cha: 8 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
        baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
        originBonusProfileId: 'dwarf-hill', originBonuses: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 }, speciesOptionId: 'dwarf-hill',
      },
      baseSpeed: 25, hitPointIncreases: [], classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'], knownSpellIds: [], preparedSpellIds: [],
      traits: 'Пьёт, но честен. Говорит коротко.',
      bonds: 'Стыдится, что когда-то промолчал на службе.',
      backstory: 'Бывший сержант баронской стражи Серого Причала. Ушёл со службы, когда капитан велел ему не замечать ночные лодки у старого маяка.',
    },
    skills: ['athletics', 'perception', 'insight', 'intimidation'],
    subclass: ['Мастер боевых искусств', 'Чемпион'],
    asi: ['str', 'con'],
    cantrips: [], spells: [],
  },
]

// ---------------------------------------------------------------------------
// Сервер и HTTP

let child = null
let logs = ''
function startServer() {
  const env = {
    ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(PORT), DND_STORAGE_DIR: storage,
    ADMIN_SETUP_TOKEN: setupToken, COOKIE_SECURE: 'false', NODE_ENV: 'test', DND_COMBAT_TURN_TIMEOUT_MS: '3600000',
  }
  if (!LIVE) env.ROUTERAI_API_KEY = ''
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
}
async function stopServer() {
  if (!child || child.exitCode != null) return
  await new Promise((done) => { child.once('exit', done); child.kill() })
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился с кодом ${child.exitCode}\n${logs.slice(-2000)}`)
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* запускается */ }
    await sleep(100)
  }
  throw new Error(`Сервер не поднялся\n${logs.slice(-2000)}`)
}
process.on('exit', () => { try { child?.kill() } catch { /* уже остановлен */ } })

const timings = []
async function request(path, { method = 'GET', account, body, key, timeoutMs = 180_000 } = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}${path}`, {
      method, signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(account?.cookie ? { Cookie: account.cookie } : {}),
        ...(key ? { 'X-Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* не JSON */ }
    timings.push({ path: `${method} ${path.replace(/\/GM-SESSION/u, '/:code')}`, ms: Date.now() - started, status: response.status })
    return { status: response.status, body: parsed, text, ms: Date.now() - started, response }
  } catch (error) {
    return { status: 0, body: null, text: String(error), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
const cookieOf = (result) => result.response?.headers.get('set-cookie')?.split(';')[0] ?? ''
const accounts = []
const accountFor = (actorId) => accounts.find((account) => account.heroId === actorId) ?? accounts[0]
async function room(account = accounts[0]) {
  const result = await request(`/api/rooms/${CODE}`, { account })
  if (result.status !== 200) throw new Error(`Комната недоступна (${result.status}): ${result.text.slice(0, 300)}`)
  return result.body.state
}
const heroOf = (state, actorId) => state.players.find((player) => player.id === actorId)
let commandSeq = 0
// Слова героя к команде доски — отдельным полем `player_note`, как шлёт клиент
// после потока D: внутри `message` они до летописи не доходили, и судья писал
// «не учтены слова игрока» (замеры 2026-10-10).
async function command(actorId, commandValue, label = commandValue.command_type, account = accountFor(actorId), note = '') {
  const key = `gm-${commandValue.command_type}-${++commandSeq}`
  return request(`/api/campaigns/${CODE}/commands`, {
    method: 'POST', account, key,
    body: { idempotency_key: key, message: label, ...(note ? { player_note: note } : {}), command: { actor_id: actorId, ...commandValue } },
  })
}

// ---------------------------------------------------------------------------
// Журнал партии

const exchanges = []
const transcript = []
const problems = []
const note = (line) => transcript.push(line)
function problem(kind, message) {
  problems.push({ kind, message })
  note(`> ⚠ ${kind}: ${message}`)
}

/** Сообщения хроники после известного набора id, кроме реплик игроков. */
const messageIds = (state) => new Set((state?.messages ?? []).map((entry) => String(entry.id)))
// Реплики, уже показанные в отчёте ходом: блок «бой целиком» собирает
// летопись с начала боя и прежде печатал реплику заклинания второй раз — судья
// читал это как дубль ведущего (замер 2026-10-10).
const reportedMessageIds = new Set()

function freshMessages(before, state) {
  const fresh = (state?.messages ?? [])
    .filter((entry) => !before.has(String(entry.id)) && !reportedMessageIds.has(String(entry.id)) && entry.speaker !== 'player' && entry.role !== 'player')
    .filter((entry) => String(entry.text ?? '').trim())
  for (const entry of fresh) reportedMessageIds.add(String(entry.id))
  return fresh.map((entry) => ({ author: String(entry.author ?? entry.speaker ?? ''), speaker: String(entry.speaker ?? ''), text: String(entry.text ?? '') }))
}

function sceneContext(state) {
  const weather = state?.weather ?? {}
  const npcs = (state?.scene_npcs ?? []).filter((npc) => npc.location_id === state?.scene?.location_id && npc.alive !== false)
  return {
    location: state?.scene?.location ?? '',
    title: state?.scene?.title ?? '',
    objective: state?.scene?.objective ?? '',
    time: `${weather.phase_label ?? ''} ${weather.clock ?? ''}, ${weather.weather_label ?? ''}`.trim(),
    npcs: npcs.map((npc) => `${npc.name} (${npc.role})`),
    zones: (state?.scene?.map?.zones ?? []).map((zone) => zone.label ?? zone.kind).filter(Boolean).slice(0, 12),
  }
}

/**
 * Свободная реплика так, как её шлёт клиент: ручной бросок, уточнение,
 * предложение ведущего. Ответ пишется целиком — всё, что игрок увидел в хронике.
 */
let narrateSeq = 0
async function say(actorId, action, { label = '', requestKind, kind = 'action' } = {}) {
  const account = accountFor(actorId)
  const before = await room(account)
  const hero = heroOf(before, actorId)
  const seen = messageIds(before)
  const baseBody = { action, campaign_id: CODE, actor_id: actorId, manual_roll: true, ...(requestKind ? { request_kind: requestKind } : {}) }
  let body = { ...baseBody, idempotency_key: `gm-say-${++narrateSeq}` }
  note(`\n**${hero?.character ?? actorId}${label ? ` · ${label}` : ''}:** ${action}`)
  const steps = []
  const started = Date.now()
  let followUps = 0
  // «Продолжим» клиент отправляет Режиссёру (`isAdventureContinuation`,
  // `src/director-continuation.mjs`), а не в /api/narrate.
  if (/^(?:продолжим|продолжаем)(?:\s+(?:приключение|историю))?$/iu.test(action.trim())) {
    const key = `gm-advance-${++narrateSeq}`
    const result = await request(`/api/campaigns/${CODE}/autonomy/advance`, { method: 'POST', account, key, body: { idempotency_key: key, player_action: action, actor_id: actorId } })
    if (result.status !== 200) note(`> ⚠ продолжение: ${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error ?? result.text, 200)}`)
    followUps = 99
  }
  for (let hop = 0; hop < 4 && followUps < 99; hop += 1) {
    const result = await request('/api/narrate', { method: 'POST', account, body, key: body.idempotency_key })
    if (result.status !== 200) {
      steps.push({ refused: `${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error ?? result.text, 200)}` })
      note(`> ⚠ отказ ${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error ?? result.text, 300)}`)
      if (result.body?.code === 'ROLL_CONTEXT_MISMATCH') problem('roll-context-mismatch', `«${short(action, 80)}»`)
      break
    }
    const answer = result.body
    steps.push({ narration: answer.narration ?? '', check: answer.check ? short(answer.check.label ?? answer.check.skill, 80) : null, clarification: answer.clarification?.question ?? null })
    if (answer.check && !answer.mechanics?.some((event) => event.event_type === 'AbilityCheckResolved')) {
      const check = answer.check
      note(`> 🎲 проверка: ${check.label ?? check.skill ?? check.ability} СЛ ${check.difficulty ?? '?'}`)
      const rolled = await request('/api/roll', { method: 'POST', account, body: { checkId: check.check_id, playerId: actorId, campaignId: CODE } })
      if (rolled.status !== 200) { problem('roll-refused', `${rolled.status} ${rolled.body?.code ?? ''}`); break }
      note(`> 🎲 ${rolled.body.value} + ${rolled.body.modifier} = **${rolled.body.total}** против ${rolled.body.difficulty ?? '?'} → ${rolled.body.success ? 'успех' : 'провал'}`)
      // Как клиент (`useGameSession`): кость едет с согласованным текстом шага
      // (`resolved_action`) и уточнением, к которому привязана проверка. Прежде
      // стенд слал полный текст плана, и шаг с проверкой падал в
      // ROLL_CONTEXT_MISMATCH — ход оставался без ответа.
      const clarificationId = check.clarification_id ?? answer.clarification?.id
      body = { ...baseBody, action: answer.resolved_action ?? body.action, idempotency_key: `gm-say-${++narrateSeq}`, roll: { roll_id: rolled.body.roll_id }, ...(clarificationId ? { clarification_id: clarificationId } : {}) }
      const resolved = await request('/api/narrate', { method: 'POST', account, body, key: body.idempotency_key })
      if (resolved.status !== 200) {
        note(`> ⚠ продолжение броска: ${resolved.status} ${resolved.body?.code ?? ''}`)
        if (resolved.body?.code === 'ROLL_CONTEXT_MISMATCH') problem('roll-context-mismatch', `«${short(action, 80)}» после броска`)
      }
      break
    }
    if (answer.clarification && !answer.check && followUps < 1) {
      // Живой игрок на вопрос ведущего отвечает коротко: выбирает первый
      // вариант или соглашается («Да»), как в браузерной партии.
      followUps += 1
      const options = answer.clarification.options ?? answer.clarification.choices ?? []
      const pick = options[0]?.label ?? options[0]?.text ?? (typeof options[0] === 'string' ? options[0] : null) ?? 'Да'
      note(`> ❓ ${short(answer.clarification.question ?? answer.narration, 300)} → игрок: «${short(pick, 80)}»`)
      body = { ...baseBody, action: String(pick), idempotency_key: `gm-say-${++narrateSeq}`, clarification_id: answer.clarification.id }
      continue
    }
    if (answer.action_proposal?.id && followUps < 1) {
      followUps += 1
      body = { ...baseBody, idempotency_key: `gm-say-${++narrateSeq}`, confirmed_proposal_id: answer.action_proposal.id }
      continue
    }
    break
  }
  await settleInteraction()
  const after = await room(account)
  const replies = freshMessages(seen, after)
  for (const reply of replies) note(`> [${reply.author}] ${short(reply.text, 1600)}`)
  const exchange = {
    index: exchanges.length + 1, label, kind, actor: hero?.character ?? actorId, action,
    replies, ms: Date.now() - started, scene: sceneContext(after), refused: steps.some((step) => step.refused),
  }
  exchanges.push(exchange)
  return exchange
}

/** Голосования и решения группы: все голосуют за первый «идём» вариант. */
async function settleInteraction() {
  for (let guard = 0; guard < 6; guard += 1) {
    const state = await room()
    const interaction = state.agentInteraction
    if (!interaction) return
    if (interaction.status === 'open') {
      const options = interaction.options ?? []
      const preferred = options.find((entry) => /^(accept|continue|go|yes)$/u.test(String(entry.id)))
        ?? options.find((entry) => /принять|продолж|идём|в путь|да\b|отправ|уходим из/iu.test(String(entry.label)) && !/бросаем/iu.test(String(entry.label)))
        ?? options[0]
      if (!preferred) return
      note(`- 🗳 «${short(interaction.title ?? interaction.question ?? interaction.id, 120)}» → «${preferred.label}»`)
      for (const account of accounts) {
        const key = `gm-vote-${randomUUID()}`
        await request(`/api/campaigns/${CODE}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, { method: 'POST', account, key, body: { actor_id: account.heroId, option_id: preferred.id, idempotency_key: key } })
      }
      continue
    }
    if (interaction.status === 'resolved') {
      const winner = (interaction.options ?? []).find((entry) => entry.id === interaction.resolvedOptionId)
      if (!winner || interaction.resolutionConsumed || interaction.consumed) return
      // Клиент после решения шлёт продолжение кнопкой «Продолжить историю».
      const key = `gm-say-${++narrateSeq}`
      const result = await request('/api/narrate', { method: 'POST', account: accounts[0], key, body: { action: `[РЕШЕНИЕ ГРУППЫ] ${winner.label}`, campaign_id: CODE, actor_id: accounts[0].heroId, idempotency_key: key } })
      if (result.status !== 200) return
      const fresh = await room()
      if (fresh.agentInteraction?.id === interaction.id && fresh.agentInteraction.status === 'resolved') return
      continue
    }
    return
  }
}

// ---------------------------------------------------------------------------
// Герои: импорт первого уровня и повышение до стартового (как в прогоне Асстохана)

function pendingChoices(actor, plan, rulesetId) {
  const commands = []
  const skillRule = classSkillRuleFor(actor)
  let skills = normalizedClassSkillProficiencies(actor)
  if (skillRule && skills.length !== skillRule.choiceCount) {
    const allowed = skillRule.skills
    skills = [...new Set([...plan.skills, ...allowed])].filter((id) => allowed.includes(id)).slice(0, skillRule.choiceCount)
  }
  const subclassOptions = combatSubclassOptionsFor(actor)
  let subclass = String(actor.subclass ?? '')
  const subclassName = (entry) => String(entry?.name ?? entry?.label ?? entry?.id ?? entry)
  const subclassLevel = Number(combatClassCatalogInfo().classes.find((entry) => entry.classKey === actor.characterClass)?.subclassLevel ?? 99)
  if (!normalizedCombatSubclassFor(actor) && subclassOptions.length && Number(actor.level) >= subclassLevel) {
    const preferred = subclassOptions.find((entry) => plan.subclass.some((name) => subclassName(entry).toLocaleLowerCase('ru').includes(name.toLocaleLowerCase('ru'))))
    subclass = subclassName(preferred ?? subclassOptions[0])
  }
  const probe = { ...actor, subclass, classSkillProficiencies: skills }
  const selected = new Set(actor.selectedFeatureIds ?? [])
  const features = []
  for (const group of featureChoiceGroupsFor(probe)) {
    const kept = group.options.filter((entry) => selected.has(entry.id)).map((entry) => entry.id)
    const extra = group.options.map((entry) => entry.id).filter((id) => !kept.includes(id))
    features.push(...[...kept, ...extra].slice(0, group.choiceCount))
  }
  const asiLevel = abilityScoreChoiceLevelsFor(actor).find((level) => level <= Number(actor.level) && !actor.abilityScoreIncreases?.[String(level)] && !actor.levelFeats?.[String(level)])
  if (characterCreationChoicesComplete(actor, { rulesetId })) return []
  const changed = asiLevel || subclass !== String(actor.subclass ?? '') || JSON.stringify(skills) !== JSON.stringify(actor.classSkillProficiencies ?? [])
    || JSON.stringify([...features].sort()) !== JSON.stringify([...(actor.selectedFeatureIds ?? [])].sort())
  if (changed) {
    commands.push({
      command_type: 'SetCharacterChoices', subclass, class_skill_proficiencies: skills, selected_feature_ids: features,
      ...(asiLevel ? { ability_score_level: asiLevel, ability_score_increases: plan.asi } : {}),
    })
  }
  const rules = spellSelectionRulesFor(probe)
  if (rules) {
    const spells = combatSpellsFor({ ...probe, knownSpellIds: undefined, preparedSpellIds: undefined }, { rulesetId })
    const byId = new Map(spells.map((spell) => [spell.id, spell]))
    const cantrips = [...new Set([...plan.cantrips, ...spells.filter((spell) => spell.level === 0).map((spell) => spell.id)])].filter((id) => byId.get(id)?.level === 0).slice(0, rules.cantrips)
    const leveledPool = [...new Set([...plan.spells, ...spells.filter((spell) => spell.level > 0).map((spell) => spell.id)])].filter((id) => (byId.get(id)?.level ?? 0) > 0)
    const known = rules.mode === 'known' ? [...cantrips, ...leveledPool.slice(0, rules.spellsKnown)] : rules.mode === 'spellbook' ? [...cantrips, ...leveledPool.slice(0, rules.spellbookMinimum)] : cantrips
    const prepared = rules.mode === 'known' ? [] : leveledPool.slice(0, rules.preparedLimit)
    if (JSON.stringify(known) !== JSON.stringify(actor.knownSpellIds ?? []) || JSON.stringify(prepared) !== JSON.stringify(actor.preparedSpellIds ?? [])) {
      commands.push({ command_type: 'SetSpellSelections', known_spell_ids: known, prepared_spell_ids: prepared })
    }
  }
  return commands
}

async function buildHero(account, plan) {
  const actorId = account.heroId
  const imported = await command(actorId, { command_type: 'ImportCharacter', document: { schema: 'skazanie.character', schema_version: 1, character: plan.document } }, `Импорт: ${plan.name}`, account)
  if (imported.status !== 200) throw new Error(`${plan.name}: импорт отклонён ${imported.body?.code ?? imported.status} — ${short(imported.body?.error ?? imported.text, 300)}`)
  for (let guard = 0; guard < 20; guard += 1) {
    const state = await room(account)
    const actor = heroOf(state, actorId)
    for (const choice of pendingChoices(actor, plan, state.ruleset_id)) {
      const saved = await command(actorId, choice, `${choice.command_type} ур. ${actor.level}`, account)
      if (saved.status !== 200) throw new Error(`${plan.name}, ур. ${actor.level}: ${choice.command_type} отклонён ${saved.body?.code} — ${short(saved.body?.error, 240)}`)
    }
    const fresh = heroOf(await room(account), actorId)
    if (Number(fresh.level) >= START_LEVEL) break
    const leveled = await command(actorId, { command_type: 'LevelUp', expected_level: Number(fresh.level) }, `Повышение до ${Number(fresh.level) + 1}`, account)
    if (leveled.status !== 200) throw new Error(`${plan.name}: LevelUp с ${fresh.level} отклонён ${leveled.body?.code} — ${short(leveled.body?.error, 240)}`)
  }
  const hero = heroOf(await room(account), actorId)
  note(`- ${hero.character}: ${hero.role}, ур. ${hero.level}, ОЗ ${hero.hp}/${hero.maxHp}, КД ${hero.armor}, подкласс «${hero.subclass ?? '—'}»`)
  if (hero.characterSetupRequired) throw new Error(`${plan.name}: подготовка героя не закрылась`)
}

// ---------------------------------------------------------------------------
// Бой: короткая стычка, собранная ведущим, с репликами игроков к действиям

async function fight() {
  const owner = accounts[0]
  let state = await room()
  const seen = messageIds(state)
  const assembled = await request(`/api/campaigns/${CODE}/encounters/assemble`, {
    method: 'POST', account: owner, key: `gm-enc-${randomUUID()}`,
    // Короткая стычка, как в сценарии: «средняя» ватага на двух героев третьего
    // уровня тянулась два десятка раундов, и судья оценивал скуку стенда, а не
    // ведущего (замер 2026-10-10). Засада — разбойники и мелочь, ближе к культу.
    body: { expected_state_version: state.state_version ?? 0, difficulty: 'easy', theme: 'ambush', seed: 'gm-session-ambush' },
  })
  if (assembled.status !== 200) { problem('encounter', `${assembled.status} ${assembled.body?.code ?? ''}: ${short(assembled.body?.error, 200)}`); return }
  note('\n### ⚔ Бой')
  const flavor = new Map([
    ['hero-slot-2', ['Борин рычит «За Илу и за стражу Причала!» и рубит с плеча', 'Борин прикрывает Мирель щитом и бьёт в ответ', 'Борин хрипло смеётся и наваливается всем весом']],
    ['hero-slot-1', ['Мирель шепчет формулу, и с пальцев срывается огонь', 'Мирель целится в того, кто ближе к Борину', 'Мирель стискивает зубы и бьёт ещё раз']],
  ])
  let freeTextSpellTried = false
  for (let step = 0; step < 60; step += 1) {
    state = await room()
    if (!state.mechanics?.combat?.active) break
    // Окно реакции («Щит» и т. п.) ждёт ответа героя: игрок берёт первую
    // предложенную реакцию, иначе отказывается — бой не должен застревать.
    const window = state.mechanics.combat.reaction_window
    if (window?.actor_id?.startsWith?.('hero-slot-')) {
      const option = window.action_options?.[0]
      const reacted = option ? await command(window.actor_id, { command_type: 'UseCombatAction', action_id: option.id }, `Реакция: ${option.label ?? option.id}`) : { status: 0 }
      if (reacted.status !== 200) await command(window.actor_id, { command_type: 'UseCombatAction', action_id: 'decline-reaction' }, 'Отказаться от реакции')
      continue
    }
    const actorId = state.tacticalTurn?.actorId
    if (!actorId?.startsWith('hero-slot-')) { await sleep(1500); continue }
    const hero = heroOf(state, actorId)
    const foes = (state.enemies ?? []).filter((enemy) => enemy.alive !== false && enemy.healthStatus !== 'defeated')
    if (!foes.length) break
    if (Number(hero?.hp) <= 0) { await command(actorId, { command_type: 'EndTurn' }, 'Завершить ход'); continue }
    const round = Number(state.tacticalTurn?.round ?? 0)
    const line = flavor.get(actorId)?.[round % 3] ?? ''
    const target = foes.map((enemy) => ({ enemy, distance: Math.max(Math.abs(enemy.x - hero.x), Math.abs(enemy.y - hero.y)) })).sort((a, b) => a.distance - b.distance)[0].enemy
    if (actorId === 'hero-slot-1' && !freeTextSpellTried) {
      freeTextSpellTried = true
      await say(actorId, `Мирель отступает за спину Борина и швыряет в ${target.name} Огненный снаряд`, { label: 'заклинание словами в бою', kind: 'combat-free-text' })
      state = await room()
      if (state.tacticalTurn?.actorId !== actorId || !state.mechanics?.combat?.active) continue
      if (state.tacticalTurn?.actionUsed) { await command(actorId, { command_type: 'EndTurn' }, 'Завершить ход'); continue }
    }
    if (actorId === 'hero-slot-1') {
      await command(actorId, { command_type: 'CastSpell', spell_id: 'fire-bolt', target_id: target.id }, 'Огненный снаряд', accountFor(actorId), line)
    } else {
      const distance = Math.max(Math.abs(target.x - hero.x), Math.abs(target.y - hero.y))
      if (distance > 1) {
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => ({ x: target.x + dx, y: target.y + dy }))
        let moved = false
        for (const cell of near) { const step = await command(actorId, { command_type: 'MoveActor', to: cell }, 'Подойти'); if (step.status === 200) { moved = true; break } }
        // Стрелок дальше одного хода: прежде бот стоял на месте, и Борин
        // раунд за раундом «ничего не делал» (замер 2026-10-10). Теперь он
        // идёт навстречу на сколько хватит скорости.
        const reach = Math.max(1, Math.floor(Number(hero?.speed ?? 30) / 5))
        for (let cells = Math.min(reach, distance - 1); !moved && cells >= 1; cells -= 1) {
          const to = {
            x: hero.x + Math.sign(target.x - hero.x) * Math.min(cells, Math.abs(target.x - hero.x)),
            y: hero.y + Math.sign(target.y - hero.y) * Math.min(cells, Math.abs(target.y - hero.y)),
          }
          const step = await command(actorId, { command_type: 'MoveActor', to }, 'Сблизиться')
          if (step.status === 200) moved = true
        }
      }
      const weapon = (hero.inventory ?? []).find((item) => item.equipped && /меч|топор|молот/iu.test(String(item.name)))
      await command(actorId, { command_type: 'MakeAttack', target_id: target.id, ...(weapon ? { item_id: weapon.id } : {}) }, 'Атаковать выбранную цель', accountFor(actorId), line)
    }
    const after = await room()
    if (after.mechanics?.combat?.active && after.tacticalTurn?.actorId === actorId) await command(actorId, { command_type: 'EndTurn' }, 'Завершить ход')
  }
  state = await room()
  const lines = freshMessages(seen, state)
  for (const reply of lines) note(`> [${reply.author}] ${short(reply.text, 600)}`)
  exchanges.push({ index: exchanges.length + 1, label: 'бой целиком', kind: 'combat', actor: 'отряд', action: 'Короткая стычка: атаки, заклинания, слова игроков к действиям', replies: lines, ms: 0, scene: sceneContext(state), refused: false })
  if (state.mechanics?.combat?.active) problem('combat-unfinished', 'бой не завершился за 60 шагов')
}

// ---------------------------------------------------------------------------
// Сценарий партии

async function play() {
  const [mirel, borin] = accounts.map((account) => account.heroId)
  let state = await room()
  const here = (state.scene_npcs ?? []).filter((npc) => npc.location_id === state.scene?.location_id && npc.alive !== false)
  const npc1 = here[0]?.name ?? 'рыбачка'
  const npc2 = here[1]?.name ?? here[0]?.name ?? 'хозяин таверны'
  note(`\nСцена: «${state.scene?.title}», ${state.scene?.location}; рядом: ${here.map((npc) => `${npc.name} — ${npc.role}`).join('; ') || 'никого'}`)

  await say(mirel, `${npc1}, чей это баркас? Кто на нём уходил в море? — Мирель помолчала. — Три месяца назад здесь пропала девушка по имени Ила, моя сестра. Вы её знали?`, { label: 'личная зацепка', kind: 'social' })
  await say(mirel, 'Я выхожу к причалу, подхожу к баркасу и методично осматриваю его: метку владельца на борту, сеть, парус, палубу — ищу следы борьбы, кровь или что-то странное.', { label: 'обыск баркаса', kind: 'explore' })
  await say(borin, 'Борин присаживается у борта баркаса и хмыкает, вспоминая службу в страже. Потом идёт к бочкам на причале и простукивает их — нет ли тайника.', { label: 'два шага подряд', kind: 'explore' })
  await say(mirel, `${npc2}, вы сказали, что знаете этот баркас. Чей он? Я кладу на стойку серебряную монету — за честный ответ.`, { label: 'подкуп', kind: 'social' })
  await say(borin, `Борин тихо говорит ${npc1}: «Я служил в страже, пока капитан не велел мне не замечать ночные лодки у маяка. Кто ходил на этом баркасе? Никто не узнает, что это ты сказала».`, { label: 'своё прошлое', kind: 'social' })
  await say(mirel, 'Что мы уже знаем о хозяине баркаса и пропавшей команде?', { label: 'вопрос ведущему', requestKind: 'question', kind: 'question' })
  await say(mirel, `Читаю «Безмолвный образ»: на мостках появляется иллюзия Илы — мокрой, в рыбацкой куртке. Слежу за тем, как на неё посмотрит ${npc1}.`, { label: 'творческое заклинание', kind: 'creative' })
  await say(mirel, 'Мирель отходит к краю причала, смотрит на тёмную воду и негромко говорит Борину: «Ила любила это море. Я не уйду отсюда, пока не узнаю правду».', { label: 'отыгрыш без механики', kind: 'roleplay' })
  await say(borin, `Борин достаёт флягу, делает глоток и предлагает ${npc2} выпить за тех, кто не вернулся с моря, — а заодно спрашивает, кто в порту в последнее время сорит деньгами.`, { label: 'выпивка и слухи', kind: 'social' })

  const world = (await room()).worldMap
  const lighthouse = (world?.locations ?? []).find((entry) => /маяк/iu.test(String(entry.name)))
  await say(mirel, lighthouse
    ? `Хватит разговоров. Мы с Борином идём к ${lighthouse.name.toLocaleLowerCase('ru').startsWith('старый') ? 'старому маяку' : `«${lighthouse.name}»`} на скале.`
    : 'Хватит разговоров. Мы с Борином идём по берегу к старому маяку на скале.', { label: 'переход к маяку', kind: 'travel' })
  state = await room()
  note(`\nСцена: «${state.scene?.title}», ${state.scene?.location}; зоны карты: ${(state.scene?.map?.zones ?? []).map((zone) => zone.label ?? zone.kind).join(', ')}`)
  await say(mirel, 'Подхожу к двери маяка и прислушиваюсь, есть ли кто-то внутри.', { label: 'у двери', kind: 'explore' })
  await say(borin, 'Борин толкает дверь маяка плечом и заходит внутрь первым, держа меч наготове.', { label: 'войти внутрь', kind: 'explore' })
  await say(mirel, 'Ждём темноты в укрытии и смотрим на вершину маяка — загорится ли огонь?', { label: 'ночное ожидание', kind: 'roleplay' })
  await fight()
  await say(mirel, 'продолжим', { label: 'после боя', kind: 'continue' })
  await say(mirel, 'Мирель обыскивает поверженных: нет ли при них знака культа или чего-то, что связывает их с пропавшими рыбаками?', { label: 'обыск врагов', kind: 'explore' })
}

// ---------------------------------------------------------------------------
// Метрики без модели: служебные фразы, повторы, авторы

const SERVICE_PATTERNS = [
  ['split-steps', /В заявке \d+ последовательн/u],
  ['approach-who', /К кому именно подойти/u],
  ['not-understood', /Не совсем понял/u],
  ['vyshlo', /(^|\n)Вышло: /u],
  ['name-target', /Назовите (конкретного участника|собеседника|одного)/u],
  ['vote-boilerplate', /Дорога ведёт весь отряд/u],
  ['unknown-ask-npc', /Этого вы пока не знаете/u],
  ['no-means', /не хватает главного/u],
  ['not-yet', /пока не (открыл|вошл|вошёл|сделал)/u],
  ['check-boilerplate', /^(Требуется проверка|Это бросок)/u],
  ['clarify', /Уточните|Опишите действие|Назовите/u],
  ['no-building', /нет названного здания/u],
]
function serviceHits() {
  const hits = []
  for (const exchange of exchanges) {
    for (const reply of exchange.replies) {
      for (const [id, pattern] of SERVICE_PATTERNS) if (pattern.test(reply.text)) hits.push({ id, exchange: exchange.index, text: short(reply.text, 160) })
    }
  }
  return hits
}
function repeatedSentences() {
  const seen = new Map()
  for (const exchange of exchanges) {
    for (const reply of exchange.replies) {
      for (const sentence of reply.text.split(/(?<=[.!?…»])\s+/u)) {
        const key = sentence.toLocaleLowerCase('ru').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/gu, ' ').trim()
        if (key.split(' ').length < 6) continue
        const entry = seen.get(key) ?? { sentence: short(sentence, 160), exchanges: new Set() }
        entry.exchanges.add(exchange.index)
        seen.set(key, entry)
      }
    }
  }
  return [...seen.values()].filter((entry) => entry.exchanges.size > 1).map((entry) => ({ sentence: entry.sentence, exchanges: [...entry.exchanges] }))
}

// ---------------------------------------------------------------------------
// Судьи

const EXCHANGE_RUBRIC = `Ты опытный ведущий D&D и оцениваешь ответ другого ведущего за столом. Представь, что это живой человек: игроки сказали реплику, ведущий ответил. Оцени по шкале 1–10 (10 — так ответил бы лучший живой ведущий, 5 — терпимо, 1 — ломает игру).
- responsiveness: ответил ли ведущий именно на то, что сделал и сказал игрок, принял ли его идею («да, и…» / «нет, но…»), без канцелярских уточнений и служебных фраз.
- voice: живой голос ведущего или персонажа, образность, ритм; без канцелярита, шаблонов и пересказа заявки игрока.
- progress: даёт ли ответ что-то новое — конкретную деталь, зацепку, следствие, ясный следующий шаг; не тупик и не отсылка по кругу.
- consistency: не противоречит ли сказанному раньше, времени суток, месту и тому, кто где стоит; NPC не знает того, чего не видел.
- npc: если говорит персонаж — характер, своя манера, мотив, не повторяет одни и те же фразы; null, если персонажа нет.
- backstory: если уместно — использует ли личную историю героя (имена, мотивы); null, если неуместно.
Верни JSON: {"responsiveness":n,"voice":n,"progress":n,"consistency":n,"npc":n|null,"backstory":n|null,"service_text":true|false,"comment":"одна фраза: главное замечание"}.`

const HOLISTIC_RUBRIC = `Ты опытный ведущий D&D и разбираешь запись партии, которую провёл ИИ-ведущий. Оцени его как живого человека за столом: хотелось бы с ним играть дальше? Шкала 1–10 (10 — лучший живой ведущий; 7 — хороший ведущий, с которым приятно играть; 5 — терпимо, но погружение рвётся; 3 — играть мучительно).
Оцени отдельно:
- language: язык и атмосфера описаний;
- responsiveness: отклик на идеи и действия игроков, принятие импровизации, отсутствие служебных фраз и канцелярских уточнений;
- clues: подача сведений и улик — получают ли игроки зацепки, двигается ли расследование, нет ли кругов и тупиков;
- npcs: голоса NPC — характер, мотивы, разумные знания, без повторов;
- world: связность мира — время суток, погода, место, то, что обещано в описании, совпадает с происходящим;
- backstories: использование личных историй героев;
- combat: подача боя — живость, понятность, учёт слов игроков;
- overall: общая оценка как живого ведущего (не среднее, а впечатление от стола).
Верни JSON: {"language":n,"responsiveness":n,"clues":n,"npcs":n,"world":n,"backstories":n,"combat":n,"overall":n,"best":"что получилось лучше всего","worst":["три главные проблемы по убыванию"],"fix_first":"что исправить в первую очередь"}.`

async function judgeExchanges(client) {
  const verdicts = []
  const heroes = HEROES.map((hero) => `${hero.name}: ${hero.document.backstory}`).join('\n')
  for (const exchange of exchanges) {
    if (!exchange.replies.length) { verdicts.push({ index: exchange.index, empty: true }); continue }
    const previous = exchanges.slice(Math.max(0, exchange.index - 3), exchange.index - 1)
      .map((entry) => `Игрок (${entry.actor}): ${short(entry.action, 300)}\nВедущий: ${short(entry.replies.map((reply) => `[${reply.author}] ${reply.text}`).join(' '), 700)}`).join('\n\n')
    const content = `Мир: ${WORLD.premise}\nГерои:\n${heroes}\nСцена сейчас: ${exchange.scene.location}, ${exchange.scene.time}; рядом: ${exchange.scene.npcs.join(', ') || 'никого'}.\n\nПредыдущие ходы:\n${previous || '—'}\n\nРеплика игрока (${exchange.actor}): ${exchange.action}\n\nОтвет ведущего (всё, что игрок увидел):\n${exchange.replies.map((reply) => `[${reply.author}] ${reply.text}`).join('\n')}`
    try {
      // Тот же терпимый разбор, что у общего судьи: строгий JSON-режим ронял
      // каждый пятый ход в LLM_JSON_INVALID.
      let json = null
      for (let attempt = 0; attempt < 2 && !json; attempt += 1) {
        const result = await client.complete({ messages: [{ role: 'system', content: EXCHANGE_RUBRIC }, { role: 'user', content: attempt ? `${content}\n\nОтветь одним JSON-объектом без markdown.` : content }] })
        json = lenientJson(String(result.content ?? ''))
      }
      if (!json) throw new Error('LLM_JSON_INVALID')
      const keys = ['responsiveness', 'voice', 'progress', 'consistency', 'npc', 'backstory']
      const scores = keys.map((key) => Number(json[key])).filter((value) => value >= 1 && value <= 10)
      verdicts.push({ index: exchange.index, label: exchange.label, ...json, average: scores.length ? Math.round(10 * scores.reduce((a, b) => a + b, 0) / scores.length) / 10 : null })
    } catch (error) {
      verdicts.push({ index: exchange.index, error: String(error?.code ?? error?.message ?? error).slice(0, 120) })
    }
  }
  return verdicts
}

async function judgeHolistic(client) {
  const heroes = HEROES.map((hero) => `${hero.name}: ${hero.document.backstory}`).join('\n')
  const body = exchanges.map((exchange) => `### ${exchange.index}. ${exchange.label} (${exchange.scene.location}, ${exchange.scene.time})\nИгрок (${exchange.actor}): ${exchange.action}\n${exchange.replies.map((reply) => `[${reply.author}] ${reply.text}`).join('\n') || '(ответа нет)'}`).join('\n\n')
  const content = `Мир, заказанный игроками: ${WORLD.premise}\nПервая сцена, заказанная игроками: ${WORLD.openingSituation}\nГерои:\n${heroes}\n\nПролог ведущего:\n${prologue}\n\nЗапись партии:\n${body}`
  // Строгий JSON-режим у длинного разбора падал LLM_JSON_INVALID: судья
  // оборачивал ответ в markdown или дописывал пояснение. Здесь ответ читается
  // терпимо — первый объект в тексте — и при неудаче просится ещё раз.
  let lastError = null
  const usage = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await client.complete({ messages: [{ role: 'system', content: HOLISTIC_RUBRIC }, { role: 'user', content: attempt ? `${content}\n\nОтветь одним JSON-объектом без markdown и пояснений.` : content }] }, { model: HOLISTIC_MODEL, maxTokens: 3000, timeoutMs: 180_000 })
      if (result.usage) usage.push(result.usage)
      const json = lenientJson(String(result.content ?? ''))
      if (json && Number.isFinite(Number(json.overall))) return { model: HOLISTIC_MODEL, ...json, usage, attempts: attempt + 1 }
      lastError = new Error('нет JSON с overall')
    } catch (error) {
      lastError = error
    }
  }
  return { model: HOLISTIC_MODEL, error: String(lastError?.code ?? lastError?.message ?? lastError).slice(0, 160), usage }
}

/** Первый JSON-объект в тексте: без markdown-обёртки и хвостовых пояснений. */
function lenientJson(text) {
  const source = text.replace(/^\s*```(?:json)?\s*/u, '').replace(/\s*```\s*$/u, '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)) } catch { return null }
    }
  }
  return null
}

/**
 * Какие черновики рассказчика отбраковал верификатор и почему — по трассам
 * ходов во временном хранилище. Живой текст, заменённый запасным, — главный
 * незаметный снаружи источник сухих ответов (замер 2026-10-10).
 */
function narratorDiagnostics() {
  const root = join(storage, 'turn-traces')
  const files = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.json')) files.push(full)
    }
  }
  walk(root)
  const rejected = []
  const codes = {}
  let turns = 0
  for (const file of files) {
    let trace = null
    try { trace = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    const result = trace?.narration_result
    if (!result) continue
    turns += 1
    const verification = result.verification ?? {}
    const repaired = Array.isArray(verification.repaired_from) ? verification.repaired_from : []
    const provider = String(result.provider ?? '')
    if (!repaired.length && !/^deterministic/u.test(provider)) continue
    for (const violation of repaired) codes[violation?.code ?? '?'] = (codes[violation?.code ?? '?'] ?? 0) + 1
    rejected.push({
      message: short(trace?.intent?.raw_message ?? trace?.player_message ?? '', 160),
      provider,
      reason: verification.origin?.reason ?? null,
      violations: repaired.map((violation) => ({ code: violation?.code, match: short(violation?.match ?? '', 120) })),
      narration: short(result.narration ?? '', 240),
    })
  }
  // Детали, которые арбитр назвал, а сервер записал: ответ на вопрос игрока
  // (`detail`) и то, что видно и без броска (`surface`). Если их нет вовсе,
  // модель не заполняет поля или ответ арбитра не проходит форму.
  const details = { detail: [], surface: [] }
  const eventsRoot = join(storage, 'engine', 'campaigns')
  const eventFiles = []
  const walkEvents = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkEvents(full)
      else if (entry.name.endsWith('.json')) eventFiles.push(full)
    }
  }
  walkEvents(eventsRoot)
  for (const file of eventFiles) {
    let commit = null
    try { commit = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    for (const event of commit?.events ?? []) {
      const fact = event?.payload?.fact
      if (event?.event_type === 'WorldFactRecorded' && ['detail', 'surface'].includes(fact?.object)) details[fact.object].push(short(fact.summary ?? '', 160))
    }
  }
  details.detail = [...new Set(details.detail)]
  details.surface = [...new Set(details.surface)]
  return { turns, rejected, codes, details }
}

// ---------------------------------------------------------------------------
// Отчёт

let prologue = ''
function mean(values) {
  const list = values.map(Number).filter(Number.isFinite)
  return list.length ? Math.round(10 * list.reduce((a, b) => a + b, 0) / list.length) / 10 : null
}

function writeReport(verdicts, holistic, usage) {
  const service = serviceHits()
  const repeats = repeatedSentences()
  const authors = {}
  for (const exchange of exchanges) for (const reply of exchange.replies) authors[reply.author] = (authors[reply.author] ?? 0) + 1
  const judged = (verdicts ?? []).filter((entry) => Number.isFinite(entry.average))
  const perKey = (key) => mean(judged.map((entry) => entry[key]).filter((value) => value != null))
  const latencies = exchanges.filter((entry) => entry.ms > 0).map((entry) => entry.ms).sort((a, b) => a - b)
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null
  const summary = {
    live: LIVE, exchanges: exchanges.length, problems, service_hits: service.length, service, repeats,
    authors, latency_p50_ms: p50,
    exchange_judge: judged.length ? {
      average: mean(judged.map((entry) => entry.average)),
      responsiveness: perKey('responsiveness'), voice: perKey('voice'), progress: perKey('progress'),
      consistency: perKey('consistency'), npc: perKey('npc'), backstory: perKey('backstory'),
      service_text_share_pct: Math.round(100 * judged.filter((entry) => entry.service_text === true).length / judged.length),
    } : null,
    holistic, usage,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, exchanges, verdicts, prologue }, null, 2))
  const lines = [
    `# Замер «живой ведущий» — ${STAMP}`,
    '',
    `Режим: ${LIVE ? 'с моделью' : 'без модели'} · ходов ${exchanges.length} · медиана ответа ${p50 ?? '—'} мс${usage?.cost_rub != null ? ` · расход ≈${usage.cost_rub} ₽ (${usage.requests} вызовов)` : ''}`,
    '',
  ]
  if (holistic) {
    lines.push(`## Общая оценка (${holistic.model})`, '', '| Что | Балл |', '| --- | --- |')
    for (const [key, label] of [['overall', '**Как живой ведущий**'], ['language', 'Язык'], ['responsiveness', 'Отклик'], ['clues', 'Улики'], ['npcs', 'Голоса NPC'], ['world', 'Связность мира'], ['backstories', 'Предыстории'], ['combat', 'Бой']]) lines.push(`| ${label} | ${holistic[key] ?? '—'} |`)
    lines.push('', `Лучше всего: ${holistic.best ?? '—'}`, '', 'Главные проблемы:', ...(holistic.worst ?? []).map((entry) => `- ${entry}`), '', `Исправить первым: ${holistic.fix_first ?? '—'}`, '')
  }
  if (summary.exchange_judge) {
    const j = summary.exchange_judge
    lines.push('## Оценка по ходам', '', `Среднее ${j.average} · отклик ${j.responsiveness} · голос ${j.voice} · движение ${j.progress} · согласованность ${j.consistency} · NPC ${j.npc ?? '—'} · предыстории ${j.backstory ?? '—'} · служебный текст в ${j.service_text_share_pct}% ответов`, '')
    lines.push('| # | Ход | Среднее | Замечание |', '| --- | --- | --- | --- |')
    for (const verdict of verdicts) lines.push(`| ${verdict.index} | ${exchanges[verdict.index - 1]?.label ?? ''} | ${verdict.average ?? (verdict.empty ? 'нет ответа' : verdict.error ?? '—')} | ${short(verdict.comment ?? '', 160)} |`)
    lines.push('')
  }
  lines.push('## Без модели', '', `Служебных фраз: ${service.length}`, ...service.map((hit) => `- ход ${hit.exchange} · ${hit.id}: ${hit.text}`), '', `Повторов предложений между ответами: ${repeats.length}`, ...repeats.map((entry) => `- ${entry.sentence} (ходы ${entry.exchanges.join(', ')})`), '', `Авторы ответов: ${Object.entries(authors).map(([author, count]) => `${author} ×${count}`).join(', ')}`, '')
  if (problems.length) lines.push('## Сбои', '', ...problems.map((entry) => `- ${entry.kind}: ${entry.message}`), '')
  writeFileSync(join(OUT, 'report.md'), `${lines.join('\n')}\n`)
  writeFileSync(join(OUT, 'transcript.md'), `# Партия — ${STAMP}\n\n## Пролог\n\n${prologue}\n${transcript.join('\n')}\n`)
  return summary
}

async function usageReport() {
  try {
    const ledger = JSON.parse(readFileSync(join(storage, 'engine', 'llm-usage.json'), 'utf8'))
    const rows = Object.values(ledger.requests ?? {})
    const cost = rows.reduce((sum, row) => sum + (Number(row.provider_cost) || 0), 0)
    return { requests: rows.length, tokens: rows.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0), cost_rub: Math.round(cost * 100) / 100 }
  } catch { return null }
}

// ---------------------------------------------------------------------------

async function main() {
  startServer()
  await waitForHealth()
  const admin = await request('/api/auth/setup-admin', { method: 'POST', body: { name: 'Ведущий стола', email: 'owner@gm.test', password: 'gm-session-owner-password', setupToken } })
  if (admin.status !== 201) throw new Error(`Админ не создан: ${admin.status} ${admin.text.slice(0, 200)}`)
  accounts.push({ name: 'owner', cookie: cookieOf(admin), heroId: 'hero-slot-1', plan: HEROES[0] })
  const second = await request('/api/auth/register', { method: 'POST', body: { name: 'Второй игрок', email: 'second@gm.test', password: 'gm-session-second-password' } })
  accounts.push({ name: 'second', cookie: cookieOf(second), heroId: 'hero-slot-2', plan: HEROES[1] })
  console.log('Создаю мир (пролог пишет модель)…')
  const created = await request('/api/campaigns', { method: 'POST', account: accounts[0], timeoutMs: 300_000, body: {
    code: CODE, name: '',
    bootstrap: { partyName: '', world: WORLD, slotCount: 2, startLevel: START_LEVEL, rulesetId: RULESET_ID, campaignMode: 'adventure' },
  } })
  if (created.status !== 201) throw new Error(`Кампания не создана: ${created.status} ${created.text.slice(0, 400)}`)
  const invite = await request(`/api/campaigns/${CODE}/invites`, { method: 'POST', account: accounts[0], body: { hero_ids: ['hero-slot-2'] } })
  const joined = await request(`/api/campaigns/${CODE}/join`, { method: 'POST', account: accounts[1], body: { invite_token: invite.body?.token } })
  if (joined.status !== 200) throw new Error(`Второй игрок не вошёл: ${joined.status} ${joined.text.slice(0, 300)}`)
  for (const account of accounts) await buildHero(account, account.plan)
  const state = await room()
  prologue = (state.messages ?? []).filter((entry) => entry.speaker === 'narrator').map((entry) => entry.text).join('\n\n')
  note(`Кампания «${state.campaign}», ${state.scene?.location}; время ${sceneContext(state).time}`)
  console.log('Играю партию…')
  await play()
}

let fatal = null
try { await main() } catch (error) { fatal = error; problems.push({ kind: 'run-aborted', message: short(error?.stack ?? error, 600) }) }
await stopServer()
const usage = LIVE ? await usageReport() : null
let verdicts = null
let holistic = null
if (JUDGE && exchanges.length) {
  await import('dotenv/config')
  const { RouterAIClient } = await import('../server/llm-client.mjs')
  const client = new RouterAIClient({ model: process.env.DND_AI_MODEL || 'openai/gpt-6-luna', maxTokens: 900, timeoutMs: 45_000 })
  console.log('Судья по ходам…')
  verdicts = await judgeExchanges(client)
  console.log('Общий судья…')
  try { holistic = await judgeHolistic(client) } catch (error) { problems.push({ kind: 'holistic-judge', message: String(error?.code ?? error?.message ?? error).slice(0, 200) }) }
}
const diagnostics = narratorDiagnostics()
writeFileSync(join(OUT, 'narrator-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
console.log(`Деталей арбитра записано: по вопросу ${diagnostics.details.detail.length}, видимых ${diagnostics.details.surface.length}`)
if (diagnostics.rejected.length) {
  console.log(`Отбракованных черновиков рассказчика: ${diagnostics.rejected.length} из ${diagnostics.turns}; причины: ${Object.entries(diagnostics.codes).map(([code, count]) => `${code}×${count}`).join(', ')}`)
}
const summary = writeReport(verdicts, holistic, usage)
console.log(`\nИтог: ходов ${summary.exchanges}, служебных фраз ${summary.service_hits}, повторов ${summary.repeats.length}${summary.exchange_judge ? `, по ходам ${summary.exchange_judge.average}` : ''}${holistic?.overall != null ? `, как живой ведущий ${holistic.overall}/10` : ''}`)
console.log(`Отчёт: ${relative(ROOT, join(OUT, 'report.md'))}`)
if (!KEEP) rmSync(storage, { recursive: true, force: true })
else console.log(`Хранилище оставлено: ${storage}`)
process.exit(fatal ? 1 : 0)
