import '../../../fixtures-env.mjs'
// Эталоны задачи П1 `sk-projection`: `server/viewer-projection.mjs` и
// `server/trace-store.mjs`.
//
//   node rust/crates/sk-projection/fixtures/gen-p1.mjs [--corpus <corpus-v1>] [--cache <файл захвата>]
//
// Источники случаев:
// - настоящие вызовы экспортов обоих модулей из тестов JS (без тестов с
//   HTTP-сервером); `.env` не читается — `dotenv/config` подменён;
// - корпус паритета (`--corpus`, по умолчанию ../Dnd-narrator-live/tmp/corpus-v1):
//   состояния боя, исследования, торговли, пленных, сценария и тумана карты ×
//   зрители (ведущий, свой игрок, чужой игрок, зритель, без доступа); события
//   строк корпуса — через `mechanicsForViewer`, `turnResultForViewer`,
//   `turnExplanationForViewer`; прогноз удара полным путём (проекция +
//   `withCombatForecast`);
// - синтетика с закрытыми полями (маркеры `SECRET-…` и числа 9871…9879) и мусор.
//
// Выход — `p1.json.gz`: `out_hash` (SHA-256 `JSON.stringify`), небольшой выход
// целиком (`out`), `error` (имя исключения) или `out_undefined`; у случаев
// синтетики — `leaks`: закрытые маркеры, оказавшиеся в выходе JS.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const vp = await import('../../../../server/viewer-projection.mjs')
const ts = await import('../../../../server/trace-store.mjs')
const { withCombatForecast } = await import('../../../../server/combat-forecast-view.mjs')
const { applyGameEvent, normalizeCampaignState } = await import('../../../../server/rules-engine.mjs')
const tm = await import('../../../../server/tactical-map.mjs')
const { argsFrom, argsOf, hash, mulberry32, plain, writeFixture } = await import('../../sk-tactics/fixtures/common.mjs')

const argv = process.argv.slice(2)
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const toPath = (url) => url.pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const corpusRoot = flag('--corpus', toPath(new URL('../../../../../Dnd-narrator-live/tmp/corpus-v1', import.meta.url)))
const cacheFile = flag('--cache', null)
const random = mulberry32(20261021)
const int = (n) => Math.floor(random() * n)

const INLINE = 3_000
function outcome(run) {
  try {
    const value = run()
    if (value === undefined) return { out_undefined: true }
    const text = JSON.stringify(value)
    return text.length > INLINE ? { out_hash: hash(value) } : { out: plain(value) }
  } catch (error) {
    // Модуль, где брошено исключение: соседние модули в Rust на мусоре не бросают.
    const frame = String(error?.stack ?? '').split(/\r?\n/u).slice(1).find((line) => line.includes('/server/')) ?? ''
    const where = frame.match(/\/server\/([\w./-]+\.mjs)/u)?.[1] ?? ''
    return { error: String(error?.name ?? 'Error'), ...(where && where !== 'viewer-projection.mjs' && where !== 'trace-store.mjs' ? { error_in: where } : {}) }
  }
}

/** Закрытые маркеры в значении: строки с `SECRET-` и числа 9871…9879. */
function leaksOf(value) {
  const found = new Set()
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/SECRET-[A-Za-z0-9_-]+/gu)) found.add(match[0])
    } else if (typeof node === 'number') {
      if (node >= 9871 && node <= 9879) found.add(String(node))
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        for (const match of key.matchAll(/SECRET-[A-Za-z0-9_-]+/gu)) found.add(match[0])
        walk(child)
      }
    }
  }
  walk(value)
  return [...found].sort()
}

const FUNCTIONS = {
  campaignStateForViewer: vp.campaignStateForViewer,
  mechanicsForViewer: vp.mechanicsForViewer,
  turnExplanationForViewer: vp.turnExplanationForViewer,
  turnResultForViewer: vp.turnResultForViewer,
  sceneTransitionForViewer: vp.sceneTransitionForViewer,
  publicSceneFor: vp.publicSceneFor,
  publicWorldMapFor: vp.publicWorldMapFor,
  publicAdventureFor: vp.publicAdventureFor,
  publicEnemyFor: vp.publicEnemyFor,
  publicEncounterFor: vp.publicEncounterFor,
  publicTacticalMapFor: vp.publicTacticalMapFor,
  publicTacticalMapWithHashFor: vp.publicTacticalMapWithHashFor,
  publicActorFootprintFor: vp.publicActorFootprintFor,
  actorAppearancesForViewer: vp.actorAppearancesForViewer,
  redactTrace: (value) => ts.redactTrace(value),
  migrateTraceToV2: ts.migrateTraceToV2,
  buildTurnExplanation: ts.buildTurnExplanation,
  isMechanicalTrace: ts.isMechanicalTrace,
  // Полный путь комнаты (`viewerStateFor` в server/index.mjs): проекция и прогноз удара.
  viewerState: (state, user, actor) => withCombatForecast(vp.campaignStateForViewer(state, user, actor), state, actor),
}

const calls = []
const seen = new Set()
function call(fn, args, { leaks = false, test = '', strict = false } = {}) {
  const entry = { fn, ...argsOf(args) }
  const text = JSON.stringify(entry)
  if (text.length > 300_000 || seen.has(text)) return
  seen.add(text)
  const record = { ...entry, ...(test ? { test } : {}), ...(strict ? { strict: true } : {}), ...outcome(() => FUNCTIONS[fn](...argsFrom(entry))) }
  if (leaks && !record.error) {
    let value
    try { value = FUNCTIONS[fn](...argsFrom(entry)) } catch { value = undefined }
    record.leaks = leaksOf(value)
  }
  calls.push(record)
}

// --- захват вызовов из тестов JS ---------------------------------------------------

const CAPTURE_TESTS = [
  'viewer-projection', 'trace-store', 'turn-trace-v2', 'combat-forecast-disclosure', 'enemy-knowledge-disclosure',
  'spell-area-privacy-projection', 'spell-area-privacy-events', 'viewer-memory-projection', 'autonomy-projection',
  'actor-appearance-projection', 'attack-visual-event', 'longstrider-projection', 'mass-cure-projection', 'npc-equipment',
  'loading-projection', 'item-origin', 'captives', 'beast-taming', 'law-and-order', 'loot-containers', 'tavern-life',
  'blessings', 'lockpicking', 'scenario-attention', 'scenario-knight', 'courier-letters-ui-contract', 'offscreen-world',
  'world-deeds', 'weather', 'world-map', 'tactical-map-state', 'reveal-transport', 'prop-supports', 'map-import-command',
  'level-transition', 'monster-defenses', 'boss-mechanics', 'pickpocket', 'quest-consequence-knowledge', 'reaction-preferences',
  'combat-chronicle-transparency', 'hero-spellcasting-summary', 'spell-components-mechanics', 'npc-positioning', 'npc-social',
  'parley', 'underworld', 'thrown-flasks', 'enemy-identification', 'action-hints', 'destructive-wave-npc-temp', 'indomitable',
  'mass-cure-wounds-npc', 'npc-item-transfer', 'spell-cast-visual-point', 'location-illustrations', 'world-memory',
]
const CAPTURED = Object.keys(FUNCTIONS).filter((name) => name !== 'viewerState')
const TARGETS = {
  '/server/viewer-projection.mjs': CAPTURED.filter((name) => Object.hasOwn(vp, name)),
  '/server/trace-store.mjs': ['redactTrace', 'migrateTraceToV2', 'buildTurnExplanation', 'isMechanicalTrace'],
}

function captureTests(tests) {
  const root = new URL('../../../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'sk-p1-capture-'))
  const file = join(dir, 'capture.jsonl')
  try {
    try {
      execFileSync(process.execPath, [
        '--import', new URL('./capture-hooks.mjs', import.meta.url).href,
        '--test', '--test-isolation=none', '--test-reporter=dot',
        ...tests.map((name) => toPath(new URL(`test/${name}.test.mjs`, root))),
      ], {
        cwd: toPath(root),
        env: { ...process.env, ROUTERAI_API_KEY: '', SK_CAPTURE: file, SK_CAPTURE_TARGETS: JSON.stringify(TARGETS), SK_CAPTURE_LIMIT: '160' },
        stdio: ['ignore', 'ignore', 'inherit'],
        maxBuffer: 1 << 30,
      })
    } catch (error) {
      console.warn(`захват: тесты завершились с ошибкой (${error.status ?? error.message})`)
    }
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const testsRoot = new URL('../../../../test/', import.meta.url)
const captureList = CAPTURE_TESTS.filter((name) => existsSync(new URL(`${name}.test.mjs`, testsRoot)))
let captured
if (cacheFile && existsSync(cacheFile)) captured = JSON.parse(readFileSync(cacheFile, 'utf8'))
else {
  captured = captureTests(captureList)
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(captured))
}
for (const record of captured) {
  if (!FUNCTIONS[record.fn]) continue
  call(record.fn, argsFrom(record), { test: record.test })
}
const capturedCount = calls.length

// --- корпус -------------------------------------------------------------------------

const ADMIN = { role: 'admin' }
const PLAYER = { role: 'player' }
function viewersOf(state) {
  const heroes = (Array.isArray(state?.players) ? state.players : []).map((player) => String(player?.id ?? ''))
  const party = (Array.isArray(state?.partyMemberIds) ? state.partyMemberIds : []).map(String)
  const own = heroes[0] ?? 'hero'
  const other = heroes.find((id) => id !== own) ?? party.find((id) => id !== own) ?? 'ally'
  return [
    [ADMIN, own], [ADMIN, ''], [PLAYER, own], [PLAYER, other], [PLAYER, 'stranger'], [null, ''], [undefined, undefined],
  ]
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

const stateDir = join(corpusRoot, 'states')
const categories = {
  combat: (s) => s.mechanics?.combat?.active === true && (s.enemies ?? []).length > 0,
  exploration: (s) => !s.mechanics?.combat?.active && s.scene?.map,
  trade: (s) => (s.merchants ?? []).length > 0,
  captives: (s) => s.captives && Object.keys(s.captives?.records ?? s.captives ?? {}).length > 0,
  scenario: (s) => Boolean(s.scenario_attention || s.campaignConcept?.scenario_id || s.campaignConcept?.scenario),
  fog: (s) => {
    const cells = s.scene?.cells ?? []
    return cells.some((cell) => cell?.revealed === true) && cells.some((cell) => cell?.revealed === false)
  },
  social: (s) => (s.social?.npcs ?? []).length > 0,
}
const PER_CATEGORY = 6
const picked = new Map()
const counts = Object.fromEntries(Object.keys(categories).map((key) => [key, 0]))
if (existsSync(stateDir)) {
  const names = readdirSync(stateDir).sort()
  for (let index = 0; index < names.length; index += 3) {
    if (Object.values(counts).every((count) => count >= PER_CATEGORY)) break
    const file = join(stateDir, names[index])
    if (statSync(file).size > 180_000) continue
    let state
    try { state = readJson(file) } catch { continue }
    for (const [category, test] of Object.entries(categories)) {
      if (counts[category] >= PER_CATEGORY) continue
      let ok = false
      try { ok = Boolean(test(state)) } catch { ok = false }
      if (ok) {
        counts[category] += 1
        picked.set(names[index], state)
        break
      }
    }
  }
}
console.log('корпус: категории', counts)

const states = []
const stateIndex = new Map()
function addState(key, state) {
  if (stateIndex.has(key)) return stateIndex.get(key)
  states.push(state)
  stateIndex.set(key, states.length - 1)
  return states.length - 1
}

const corpus = []
function corpusCase(fn, stateRef, args, path) {
  // В `args` на месте состояния — `null`; Rust подставляет `states[stateRef]` по пути `slot`.
  const record = { fn, state: stateRef, slot: path, ...argsOf(args) }
  const full = argsFrom(record)
  let target = full
  for (const key of path.slice(0, -1)) target = target[key]
  target[path.at(-1)] = JSON.parse(JSON.stringify(states[stateRef]))
  corpus.push({ ...record, ...outcome(() => FUNCTIONS[fn](...full)) })
}

for (const [name, state] of picked) {
  const index = addState(name, state)
  for (const [user, actor] of viewersOf(state)) {
    corpusCase('campaignStateForViewer', index, [null, user, actor], [0])
    corpusCase('viewerState', index, [null, user, actor], [0])
  }
}

// Строки корпуса с событиями: зрители × события.
const rows = []
const seenTypes = new Map()
if (existsSync(corpusRoot)) {
  for (const file of readdirSync(corpusRoot).filter((name) => name.startsWith('corpus-')).sort()) {
    for (const line of readFileSync(join(corpusRoot, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const events = row?.outcome?.events
      if (!Array.isArray(events) || !events.length) continue
      const fresh = events.map((event) => String(event?.event_type)).filter((type) => (seenTypes.get(type) ?? 0) < 3)
      if (!fresh.length) continue
      const stateFile = join(stateDir, `${row.state}.json`)
      if (!existsSync(stateFile) || statSync(stateFile).size > 180_000) continue
      for (const type of fresh) seenTypes.set(type, (seenTypes.get(type) ?? 0) + 1)
      rows.push({ state: row.state, command: row.command, events })
      if (rows.length >= 120) break
    }
    if (rows.length >= 120) break
  }
}
console.log('корпус: строк с событиями', rows.length, 'типов событий', seenTypes.size)
for (const row of rows) {
  const state = readJson(join(stateDir, `${row.state}.json`))
  const index = addState(row.state, state)
  const viewers = viewersOf(state)
  for (const [user, actor] of [viewers[0], viewers[2], viewers[3], viewers[4]]) {
    corpusCase('mechanicsForViewer', index, [row.events, user, actor, null], [3])
    corpusCase('turnExplanationForViewer', index, [{ turn_id: 't', events: row.events, commands: [row.command], rolls: [] }, user, actor, null], [3])
  }
  const [user, actor] = viewers[2]
  corpusCase('turnResultForViewer', index, [{ authoritative_state: null, mechanics: row.events, rolls: [], effects: {} }, user, actor], [0, 'authoritative_state'])
}
const corpusCount = corpus.length

// --- синтетика: закрытые поля ------------------------------------------------------------

function secretState() {
  const cells = []
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 6; x += 1) {
    cells.push({ x, y, type: 'floor', revealed: x < 3, material: 'wood', variant: 2, ...(x >= 3 ? { feature: 'SECRET-fog-feature', secret: 'SECRET-cell' } : { feature: 'torch' }) })
  }
  const map = tm.tacticalMapFromLegacyCells(cells)
  tm.addProp(map, { id: 'seen-table', assetId: 'table', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }],
    interaction: { kind: 'search', verbs: ['inspect'], pointOfInterest: true, detailKey: 'SECRET-detail', rewardKey: 'SECRET-reward' } })
  tm.addProp(map, { id: 'SECRET-hidden-chest', assetId: 'chest', x: 4.5, y: 1.5, footprint: [{ x: 4, y: 1 }] })
  tm.setDoor(map, { id: 'door-hidden', x: 4, y: 2, dir: 'e', state: 'locked', lockDc: 25, keyItemId: 'SECRET-key' })
  tm.setDoor(map, { id: 'door-seen', x: 1, y: 2, dir: 'e', state: 'locked', lockDc: 15, keyItemId: 'SECRET-key-seen' })
  return {
    sessionCode: 'P1-SECRET', partyMemberIds: ['hero', 'ally'], activePlayerId: 'hero', ruleset_id: 'dnd_5e_2014',
    gm_notes: 'SECRET-gm-notes', hidden_information: { plot: 'SECRET-plot' },
    players: [
      { id: 'hero', character: 'Лира', hp: 10, maxHp: 10, x: 0, y: 0, level: 3, characterClass: 'wizard', abilities: { int: 16 }, characterSheet: { class: 'wizard' },
        inventory: [{ id: 'own-stolen', name: 'Кольцо', type: 'other', quantity: 1, origin: 'stolen' }] },
      { id: 'ally', character: 'Борин', hp: 12, maxHp: 12, x: 1, y: 0,
        inventory: [{ id: 'ally-stolen', name: 'Кошель', type: 'other', quantity: 1, origin: 'stolen', gm_notes: 'SECRET-ally-item' }],
        combatActions: [{ id: 'enervation-repeat' }, { id: 'attack' }] },
    ],
    scene: { title: 'Склеп', location: 'Склеп', location_id: 'crypt', mood: 'Тихо', objective: 'Выйти', turn: 3,
      gm_only: { boss: 'SECRET-boss' }, hidden_information: { trap: 'SECRET-trap' }, secrets: ['SECRET-scene-secret'],
      cells, map: tm.serializeTacticalMap(map), levels: [{ index: 1, label: 'SECRET-level-plan' }] },
    locationMaps: { crypt: { cells: [{ x: 0, y: 0, feature: 'SECRET-location-map' }] } },
    locationLevels: { crypt: [{ index: 0, label: 'Вход' }, { index: -1, label: 'Подвал', plan: 'SECRET-level' }] },
    levelEntities: { crypt: { '-1': { enemies: [{ id: 'SECRET-deep', hp: 9871 }] } } },
    adventure: { chapter: 2, currentHook: 'Печать', gm_only: { villain: 'SECRET-villain' }, private_notes: 'SECRET-notes',
      history: [{ chapter: 1, title: 'Начало', outcome: 'Вышли', gm_only: 'SECRET-history' }] },
    worldMap: { name: 'Земли', currentLocationId: 'crypt', seed: 'SECRET-seed',
      locations: [{ id: 'crypt', name: 'Склеп', known: true, visited: true }, { id: 'SECRET-vault', name: 'SECRET-vault-name', known: false }],
      routes: [{ id: 'SECRET-road', from: 'crypt', to: 'SECRET-vault', discovered: false }] },
    merchants: [{ id: 'm1', name: 'Марта', location: 'Склеп', available: true, secret: 'SECRET-merchant',
      stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'gear', quantity: 2, base_price_cp: 1, secret_supplier: 'SECRET-supplier' }],
      pricing: { mode: 'catalog', agent_adjustment_bps: 9872, bargain_dc: 9873 }, bargains: { hero: { success: true, note: 'SECRET-bargain' } } }],
    enemies: [
      { id: 'goblin', name: 'Гоблин', hp: 9874, maxHp: 9875, armor: 9876, speed: 30, stat_block_id: 'SECRET-statblock', x: 2, y: 1, alive: true,
        attack_bonus: 9877, legendary: { uses: 3, actions: [{ id: 'SECRET-legendary' }] }, spellcasting: { dc: 9878, spells: ['SECRET-spell'] } },
      { id: 'shade', name: 'Тень', hp: 5, maxHp: 9, x: 4, y: 1, alive: true, footprint: { version: 1, size: 2 } },
    ],
    npc_world: { vitals: { brom: { hp: 9879 } }, placements: [{ npc_id: 'SECRET-npc', location_id: 'crypt', x: 5, y: 3 }] },
    social: { npcs: [
      { id: 'brom', name: 'Бром', location: 'Склеп', available: true, visibility: 'party', goals: ['SECRET-goal'], beliefs: ['SECRET-belief'], social_dcs: { persuasion: 9871 } },
      { id: 'SECRET-traitor', name: 'SECRET-traitor-name', visibility: 'gm_only' },
    ] },
    world_deeds: { deeds: [{ id: 'SECRET-deed', summary: 'SECRET-deed-summary' }] },
    scenario_attention: { score: 9872, reasons: ['SECRET-attention'] },
    scenario_knight: { head: 'SECRET-knight' },
    law: { level: 9873, crimes: [{ id: 'SECRET-crime' }] },
    dialogues: { flags: ['SECRET-dialogue-flag'] },
    autonomy: { schema_version: 1, pacing: { beat: 2, phase: 'development', tension: 40 }, hooks: ['SECRET-hook'],
      npc_schedules: [{ id: 'SECRET-schedule' }], director_history: ['SECRET-director'], reputations: { guild: 25 } },
    mechanics: {
      enemy_knowledge: { party: { shade: { health: 'exact', note: 'SECRET-knowledge' } } },
      conditions: {
        goblin: [{ id: 'weapon-coated:SECRET-item-instance', rider_source_name: 'SECRET-poison', rider_damage: '1d4' }, 'legendary-action-used:1', 'poisoned'],
        brom: ['pocket-picked:SECRET-thief'],
      },
      temporary_hp: { goblin: 9874, hero: 3 },
      defenses: { goblin: { resistances: ['SECRET-resistance'] } },
      reaction_preferences: { hero: { shield: 'ask' }, ally: { shield: 'SECRET-pref' } },
      active_effects: [{ effect_id: 'SECRET-effect', spell_id: 'SECRET-fog-spell', center: { x: 5, y: 3 }, radius_feet: 5, source_actor: 'goblin' }],
      concentration: { goblin: { effect_id: 'SECRET-effect' }, hero: { effect_id: 'own-effect' } },
      combat: { active: true, round: 1, active_index: 0, combat_instance_id: 'SECRET-combat-instance',
        initiative: [{ actor_id: 'hero', total: 14 }, { actor_id: 'goblin', roll: 9878, modifier: 9879, total: 9877 }],
        action_economy: { goblin: { action: true, loading_weapon_item_ids: ['SECRET-loading'], attack_action_stack: [{ id: 'SECRET-frame', kind: 'attack' }] } },
        reaction_window: { id: 'w1', trigger: 'attack', actor_id: 'hero', source_actor_id: 'goblin', target_id: 'goblin',
          trigger_roll: { kept: 9871, modifier: 9872, total: 15, difficulty: 9873 },
          damage: { applied_amount: 3, hp_before: 9874, hp_after: 9875, raw_amount: 9876, damage_components: [{ item_id: 'SECRET-rider', raw_amount: 9877, applied_amount: 1 }] } } },
    },
    battleLog: [
      { id: 'b1', type: 'attack', actorId: 'hero', targetId: 'goblin', hpBefore: 9874, hpAfter: 9875, roll: { total: 12, difficulty: 9876, hit: true } },
      { id: 'b2', type: 'attack', actorId: 'goblin', targetId: 'hero', roll: { total: 15, modifier: 9877, hit: true }, rollDice: [9878] },
      { id: 'b3', type: 'move', actorId: 'shade', from: { x: 4, y: 1 }, to: { x: 5, y: 1 }, path: [{ x: 5, y: 1 }] },
    ],
    messages: [{ id: 'combat-1', author: 'Система боя', text: 'Лира атакует: 12 против КД 9876 — промах; ОЗ 9874 → 9875.' }],
  }
}

const secretEvents = [
  { event_type: 'DamageApplied', actor_id: 'hero', target_ids: ['goblin'], visibility: 'public', payload: { target_id: 'goblin', applied_amount: 4, hp_before: 9874, hp_after: 9875, raw_amount: 9876, item_resistance_sources: [{ item_id: 'SECRET-res' }] } },
  { event_type: 'AttackResolved', actor_id: 'goblin', target_ids: ['hero'], visibility: 'public', payload: { target_id: 'hero', modifier: 9877, attack_bonus: 9878, action_id: 'SECRET-action', hit: true } },
  { event_type: 'GmSecret', visibility: 'gm_only', payload: { secret: 'SECRET-gm-event' } },
  { event_type: 'NpcSocialProfileUpserted', visibility: 'party', payload: { npc: { id: 'brom', name: 'Бром', visibility: 'party', goals: ['SECRET-goal-event'], social_dcs: { persuasion: 9879 } } } },
  { event_type: 'CourierLetterDelivered', visibility: 'party', payload: { letter_id: 'l1', tone: 'SECRET-tone' } },
  { event_type: 'WantedCleared', visibility: 'party', payload: { level_before: 9871, crime_ids: ['SECRET-crime-event'] } },
  { event_type: 'SpellAreaCreated', actor_id: 'goblin', visibility: 'public', payload: { effect: { effect_id: 'SECRET-area', spell_id: 'SECRET-area-spell', center: { x: 5, y: 3 }, radius_feet: 5 } } },
  { event_type: 'ConditionAdded', actor_id: 'goblin', target_ids: ['goblin'], visibility: 'public', payload: { condition: 'weapon-coated:SECRET-coat', rider_source_name: 'SECRET-dose' } },
  { event_type: 'ConditionAdded', actor_id: 'goblin', target_ids: ['goblin'], visibility: 'public', payload: { condition: 'npc-tactic-used:SECRET-tactic' } },
  { event_type: 'AbilityCheckResolved', actor_id: 'hero', visibility: 'public', payload: { difficulty: 9872, social_check: { check_id: 'c1', npc_id: 'brom', skill: 'persuasion', request_fingerprint: 'SECRET-fp' } } },
  { event_type: 'EncounterOutcomeRecorded', visibility: 'party', payload: { plan: { xp: 9873 }, prepared_reward: { seed: 'SECRET-reward-seed' } } },
  { event_type: 'QuestUpserted', visibility: 'party', payload: { quest: { id: 'q', progress_fact_ids: ['SECRET-fact'] }, proof_fact_ids: ['SECRET-proof'] } },
  { event_type: 'ReactionWindowOpened', actor_id: 'hero', target_ids: ['hero'], visibility: 'public', payload: { id: 'w', trigger: 'attack', actor_id: 'hero', source_actor_id: 'goblin', target_id: 'hero', trigger_roll: { kept: 9874, modifier: 9875, total: 9 } } },
  { event_type: 'SceneAdvanced', visibility: 'public', payload: { library_levels: ['SECRET-library'], scene: { title: 'Новое', gm_only: 'SECRET-next-scene', cells: [{ x: 0, y: 0, revealed: false, feature: 'SECRET-next-feature' }] }, adventure: { gm_only: 'SECRET-adv' }, worldMap: { seed: 'SECRET-wm' } } },
  { event_type: 'LocationMapImported', visibility: 'public', payload: { location_id: 'crypt', levels: [{ index: 0, label: 'Вход', map: { secret: 'SECRET-import-map' } }], relocations: [{ id: 'SECRET-reloc' }] } },
  { event_type: 'NpcHarmed', visibility: 'public', target_ids: ['brom'], payload: { npc_id: 'brom', hp_before: 9876, hp_after: 9877, applied_amount: 2 } },
]

const secretUsers = [[PLAYER, 'hero'], [PLAYER, 'ally'], [PLAYER, 'stranger'], [null, ''], [undefined, undefined]]
const leakStart = calls.length
const base = secretState()
for (const [user, actor] of [...secretUsers, [ADMIN, 'hero']]) {
  const strict = user?.role !== 'admin'
  call('campaignStateForViewer', [base, user, actor], { leaks: true, strict })
  call('viewerState', [base, user, actor], { leaks: true, strict })
  call('mechanicsForViewer', [secretEvents, user, actor, base], { leaks: true, strict })
  call('turnExplanationForViewer', [{ turn_id: 't1', events: secretEvents, rolls: [{ roll_id: 'r1', actor_id: 'goblin', modifier: 9871, total: 7, visibility: 'public' }, { roll_id: 'r2', visibility: 'gm_only', total: 9872 }, { roll_id: 'r3', purpose: 'npc_spell_save:x', total: 1 }],
    commands: [{ type: 'AdvanceScene', actor_id: 'hero', scene_args: { title: 'x', secrets: ['SECRET-scene-args'] } }, { type: 'Attack', actor_id: 'goblin', target_id: 'hero', weapon_id: 'SECRET-weapon' }] }, user, actor, base], { leaks: true, strict })
  call('turnResultForViewer', [{ authoritative_state: base, mechanics: secretEvents, locationMaps: { a: 'SECRET-result-maps' }, debug: { gm_only: 'SECRET-debug' },
    effects: { roll: { roll_id: 'r', actor_id: 'goblin', total: 9, modifier: 9873, label: 'Удар' }, scene: { scene: base.scene, adventure: base.adventure, worldMap: base.worldMap, transition: 'Переход', secret: 'SECRET-transition' } },
    rolls: [{ roll_id: 'a', visibility: 'gm_only', total: 9874 }, { roll_id: 'b', total: 3 }], visible_state_changes: secretEvents }, user, actor], { leaks: true, strict })
  // Закрытые корзины внутри броска и механика не массивом: проходят только через проекцию.
  call('turnResultForViewer', [{ authoritative_state: base, mechanics: { summary: 'Удар', gm_only: { villain: 'SECRET-result-mechanics' } },
    rolls: [{ roll_id: 'c', total: 4, gm_only: { note: 'SECRET-roll-basket' }, hidden_information: { dc: 9875 } }] }, user, actor], { leaks: true, strict })
}
// Варианты знания: точные ОЗ, КД, стат-блок, known_by.
const knowledgeVariants = [
  { party: { goblin: { health: 'exact' } } },
  { party: { goblin: { armor_class: 'exact' } } },
  { party: { goblin: { armor_class: true, speed: 'exact', stat_block: 'exact', hp: true } } },
  { party: { goblin: { health: 'exact', known_by: ['ally'] } } },
  { goblin: { exact_hp: true } },
]
for (const knowledge of knowledgeVariants) {
  const state = { ...secretState(), mechanics: { ...secretState().mechanics, enemy_knowledge: knowledge } }
  for (const [user, actor] of [[PLAYER, 'hero'], [PLAYER, 'ally']]) {
    call('campaignStateForViewer', [state, user, actor], { leaks: true })
    call('mechanicsForViewer', [secretEvents, user, actor, state], { leaks: true })
  }
}
const leakCount = calls.length - leakStart

// --- прогноз удара: фикстура теста-сторожа ----------------------------------------------

function forecastFixture(armor, knowledge = {}) {
  return normalizeCampaignState({
    partyMemberIds: ['hero', 'ally'],
    players: [
      { id: 'hero', character: 'Герой', hp: 12, maxHp: 12, armor: 14, proficiency: 2, abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 }, x: 0, y: 0,
        inventory: [{ id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }] },
      { id: 'ally', character: 'Союзник', hp: 12, maxHp: 12, armor: 14, proficiency: 2, abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 8 }, x: 0, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10, armor, alive: true, x: 1, y: 0 }],
    scene: { turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }, { x: 0, y: 1, type: 'floor', revealed: true }] },
    mechanics: { enemy_knowledge: knowledge, combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }], action_economy: { hero: { action: true } } } },
  })
}
const paralyze = (state) => applyGameEvent(state, { event_id: 'condition:goblin:paralyzed', event_type: 'ConditionAdded', actor_id: 'ally', target_ids: ['goblin'], payload: { condition: 'paralyzed', source_actor: 'ally' } })
const forecastStates = []
for (const armor of [13, 18]) {
  for (const knowledge of [{}, { party: { goblin: { health: 'exact' } } }, { party: { goblin: { armor_class: 'exact' } } }]) {
    forecastStates.push(forecastFixture(armor, knowledge), paralyze(forecastFixture(armor, knowledge)))
  }
}
const forecastStart = calls.length
for (const state of forecastStates) {
  for (const [user, actor] of [[{ role: 'player', id: 'hero' }, 'hero'], [{ role: 'player', id: 'ally' }, 'ally'], [{ role: 'admin', id: 'gm' }, '']]) {
    call('viewerState', [state, user, actor])
  }
}
const forecastCount = calls.length - forecastStart

// --- мусор ---------------------------------------------------------------------------------

const JUNK = [undefined, null, 0, 1, '', 'строка', true, false, [], [1, 'a'], {}, { a: 1 }, { visibility: 'gm_only' }]
const junkStart = calls.length
for (const value of JUNK) {
  for (const user of [ADMIN, PLAYER, null]) {
    call('campaignStateForViewer', [value, user, 'hero'])
    call('mechanicsForViewer', [value, user, 'hero', base])
    call('mechanicsForViewer', [[value], user, 'hero', base])
    call('mechanicsForViewer', [secretEvents.slice(0, 3), user, 'hero', value])
    call('turnExplanationForViewer', [value, user, 'hero', base])
    call('turnResultForViewer', [value, user, 'hero'])
  }
  for (const name of ['sceneTransitionForViewer', 'publicSceneFor', 'publicWorldMapFor', 'publicAdventureFor', 'publicEncounterFor', 'publicTacticalMapFor', 'publicTacticalMapWithHashFor', 'actorAppearancesForViewer', 'redactTrace', 'migrateTraceToV2', 'buildTurnExplanation', 'isMechanicalTrace']) {
    call(name, [value])
  }
  call('publicEnemyFor', [value, base, 'hero'])
  call('publicEnemyFor', [base.enemies[0], value, 'hero'])
  call('publicActorFootprintFor', [value])
  call('publicActorFootprintFor', [{ footprint: { version: 1, size: 2 } }, value])
  call('buildTurnExplanation', [{ turn_id: 't', events: secretEvents }, value])
}
// Мусор внутри состояния: каждое поле верхнего уровня и механики по очереди.
const FIELD_JUNK = [null, 5, 'x', [], [null], {}]
for (const key of ['players', 'enemies', 'actors', 'merchants', 'scene', 'adventure', 'worldMap', 'social', 'battleLog', 'messages', 'autonomy', 'mechanics', 'locationLevels', 'partyMemberIds', 'captives', 'worldMemory']) {
  for (const junk of FIELD_JUNK) {
    const state = { ...secretState(), [key]: junk }
    call('campaignStateForViewer', [state, PLAYER, 'hero'])
    if (int(3) === 0) call('campaignStateForViewer', [state, ADMIN, 'hero'])
  }
}
for (const key of ['conditions', 'temporary_hp', 'defenses', 'active_effects', 'concentration', 'combat', 'resources', 'encounter', 'reaction_preferences']) {
  for (const junk of FIELD_JUNK) {
    const state = secretState()
    state.mechanics[key] = junk
    call('campaignStateForViewer', [state, PLAYER, 'hero'])
  }
}
// Карта: рыхлые слои, частичный реквизит и случайные раскрытия.
for (let round = 0; round < 24; round += 1) {
  const width = 3 + int(8)
  const height = 3 + int(6)
  const map = tm.createTacticalMap({ width, height, seed: `p1-${round}`, fill: { passable: true, revealed: false } })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (int(2) === 0) tm.setCell(map, x, y, { revealed: true, moveCost: 1 + int(2), elevation: int(3) * 5 })
  tm.addZone(map, { id: 'hall', kind: 'interior', label: 'Зал' })
  tm.addZone(map, { id: 'SECRET-zone', kind: 'interior', label: 'SECRET-zone-label' })
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) tm.setCell(map, x, y, { zone: int(2) ? 'hall' : 'SECRET-zone' })
  map.overlays.roomLabels = [{ zoneId: 'hall', label: 'Зал' }, { zoneId: 'SECRET-zone', label: 'SECRET-room-label' }]
  tm.addSpawnPoint(map, { id: `spawn-${round}`, x: int(width), y: int(height), role: 'enemy' })
  tm.addProp(map, { id: `long-${round}`, assetId: 'table_long', x: 0.5, y: 0.5, footprint: [{ x: 0, y: 0 }, { x: 0, y: 1 }], blocksMove: true })
  tm.addProp(map, { id: `chest-${round}`, assetId: 'chest', x: 1.5, y: 1.5, footprint: [{ x: 1, y: 1 }], interaction: { kind: 'search', verbs: ['open', 'inspect'], pointOfInterest: true, detailKey: 'SECRET-map-detail', rewardKey: 'SECRET-map-reward' } })
  tm.setDoor(map, { id: `door-${round}`, x: 1, y: 0, dir: 'e', state: 'locked', lockDc: 12, keyItemId: 'SECRET-door-key',
    ...(int(2) ? { barricade: { material_item_id: 'SECRET-plank', actor_id: 'hero', previous_state: 'closed', side_x: 1, side_y: 0 } } : {}) })
  const serialized = tm.serializeTacticalMap(map)
  call('publicTacticalMapWithHashFor', [serialized], { leaks: true })
  const cells = tm.legacyCellsFromTacticalMap(map)
  call('publicSceneFor', [{ title: 'Карта', cells, map: serialized, map_source: { title: 'T', author: 'A', url: int(2) ? 'https://ok.example/x' : 'javascript:alert(1)' } }, [{ index: 0, label: 'Вход' }, { index: 'x' }]], { leaks: true })
  call('campaignStateForViewer', [{ ...secretState(), scene: { ...secretState().scene, map: serialized, cells } }, ADMIN, 'hero'])
}
const junkCount = calls.length - junkStart

// --- трассы ----------------------------------------------------------------------------------

const traces = [
  { turn_id: 'x', schema_version: 'turn-trace/v1', validated_commands: [{ type: 'Attack', visibility: 'gm_only' }], rolls: [{ total: 1 }], events: [{ event_type: 'A', visibility: 'party', party_ids: ['p'] }], ruling: { visibility: 'gm_only' }, verification_result: { ok: true }, recovery: { from: 'journal' } },
  { schema_version: 'turn-trace/v2', proposal_id: 'p1' }, { schema_version: 3 }, { events: [] }, { rolls: [1] }, { validated_commands: [{}] }, [1, 2],
  { token: 'SECRET-token', nested: { password: 'SECRET-pass', note: 'Bearer abc.def', key: 'sk-abcdefghijklmnopq' }, long: 'я'.repeat(5000), list: Array.from({ length: 250 }, (_, index) => index), env: { PATH: 'x' }, '': { inner: 'x' } },
]
for (const trace of traces) {
  for (const viewer of [undefined, null, { playerId: 'p' }, { role: 'gm' }, { playerId: 'q', partyIds: ['p'] }]) call('buildTurnExplanation', [trace, viewer])
  call('migrateTraceToV2', [trace])
  call('isMechanicalTrace', [trace])
  call('redactTrace', [trace])
}

// Запись трасс: то, что `FileTraceStore.save` кладёт на диск и возвращает.
const saves = []
const traceRoot = mkdtempSync(join(tmpdir(), 'sk-p1-traces-'))
try {
  const store = new ts.FileTraceStore({ rootDir: traceRoot })
  const inputs = [
    { turn_id: 'turn-1', campaign_id: 'ROOM-1', created_at: '2026-07-29T20:00:01.000Z', idempotency_key: 'k', retrieved_rule_ids: ['rule-1'], validated_commands: [{ command_type: 'ApplyDamage' }], rolls: [{ total: 14 }], events: [{ event_type: 'DamageApplied' }], state_version_before: 1, state_version_after: 2, narration_result: { narration: 'Урон.' } },
    { turn_id: 'turn-2', campaign_id: 'ROOM-1', created_at: '2026-07-29T20:00:02.000Z', token_usage: { input: 5 }, prompt_versions: { narrator: 'v13' }, agent_contexts: [{ role: 'narrator', prompt: 'SECRET-prompt' }], intent: { action: 'SECRET-action-text', goal: 'g' }, state_version_before: '7', latency_ms: 'x', recovery: { reason: 'trace_missing_after_commit' }, ruling: { text: 'Bearer abcdef.ghi' } },
    { turn_id: 'turn-3', campaign_id: 'ROOM-2', created_at: '2026-07-29T20:00:03.000Z', events: null, rolls: undefined, apiKey: 'x', email: 'a@b.cd', verification_result: { session: 'S', ok: true } },
  ]
  for (const input of inputs) saves.push({ input: plain(input), out: plain(store.save(input)) })
  for (const input of [{ campaign_id: 'ROOM-1' }, { turn_id: 'bad id', campaign_id: 'ROOM-1' }, { turn_id: 't', campaign_id: '../x' }]) {
    try { store.save({ ...input, created_at: '2026-07-29T20:00:00.000Z' }); saves.push({ input, out_ok: true }) } catch (error) { saves.push({ input, error: error.name, message: error.message }) }
  }
} finally {
  rmSync(traceRoot, { recursive: true, force: true })
}

writeFixture(new URL('./p1.json.gz', import.meta.url), { states, calls, corpus, saves }, { gzip: true })
console.log(`захвачено ${capturedCount}, корпус ${corpusCount}, утечки ${leakCount}, прогноз ${forecastCount}, мусор ${junkCount}, всего ${calls.length + corpus.length}`)
