/**
 * Сквозной прогон кампании «Асстоханские равнины» ботами через HTTP
 * (eval, в тесты не входит). Пункт 5 плана `docs/playable-goal.md`: «вечер за
 * несколько минут» — без браузера, но тем же путём, что и сайт.
 *
 * Что делает:
 *  - поднимает изолированный сервер на временном хранилище (порт свой);
 *  - заводит владельца и игроков по приглашениям — по аккаунту на героя;
 *  - создаёт кампанию из авторского мира `astohan-plains` так же, как мастер
 *    создания на сайте (редакция 2014, стартовый уровень 7);
 *  - создаёт героев (по умолчанию воин, жрица, маг, плут) импортом и
 *    поэтапным повышением до 7-го уровня, выборы уровня — из серверного каталога;
 *  - играет сценарий: поручение Ареса, принятие задания голосованием, торговля,
 *    улики из заготовок ведущего, реальные фразы игроков из
 *    `eval/player-phrases.json`, дорога по карте мира, бой ботом через команды
 *    доски (огненный шар, скрытая атака, зелье, переговоры), добыча, отдых,
 *    Режиссёр до финала арки или до лимита времени;
 *  - по пути ловит тупики, ответы 5xx, отказы законным командам, зависший бой;
 *  - в конце проверяет идемпотентность, перезапуск, проекцию второго игрока,
 *    replay (`tools/audit-cutover.mjs`), меряет текст рассказчика и пишет
 *    отчёт с оценкой.
 *
 *   node eval/astohan-playthrough.mjs                 # без модели, 3–15 мин до развязки
 *   node eval/astohan-playthrough.mjs --seed 7        # повторяемые кости
 *   node eval/astohan-playthrough.mjs --party fighter,cleric   # быстрый прогон вдвоём
 *   node eval/astohan-playthrough.mjs --live          # с моделью из .env, бюджет и темп
 *   node eval/astohan-playthrough.mjs --live --judge  # плюс оценка текста моделью-судьёй
 *   node eval/astohan-playthrough.mjs --minutes 20 --out tmp/astohan-playtest/run1
 *
 * Итог — `<out>/report.md` (оценка и находки), `<out>/transcript.md`
 * (хроника: реплика → ответ), `<out>/narration-sample.md` (выборка текста
 * рассказчика для чтения глазами), `<out>/report.json` (всё для сравнения
 * прогонов). Ключ модели не печатается и в отчёт не попадает.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { abilityScoreChoiceLevelsFor, classSkillRuleFor, featureChoiceGroupsFor, normalizedClassSkillProficiencies } from '../server/character-progression.mjs'
import { characterCreationChoicesComplete } from '../server/character-lifecycle.mjs'
import { combatClassCatalogInfo, combatSubclassOptionsFor, normalizedCombatSubclassFor } from '../server/combat-actions.mjs'
import { combatSpellsFor, spellSelectionRulesFor } from '../server/combat-spells.mjs'
import { movementForActor, movementStepCostFor, normalizeCampaignState, previewApproachAttack } from '../server/rules-engine.mjs'
import { occupiedPositions, shortestTacticalPath } from '../server/rules/tactical-geometry.mjs'
import { footprintCellsFor } from '../server/actor-footprint.mjs'
import { isDirectorPartyDecision } from '../src/director-continuation.mjs'
import { findNarratorCliches } from '../server/narrator-craft-quality.mjs'
import { measureNarratorCraft } from './narrator-craft-metrics.mjs'
import { judgeContext, narrationConsistency, sceneContinuity, sceneMapConsistency } from './consistency-checks.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const LIVE = flag('live')
// `--visit a,b` — дойти до мест по очереди и остановиться, оставив хранилище:
// так карту места смотрят глазами в браузере (`docs/astohan-scenario.md`).
const VISIT = option('visit', '').split(',').map((entry) => entry.trim()).filter(Boolean)
const KEEP = flag('keep') || VISIT.length > 0
// Судья тратит вызовы модели, поэтому включается только явно.
const JUDGE = flag('judge')
const PARTY = option('party', 'fighter,cleric,wizard,rogue').split(',').map((entry) => entry.trim()).filter(Boolean)
const SEED = option('seed', null)
const MINUTES = Number(option('minutes', LIVE ? 25 : 20))
const PORT = Number(option('port', 8900 + Math.floor(Math.random() * 90)))
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const OUT = resolve(ROOT, option('out', join('tmp', 'astohan-playtest', `${STAMP}${LIVE ? '-live' : ''}`)))
const CODE = 'ASTOHAN-RUN'
const TEMPLATE_ID = 'astohan-plains'
const RULESET_ID = 'dnd_5e_2014'
const START_LEVEL = 7
const DEADLINE = Date.now() + MINUTES * 60_000
const startedAt = Date.now()
const base = `http://127.0.0.1:${PORT}`
const setupToken = `astohan-${randomUUID()}`

// Сервер берёт ключ из `.env` своей рабочей папки. В отдельном worktree
// `.env` нет (он в .gitignore), и прогон с --live молча шёл без модели —
// отчёт о «живой» игре был бы ложным. Значение ключа не читается в вывод.
if (LIVE || JUDGE) {
  const envText = (() => { try { return readFileSync(join(ROOT, '.env'), 'utf8') } catch { return '' } })()
  if (!process.env.ROUTERAI_API_KEY && !/^ROUTERAI_API_KEY=\S+/mu.test(envText)) {
    console.error(`--live/--judge: в ${join(ROOT, '.env')} нет ROUTERAI_API_KEY. В отдельной рабочей копии скопируйте .env из основной папки.`)
    process.exit(2)
  }
}

mkdirSync(OUT, { recursive: true })
const storage = mkdtempSync(join(tmpdir(), 'skazanie-astohan-'))
const template = JSON.parse(readFileSync(join(ROOT, 'data', 'campaign-worlds-v1.json'), 'utf8')).templates.find((entry) => entry.id === TEMPLATE_ID)
if (!template) throw new Error(`В каталоге нет мира ${TEMPLATE_ID}`)

// ---------------------------------------------------------------------------
// Журнал прогона: находки, хроника, замеры

const findings = []
const transcript = []
const timings = []
const narrateLatency = []
const stats = {
  narrate: 0, narrateRefused: 0, checks: 0, checkSuccess: 0, discoveries: 0, discoveryEmpty: 0, clarifications: 0,
  deadEnds: 0, http5xx: 0, rateLimited: 0, votes: 0, travels: 0, directorSteps: 0, directorIntents: {},
  combats: 0, combatRounds: 0, combatWins: 0, heroDowns: 0, heroDeaths: 0, playerCommands: 0, commandRefused: 0,
  lootTaken: 0, rests: 0, levelUps: 0, restarts: 0, scenes: [], chapters: 0,
  // Реальные фразы игроков: сколько сказано и сколько из них упёрлось в тупик, по видам.
  corpus: { said: 0, deadEnds: 0, byKind: {} },
  trade: { bought: 0, sold: 0, refused: 0 }, potionsUsed: 0,
  parley: { attempts: 0, truces: 0, outcomes: [] },
  spells: {}, sneakAttacks: 0,
  // Сколько ответов сверено с картой и механикой и какие расхождения нашлись.
  consistencyChecked: 0, consistency: {},
}
/** Текст рассказчика за прогон: для метрик, выборки и судьи. */
const narrations = []
let currentStage = 'startup'

function finding(severity, kind, message, context = {}) {
  const entry = { severity, kind, stage: currentStage, at_s: Math.round((Date.now() - startedAt) / 1000), message, ...context }
  findings.push(entry)
  console.log(`  [${severity}] ${kind}: ${message}`)
  return entry
}
function note(line) {
  transcript.push(line)
}
function stage(name) {
  currentStage = name
  note(`\n## ${name}\n`)
  console.log(`\n== ${name} (${Math.round((Date.now() - startedAt) / 1000)} с)`)
}
const timeLeft = () => DEADLINE - Date.now()
const short = (text, limit = 400) => {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

// ---------------------------------------------------------------------------
// Сервер

let child = null
let logs = ''
function startServer() {
  const preload = SEED == null ? [] : ['--import', './eval/playtest-seeded-dice.mjs']
  const env = {
    ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(PORT), DND_STORAGE_DIR: storage,
    ADMIN_SETUP_TOKEN: setupToken, COOKIE_SECURE: 'false', NODE_ENV: 'test',
    // Ход героя бот делает за секунды; срок хода не должен отдавать его NPC.
    DND_COMBAT_TURN_TIMEOUT_MS: '3600000',
    ...(SEED == null ? {} : { PLAYTEST_DICE_SEED: String(SEED) }),
  }
  // Без --live ключ обнуляется явно: dotenv не перекрывает уже заданные
  // переменные, и пустая строка выигрывает у ключа из .env.
  if (!LIVE) env.ROUTERAI_API_KEY = ''
  child = spawn(process.execPath, [...preload, 'server/index.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { logs += chunk })
  child.stderr.on('data', (chunk) => { logs += chunk })
}
async function stopServer() {
  if (!child || child.exitCode != null) return
  await new Promise((done) => { child.once('exit', done); child.kill() })
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Сервер завершился с кодом ${child.exitCode}\n${logs.slice(-2000)}`)
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* запускается */ }
    await sleep(100)
  }
  throw new Error(`Сервер не поднялся\n${logs.slice(-2000)}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
process.on('exit', () => { try { child?.kill() } catch { /* уже остановлен */ } })

// ---------------------------------------------------------------------------
// HTTP с замерами

async function request(path, { method = 'GET', account, body, key, timeoutMs = 120_000 } = {}) {
  const started = Date.now()
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method, signal: controller.signal,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(account?.cookie ? { Cookie: account.cookie } : {}),
          ...(key ? { 'X-Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      clearTimeout(timer)
      finding('critical', 'transport', `${method} ${path}: ${error?.name ?? error} после ${Date.now() - started} мс`)
      return { status: 0, body: null, text: String(error), ms: Date.now() - started }
    }
    clearTimeout(timer)
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* тело не JSON */ }
    const ms = Date.now() - started
    const route = path.replace(/\/[A-Z0-9-]{3,24}(?=\/|$)/u, '/:code').replace(/\?.*$/u, '').replace(/party-decisions\/[^/]+/u, 'party-decisions/:id').replace(/merchants\/[^/]+/u, 'merchants/:id')
    timings.push({ route: `${method} ${route}`, ms, status: response.status })
    if (response.status === 429 && attempt < 5) {
      stats.rateLimited += 1
      finding('minor', 'rate-limit', `${method} ${route}: 429, бот ждёт 30 с`)
      await sleep(30_000)
      continue
    }
    if (response.status >= 500) {
      stats.http5xx += 1
      finding('critical', 'http-5xx', `${method} ${route} → ${response.status}: ${short(parsed?.error ?? text, 300)}`, { code: parsed?.code })
    }
    return { status: response.status, body: parsed, text, ms, response }
  }
  return { status: 429, body: null, text: 'rate limited', ms: Date.now() - started }
}

const accounts = { players: [] }
const cookieOf = (result) => result.response?.headers.get('set-cookie')?.split(';')[0] ?? ''

// Живой поток: держит игрока «в сети» для голосований и мерит первое слово
// рассказчика по событиям narration.*.
const streamFirstText = new Map()
const streamComplete = new Map()
async function openStream(account) {
  account.stream?.abort()
  const controller = new AbortController()
  account.stream = controller
  try {
    const response = await fetch(`${base}/api/campaigns/${CODE}/stream`, { headers: { Cookie: account.cookie, Accept: 'text/event-stream' }, signal: controller.signal })
    if (!response.ok) { finding('major', 'stream', `поток ${account.name}: ${response.status}`); return }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    ;(async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const event = /^event: (.+)$/mu.exec(block)?.[1]
            const data = /^data: (.+)$/mu.exec(block)?.[1]
            if (!event?.startsWith('narration.') || !data) continue
            let payload = null
            try { payload = JSON.parse(data) } catch { continue }
            const id = String(payload.messageId ?? payload.message_id ?? '')
            if (!id) continue
            if (payload.text && !streamFirstText.has(id)) streamFirstText.set(id, Date.now())
            if (event === 'narration.complete') streamComplete.set(id, Date.now())
          }
        }
      } catch { /* поток закрыт */ }
    })()
  } catch (error) {
    if (error?.name !== 'AbortError') finding('major', 'stream', `поток ${account.name}: ${error}`)
  }
}

// ---------------------------------------------------------------------------
// Состояние комнаты

async function room(account = accounts.owner) {
  const result = await request(`/api/rooms/${CODE}`, { account })
  if (result.status !== 200) throw new Error(`Комната недоступна (${result.status}): ${result.text.slice(0, 300)}`)
  return result.body.state
}
const heroIds = () => accounts.players.map((account) => account.heroId)
const accountFor = (actorId) => accounts.players.find((account) => account.heroId === actorId) ?? accounts.owner
const heroOf = (state, actorId) => state.players.find((player) => player.id === actorId)
const lifecycleStatus = (state) => state?.mechanics?.campaign_lifecycle?.status ?? 'active'
const sceneKey = (state) => `${state.worldMap?.currentLocationId ?? '?'}|${state.scene?.location ?? '?'}|${state.adventure?.chapter ?? '?'}`

let commandSeq = 0
/** Команды текущего хода героя — для строки хода в хронике боя. */
let turnLog = null
/** Сообщения хроники, появившиеся после известного набора id. */
function newMessages(before, state) {
  return (state?.messages ?? []).filter((entry) => !before.has(String(entry.id)) && entry.role !== 'player' && entry.type !== 'player')
}
const messageIds = (state) => new Set((state?.messages ?? []).map((entry) => String(entry.id)))
async function command(actorId, commandValue, label = commandValue.command_type, { expectFailure = false } = {}) {
  const account = accountFor(actorId)
  const key = `bot-${commandValue.command_type}-${++commandSeq}`
  const result = await request(`/api/campaigns/${CODE}/commands`, {
    method: 'POST', account, key,
    body: { idempotency_key: key, message: label, command: { actor_id: actorId, ...commandValue } },
  })
  stats.playerCommands += 1
  if (turnLog && result.status === 200 && /MakeAttack|CastSpell|MakeAreaAttack/u.test(commandValue.command_type)) combatActs[actorId] = (combatActs[actorId] ?? 0) + 1
  turnLog?.push(`${label}${result.status === 200 ? ' ✓' : ` ✗${result.body?.code ? ` ${result.body.code}` : ''}`}`)
  if (result.status !== 200) {
    stats.commandRefused += 1
    if (!expectFailure && result.status < 500) note(`- ⚠ ${label}: отказ ${result.status} ${result.body?.code ?? ''} — ${short(result.body?.error, 200)}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Создание героев: импорт первого уровня и поэтапное повышение до седьмого

const HERO_PLANS = {
  fighter: {
    name: 'Торвальд', characterClass: 'fighter', role: 'Воин · ур. 1', species: 'Холмовой дварф',
    document: {
      character: 'Торвальд', name: 'Владелец', role: 'Воин · ур. 1', characterClass: 'fighter', species: 'Холмовой дварф',
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
    },
    skills: ['athletics', 'perception', 'survival', 'intimidation', 'insight'],
    subclass: ['Чемпион'],
    asi: ['str', 'con'],
    cantrips: [], spells: [],
  },
  cleric: {
    name: 'Ильва', characterClass: 'cleric', role: 'Жрец · ур. 1', species: 'Холмовой дварф',
    document: {
      character: 'Ильва', name: 'Гость', role: 'Жрец · ур. 1', characterClass: 'cleric', species: 'Холмовой дварф',
      background: 'Прислужник', backgroundId: 'acolyte', backgroundChoices: { tools: [], languages: ['elvish', 'giant'], replacementSkills: [], replacementTools: [] },
      speciesChoices: { 'artisan-tool': ['brewers_supplies'] },
      level: 1, experience: 0,
      abilities: { str: 13, dex: 10, con: 16, int: 8, wis: 16, cha: 12 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
        baseScores: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
        originBonusProfileId: 'dwarf-hill', originBonuses: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 }, speciesOptionId: 'dwarf-hill',
      },
      baseSpeed: 25, hitPointIncreases: [], classSkillProficiencies: ['medicine', 'persuasion'],
      subclass: 'Домен жизни',
      selectedFeatureIds: [], knownSpellIds: ['sacred-flame', 'guidance', 'spare-the-dying'], preparedSpellIds: ['cure-wounds', 'healing-word', 'guiding-bolt', 'bless'],
      phbCreation: { schema_version: 1, classChoices: {} },
    },
    skills: ['medicine', 'persuasion', 'history'],
    subclass: ['Домен жизни', 'Жизнь'],
    asi: ['wis', 'wis'],
    cantrips: ['sacred-flame', 'guidance', 'spare-the-dying', 'thaumaturgy', 'light'],
    spells: ['healing-word', 'cure-wounds', 'guiding-bolt', 'bless', 'spiritual-weapon', 'prayer-of-healing', 'spirit-guardians', 'mass-healing-word', 'revivify', 'aid', 'lesser-restoration', 'guardian-of-faith', 'death-ward'],
  },
  wizard: {
    name: 'Мирра', characterClass: 'wizard', role: 'Волшебник · ур. 1', species: 'Скальный гном',
    document: {
      character: 'Мирра', name: 'Третий игрок', role: 'Волшебник · ур. 1', characterClass: 'wizard', species: 'Скальный гном',
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
      knownSpellIds: ['fire-bolt', 'mage-hand', 'ray-of-frost', 'magic-missile', 'shield', 'mage-armor', 'sleep', 'thunderwave', 'burning-hands'],
      preparedSpellIds: ['magic-missile', 'shield', 'mage-armor', 'sleep'],
    },
    skills: ['insight', 'investigation', 'arcana', 'history'],
    subclass: ['Школа Воплощения'],
    asi: ['int', 'int'],
    cantrips: ['fire-bolt', 'ray-of-frost', 'mage-hand', 'light', 'shocking-grasp'],
    spells: ['magic-missile', 'fireball', 'shield', 'misty-step', 'scorching-ray', 'mage-armor', 'lightning-bolt', 'ice-storm', 'thunderwave', 'burning-hands', 'sleep', 'hold-person', 'web', 'counterspell', 'haste', 'fly', 'polymorph', 'greater-invisibility', 'detect-magic', 'absorb-elements', 'banishment', 'dimension-door', 'chromatic-orb', 'ice-knife'],
  },
  rogue: {
    name: 'Шорох', characterClass: 'rogue', role: 'Плут · ур. 1', species: 'Легконогий полурослик',
    document: {
      character: 'Шорох', name: 'Четвёртый игрок', role: 'Плут · ур. 1', characterClass: 'rogue', species: 'Легконогий полурослик',
      background: 'Преступник', backgroundId: 'criminal', backgroundChoices: { tools: ['dice_set'], languages: [] },
      starterEquipmentChoices: { primary: ['rapier'], secondary: ['shortbow'], pack: ['burglars-pack'] },
      level: 1, experience: 0,
      abilities: { str: 8, dex: 17, con: 14, int: 12, wis: 13, cha: 11 },
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2, method: 'standard_array',
        baseScores: { str: 8, dex: 15, con: 14, int: 12, wis: 13, cha: 10 },
        originBonusProfileId: 'halfling-lightfoot', originBonuses: { str: 0, dex: 2, con: 0, int: 0, wis: 0, cha: 1 }, speciesOptionId: 'halfling-lightfoot',
      },
      baseSpeed: 25, hitPointIncreases: [], classSkillProficiencies: ['acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
      selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: [],
    },
    skills: ['acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
    subclass: ['Вор'],
    asi: ['dex', 'dex'],
    cantrips: [], spells: [],
  },
}

/** Недостающие выборы текущего уровня — тем же каталогом, что и проверка сервера. */
function pendingChoices(actor, plan, rulesetId) {
  const commands = []
  const skillRule = classSkillRuleFor(actor)
  let skills = normalizedClassSkillProficiencies(actor)
  if (skillRule && skills.length !== skillRule.choiceCount) {
    const allowed = skillRule.skills
    skills = [...new Set([...plan.skills, ...allowed])].filter((id) => allowed.includes(id)).slice(0, skillRule.choiceCount)
  }
  const subclassOptions = combatSubclassOptionsFor(actor)
  let subclass = normalizedCombatSubclassFor(actor) ? String(actor.subclass ?? '') : String(actor.subclass ?? '')
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
  const choice = {
    command_type: 'SetCharacterChoices', subclass, class_skill_proficiencies: skills, selected_feature_ids: features,
    ...(asiLevel ? { ability_score_level: asiLevel, ability_score_increases: plan.asi.filter((id) => Number(actor.abilities?.[id] ?? 20) < 20).length === plan.asi.length ? plan.asi : ['con', 'con'] } : {}),
  }
  if (characterCreationChoicesComplete(actor, { rulesetId })) return []
  const changed = asiLevel || subclass !== String(actor.subclass ?? '') || JSON.stringify(skills) !== JSON.stringify(actor.classSkillProficiencies ?? [])
    || JSON.stringify([...features].sort()) !== JSON.stringify([...(actor.selectedFeatureIds ?? [])].sort())
  if (changed) commands.push(choice)
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
  const imported = await command(actorId, { command_type: 'ImportCharacter', document: { schema: 'skazanie.character', schema_version: 1, character: plan.document } }, `Импорт: ${plan.name}`)
  if (imported.status !== 200) {
    finding('blocker', 'character-import', `${plan.name}: импорт отклонён ${imported.body?.code ?? imported.status} — ${short(imported.body?.error ?? imported.text, 300)}`)
    return false
  }
  for (let guard = 0; guard < 40; guard += 1) {
    const state = await room(account)
    const actor = heroOf(state, actorId)
    if (!actor.characterSetupRequired && Number(actor.level) >= START_LEVEL) break
    for (const choice of pendingChoices(actor, plan, state.ruleset_id)) {
      const saved = await command(actorId, choice, `${choice.command_type} ур. ${actor.level}`)
      if (saved.status !== 200) finding('major', 'character-choice', `${plan.name}, ур. ${actor.level}: ${choice.command_type} отклонён ${saved.body?.code} — ${short(saved.body?.error, 240)}`, { command: choice })
    }
    const fresh = heroOf(await room(account), actorId)
    if (Number(fresh.level) >= START_LEVEL) {
      if (fresh.characterSetupRequired) finding('blocker', 'character-setup', `${plan.name}: на ${fresh.level} уровне подготовка не закрылась`)
      break
    }
    const leveled = await command(actorId, { command_type: 'LevelUp', expected_level: Number(fresh.level) }, `Повышение до ${Number(fresh.level) + 1}`)
    if (leveled.status !== 200) {
      finding('blocker', 'level-up', `${plan.name}: LevelUp с ${fresh.level} отклонён ${leveled.body?.code} — ${short(leveled.body?.error, 240)}`)
      return false
    }
    stats.levelUps += 1
  }
  const hero = heroOf(await room(account), actorId)
  note(`- ${hero.character}: ${hero.role}, ур. ${hero.level}, ОЗ ${hero.hp}/${hero.maxHp}, КД ${hero.armor}, подкласс «${hero.subclass ?? '—'}», заклинаний ${(hero.preparedSpellIds ?? []).length + (hero.knownSpellIds ?? []).length}`)
  if (hero.characterSetupRequired) return false
  if (Number(hero.level) !== START_LEVEL) finding('blocker', 'character-level', `${plan.name}: уровень ${hero.level} вместо ${START_LEVEL}`)
  if (!(Number(hero.maxHp) > 30)) finding('major', 'character-hp', `${plan.name}: подозрительно мало ОЗ на 7 уровне — ${hero.maxHp}`)
  return true
}

// ---------------------------------------------------------------------------
// Свободные реплики: ручной бросок, уточнение, подтверждение, классификация

const DEAD_END = [
  /действие недоступно/iu, /недоступно для этого/iu, /назовите (собеседника|по имени)/iu, /новой зацепки нет/iu, /зацепки нет/iu,
  /пока ничего не меняется/iu, /не понял/iu, /не удалось понять/iu, /ничего не происходит/iu, /сначала уточните/iu,
  /ведущий временно недоступен/iu, /\bundefined\b|\bnull\b|\[object Object\]/u, /\{\{|\}\}/u,
]
const RAW_CODE = /\b[A-Z][A-Z_]{5,}\b|\bquest:[a-z]|\bastohan-[a-z]|\bhero-slot-\d|\bencounter-[0-9a-f]{4}/u
const DISCOVERY_SKILLS = new Set(['perception', 'investigation', 'insight', 'survival', 'history', 'arcana', 'religion', 'nature', 'medicine'])

let narrateSeq = 0
async function say(actorId, action, { label = '', requestKind, npcId, expect = 'outcome' } = {}) {
  const account = accountFor(actorId)
  const hero = heroOf(await room(account), actorId)
  const baseBody = { action, campaign_id: CODE, actor_id: actorId, manual_roll: true, ...(requestKind ? { request_kind: requestKind } : {}), ...(npcId ? { npc_id: npcId } : {}) }
  let body = { ...baseBody, idempotency_key: `bot-say-${++narrateSeq}` }
  note(`\n**${hero?.character ?? actorId}${label ? ` · ${label}` : ''}:** ${action}`)
  let final = null
  const steps = []
  let rolledCheck = null
  for (let hop = 0; hop < 4; hop += 1) {
    const sentAt = Date.now()
    const result = await request('/api/narrate', { method: 'POST', account, body, key: body.idempotency_key })
    stats.narrate += 1
    const messageId = result.body?.narration_message_id
    const firstText = messageId ? streamFirstText.get(messageId) : null
    narrateLatency.push({ ms: result.ms, first_word_ms: firstText ? firstText - sentAt : null, label, hop })
    if (result.status !== 200) {
      stats.narrateRefused += 1
      note(`> ⚠ отказ ${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error ?? result.text, 300)}`)
      const fatal = !['NOT_ACTIVE_ACTOR', 'COMBAT_ACTIVE', 'PARTY_DECISION_OPEN'].includes(result.body?.code)
      if (fatal) { stats.deadEnds += 1; finding('major', 'narrate-refused', `«${short(action, 90)}» → ${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error, 200)}`) }
      return { status: result.status, body: result.body, steps }
    }
    const answer = result.body
    steps.push(answer)
    final = answer
    const text = String(answer.narration ?? '')
    if (text) { note(`> ${short(text, 1400)}`); narrations.push({ kind: 'reply', action, label, text }) }
    if (answer.check && !answer.mechanics?.some((event) => event.event_type === 'AbilityCheckResolved')) {
      stats.checks += 1
      const check = answer.check
      note(`> 🎲 проверка: ${check.label ?? check.skill ?? check.ability} СЛ ${check.difficulty ?? '?'}${check.advantage ? ' (преимущество)' : ''}${check.disadvantage ? ' (помеха)' : ''}`)
      const rolled = await request('/api/roll', { method: 'POST', account, body: { checkId: check.check_id, playerId: actorId, campaignId: CODE } })
      if (rolled.status !== 200) {
        finding('major', 'roll-refused', `бросок по «${check.label}» → ${rolled.status} ${rolled.body?.code ?? ''}: ${short(rolled.body?.error, 200)}`)
        return { status: rolled.status, body: rolled.body, steps }
      }
      if (rolled.body.success) stats.checkSuccess += 1
      rolledCheck = { success: rolled.body.success, total: rolled.body.total, difficulty: rolled.body.difficulty, label: check.label, skill: check.skill }
      note(`> 🎲 ${rolled.body.value} + ${rolled.body.modifier} = **${rolled.body.total}** против ${rolled.body.difficulty ?? '?'} → ${rolled.body.success ? 'успех' : 'провал'}`)
      // Бросок продолжает ту заявку, на которую выдана проверка: после
      // уточнения это выбранный вариант, а не исходная фраза — иначе сервер
      // законно отвечает ROLL_CONTEXT_MISMATCH.
      body = { ...baseBody, action: body.action, idempotency_key: `bot-say-${++narrateSeq}`, roll: { roll_id: rolled.body.roll_id }, ...(answer.clarification?.id ? { clarification_id: answer.clarification.id } : {}) }
      const resolved = await sayFollowUp(body, account, steps)
      final = resolved ?? final
      const skill = String(check.skill ?? '').replace(/_/gu, '-')
      if (rolled.body.success && DISCOVERY_SKILLS.has(skill)) {
        const facts = (final?.mechanics ?? []).filter((event) => event.event_type === 'WorldFactRecorded')
        if (facts.length) { stats.discoveries += 1; note(`> 🔎 находка: ${facts.map((event) => short(event.payload?.object ?? event.payload?.value ?? event.payload?.text ?? JSON.stringify(event.payload), 160)).join(' | ')}`) }
        else { stats.discoveryEmpty += 1; finding('major', 'empty-success', `успех ${check.label} (${rolled.body.total} против ${rolled.body.difficulty}) не записал находку: «${short(action, 90)}»`) }
      }
      break
    }
    if (answer.clarification && !answer.check) {
      stats.clarifications += 1
      const clarification = answer.clarification
      const options = clarification.options ?? clarification.choices ?? []
      note(`> ❓ уточнение: ${short(clarification.question, 300)}${options.length ? ` [${options.map((entry) => entry.label ?? entry).join(' / ')}]` : ''}`)
      if (hop >= 1) { stats.deadEnds += 1; finding('major', 'clarify-loop', `повторное уточнение на «${short(action, 90)}»: ${short(clarification.question, 160)}`); break }
      // Варианты бывают только текстом («Можно, например, осмотреть место
      // внимательнее, …») — живой игрок выбрал бы первый, а не повторил фразу.
      const offered = /Можно, например, ([^,.;(]+)/u.exec(String(clarification.question ?? answer.narration ?? ''))?.[1]?.trim()
      const firstPerson = offered && offered
        .replace(/^осмотреть/u, 'Осматриваю').replace(/^расспросить/u, 'Расспрашиваю').replace(/^отправиться/u, 'Отправляюсь')
      const pick = options[0]?.label ?? options[0]?.text ?? options[0] ?? firstPerson ?? action
      body = { ...baseBody, action: typeof pick === 'string' ? pick : action, idempotency_key: `bot-say-${++narrateSeq}`, clarification_id: clarification.id }
      continue
    }
    if (answer.action_proposal?.id) {
      note(`> ✋ предложение: ${answer.action_proposal.kind}`)
      body = { ...baseBody, idempotency_key: `bot-say-${++narrateSeq}`, confirmed_proposal_id: answer.action_proposal.id }
      continue
    }
    break
  }
  classifyOutcome(action, final, expect, rolledCheck)
  await checkNarrationConsistency(action, final?.narration, rolledCheck)
  return { status: 200, body: final, steps }
}

async function sayFollowUp(body, account, steps) {
  const sentAt = Date.now()
  const result = await request('/api/narrate', { method: 'POST', account, body, key: body.idempotency_key })
  stats.narrate += 1
  const messageId = result.body?.narration_message_id
  const firstText = messageId ? streamFirstText.get(messageId) : null
  narrateLatency.push({ ms: result.ms, first_word_ms: firstText ? firstText - sentAt : null, label: 'roll', hop: 1 })
  if (result.status !== 200) {
    finding('major', 'roll-narrate-refused', `продолжение броска → ${result.status} ${result.body?.code ?? ''}: ${short(result.body?.error, 200)}`)
    return null
  }
  steps.push(result.body)
  if (result.body.narration) { note(`> ${short(result.body.narration, 1400)}`); narrations.push({ kind: 'roll', action: body.action, label: 'после броска', text: String(result.body.narration) }) }
  return result.body
}

const answersSeen = new Map()
function classifyOutcome(action, answer, expect, rolledCheck = null) {
  if (!answer) return
  const text = String(answer.narration ?? '')
  const events = answer.mechanics ?? []
  // После проваленного броска «не удалось понять, куда ведут следы» — честный
  // исход проверки, а не «я не понял заявку» (прогон с моделью 2026-10-06).
  const deadEnd = DEAD_END
    .filter((pattern) => !(rolledCheck?.success === false && String(pattern) === String(/не удалось понять/iu)))
    .find((pattern) => pattern.test(text))
  if (deadEnd) { stats.deadEnds += 1; finding('major', 'dead-end', `«${short(action, 90)}» → «${short(text, 220)}»`, { pattern: String(deadEnd) }) }
  else if (!text.trim() && !events.length && expect === 'outcome') { stats.deadEnds += 1; finding('major', 'silent', `«${short(action, 90)}»: ни текста, ни событий`) }
  else if (expect === 'outcome' && text.trim().length < 40 && !events.some((event) => /Check|Attack|Damage|Moved/u.test(event.event_type))) {
    stats.deadEnds += 1
    finding('major', 'empty-answer', `«${short(action, 90)}» → только «${short(text, 80)}»`)
  }
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length > 60) {
    const seenBefore = answersSeen.get(normalized)
    // Служебные заявки карты мира и решения группы отвечают шаблоном голосования — это не повтор рассказчика.
    if (seenBefore && seenBefore !== action && !/^\[/u.test(action)) finding('major', 'repeated-answer', `на «${short(action, 70)}» тот же ответ, что и на «${short(seenBefore, 70)}»: «${short(normalized, 140)}»`)
    else answersSeen.set(normalized, action)
    const opening = String(template.opening?.narration ?? '').replace(/\s+/gu, ' ').slice(60, 160)
    if (opening && normalized.includes(opening) && !/^\[|прошл|^что мы/iu.test(action)) finding('major', 'parrots-opening', `ответ на «${short(action, 70)}» пересказывает вступление кампании`)
  }
  const raw = RAW_CODE.exec(text)
  if (raw) finding('minor', 'raw-identifier', `в тексте для игрока служебное «${raw[0]}»: «${short(text, 200)}»`)
  if (text.length > 2600) finding('minor', 'long-narration', `ответ на «${short(action, 60)}» длиной ${text.length} символов`)
}

// ---------------------------------------------------------------------------
// Голосования и Режиссёр

async function settleInteraction(reason = '') {
  for (let guard = 0; guard < 6; guard += 1) {
    const state = await room()
    const interaction = state.agentInteraction
    if (!interaction) return state
    if (interaction.status === 'open') {
      if (interaction.type === 'roll') {
        for (const actorId of heroIds()) {
          const key = `bot-share-roll-${randomUUID()}`
          const rolled = await request(`/api/campaigns/${CODE}/party-decisions/${encodeURIComponent(interaction.id)}/roll`, { method: 'POST', account: accountFor(actorId), key, body: { actor_id: actorId, idempotency_key: key } })
          if (rolled.status !== 200 && rolled.status < 500) note(`- общий бросок ${actorId}: ${rolled.status} ${rolled.body?.code ?? ''}`)
        }
        continue
      }
      const options = interaction.options ?? []
      const preferred = options.find((entry) => /^(accept|continue|go|yes)$/u.test(String(entry.id)))
        ?? options.find((entry) => /принять|продолж|идём|в путь|да\b|отправ/iu.test(String(entry.label)))
        ?? options[0]
      note(`- 🗳 голосование «${short(interaction.question ?? interaction.title ?? interaction.id, 160)}»: ${options.map((entry) => entry.label).join(' / ')} → «${preferred?.label}»`)
      for (const actorId of heroIds()) {
        const key = `bot-vote-${randomUUID()}`
        const vote = await request(`/api/campaigns/${CODE}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, { method: 'POST', account: accountFor(actorId), key, body: { actor_id: actorId, option_id: preferred?.id, idempotency_key: key } })
        stats.votes += 1
        if (vote.status !== 200) {
          const code = vote.body?.code ?? ''
          if (!/ALREADY|RESOLVED|CLOSED/u.test(code)) finding('major', 'vote-refused', `голос ${actorId} в «${interaction.id}»: ${vote.status} ${code} — ${short(vote.body?.error, 200)}`)
        }
        if (vote.body?.state?.agentInteraction?.status !== 'open') break
      }
      continue
    }
    if (interaction.status === 'resolved') {
      if (interaction.questAcceptance || interaction.questAbandonment) return state
      const winner = (interaction.options ?? []).find((entry) => entry.id === interaction.resolvedOptionId)
      if (isDirectorPartyDecision(interaction)) {
        const advanced = await director('Продолжить подтверждённый переход.', { interactionId: interaction.id, quiet: true })
        if (!advanced) return room()
      } else if (winner) {
        await say(accounts.owner.heroId, `[РЕШЕНИЕ ГРУППЫ] ${winner.label}`, { label: 'решение группы', expect: 'any' })
      } else return state
      const after = await room()
      if (after.agentInteraction?.id === interaction.id && after.agentInteraction.status === 'resolved') {
        finding('major', 'vote-stuck', `решение «${interaction.id}» принято, но продолжение его не закрыло (${reason})`)
        return after
      }
      continue
    }
    return state
  }
  return room()
}

/** Кто где стоит и в каком состоянии — чтобы разобрать зависший бой без хранилища. */
function combatSnapshot(state) {
  const conditions = (id) => (state.mechanics.conditions?.[id] ?? []).map((entry) => String(entry?.id ?? entry)).join('+')
  const actor = (entry) => {
    const at = state.mechanics.positions?.[entry.id] ?? { x: entry.x, y: entry.y }
    const flags = conditions(entry.id)
    return `${entry.character ?? entry.name ?? entry.id} ${entry.hp}/${entry.maxHp} @${at?.x},${at?.y}${entry.size ? ` ${entry.size}` : ''}${flags ? ` [${flags}]` : ''}`
  }
  // Хиты врага в проекции игрока скрыты: живым считается всякий, кто не выбыл.
  const enemies = (state.enemies ?? []).filter(isUp)
  return [...state.players.map(actor), ...enemies.map(actor)].join('; ')
}

let directorSeq = 0
async function director(playerAction = 'Продолжить приключение', { interactionId, quiet = false } = {}) {
  const key = `bot-director-${++directorSeq}`
  const before = await room()
  const seen = messageIds(before)
  const result = await request(`/api/campaigns/${CODE}/autonomy/advance`, {
    method: 'POST', account: accounts.owner, key,
    body: { idempotency_key: key, player_action: playerAction, actor_id: accounts.owner.heroId, ...(interactionId ? { interaction_id: interactionId } : {}) },
  })
  stats.directorSteps += 1
  if (result.status !== 200) {
    const code = result.body?.code ?? ''
    // ENCOUNTER_ALREADY_PRESENT — честный отказ: отряд выведен из строя, а
    // враги прежней встречи ещё стоят на поле. Новую встречу поверх неё
    // сервер собирать и не должен.
    if (!['COMBAT_ACTIVE', 'PARTY_DECISION_OPEN', 'CAMPAIGN_READ_ONLY', 'ENCOUNTER_ALREADY_PRESENT'].includes(code)) finding('major', 'director-refused', `Режиссёр на «${playerAction}»: ${result.status} ${code} — ${short(result.body?.error, 200)}`)
    if (!quiet) note(`- 🎬 Режиссёр отказал: ${code || result.status}`)
    return null
  }
  const type = result.body.intent?.type ?? '?'
  stats.directorIntents[type] = (stats.directorIntents[type] ?? 0) + 1
  // Строку Режиссёра сервер дописывает в ленту комнаты после того, как собрал
  // состояние ответа, поэтому новые сообщения ищутся в свежем снимке комнаты:
  // по `result.body.state` детектор молчания срабатывал на каждом шаге.
  const after = await room()
  for (const entry of newMessages(seen, after)) {
    if (entry.speaker !== 'narrator' || !entry.text) continue
    narrations.push({ kind: 'director', action: playerAction, label: type, text: String(entry.text) })
    for (const issue of narrationConsistency(String(entry.text), after)) recordConsistency(issue, `Режиссёр, ${type}`)
    stats.consistencyChecked += 1
  }
  const fresh = newMessages(seen, after).map((entry) => short(entry.text ?? entry.content, 500)).filter(Boolean)
  // Подтверждённый переход меняет сцену, и её вступление приходит своим путём —
  // смена места сама по себе видимый шаг, а не молчание Режиссёра.
  const sceneChanged = sceneKey(after) !== sceneKey(before)
  note(`- 🎬 Режиссёр (${playerAction}) → **${type}**${result.body.reward?.xp ? `, опыт ${result.body.reward.xp}` : ''}${fresh.length ? `: ${fresh.join(' ⏐ ')}` : ' (в хронике ничего нового)'}`)
  if (!fresh.length && !sceneChanged && !['COMBAT_ACTIVE'].includes(type) && !result.body.state?.agentInteraction) finding('minor', 'director-silent', `шаг Режиссёра ${type} на «${playerAction}» не добавил в хронику ни строки`)
  // Игрок просит идти дальше, а Режиссёр отвечает «ничего не меняется» — тот же тупик,
  // что и «не понял» на свободную реплику (прогон с моделью 2026-10-05, Обсидиановый перевал).
  const stalled = fresh.find((line) => DEAD_END.some((pattern) => pattern.test(line)))
  if (stalled && !sceneChanged) { stats.deadEnds += 1; finding('major', 'director-dead-end', `Режиссёр на «${playerAction}» (${type}): «${short(stalled, 160)}»`) }
  return result.body
}

// ---------------------------------------------------------------------------
// Бой

const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5
// У врагов в проекции игрока ОЗ скрыты: живой — пока не помечен павшим.
const isUp = (actor) => actor?.alive !== false && actor?.defeated !== true && !(actor?.hp != null && Number(actor.hp) <= 0)

let combatAbandoned = false
/** Удачные атаки и боевые заклинания героев в текущем бою. */
let combatActs = {}
async function playCombat(label) {
  let state = await room()
  if (!state.mechanics?.combat?.active) return state
  stats.combats += 1
  combatActs = {}
  const enemies = (state.enemies ?? []).map((enemy) => enemy.name).join(', ')
  note(`\n### ⚔ Бой: ${label} — ${enemies}`)
  console.log(`  бой: ${enemies}`)
  let lastVersion = -1
  let stuck = 0
  let maxRound = 0
  for (let step = 0; step < 600 && timeLeft() > 0; step += 1) {
    state = await room()
    const combat = state.mechanics.combat
    if (!combat.active) break
    maxRound = Math.max(maxRound, Number(combat.round) || 0)
    if (combat.round > 30) {
      finding('blocker', 'combat-long', `бой «${label}» идёт ${combat.round} раундов — прогон остановлен`)
      note(`- ⛔ снимок зависшего боя: ${combatSnapshot(state)}`)
      combatAbandoned = true
      break
    }
    if (state.state_version === lastVersion) stuck += 1
    else { stuck = 0; lastVersion = state.state_version }
    if (stuck === 3) await request(`/api/campaigns/${CODE}/system-tick`, { method: 'POST', account: accounts.owner })
    if (stuck > 6) {
      finding('blocker', 'combat-stuck', `бой «${label}» встал: ходит ${combat.initiative[combat.active_index]?.actor_id}, окно реакции ${combat.reaction_window?.trigger ?? 'нет'}; сервер: ${short(logs.split('\n').filter((line) => /не выполнена|Error/u.test(line)).at(-1), 200)}`)
      combatAbandoned = true
      break
    }
    if (combat.reaction_window) {
      const actorId = String(combat.reaction_window.actor_id)
      if (heroIds().includes(actorId)) await command(actorId, { command_type: 'UseCombatAction', action_id: 'decline-reaction' }, 'Пропустить реакцию')
      else await request(`/api/campaigns/${CODE}/system-tick`, { method: 'POST', account: accounts.owner })
      continue
    }
    const activeId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
    if (!heroIds().includes(activeId)) {
      await sleep(150)
      continue
    }
    await heroTurn(state, activeId)
  }
  state = await room()
  stats.combatRounds += maxRound
  const ended = (state.battleLog ?? []).findLast((entry) => entry.type === 'combat-end')
  const heroesUp = state.players.filter(isUp).length
  if (!state.mechanics.combat.active) {
    if ((state.enemies ?? []).every((enemy) => !isUp(enemy))) stats.combatWins += 1
    note(`- итог боя: раундов ${maxRound}, ${ended?.reason ?? ended?.text ?? '?'}, героев на ногах ${heroesUp}/${heroIds().length}`)
  }
  const tally = {}
  for (const entry of state.battleLog ?? []) {
    if (entry.type !== 'attack' && entry.type !== 'damage') continue
    const who = heroOf(state, entry.actorId)?.character ?? (state.enemies ?? []).find((enemy) => enemy.id === entry.actorId)?.name ?? entry.actorId
    const row = (tally[who] ??= { attacks: 0, hits: 0, damage: 0 })
    if (entry.type === 'attack') { row.attacks += 1; if (entry.roll?.hit) row.hits += 1 }
    if (Number.isFinite(Number(entry.damage)) && Number(entry.damage) > 0) row.damage += Number(entry.damage)
  }
  note(`- сводка атак: ${Object.entries(tally).map(([who, row]) => `${who} ${row.hits}/${row.attacks}${row.damage ? `, урон ${row.damage}` : ''}`).join('; ') || 'атак нет'}`)
  for (const hero of state.players) {
    const acted = combatActs[hero.id] ?? 0
    if (maxRound >= 4 && acted === 0) finding('major', 'hero-idle', `${hero.character} за ${maxRound} раундов «${label}» не провёл ни одной атаки или боевого заклинания`)
  }
  for (const actorId of heroIds()) {
    if (state.mechanics.death?.heroes?.[actorId]?.status === 'dead') {
      stats.heroDeaths += 1
      finding('minor', 'hero-died', `${heroOf(state, actorId)?.character} погиб в бою «${label}» — воскрешаю`)
      await command(actorId, { command_type: 'ResolveHeroDeath', resolution: 'resurrect' }, 'Воскресить')
    }
  }
  return room()
}

async function heroTurn(state, actorId) {
  turnLog = []
  try { await heroTurnActions(state, actorId) } finally {
    note(`- р${state.mechanics.combat.round} ${heroOf(state, actorId)?.character} (${heroOf(state, actorId)?.hp} ОЗ): ${turnLog.join(', ') || 'ничего'}`)
    turnLog = null
  }
}

async function heroTurnActions(state, actorId) {
  const me = heroOf(state, actorId)
  const fate = state.mechanics.death?.heroes?.[actorId]
  if (fate?.status === 'dead') {
    await command(actorId, { command_type: 'ResolveHeroDeath', resolution: 'resurrect' }, 'Воскресить')
    return
  }
  if (isUp(me)) {
    const conditions = (state.mechanics.conditions?.[actorId] ?? []).map((entry) => String(entry?.id ?? entry))
    if (conditions.includes('prone')) await command(actorId, { command_type: 'UseCombatAction', action_id: 'stand-up' }, 'Встать', { expectFailure: true })
    const at = state.mechanics.positions?.[actorId] ?? me
    const foes = (state.enemies ?? []).filter(isUp).map((enemy) => ({ enemy, at: state.mechanics.positions?.[enemy.id] ?? enemy })).sort((a, b) => distance(at, a.at) - distance(at, b.at))
    if (await tryParley(state, actorId, foes)) { /* действие ушло на переговоры */ }
    else if (me.characterClass === 'cleric') await clericTurn(state, actorId, at, foes)
    else if (me.characterClass === 'wizard') await wizardTurn(state, actorId, at, foes)
    else if (me.characterClass === 'rogue') await rogueTurn(state, actorId, at, foes)
    else await fighterTurn(state, actorId, foes)
  } else {
    stats.heroDowns += 1
  }
  const after = await room()
  const combat = after.mechanics.combat
  if (!combat.active || combat.reaction_window) return
  if (String(combat.initiative[combat.active_index]?.actor_id) !== actorId) return
  const ended = await command(actorId, { command_type: 'EndTurn' }, 'Завершить ход')
  if (ended.status !== 200 && ended.body?.code === 'HERO_DEAD_UNRESOLVED') await command(actorId, { command_type: 'ResolveHeroDeath', resolution: 'resurrect' }, 'Воскресить')
  else if (ended.status !== 200) finding('major', 'end-turn-refused', `EndTurn ${actorId}: ${ended.body?.code} — ${short(ended.body?.error, 200)}`)
}

const EXPECTED_REFUSALS = /TARGET_OUT_OF_RANGE|TRAJECTORY|COVER|VISIBLE|SPEED|PATH|DIFFICULT|OCCUPIED|DESTINATION|NO_ACTION|ACTION_USED|ACTION_SPENT|ALREADY|INSUFFICIENT|SLOT|BONUS_ACTION|ONE_SPELL|CONCENTRATION|LINE_OF_SIGHT|REACTION_PENDING/u

/** Слот заклинания уровня `level` у героя: сколько осталось. */
const slotsLeft = (state, actorId, level) => Number(state.mechanics.resources?.[actorId]?.[`spell_slots_${level}`]?.current ?? 0)
const countSpell = (spellId, result) => { if (result?.status === 200) stats.spells[spellId] = (stats.spells[spellId] ?? 0) + 1 }

/**
 * Переговоры посреди боя: раз за прогон, когда враги уже потеряли бойца, а
 * ходит жрица (убеждение) или плут (запугивание). Действие уходит на попытку,
 * как и у живого игрока; при перемирии бот выбирает самый мирный исход.
 */
async function tryParley(state, actorId, foes) {
  const me = heroOf(state, actorId)
  if (stats.parley.attempts >= 1 || !['cleric', 'rogue'].includes(me.characterClass)) return false
  const fallen = (state.enemies ?? []).filter((enemy) => !isUp(enemy)).length
  if (Number(state.mechanics.combat.round) < 2 || !fallen || !foes.length) return false
  stats.parley.attempts += 1
  const skill = me.characterClass === 'cleric' ? 'persuasion' : 'intimidation'
  const proposed = await command(actorId, { command_type: 'ProposeParley', skill }, `Переговоры (${skill === 'persuasion' ? 'убеждение' : 'запугивание'})`, { expectFailure: true })
  if (proposed.status !== 200) {
    if (!/PARLEY|TRUCE|ACTION_SPENT/u.test(String(proposed.body?.code))) finding('major', 'parley-refused', `ProposeParley: ${proposed.body?.code} — ${short(proposed.body?.error, 200)}`)
    return false
  }
  const truce = (await room(accountFor(actorId))).mechanics.combat?.truce
  if (!truce) { note('- 🕊 переговоры: враги отказались'); stats.parley.outcomes.push('refused'); return true }
  stats.parley.truces += 1
  const outcome = ['surrender', 'withdraw', 'tribute', 'resume'].find((entry) => (truce.outcomes ?? []).includes(entry)) ?? 'resume'
  const settled = await command(actorId, { command_type: 'SettleParley', outcome }, `Условие перемирия: ${outcome}`, { expectFailure: true })
  stats.parley.outcomes.push(settled.status === 200 ? outcome : `${outcome}:${settled.body?.code}`)
  if (settled.status !== 200) finding('major', 'parley-settle-refused', `SettleParley ${outcome}: ${settled.body?.code} — ${short(settled.body?.error, 200)}`)
  note(`- 🕊 переговоры: перемирие, исходы ${JSON.stringify(truce.outcomes)}, выбран «${outcome}»`)
  return true
}

/** Огненный шар по скоплению врагов, где нет своих; иначе волшебная стрела или огненный снаряд. */
async function wizardTurn(state, actorId, at, foes) {
  if (!foes.length) return
  const allies = state.players.filter((player) => isUp(player)).map((player) => state.mechanics.positions?.[player.id] ?? player)
  const cluster = foes.map(({ at: point }) => ({
    point,
    hit: foes.filter((other) => distance(point, other.at) <= 20).length,
    friendly: allies.some((ally) => distance(point, ally) <= 20),
  })).filter((entry) => !entry.friendly && entry.hit >= 2 && distance(at, entry.point) <= 150).sort((a, b) => b.hit - a.hit)[0]
  if (cluster && slotsLeft(state, actorId, 3) > 0) {
    const fireball = await command(actorId, { command_type: 'CastSpell', spell_id: 'fireball', to: { x: cluster.point.x, y: cluster.point.y }, slot_level: 3 }, `Огненный шар (${cluster.hit} цели)`, { expectFailure: true })
    countSpell('fireball', fireball)
    if (fireball.status === 200) return
    if (!EXPECTED_REFUSALS.test(String(fireball.body?.code))) finding('major', 'fireball-refused', `Огненный шар: ${fireball.body?.code} — ${short(fireball.body?.error, 200)}`)
  }
  const target = foes[0]
  if (distance(at, target.at) <= 120 && slotsLeft(state, actorId, 1) > 0 && foes.length === 1) {
    const missile = await command(actorId, { command_type: 'CastSpell', spell_id: 'magic-missile', target_id: target.enemy.id, slot_level: 1 }, 'Волшебная стрела', { expectFailure: true })
    countSpell('magic-missile', missile)
    if (missile.status === 200) return
  }
  if (distance(at, target.at) <= 120) {
    const bolt = await command(actorId, { command_type: 'CastSpell', spell_id: 'fire-bolt', target_id: target.enemy.id }, 'Огненный снаряд', { expectFailure: true })
    countSpell('fire-bolt', bolt)
    if (bolt.status === 200) return
    if (!EXPECTED_REFUSALS.test(String(bolt.body?.code))) finding('major', 'cantrip-refused', `Огненный снаряд: ${bolt.body?.code} — ${short(bolt.body?.error, 200)}`)
  }
  await meleeApproach(actorId, target.enemy.id)
}

/** Плут стреляет из короткого лука со скрытой атакой, если рядом с целью стоит союзник. */
async function rogueTurn(state, actorId, at, foes) {
  if (!foes.length) return
  const me = heroOf(state, actorId)
  const bow = (me.inventory ?? []).find((item) => /shortbow/u.test(String(item.catalog_id)))
  const target = foes.find(({ enemy, at: point }) => state.players.some((ally) => ally.id !== actorId && isUp(ally) && distance(state.mechanics.positions?.[ally.id] ?? ally, point) <= 5)) ?? foes[0]
  if (bow && distance(at, target.at) <= 80 && distance(at, target.at) > 5) {
    const flanked = state.players.some((ally) => ally.id !== actorId && isUp(ally) && distance(state.mechanics.positions?.[ally.id] ?? ally, target.at) <= 5)
    // Лук не в руках — сначала сменить оружие, как кнопкой на панели.
    if (!bow.equipped) await command(actorId, { command_type: 'ChangeWeapon', item_id: bow.id }, 'Взять короткий лук', { expectFailure: true })
    let shot = await command(actorId, { command_type: 'MakeAttack', target_id: target.enemy.id, item_id: bow.id, ...(flanked ? { sneak_attack: true } : {}) }, flanked ? 'Выстрел со скрытой атакой' : 'Выстрел', { expectFailure: true })
    if (shot.status === 200 && flanked) stats.sneakAttacks += 1
    if (shot.status !== 200 && /SNEAK_ATTACK/u.test(String(shot.body?.code))) shot = await command(actorId, { command_type: 'MakeAttack', target_id: target.enemy.id, item_id: bow.id }, 'Выстрел', { expectFailure: true })
    if (shot.status === 200) return
    if (!EXPECTED_REFUSALS.test(String(shot.body?.code)) && !/WEAPON|EQUIP|AMMUNITION/u.test(String(shot.body?.code))) finding('major', 'shot-refused', `Выстрел плута: ${shot.body?.code} — ${short(shot.body?.error, 200)}`)
  }
  await meleeApproach(actorId, target.enemy.id)
}

async function fighterTurn(state, actorId, foes) {
  const me = heroOf(state, actorId)
  const potion = (me.inventory ?? []).find((item) => /potion-of-healing/u.test(String(item.catalog_id)) && Number(item.quantity ?? 1) > 0)
  if (potion && Number(me.hp) < Number(me.maxHp) * 0.35) {
    const drank = await command(actorId, { command_type: 'UseItem', item_id: potion.id, target_id: actorId }, 'Выпить лечебное зелье', { expectFailure: true })
    if (drank.status === 200) stats.potionsUsed += 1
    else finding('major', 'potion-refused', `Лечебное зелье: ${drank.body?.code} — ${short(drank.body?.error, 200)}`)
  }
  if (Number(me.hp) < Number(me.maxHp) * 0.4) await command(actorId, { command_type: 'UseCombatAction', action_id: 'second-wind' }, 'Второе дыхание', { expectFailure: true })
  const target = foes[0]
  if (!target) return
  await meleeApproach(actorId, target.enemy.id)
}

async function meleeApproach(actorId, targetId) {
  let fresh = await room(accountFor(actorId))
  let route = null
  // Помощник маршрута проверяет «живой ли враг» по ОЗ, а проекция игрока их прячет.
  const preview = { ...fresh, enemies: (fresh.enemies ?? []).map((enemy) => (enemy.hp == null && isUp(enemy) ? { ...enemy, hp: Number(enemy.maxHp) || 1 } : enemy)) }
  try { route = previewApproachAttack(preview, actorId, targetId) } catch (error) { route = null; turnLog?.push(`(маршрут: ${error?.code ?? error?.message ?? error})`) }
  if (!route) {
    // Враг уже рядом: бьём надетым оружием без манёвра.
    const at = fresh.mechanics.positions?.[actorId]
    const adjacent = (fresh.enemies ?? []).filter(isUp).find((enemy) => at && distance(at, fresh.mechanics.positions?.[enemy.id] ?? enemy) <= 5)
    if (adjacent) {
      const weapon = (heroOf(fresh, actorId)?.inventory ?? []).find((item) => item.equipped && /weapon/u.test(String(item.type)) && !/crossbow|bow|арбалет|лук/iu.test(`${item.catalog_id} ${item.name}`))
      for (let swing = 0; swing < 3; swing += 1) {
        const hit = await command(actorId, { command_type: 'MakeAttack', target_id: adjacent.id, ...(weapon ? { item_id: weapon.id } : {}) }, 'Ударить', { expectFailure: true })
        if (hit.status !== 200) {
          if (swing === 0 && !EXPECTED_REFUSALS.test(String(hit.body?.code))) finding('major', 'attack-refused', `MakeAttack ${actorId}→${adjacent.id}: ${hit.body?.code} — ${short(hit.body?.error, 200)}`)
          break
        }
        const after = await room(accountFor(actorId))
        if (!after.mechanics.combat.active || !isUp((after.enemies ?? []).find((enemy) => enemy.id === adjacent.id))) break
      }
      return
    }
  }
  if (route) {
    for (const step of route.commands) {
      const { server_authoritative: _ignored, actor_id: _actor, ...clean } = step
      const sent = await command(actorId, clean, step.command_type === 'MoveActor' ? 'Подойти' : 'Ударить', { expectFailure: true })
      if (sent.status !== 200) {
        if (!EXPECTED_REFUSALS.test(String(sent.body?.code))) finding('major', 'approach-refused', `${step.command_type} ${actorId}→${targetId}: ${sent.body?.code} — ${short(sent.body?.error, 200)}`)
        return
      }
    }
    // Дополнительная атака: бьём того же или соседнего, пока сервер не скажет «хватит».
    for (let extra = 0; extra < 3; extra += 1) {
      fresh = await room(accountFor(actorId))
      if (!fresh.mechanics.combat.active) return
      // Серия атак кончилась: действие израсходовано и продолжения Атаки нет.
      // Движок снимает `action` уже после первого удара, а Дополнительную
      // атаку считает парой `attacks_used` / `attacks_allowed`. Без проверки
      // бот бил «ещё раз» сверх неё и копил отказы ACTION_SPENT.
      const economy = fresh.mechanics.combat.action_economy?.[actorId] ?? {}
      const attackContinues = Number(economy.attacks_used) > 0 && Number(economy.attacks_used) < Number(economy.attacks_allowed)
      if (economy.action === false && !attackContinues) return
      const at = fresh.mechanics.positions?.[actorId]
      const adjacent = (fresh.enemies ?? []).filter(isUp).find((enemy) => distance(at, fresh.mechanics.positions?.[enemy.id] ?? enemy) <= 5)
      if (!adjacent) return
      const weapon = route.commands.find((entry) => entry.command_type === 'MakeAttack')?.item_id
      const again = await command(actorId, { command_type: 'MakeAttack', target_id: adjacent.id, ...(weapon ? { item_id: weapon } : {}) }, 'Ещё удар', { expectFailure: true })
      if (again.status !== 200) return
    }
    return
  }
  const targetAt = fresh.mechanics.positions?.[targetId]
  if (!targetAt) return
  // До удара не дойти — идём, сколько хватает скорости. Путь режется по цене
  // шага движка (трудная местность), а занятыми считаются все клетки тела:
  // крупный зверь занимает 2×2, и по одной опорной клетке бот вставал внутрь
  // него — INVALID_DESTINATION раунд за раундом (серия сидов 2026-10-05).
  // Хиты врага игроку не видны; без них занятость считала его мёртвым, и
  // путь шёл сквозь тело медведя прямо в его клетку (сид 5, 2026-10-05).
  const rules = normalizeCampaignState({ ...fresh, enemies: (fresh.enemies ?? []).map((enemy) => (enemy.hp == null && isUp(enemy) ? { ...enemy, hp: Number(enemy.maxHp) || 1 } : enemy)) })
  const { stepCost, map } = movementStepCostFor(rules, actorId)
  // Цель пути — свободная клетка вплотную к телу врага, а не его опорная клетка:
  // она занята им самим, и путь «в неё» не находился. Воин стоял в двенадцати
  // клетках от совомеда и тридцать раундов заканчивал ход (сид 3, 2026-10-05).
  const target = (rules.enemies ?? []).find((enemy) => enemy.id === targetId)
  const body = new Set(footprintCellsFor(target, targetAt).map((cell) => `${cell.x},${cell.y}`))
  const taken = occupiedPositions(rules, actorId)
  const goals = new Map()
  for (const key of body) {
    const [x, y] = key.split(',').map(Number)
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      const goal = `${x + dx},${y + dy}`
      if (!body.has(goal) && !taken.has(goal)) goals.set(goal, { x: x + dx, y: y + dy })
    }
  }
  const costOf = (steps) => steps.reduce((total, step) => total + stepCost(step, map), 0)
  const path = [...goals.values()]
    .map((goal) => shortestTacticalPath(rules, actorId, goal, { tacticalMap: map, stepCost }))
    .filter((candidate) => Array.isArray(candidate) && candidate.length)
    .sort((left, right) => costOf(left) - costOf(right))[0] ?? []
  let budgetFeet = Number(movementForActor(rules, actorId).movement_remaining) || 0
  const stop = []
  for (const step of path) {
    budgetFeet -= stepCost(step)
    if (budgetFeet < 0) break
    stop.push(step)
  }
  // Занятость — тем же набором, что проверяет MoveActor: сдавшийся или
  // оглушённый зверь лежит на своих клетках, и встать на них нельзя.
  const occupied = occupiedPositions(rules, actorId)
  while (stop.length && occupied.has(`${stop.at(-1).x},${stop.at(-1).y}`)) stop.pop()
  if (!stop.length) return
  const moved = await command(actorId, { command_type: 'MoveActor', to: stop.at(-1) }, 'Подойти', { expectFailure: true })
  if (moved.status !== 200 && !EXPECTED_REFUSALS.test(String(moved.body?.code))) finding('major', 'move-refused', `MoveActor ${actorId}: ${moved.body?.code} — ${short(moved.body?.error, 200)}`)
}

let somaticNoted = false
/** Жрец со щитом и булавой не может жестикулировать: как живой игрок, убирает булаву. */
async function freeCasterHand(actorId, refusal) {
  if (refusal?.body?.code !== 'SPELL_SOMATIC_COMPONENT_BLOCKED') return false
  const hero = heroOf(await room(accountFor(actorId)), actorId)
  const weapon = (hero?.inventory ?? []).find((item) => item.equipped && /weapon/u.test(String(item.type)))
  if (!weapon) return false
  if (!somaticNoted) {
    somaticNoted = true
    finding('minor', 'rules-friction', `${hero.character} со стартовым снаряжением (оружие + щит) не может читать «Священное пламя» и «Лечение ран», пока не уберёт оружие — правило PHB, но без подсказки игроку это выглядит как поломка`)
  }
  const stowed = await command(actorId, { command_type: 'EquipItem', item_id: weapon.id, equipped: false }, `Убрать «${weapon.name}»`, { expectFailure: true })
  return stowed.status === 200
}

async function clericTurn(state, actorId, at, foes) {
  const slots = (level) => Number(state.mechanics.resources?.[actorId]?.[`spell_slots_${level}`]?.current ?? 0)
  // Самый раненый живой союзник в пределах 60 футов, включая лежащего на 0 ОЗ.
  const ally = state.players
    .filter((player) => player.id !== actorId && state.mechanics.death?.heroes?.[player.id]?.status !== 'dead')
    .filter((player) => distance(at, state.mechanics.positions?.[player.id] ?? player) <= 60)
    .sort((a, b) => Number(a.hp) / Math.max(1, Number(a.maxHp)) - Number(b.hp) / Math.max(1, Number(b.maxHp)))[0]
  if (ally && Number(ally.hp) < Number(ally.maxHp) * 0.35) {
    const level = [1, 2, 3].find((entry) => slots(entry) > 0)
    if (level) {
      let healed = await command(actorId, { command_type: 'CastSpell', spell_id: 'healing-word', target_id: ally.id, slot_level: level }, 'Лечащее слово', { expectFailure: true })
      if (healed.status !== 200 && await freeCasterHand(actorId, healed)) healed = await command(actorId, { command_type: 'CastSpell', spell_id: 'healing-word', target_id: ally.id, slot_level: level }, 'Лечащее слово', { expectFailure: true })
      countSpell('healing-word', healed)
      if (healed.status !== 200 && !EXPECTED_REFUSALS.test(String(healed.body?.code))) finding('major', 'heal-refused', `Лечащее слово: ${healed.body?.code} — ${short(healed.body?.error, 200)}`)
    }
  }
  const target = foes[0]
  if (!target) return
  if (distance(at, target.at) <= 60) {
    const bolt = slots(1) > 1 ? await command(actorId, { command_type: 'CastSpell', spell_id: 'guiding-bolt', target_id: target.enemy.id, slot_level: 1 }, 'Направляющий снаряд', { expectFailure: true }) : null
    countSpell('guiding-bolt', bolt)
    if (bolt?.status === 200) return
    let flame = await command(actorId, { command_type: 'CastSpell', spell_id: 'sacred-flame', target_id: target.enemy.id }, 'Священное пламя', { expectFailure: true })
    if (flame.status !== 200 && await freeCasterHand(actorId, flame)) flame = await command(actorId, { command_type: 'CastSpell', spell_id: 'sacred-flame', target_id: target.enemy.id }, 'Священное пламя', { expectFailure: true })
    countSpell('sacred-flame', flame)
    if (flame.status === 200) return
    if (!EXPECTED_REFUSALS.test(String(flame.body?.code))) finding('major', 'cantrip-refused', `Священное пламя: ${flame.body?.code} — ${short(flame.body?.error, 200)}`)
  }
  await meleeApproach(actorId, target.enemy.id)
}

// ---------------------------------------------------------------------------
// После боя и между сценами

async function lootAll() {
  const state = await room()
  const containers = Array.isArray(state.loot_containers) ? state.loot_containers : Object.values(state.loot_containers?.containers ?? state.loot_containers ?? {})
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue
    if (container.status && !['open', 'available', 'unlooted', 'partial'].includes(container.status)) continue
    const lines = (container.items ?? []).map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity ?? 1 })).filter((line) => line.item_instance_id)
    if (!lines.length) continue
    const taken = await command(accounts.owner.heroId, { command_type: 'LootContainer', container_id: container.id, lines }, 'Обыскать')
    if (taken.status === 200) { stats.lootTaken += lines.length; note(`- 🎒 добыча из «${container.name ?? container.id}»: ${(container.items ?? []).map((item) => item.name).join(', ')}`) }
    else finding('major', 'loot-refused', `LootContainer ${container.id}: ${taken.body?.code} — ${short(taken.body?.error, 200)}`)
  }
}

/**
 * Отдых — личный: `StartRest` начинает его одному герою, сервер сам
 * проматывает час (короткий) или восемь часов и завершает (долгий). Прежний
 * бот начинал отдых только владельцу, тратил одну кость хитов и долгого отдыха
 * не брал вовсе — отряд шёл в тяжёлый бой кульминации с 8/74 и 1/66 хитов и
 * раз за разом падал (серия сидов 2026-10-05, сид 4).
 */
async function restIfHurt() {
  const state = await room()
  if (state.mechanics.combat?.active) return
  const heroes = heroIds().map((actorId) => heroOf(state, actorId)).filter(Boolean)
  const living = heroes.filter((hero) => Number(hero.hp) > 0)
  if (!living.some((hero) => Number(hero.hp) < Number(hero.maxHp) * 0.7)) return
  const badly = living.length < heroes.length || living.some((hero) => Number(hero.hp) < Number(hero.maxHp) * 0.4)
  let kind = badly ? 'long' : 'short'
  for (const hero of living) {
    const label = kind === 'long' ? 'Долгий отдых' : 'Короткий отдых'
    let started = await command(hero.id, { command_type: 'StartRest', kind }, label, { expectFailure: true })
    if (started.status !== 200 && kind === 'long') {
      note(`- долгий отдых не начат: ${started.body?.code} — ${short(started.body?.error, 160)}; беру короткий`)
      kind = 'short'
      started = await command(hero.id, { command_type: 'StartRest', kind }, 'Короткий отдых', { expectFailure: true })
    }
    if (started.status !== 200) { note(`- отдых ${hero.character} не начат: ${started.body?.code} — ${short(started.body?.error, 160)}`); continue }
    stats.rests += 1
    if (kind !== 'short') continue
    for (let die = 0; die < 20; die += 1) {
      const current = heroOf(await room(), hero.id)
      if (!current || Number(current.hp) >= Number(current.maxHp) * 0.9) break
      const spent = await command(hero.id, { command_type: 'SpendHitPointDie' }, 'Кость хитов', { expectFailure: true })
      if (spent.status !== 200) break
    }
    await command(hero.id, { command_type: 'CompleteRest' }, 'Закончить отдых', { expectFailure: true })
  }
  const after = await room()
  note(`- 💤 ${kind === 'long' ? 'долгий' : 'короткий'} отдых: ${after.players.map((player) => `${player.character} ${player.hp}/${player.maxHp}`).join(', ')}`)
}

/** Число переходов по дорогам глобальной карты между двумя местами (BFS). */
function routeHops(map, from, to) {
  if (from === to) return 0
  const next = new Map()
  for (const route of map?.routes ?? []) {
    next.set(route.from, [...(next.get(route.from) ?? []), route.to])
    next.set(route.to, [...(next.get(route.to) ?? []), route.from])
  }
  const seen = new Map([[from, 0]])
  const queue = [from]
  while (queue.length) {
    const at = queue.shift()
    for (const neighbour of next.get(at) ?? []) {
      if (seen.has(neighbour)) continue
      seen.set(neighbour, seen.get(at) + 1)
      if (neighbour === to) return seen.get(neighbour)
      queue.push(neighbour)
    }
  }
  return Infinity
}

async function travelTo(locationId) {
  const state = await room()
  const map = state.worldMap
  const current = map?.locations?.find((entry) => entry.id === map.currentLocationId)
  const target = map?.locations?.find((entry) => entry.id === locationId)
  if (!current || !target) { finding('major', 'travel-target', `нет точки ${locationId} или текущей ${map?.currentLocationId}`); return false }
  const action = `[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=${encodeURIComponent(target.id)}] Отряд предлагает отправиться из «${current.name}» в «${target.name}». Выбранный путь: ${current.name} → ${target.name}.`
  stats.travels += 1
  await say(accounts.owner.heroId, action, { label: `дорога в «${target.name}»`, expect: 'any' })
  await settleInteraction('travel')
  const after = await room()
  if (after.mechanics.combat?.active) await playCombat(`засада по дороге в «${target.name}»`)
  const arrived = await room()
  // Дальнее место не соседнее: отряд идёт по дорогам с остановками, и каждое
  // предложение пути — один переход. Остановка ближе к цели — это не провал.
  const before = routeHops(map, current.id, target.id)
  const now = routeHops(arrived.worldMap ?? map, arrived.worldMap?.currentLocationId, target.id)
  if (arrived.worldMap?.currentLocationId !== target.id && now < before) {
    note(`  по дороге в «${target.name}»: остановка «${arrived.scene?.location}», осталось переходов: ${now}`)
    return false
  }
  if (arrived.worldMap?.currentLocationId !== target.id) {
    finding('major', 'travel-failed', `после предложения пути отряд в «${arrived.worldMap?.currentLocationId}», а не в «${target.id}» (сцена «${arrived.scene?.location}»)`)
    return false
  }
  return true
}

function sceneSnapshot(state) {
  const npcs = (state.social?.npcs ?? []).filter((npc) => npc.present !== false && (npc.location === state.scene?.location || npc.placement)).map((npc) => npc.name)
  const cells = state.scene?.cells?.length ?? 0
  const props = state.scene?.map?.props?.length ?? 0
  return { chapter: state.adventure?.chapter, location: state.scene?.location, locationId: state.worldMap?.currentLocationId, title: state.scene?.title, objective: state.scene?.objective, cells, props, npcs: npcs.slice(0, 8) }
}

// ---------------------------------------------------------------------------
// Согласованность: рассказчик против карты, броска, механики и часов;
// карта сцены против аудита и собственного текста (`eval/consistency-checks.mjs`)

/** Расхождение согласованности — в находки и в счётчик по коду. */
function recordConsistency(issue, where = '') {
  stats.consistency[issue.code] = (stats.consistency[issue.code] ?? 0) + 1
  finding(issue.severity, `consistency-${issue.code.toLowerCase().replace(/_/gu, '-')}`, `${issue.message}${where ? ` — ${where}` : ''}`)
}

/** Ответ рассказчика сверяется с тем, что сейчас на самом деле в сцене. */
async function checkNarrationConsistency(action, text, check = null) {
  if (!text) return
  const state = await room()
  stats.consistencyChecked += 1
  for (const issue of narrationConsistency(String(text), state, { check })) recordConsistency(issue, `на «${short(action, 70)}»`)
  // Контекст в момент ответа — для судьи: без него он не знает, что на карте и чем кончился бросок.
  const entry = narrations.findLast((item) => item.text === String(text))
  if (entry) entry.context = judgeContext(state, { check, recentNarrations: narrations.slice(-4, -1).map((item) => item.text) })
}

async function trackScene(state) {
  const snap = sceneSnapshot(state)
  const last = stats.scenes.at(-1)
  if (last && last.location === snap.location && last.chapter === snap.chapter) return
  // Новая сцена: построена ли карта и держит ли она текст сцены, не заглушка ли имя.
  // Карта — по полному виду ведущего: проекция игрока прячет нераскрытые клетки,
  // и аудит принимал их за проходы за край карты.
  let full = state
  try { full = await room(accounts.admin) } catch { full = state }
  const sceneIssues = [...sceneMapConsistency(full), ...sceneContinuity(state, last)]
  for (const issue of sceneIssues) recordConsistency(issue, `сцена ${snap.chapter}`)
  // Карту с замечанием аудита — в отчёт: карту прогона с моделью иначе не
  // воспроизвести бесплатно, архитектор сцены строит её по ответу модели.
  if (sceneIssues.some((issue) => /^(?:MAP_|PROGRAM_|SCENE_TEXT_)/u.test(issue.code)) && full?.scene?.map) {
    mkdirSync(join(OUT, 'maps'), { recursive: true })
    const file = join(OUT, 'maps', `${snap.chapter}-${String(snap.location).replace(/[^\p{L}\p{N}]+/gu, '-')}.json`)
    writeFileSync(file, JSON.stringify({ location: full.scene.location, title: full.scene.title, objective: full.scene.objective, location_id: full.worldMap?.currentLocationId, map_requirements: full.scene.map_requirements ?? null, issues: sceneIssues, map: full.scene.map }, null, 1))
  }
  stats.scenes.push(snap)
  stats.chapters = Math.max(stats.chapters, Number(snap.chapter) || 0)
  note(`\n### 📍 Сцена ${snap.chapter}: ${snap.location} — «${snap.title}»\nЦель: ${snap.objective ?? '—'} · карта ${snap.cells} клеток, ${snap.props} предметов · рядом: ${snap.npcs.join(', ') || 'никого'}`)
  if (!snap.cells) finding('major', 'scene-no-map', `сцена «${snap.location}» без тактической карты`)
}

// ---------------------------------------------------------------------------
// Проверки целостности

/** Путь в JSON до первой строки, содержащей `needle`, — чтобы утечку было где искать. */
function jsonPathOf(value, needle, path = 'state') {
  if (typeof value === 'string') return value.includes(needle) ? path : null
  if (!value || typeof value !== 'object') return null
  for (const [key, child] of Object.entries(value)) {
    const found = jsonPathOf(child, needle, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`)
    if (found) return found
  }
  return null
}

async function checkGuestProjection(when) {
  const fullGuestState = await room(accounts.guest)
  // Тайну, которую герой узнал сам (собеседник раскрыл её ему — событие
  // KnowledgeRevealed), проекция законно показывает этому игроку вместе с
  // пометкой gm_secret. Утечка — только то, чего он не узнавал (прогон с
  // моделью 2026-10-06: Мира Венн рассказала Ильве о сборщике налогов).
  const knownFactIds = new Set((fullGuestState.worldMemory?.knowledge_revealed ?? []).map((entry) => String(entry.fact_id)))
  const guestState = knownFactIds.size
    ? { ...fullGuestState, worldMemory: { ...fullGuestState.worldMemory, facts: (fullGuestState.worldMemory?.facts ?? []).filter((fact) => !knownFactIds.has(String(fact?.id))) } }
    : fullGuestState
  const json = JSON.stringify(guestState)
  const leaks = []
  // Найденная заготовка законно видна обоим: её открывает факт мира, видимый
  // отряду. Модель пересказывает находку своими словами, поэтому по хронике
  // находку не узнать — проверяется сам факт.
  const partyFacts = JSON.stringify((guestState.worldMemory?.facts ?? []).filter((fact) => fact?.visibility !== 'gm_only'))
  for (const secret of template.opening.secrets ?? []) {
    const clue = String(secret.clue ?? '').slice(0, 60)
    if (!clue || !json.includes(clue) || partyFacts.includes(clue) || transcript.join('\n').includes(clue.slice(0, 40))) continue
    leaks.push(`заготовка «${secret.topic}» (в ${jsonPathOf(guestState, clue) ?? '?'})`)
  }
  if (/"gm_secret"|"gmSecret"|"secrets":\s*\[\s*\{/u.test(json)) leaks.push('поле секретов ведущего')
  const enemyHp = (guestState.enemies ?? []).filter((enemy) => Number.isFinite(enemy.hp) && enemy.hpVisibility === 'hidden')
  if (enemyHp.length) leaks.push('скрытые ОЗ врагов')
  if (leaks.length) finding('critical', 'projection-leak', `${when}: второй игрок видит ${leaks.join(', ')}`)
  return leaks
}

async function checkIdempotency() {
  const key = `bot-idem-${randomUUID()}`
  // Действие с серверным броском без ручной фазы: оно точно записывается коммитом.
  const body = { action: 'Внимательно осматриваю всё вокруг, ищу следы и тайники', campaign_id: CODE, actor_id: accounts.guest.heroId, idempotency_key: key }
  const first = await request('/api/narrate', { method: 'POST', account: accounts.guest, body, key })
  const second = await request('/api/narrate', { method: 'POST', account: accounts.guest, body, key })
  if (first.status !== 200 || second.status !== 200) { note(`- идемпотентность: ${first.status}/${second.status} ${second.body?.code ?? ''}`); return }
  if (second.body.state_version !== first.body.state_version) finding('critical', 'idempotency', `повтор с тем же ключом сдвинул версию ${first.body.state_version} → ${second.body.state_version}`)
  const forged = await request('/api/narrate', { method: 'POST', account: accounts.guest, body: { ...body, action: 'Совсем другое действие' }, key })
  if (forged.status === 200 && forged.body?.state_version !== first.body.state_version) finding('critical', 'idempotency-conflict', `другой текст под тем же ключом записал новый ход (${first.body.state_version} → ${forged.body.state_version})`)
  else if (forged.status !== 409) note(`- идемпотентность: другой текст под тем же ключом → ${forged.status}${forged.body?.idempotent_replay ? ' (возвращён прежний ответ)' : ''}`)
}

async function restartAndCompare(reason) {
  const before = await room()
  await stopServer()
  startServer()
  await waitForHealth()
  stats.restarts += 1
  for (const account of accounts.players) await openStream(account)
  const after = await room()
  const pick = (state) => JSON.stringify({ v: state.state_version, combat: state.mechanics.combat, hp: state.players.map((p) => [p.id, p.hp]), loc: state.worldMap?.currentLocationId, chapter: state.adventure?.chapter, vote: state.agentInteraction?.id ?? null })
  if (pick(before) !== pick(after)) finding('critical', 'restart-drift', `перезапуск (${reason}) изменил состояние: ${short(pick(before), 200)} → ${short(pick(after), 200)}`)
  else note(`- 🔁 перезапуск сервера (${reason}): состояние совпало, версия ${after.state_version}`)
}

function runCutoverAudit() {
  const audit = spawnSync(process.execPath, ['tools/audit-cutover.mjs', '--storage', storage], { cwd: ROOT, encoding: 'utf8', timeout: 600_000, env: { ...process.env, ROUTERAI_API_KEY: '' } })
  const output = `${audit.stdout ?? ''}${audit.stderr ?? ''}`
  // Статус null без вывода — аудит не успел за отведённое время (длинная
  // кампания на занятой машине), а не расхождение replay: это разные находки.
  if (audit.status === null) finding('major', 'replay-audit-timeout', `audit-cutover не успел за 10 мин (${audit.signal ?? audit.error?.code ?? 'timeout'})`)
  else if (audit.status !== 0) finding('critical', 'replay-audit', `audit-cutover вернул ${audit.status}: ${short(output, 400)}`)
  return { status: audit.status, output: short(output, 2000) }
}

// ---------------------------------------------------------------------------
// Сценарий

const ROUTE_PLAN = ['astohan-ash-watch', 'astohan-obsidian-pass', 'astohan-vulkanis-brazier']

// Реальные фразы игроков. Уход из сцены и нападение на NPC бот не говорит:
// они уводят сценарий в сторону, а дорогу и бой он проверяет своими путями.
const CORPUS_KINDS = new Set(['explore', 'social', 'question', 'creative', 'provocation', 'offtopic'])
const corpus = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'eval', 'player-phrases.json'), 'utf8')).phrases.filter((entry) => CORPUS_KINDS.has(entry.kind))
  } catch { return [] }
})()
// Порядок фраз зависит от сида: серия сидов проходит по всему корпусу, а один сид повторяется.
let corpusCursor = Math.abs(Number(SEED ?? Math.floor(Math.random() * 1000))) * 7
async function sayRealPhrase(count = 1) {
  for (let index = 0; index < count && corpus.length; index += 1) {
    if ((await room()).mechanics.combat?.active) return
    const phrase = corpus[corpusCursor % corpus.length]
    const actorId = heroIds()[corpusCursor % heroIds().length]
    corpusCursor += 1
    const before = stats.deadEnds
    await say(actorId, phrase.text, { label: `реальная фраза · ${phrase.kind}` })
    const deadEnd = stats.deadEnds > before
    stats.corpus.said += 1
    if (deadEnd) stats.corpus.deadEnds += 1
    const row = (stats.corpus.byKind[phrase.kind] ??= { said: 0, deadEnds: 0 })
    row.said += 1
    if (deadEnd) row.deadEnds += 1
    await settleInteraction('real-phrase')
  }
}

/** Торговля у купца сцены: лечебное зелье для воина и продажа лишнего арбалета. */
async function tradeAtMerchant() {
  const state = await room()
  const merchants = Array.isArray(state.merchants) ? state.merchants : Object.values(state.merchants ?? {})
  const merchant = merchants.find((entry) => entry && entry.can_trade !== false)
  if (!merchant) { finding('minor', 'no-merchant', `в сцене «${state.scene?.location}» нет торговца`); return }
  const buyer = heroIds()[0]
  const view = await request(`/api/campaigns/${CODE}/merchants/${encodeURIComponent(merchant.id)}?actor_id=${encodeURIComponent(buyer)}`, { account: accountFor(buyer) })
  if (view.status !== 200) { stats.trade.refused += 1; finding('major', 'merchant-view', `лавка «${merchant.name}»: ${view.status} ${view.body?.code ?? ''} — ${short(view.body?.error, 200)}`); return }
  // Зелье за 50 зм стартовому герою 2014 не по карману — тогда самое дешёвое, что по карману.
  const quotes = view.body.merchant_view?.buy_quotes ?? []
  const quote = quotes.find((entry) => /healing|лечени/iu.test(`${entry.stock_id} ${entry.name ?? ''}`) && entry.can_afford !== false)
    ?? quotes.filter((entry) => entry.can_afford !== false).sort((a, b) => Number(a.unit_price_cp) - Number(b.unit_price_cp))[0]
  if (quote) {
    const key = `bot-buy-${randomUUID()}`
    const bought = await request(`/api/campaigns/${CODE}/merchants/${encodeURIComponent(merchant.id)}/commands`, {
      method: 'POST', account: accountFor(buyer), key,
      body: { idempotency_key: key, command: { command_type: 'BuyItem', actor_id: buyer, stock_id: quote.stock_id, quantity: 1, expected_state_version: view.body.merchant_view.expected_state_version ?? view.body.merchant_view.state_version } },
    })
    if (bought.status === 200) { stats.trade.bought += 1; note(`- 🛒 ${heroOf(state, buyer)?.character} покупает у «${merchant.name}»: ${quote.name ?? quote.stock_id} за ${quote.total_price_cp ?? quote.unit_price_cp} мм`) }
    else { stats.trade.refused += 1; finding('major', 'buy-refused', `BuyItem ${quote.stock_id}: ${bought.body?.code} — ${short(bought.body?.error, 200)}`) }
  } else finding('minor', 'nothing-affordable', `у «${merchant.name}» герою ничего не по карману`)
  const fresh = await request(`/api/campaigns/${CODE}/merchants/${encodeURIComponent(merchant.id)}?actor_id=${encodeURIComponent(buyer)}`, { account: accountFor(buyer) })
  const sale = (fresh.body?.merchant_view?.sell_quotes ?? []).find((entry) => entry.can_sell && /crossbow|арбалет/iu.test(`${entry.item_id} ${entry.name ?? ''}`))
    ?? (fresh.body?.merchant_view?.sell_quotes ?? []).find((entry) => entry.can_sell)
  if (!sale) return
  const key = `bot-sell-${randomUUID()}`
  const sold = await request(`/api/campaigns/${CODE}/merchants/${encodeURIComponent(merchant.id)}/commands`, {
    method: 'POST', account: accountFor(buyer), key,
    body: { idempotency_key: key, command: { command_type: 'SellItem', actor_id: buyer, item_id: sale.item_id, quantity: 1, expected_state_version: fresh.body.merchant_view.expected_state_version ?? fresh.body.merchant_view.state_version } },
  })
  if (sold.status === 200) { stats.trade.sold += 1; note(`- 💰 продано «${sale.name ?? sale.item_id}» за ${sale.unit_price_cp} мм`) }
  else { stats.trade.refused += 1; finding('major', 'sell-refused', `SellItem ${sale.item_id}: ${sold.body?.code} — ${short(sold.body?.error, 200)}`) }
}

async function exploreScene(state, round) {
  const scene = sceneSnapshot(state)
  const owner = accounts.owner.heroId
  const guest = accounts.guest.heroId
  const presentNpc = (state.social?.npcs ?? []).find((npc) => scene.npcs.includes(npc.name))
  const lines = [
    [guest, `Внимательно осматриваю ${scene.location}: ищу следы того, что здесь произошло, и всё, что связано с драконом Саргатом.`, 'осмотр'],
    [owner, 'Иду по следам, которые мы нашли, и пытаюсь понять, куда они ведут.', 'следы'],
    ...(presentNpc ? [[guest, `Обращаюсь к ${presentNpc.name}: что вы видели в последние дни и кто ещё может знать о налётах дракона?`, 'разговор']] : []),
  ]
  for (const [actorId, text, label] of lines.slice(0, round === 0 ? 3 : 1)) {
    if ((await room()).mechanics.combat?.active) return
    await say(actorId, text, { label })
    await settleInteraction('explore')
  }
  if (round === 0) await sayRealPhrase(2)
}

async function openingScene() {
  stage('Сцена 1: военная галерея Штормберга')
  let state = await room()
  await trackScene(state)
  const owner = accounts.owner.heroId
  const guest = accounts.guest.heroId
  await say(owner, 'Ваше величество, какое поручение вы даёте нам и что известно о Саргате?', { label: 'к королю' })
  const accepted = await request(`/api/campaigns/${CODE}/quests/accept`, { method: 'POST', account: accounts.owner, key: `bot-quest-${randomUUID()}`, body: { actor_id: owner, quest_id: 'quest:astohan-crown-report', idempotency_key: `bot-quest-${randomUUID()}` } })
  if (accepted.status !== 200) finding('major', 'quest-accept', `принять «Вернуть донесение короне»: ${accepted.status} ${accepted.body?.code ?? ''} — ${short(accepted.body?.error, 200)}`)
  await settleInteraction('quest')
  state = await room()
  const quest = state.worldMemory?.quests?.find((entry) => entry.id === 'quest:astohan-crown-report')
  note(`- 📜 задание «${quest?.title ?? '?'}»: ${quest?.status ?? 'нет в журнале'}`)
  if (quest && quest.status !== 'active') finding('major', 'quest-not-active', `после голосования задание в статусе ${quest.status}`)
  await say(guest, 'Изучаю донесение о сожжённой Пепельной заставе: кто открыл ворота и откуда начинаются следы когтей?', { label: 'донесение' })
  await say(owner, 'Присматриваюсь к Орену Фалю: правду ли он говорит о человеке в порту, который расспрашивал о последней охоте на Вулканиса?', { label: 'проницательность' })
  await say(guest, 'Расспрашиваю Миру Венн об исчезнувшем сборщике налогов у Митглайда.', { label: 'Мира Венн' })
  await say(owner, 'Наблюдаю за королём Аресом, когда маршал произносит имя Вулканиса.', { label: 'Арес и Вулканис' })
  await say(guest, 'Что мы уже знаем о Пепельной заставе?', { label: 'вопрос', requestKind: 'question', expect: 'any' })
  await tradeAtMerchant()
  await sayRealPhrase(2)
  await settleInteraction('opening')
  await director('Продолжить приключение')
  await settleInteraction('opening-director')
}

async function playUntilFinale() {
  let leg = 0
  let lastScene = ''
  let exploreRound = 0
  let idleDirector = 0
  let guardAttempts = 0
  for (let tick = 0; tick < 120 && timeLeft() > 60_000; tick += 1) {
    let state = await settleInteraction('loop')
    if (lifecycleStatus(state) !== 'active') return state
    if (state.mechanics.combat?.active) {
      if (combatAbandoned) return state
      if (!stats.restarts && stats.combats >= 1) await restartAndCompare('посреди боя')
      state = await playCombat(`сцена ${state.adventure?.chapter}, ${state.scene?.location}`)
      await lootAll()
      await restIfHurt()
      continue
    }
    // Стража у ворот: отряд в розыске. Живой стол выбирает из карточки, бот
    // платит виру — иначе переход заблокирован (`GUARD_ENCOUNTER_BLOCKS_SCENE`).
    if (state.law?.encounter) {
      const payer = state.partyMemberIds?.[0] ?? state.players?.[0]?.id
      guardAttempts += 1
      if (guardAttempts > 3) { finding('blocker', 'guard-stalled', `стража в «${state.scene?.location}» не отпускает отряд: ни вира, ни сдача не приняты`); return state }
      const resolution = guardAttempts === 1 ? 'fine' : 'surrender'
      note(`  стража: ${state.law.encounter.officer_name ?? 'офицер'} — ${resolution === 'fine' ? 'платим виру' : 'сдаёмся'}`)
      await command(payer, { command_type: 'ResolveGuardEncounter', actor_id: payer, resolution }, resolution === 'fine' ? 'вира страже' : 'сдаться страже', { expectFailure: true })
      continue
    }
    guardAttempts = 0
    await trackScene(state)
    const key = sceneKey(state)
    if (key !== lastScene) { lastScene = key; exploreRound = 0; idleDirector = 0; stage(`Сцена ${state.adventure?.chapter}: ${state.scene?.location}`) }
    if (exploreRound < 2) {
      await exploreScene(state, exploreRound)
      exploreRound += 1
      continue
    }
    const arc = state.autonomy?.pacing ?? {}
    // По сценарию финал — логово Саргата, а не номер главы.
    const finale = state.campaignConcept?.arc?.scenario_id
      ? state.scene?.location_id === 'astohan-vulkanis-brazier'
      : Number(state.adventure?.chapter) >= Number(state.campaignConcept?.arc?.target_scenes ?? 99)
    const action = idleDirector >= 3 ? 'Перейти дальше' : finale || arc.phase === 'climax' ? 'Ищем бой с Саргатом и его слугами' : idleDirector === 1 ? 'Ищем бой с теми, кто разорил эти земли' : 'Продолжить приключение'
    const before = state.state_version
    const advanced = await director(action)
    await settleInteraction('director')
    const after = await room()
    if (!advanced || after.state_version === before) idleDirector += 1
    else if (sceneKey(after) === key && !after.mechanics.combat?.active) idleDirector += 1
    if (idleDirector >= 5 && leg < ROUTE_PLAN.length) {
      const next = ROUTE_PLAN.slice(leg).find((id) => after.worldMap?.routes?.some((route) => route.discovered !== false && [route.from, route.to].includes(id) && [route.from, route.to].includes(after.worldMap.currentLocationId)))
      leg += 1
      if (next) { await travelTo(next); idleDirector = 0 }
    }
    if (idleDirector >= 8) { finding('blocker', 'story-stalled', `сюжет встал в сцене ${after.adventure?.chapter} «${after.scene?.location}»: Режиссёр ${idleDirector} шагов подряд ничего не продвинул`); return after }
  }
  return room()
}

// ---------------------------------------------------------------------------
// Оценка

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

// ---------------------------------------------------------------------------
// Текст рассказчика: метрики без модели, выборка для чтения, судья по флагу

/** Метрики всего текста прогона: штампы, повторы, служебные коды, пустые ответы. */
function narrationQuality() {
  const texts = narrations.map((entry) => entry.text.replace(/\s+/gu, ' ').trim()).filter(Boolean)
  const craft = measureNarratorCraft(texts.map((text, index) => ({ id: `n${index}`, kind: 'narrator', text })))
  const counts = new Map()
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1)
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0)
  const cliches = texts.flatMap((text) => findNarratorCliches(text).map((entry) => entry.match))
  const lengths = texts.map((text) => text.length)
  return {
    samples: texts.length,
    average_chars: lengths.length ? Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length) : 0,
    short_share_pct: texts.length ? Math.round(100 * texts.filter((text) => text.length < 40).length / texts.length) : 0,
    repeated_share_pct: texts.length ? Math.round(100 * repeated / texts.length) : 0,
    ngram_overlap_pct: craft.ngram_overlap.pairwise_jaccard_pct,
    cliches: cliches.length,
    cliche_examples: [...new Set(cliches)].slice(0, 8),
    raw_identifiers: texts.filter((text) => RAW_CODE.test(text)).length,
  }
}

/** Выборка для чтения глазами: равномерно по прогону, без повторов, разных видов. */
function narrationSample(limit = 14) {
  const unique = []
  const seen = new Set()
  for (const entry of narrations) {
    const key = entry.text.replace(/\s+/gu, ' ').trim()
    if (key.length < 20 || seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
  }
  if (unique.length <= limit) return unique
  const step = unique.length / limit
  return Array.from({ length: limit }, (_, index) => unique[Math.floor(index * step)])
}

const JUDGE_RUBRIC = `Ты — редактор текстовой ролевой игры по D&D на русском. Оцени ответ ведущего на реплику игрока.
Критерии, каждый от 1 до 5:
- relevance: отвечает на то, что сделал или спросил игрок, а не пересказывает общее;
- concreteness: конкретные детали места, людей, последствий; без воды и общих слов;
- consequence: у действия есть видимый исход или ясный следующий шаг;
- style: живой русский язык, без канцелярита, штампов, служебных слов и кодов;
- voice: если говорит персонаж — у него свой голос; если не говорит — ставь 3;
- consistency: не противоречит контексту — предметам на карте, персонажам в сцене, исходу броска, времени суток и тому, что ведущий говорил раньше; называет только то, что есть. Без контекста ставь 3.
Верни только JSON: {"relevance":n,"concreteness":n,"consequence":n,"style":n,"voice":n,"consistency":n,"issue":"главная проблема одной фразой или пусто","contradiction":"противоречие контексту одной фразой или пусто"}.`

/** Оценка выборки моделью-судьёй. Только с --judge: это вызовы модели за деньги. */
async function judgeNarration(sample) {
  if (!JUDGE) return null
  await import('dotenv/config')
  if (!process.env.ROUTERAI_API_KEY) { finding('minor', 'judge-unavailable', 'для --judge нужен ROUTERAI_API_KEY в .env'); return null }
  const { RouterAIClient } = await import('../server/llm-client.mjs')
  const client = new RouterAIClient({ maxTokens: 400, timeoutMs: 30_000 })
  const pricing = modelPricing(client.model)
  const verdicts = []
  let costRub = 0
  for (const entry of sample) {
    try {
      const result = await client.complete({ messages: [
        { role: 'system', content: JUDGE_RUBRIC },
        { role: 'user', content: `${entry.context ? `Контекст сцены в момент ответа:\n${entry.context}\n\n` : ''}Реплика игрока: ${entry.action}\n\nОтвет ведущего: ${entry.text}` },
      ] }, { json: true })
      costRub += callCostRub(result.usage, pricing)
      const scores = ['relevance', 'concreteness', 'consequence', 'style', 'voice', 'consistency'].map((key) => Number(result.json?.[key])).filter((value) => value >= 1 && value <= 5)
      verdicts.push({ action: short(entry.action, 120), text: short(entry.text, 300), ...result.json, average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null })
    } catch (error) {
      verdicts.push({ action: short(entry.action, 120), error: String(error?.code ?? error?.message ?? error).slice(0, 120) })
    }
  }
  const averages = verdicts.map((entry) => entry.average).filter(Number.isFinite)
  const consistencyScores = verdicts.map((entry) => Number(entry.consistency)).filter((value) => value >= 1 && value <= 5)
  return { model: client.model, verdicts, consistency_average: consistencyScores.length ? Math.round(10 * consistencyScores.reduce((sum, value) => sum + value, 0) / consistencyScores.length) / 10 : null, contradictions: verdicts.map((entry) => entry.contradiction).filter(Boolean), average: averages.length ? Math.round(10 * averages.reduce((sum, value) => sum + value, 0) / averages.length) / 10 : null, cost_rub: Math.round(costRub * 100) / 100 }
}

/** Цена токенов модели из последнего снимка каталога RouterAI (₽ за токен). */
function modelPricing(model) {
  try {
    const catalogs = readdirSync(join(ROOT, 'eval')).filter((name) => /^routerai-catalog-.*\.json$/u.test(name)).sort()
    const catalog = JSON.parse(readFileSync(join(ROOT, 'eval', catalogs.at(-1)), 'utf8'))
    return catalog.data.find((entry) => entry.id === model)?.pricing ?? null
  } catch { return null }
}
function callCostRub(usage, pricing) {
  if (Number.isFinite(Number(usage?.cost))) return Number(usage.cost)
  if (!pricing) return 0
  return (Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0) * pricing.prompt + (Number(usage?.completion_tokens ?? usage?.output_tokens) || 0) * pricing.completion
}

/**
 * Оценка текста от 1 до 10. Без судьи — только то, что меряется надёжно:
 * повторы, служебные коды, штампы, пустые ответы. Судья (1–5) заменяет её,
 * когда есть: это ближе к тому, что видит игрок, но стоит денег.
 */
function narrationScore(quality, judge) {
  if (judge?.average != null) return Math.round(judge.average * 2 * 10) / 10
  if (!quality.samples) return null
  let score = 10
  if (quality.repeated_share_pct > 10) score -= 3
  else if (quality.repeated_share_pct > 3) score -= 1
  if (quality.ngram_overlap_pct > 5) score -= 2
  if (quality.raw_identifiers) score -= 2
  if (quality.cliches) score -= 1
  if (quality.short_share_pct > 15) score -= 2
  return Math.max(1, score)
}

/** Согласованность 1–10: расхождения с картой и механикой на сверенный ответ, вместе с оценкой судьи. */
function consistencyScore(judge) {
  if (!stats.consistencyChecked && !Object.keys(stats.consistency).length) return null
  const issues = findings.filter((entry) => entry.kind.startsWith('consistency-'))
  const severe = issues.filter((entry) => entry.severity !== 'minor').length
  const minor = issues.length - severe
  const perAnswer = (severe * 3 + minor) / Math.max(1, stats.consistencyChecked)
  const own = Math.max(1, Math.round((10 - perAnswer * 20) * 10) / 10)
  return judge?.consistency_average != null ? Math.round(((own + judge.consistency_average * 2) / 2) * 10) / 10 : own
}
function consistencyDetail(judge) {
  const top = Object.entries(stats.consistency).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, count]) => `${code} ×${count}`).join(', ')
  return `сверено ответов ${stats.consistencyChecked}, сцен ${stats.scenes.length}; расхождения: ${top || 'нет'}${judge?.consistency_average != null ? `; судья по согласованности ${judge.consistency_average}/5` : ''}`
}

function grade(final, usage, audit, quality, judge) {
  const status = lifecycleStatus(final)
  const blockers = findings.filter((entry) => entry.severity === 'blocker').length
  const critical = findings.filter((entry) => entry.severity === 'critical').length
  const major = findings.filter((entry) => entry.severity === 'major').length
  const meaningful = Math.max(1, stats.narrate)
  const deadShare = stats.deadEnds / meaningful
  const firstWords = narrateLatency.map((entry) => entry.first_word_ms ?? entry.ms)
  const p50 = percentile(firstWords, 50)
  const p95 = percentile(firstWords, 95)
  const criteria = [
    { id: 1, name: 'Нет тупиков', score: deadShare <= 0.02 ? 10 : deadShare <= 0.05 ? 7 : deadShare <= 0.1 ? 4 : 1, detail: `${stats.deadEnds} тупиков на ${stats.narrate} реплик (${(deadShare * 100).toFixed(1)} %), уточнений ${stats.clarifications}; на реальных фразах игроков — ${stats.corpus.deadEnds} из ${stats.corpus.said}` },
    { id: 2, name: 'Успех что-то даёт', score: stats.discoveries + stats.discoveryEmpty === 0 ? 5 : Math.round(10 * stats.discoveries / (stats.discoveries + stats.discoveryEmpty)), detail: `находок ${stats.discoveries}, пустых успехов ${stats.discoveryEmpty}` },
    { id: 3, name: 'Сюжет движется', score: status === 'completed' ? 10 : stats.chapters >= 3 ? 6 : stats.chapters >= 2 ? 4 : 1, detail: `исход кампании: ${status}, глав ${stats.chapters}, сцен ${stats.scenes.length}, шагов Режиссёра ${stats.directorSteps}` },
    { id: 4, name: 'Бой', score: stats.combats === 0 ? 3 : Math.max(1, 10 - 3 * findings.filter((entry) => /combat|approach|move-refused|end-turn|heal|cantrip/u.test(entry.kind)).length), detail: `боёв ${stats.combats}, побед ${stats.combatWins}, раундов ${stats.combatRounds}, падений героев ${stats.heroDowns}, смертей ${stats.heroDeaths}` },
    { id: 7, name: 'Темп', score: p50 == null ? 5 : LIVE ? (p50 <= 4000 && p95 <= 10000 ? 10 : p50 <= 6000 ? 6 : 3) : (p95 <= 1500 ? 10 : 6), detail: `первое слово p50 ${p50 ?? '—'} мс, p95 ${p95 ?? '—'} мс${LIVE ? '' : ' (без модели — это время сервера, не модели)'}` },
    // Бюджет цели — 50 ₽ на трёхчасовой вечер; прогон короче, поэтому порог
    // пересчитан на его фактическую длительность.
    // Бот говорит в разы чаще людей, поэтому вечер пересчитывается не по
    // времени, а по числу реплик: ~150 реплик отряда за три часа игры.
    { id: 8, name: 'Бюджет', score: !LIVE ? null : usage?.per_evening_rub == null ? 5 : usage.per_evening_rub <= 50 ? 10 : usage.per_evening_rub <= 75 ? 6 : 3, detail: LIVE ? `вызовов модели ${usage?.requests ?? '?'}, токенов ${usage?.tokens ?? '?'}, ≈${usage?.cost_rub ?? '?'} ₽ (${usage?.cost_source ?? '?'}); ≈${usage?.per_action_rub ?? '?'} ₽ на реплику, вечер в ${EVENING_ACTIONS} реплик ≈${usage?.per_evening_rub ?? '?'} ₽ (цель ≤ 50 ₽)` : 'без модели не меряется' },
    { id: 'Т', name: 'Текст рассказчика', score: narrationScore(quality, judge), detail: `${quality.samples} ответов, в среднем ${quality.average_chars} знаков; повторы ${quality.repeated_share_pct} %, пересечение 3-грамм ${quality.ngram_overlap_pct} %, штампов ${quality.cliches}, служебных кодов ${quality.raw_identifiers}, коротких ${quality.short_share_pct} %${judge?.average != null ? `; судья ${judge.model}: ${judge.average}/5` : ''}` },
    { id: 'С', name: 'Согласованность', score: consistencyScore(judge), detail: consistencyDetail(judge) },
    { id: 9, name: 'Устойчивость', score: Math.max(1, 10 - 4 * findings.filter((entry) => /restart|replay|idempotency|transport|http-5xx/u.test(entry.kind)).length), detail: `перезапусков ${stats.restarts}, 5xx ${stats.http5xx}, audit-cutover ${audit.status === 0 ? 'чистый' : `код ${audit.status}`}` },
  ]
  const scored = criteria.filter((entry) => entry.score != null)
  const average = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length
  const overall = Math.max(1, Math.round((average - blockers * 1.5 - critical * 1) * 10) / 10)
  return { criteria, overall, blockers, critical, major, status, p50, p95 }
}

/** Реплик отряда (свободных и шагов Режиссёра) за трёхчасовой вечер — для пересчёта цены. */
const EVENING_ACTIONS = 150

async function usageReport() {
  const usage = await request('/api/admin/usage', { account: accounts.admin })
  if (usage.status !== 200) return null
  // Учёт расхода сервера (`server/usage-ledger.mjs`) называет токены и цену
  // поставщика; если поставщик цену не прислал, она оценивается по каталогу.
  const report = usage.body.usage ?? {}
  const architect = usage.body.architect ?? {}
  const requests = (report.requests ?? 0) + (architect.requests ?? 0)
  const tokens = (report.committed_tokens ?? 0) + (architect.committed_tokens ?? 0)
  let costRub = Number(report.provider_cost ?? 0) + Number(architect.provider_cost ?? 0)
  let costSource = 'цена поставщика'
  if (!(costRub > 0) && tokens > 0) {
    const env = (() => { try { return readFileSync(join(ROOT, '.env'), 'utf8') } catch { return '' } })()
    const model = process.env.DND_AI_MODEL || /^DND_AI_MODEL=(.+)$/mu.exec(env)?.[1]?.trim() || ''
    const pricing = modelPricing(model)
    costRub = callCostRub({ prompt_tokens: report.input_tokens ?? 0, completion_tokens: report.output_tokens ?? 0 }, pricing)
    costSource = pricing ? `оценка по каталогу для ${model}` : 'нет цены'
  }
  const perAction = costRub / Math.max(1, stats.narrate + stats.directorSteps)
  return {
    requests, tokens, input_tokens: report.input_tokens ?? null, output_tokens: report.output_tokens ?? null,
    failed_requests: report.failed_requests ?? null,
    cost_rub: Math.round(costRub * 100) / 100, cost_source: costSource,
    per_action_rub: Math.round(perAction * 1000) / 1000,
    per_evening_rub: Math.round(perAction * EVENING_ACTIONS * 100) / 100,
  }
}

function writeReport(final, scorecard, usage, audit, quality, judge, sample) {
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
  const byRoute = {}
  for (const entry of timings) (byRoute[entry.route] ??= []).push(entry.ms)
  const routeLines = Object.entries(byRoute).sort((a, b) => b[1].length - a[1].length).slice(0, 14)
    .map(([route, values]) => `| \`${route}\` | ${values.length} | ${percentile(values, 50)} | ${percentile(values, 95)} | ${Math.max(...values)} |`)
  const severityOrder = { blocker: 0, critical: 1, major: 2, minor: 3 }
  const grouped = new Map()
  for (const entry of findings) {
    const key = `${entry.severity}|${entry.kind}`
    const bucket = grouped.get(key) ?? { ...entry, count: 0, examples: [] }
    bucket.count += 1
    if (bucket.examples.length < 3) bucket.examples.push(`${entry.stage}: ${entry.message}`)
    grouped.set(key, bucket)
  }
  const findingLines = [...grouped.values()].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count)
    .map((entry) => `- **${entry.severity}** \`${entry.kind}\` ×${entry.count}\n${entry.examples.map((line) => `  - ${line}`).join('\n')}`)
  const md = [
    `# Прогон «Асстоханские равнины» — ${STAMP}`,
    '',
    `Режим: **${LIVE ? 'с моделью' : 'без модели'}**${SEED != null ? `, сид костей ${SEED}` : ''} · длительность ${minutes} мин · исход кампании **${scorecard.status}** · итоговая оценка **${scorecard.overall}/10**`,
    `Блокеров ${scorecard.blockers}, критичных ${scorecard.critical}, серьёзных ${scorecard.major}, мелких ${findings.length - scorecard.blockers - scorecard.critical - scorecard.major}.`,
    '',
    '## Критерии цели «Первый вечер без ведущего»',
    '',
    '| # | Критерий | Оценка | Замер |',
    '| --- | --- | --- | --- |',
    ...scorecard.criteria.map((entry) => `| ${entry.id} | ${entry.name} | ${entry.score ?? '—'} | ${entry.detail} |`),
    '',
    'Критерии 5 (вид места) и 6 (двое за столом в интерфейсе) этот прогон не меряет: первый — `pnpm maps:preview -- --preset all --audit`, второй — ручной плейтест.',
    '',
    '## Находки',
    '',
    ...(findingLines.length ? findingLines : ['Нет.']),
    '',
    '## Текст рассказчика',
    '',
    `Ответов ${quality.samples}, в среднем ${quality.average_chars} знаков. Повторы ${quality.repeated_share_pct} %, пересечение 3-грамм между ответами ${quality.ngram_overlap_pct} %, коротких (< 40 знаков) ${quality.short_share_pct} %, служебных кодов ${quality.raw_identifiers}, штампов ${quality.cliches}${quality.cliche_examples.length ? ` (${quality.cliche_examples.map((entry) => `«${entry}»`).join(', ')})` : ''}.`,
    judge ? `Судья ${judge.model}: средняя ${judge.average ?? '—'}/5 по ${judge.verdicts.length} ответам, ≈${judge.cost_rub} ₽. Главные замечания: ${judge.verdicts.map((entry) => entry.issue).filter(Boolean).slice(0, 6).map((issue) => `«${short(issue, 120)}»`).join('; ') || 'нет'}.` : 'Судья не запускался (флаг --judge).',
    `Выборка из ${sample.length} ответов для чтения глазами — narration-sample.md.`,
    '',
    '## Согласованность',
    '',
    `Сверено ответов рассказчика ${stats.consistencyChecked}, сцен ${stats.scenes.length}. Расхождения по видам: ${Object.entries(stats.consistency).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} ×${count}`).join(', ') || 'нет'}.`,
    'Что проверяется: предметы, которые называет рассказчик, против карты сцены; исход броска против текста после него; смерть героя и реплики отсутствующих NPC против механики; время суток против часов мира; склонение названий мест и обрывы на полуслове; аудит построения каждой карты (`map-quality`), её программа и то, что обещает текст самой сцены; имена-заглушки и переименование места.',
    judge?.contradictions?.length ? `Противоречия, которые нашёл судья: ${judge.contradictions.slice(0, 6).map((entry) => `«${short(entry, 140)}»`).join('; ')}.` : '',
    '',
    '## Реальные фразы игроков',
    '',
    `Сказано ${stats.corpus.said}, тупиков ${stats.corpus.deadEnds}. По видам: ${Object.entries(stats.corpus.byKind).map(([kind, row]) => `${kind} ${row.deadEnds}/${row.said}`).join(', ') || '—'}.`,
    '',
    '## Механики отряда',
    '',
    `Отряд: ${PARTY.join(', ')}. Заклинания: ${Object.entries(stats.spells).map(([id, count]) => `${id} ×${count}`).join(', ') || '—'}; скрытых атак ${stats.sneakAttacks}; зелий выпито ${stats.potionsUsed}. Торговля: куплено ${stats.trade.bought}, продано ${stats.trade.sold}, отказов ${stats.trade.refused}. Переговоры: попыток ${stats.parley.attempts}, перемирий ${stats.parley.truces}, исходы ${stats.parley.outcomes.join(', ') || '—'}.`,
    '',
    '## Путь отряда',
    '',
    ...stats.scenes.map((scene) => `- глава ${scene.chapter}: **${scene.location}** — «${scene.title}» (${scene.cells} клеток, ${scene.props} предметов; рядом: ${scene.npcs.join(', ') || 'никого'})`),
    '',
    '## Счётчики',
    '',
    '```json',
    JSON.stringify(stats, null, 2),
    '```',
    '',
    '## Темп запросов (мс)',
    '',
    '| Маршрут | Кол-во | p50 | p95 | max |',
    '| --- | --- | --- | --- | --- |',
    ...routeLines,
    '',
    `audit-cutover: код ${audit.status}`,
    '',
    '```',
    audit.output,
    '```',
  ].join('\n')
  writeFileSync(join(OUT, 'report.md'), md)
  writeFileSync(join(OUT, 'narration-sample.md'), [
    `# Текст рассказчика — выборка прогона ${STAMP}`,
    '',
    'Для чтения глазами: равномерно по прогону, без повторов. Вопросы к каждому ответу — отвечает ли он на реплику, есть ли конкретика и последствие, живой ли язык, слышен ли голос персонажа.',
    ...sample.map((entry, index) => {
      const verdict = judge?.verdicts?.find((item) => item.text === short(entry.text, 300))
      const kind = entry.kind === 'director' ? 'Режиссёр' : entry.kind === 'roll' ? 'После броска' : 'Ответ'
      const score = verdict?.average != null ? `\n\n_Судья: ${verdict.average.toFixed(1)}/5${verdict.issue ? ` — ${verdict.issue}` : ''}_` : ''
      return `\n## ${index + 1}. ${kind} · ${entry.label}\n\n**Игрок:** ${entry.action}\n\n> ${entry.text.replace(/\n+/gu, '\n> ')}${score}`
    }),
  ].join('\n') + '\n')
  writeFileSync(join(OUT, 'transcript.md'), `# Хроника прогона ${STAMP}\n${transcript.join('\n')}\n`)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ stamp: STAMP, live: LIVE, seed: SEED, minutes: Number(minutes), scorecard, stats, findings, narrateLatency, usage, narration: { quality, judge }, audit, final: { lifecycle: final?.mechanics?.campaign_lifecycle ?? null, chapter: final?.adventure?.chapter, location: final?.scene?.location } }, null, 2))
  const serverErrors = logs.split('\n').filter((line) => /error|ошибк|exception|unhandled/iu.test(line) && !/ROUTERAI|api[_-]?key/iu.test(line)).slice(0, 60)
  writeFileSync(join(OUT, 'server-errors.log'), serverErrors.join('\n'))
}

// ---------------------------------------------------------------------------
// Прогон

async function main() {
  stage('Подготовка')
  startServer()
  await waitForHealth()
  const admin = await request('/api/auth/setup-admin', { method: 'POST', body: { name: 'Стенд', email: 'admin@astohan.test', password: 'astohan-admin-password', setupToken } })
  accounts.admin = { name: 'admin', cookie: cookieOf(admin) }
  const unknown = PARTY.filter((classKey) => !HERO_PLANS[classKey])
  if (unknown.length || PARTY.length < 2) throw new Error(`--party: нужно от двух героев из ${Object.keys(HERO_PLANS).join(', ')}; непонятно: ${unknown.join(', ')}`)
  // По аккаунту на героя: первый — владелец кампании, остальные входят по приглашению.
  for (const [index, classKey] of PARTY.entries()) {
    const registered = await request('/api/auth/register', { method: 'POST', body: { name: `Игрок ${index + 1}`, email: `player${index + 1}@astohan.test`, password: `astohan-player-${index + 1}-password` } })
    accounts.players.push({ name: index === 0 ? 'owner' : `player${index + 1}`, cookie: cookieOf(registered), heroId: `hero-slot-${index + 1}`, plan: HERO_PLANS[classKey] })
  }
  accounts.owner = accounts.players[0]
  accounts.guest = accounts.players[1]
  const created = await request('/api/campaigns', { method: 'POST', account: accounts.owner, body: {
    code: CODE, name: 'Асстоханские равнины',
    bootstrap: { partyName: 'Пепельный отряд', world: {}, worldTemplateId: TEMPLATE_ID, slotCount: PARTY.length, startLevel: START_LEVEL, rulesetId: RULESET_ID, campaignMode: 'adventure' },
  } })
  if (created.status !== 201) throw new Error(`Кампания не создана: ${created.status} ${created.text.slice(0, 400)}`)
  note(`Кампания «${created.body.state.campaign}», старт в «${created.body.state.scene.location}», редакция ${created.body.state.ruleset_id}, мир ${created.body.state.worldMap?.locations?.length} мест, отряд: ${PARTY.join(', ')}`)
  for (const account of accounts.players.slice(1)) {
    const invite = await request(`/api/campaigns/${CODE}/invites`, { method: 'POST', account: accounts.owner, body: { hero_ids: [account.heroId] } })
    const joined = await request(`/api/campaigns/${CODE}/join`, { method: 'POST', account, body: { invite_token: invite.body?.token } })
    if (joined.status !== 200) throw new Error(`Игрок ${account.name} не вошёл: ${joined.status} ${joined.text.slice(0, 300)}`)
  }
  for (const account of accounts.players) await openStream(account)
  await checkGuestProjection('до первой реплики')

  stage('Создание героев 7-го уровня')
  const built = []
  for (const account of accounts.players) built.push(await buildHero(account, account.plan))
  if (!built.every(Boolean)) throw new Error('Герои не созданы — дальше прогон не имеет смысла')

  await openingScene()
  if (VISIT.length) {
    for (const target of VISIT) {
      for (let hop = 0; hop < 6 && (await room()).worldMap?.currentLocationId !== target; hop += 1) {
        await travelTo(target)
        const here = await room()
        if (here.mechanics.combat?.active) await playCombat(`по дороге в ${target}`)
        await settleInteraction('visit')
      }
      await trackScene(await room())
    }
    note(`
Хранилище оставлено: ${storage}
Кампания ${CODE}, вход владельца — player1@astohan.test`)
    return room()
  }
  if (await travelTo('astohan-ash-watch')) await trackScene(await room())
  let final = await playUntilFinale()

  stage('Проверки целостности')
  await checkIdempotency()
  await checkGuestProjection('в конце прогона')
  if (stats.restarts === 0) await restartAndCompare('в конце')
  final = await room()
  if (lifecycleStatus(final) === 'active') {
    finding('major', 'not-completed', `за ${MINUTES} мин кампания не дошла до финала: глава ${final.adventure?.chapter}, «${final.scene?.location}», фаза ${final.autonomy?.pacing?.phase ?? '?'}`)
  } else {
    note(`\n### Эпилог\n${final.mechanics.campaign_lifecycle?.epilogue ?? '—'}`)
  }
  return final
}

let final = null
let fatal = null
try {
  final = await main()
} catch (error) {
  fatal = error
  finding('blocker', 'run-aborted', short(error?.stack ?? error, 600))
}
await stopServer()
const audit = runCutoverAudit()
let usage = null
if (LIVE) {
  startServer()
  try { await waitForHealth(); usage = await usageReport() } catch { /* без замера */ }
  await stopServer()
  if (!usage?.requests) finding('critical', 'live-without-model', 'прогон с --live не сделал ни одного вызова модели: сервер работал без ключа или модель недоступна — отчёт описывает игру без модели')
}
const quality = narrationQuality()
const sample = narrationSample()
const judge = await judgeNarration(sample)
const scorecard = grade(final, usage, audit, quality, judge)
writeReport(final, scorecard, usage, audit, quality, judge, sample)
console.log(`\nИтог: ${scorecard.status}, оценка ${scorecard.overall}/10, блокеров ${scorecard.blockers}, критичных ${scorecard.critical}, серьёзных ${scorecard.major}`)
console.log(`Отчёт: ${relative(ROOT, join(OUT, 'report.md'))}`)
if (!KEEP) rmSync(storage, { recursive: true, force: true })
else console.log(`Хранилище оставлено: ${storage}`)
process.exit(fatal ? 1 : 0)
