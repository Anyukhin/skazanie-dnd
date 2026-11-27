import '../../../fixtures-env.mjs'
import './capture-hook.mjs'
// Эталон server/campaign-dialogues.mjs для Rust:
//
//   SK_STORY_CAPTURE=<capture.jsonl> node rust/crates/sk-story/fixtures/gen-campaign-dialogues.mjs [каталог корпуса]
//
// Источники входов:
//
// - настоящие вызовы из тестов JS (`capture-tests.mjs`: campaign-dialogues,
//   dialogue-interaction, clarification-dialogue-memory и сценарные тесты
//   через Rules Engine) — файл `SK_STORY_CAPTURE`;
// - корпус паритета: состояния Асстохана (`tmp/corpus-v1/states`) — варианты,
//   разговоры сцены, флаги, тайны — и записанные события `DialogueOptionChosen`;
// - сотни случайных каталогов, реестров, событий и состояний с мусором старых
//   сохранений.
//
// Состояния урезаются до полей, которые читает модуль (`prepare`): JS
// исполняется на урезанном входе и сверяется с исходом на полном.
import { existsSync, readFileSync } from 'node:fs'

import { D, RUNNERS, STATE_ARGS, MODULE_OF, prepare, stats, fixtureWriter, mulberry32, chooser, viaJson, corpusDir, corpusRecords, corpusStateText, PROTOTYPE_KEYS } from './story-fixtures.mjs'

const writer = fixtureWriter('campaign-dialogues', ['dialogues', 'scenario_attention', 'worldMemory', 'social', 'scenario_knight'])
const random = mulberry32(2026_10_17)
const { int, pick, chance } = chooser(random)

function record(name, args, cap = Infinity) {
  if ((writer.counts.get(name) ?? 0) >= cap) return false
  const prepared = prepare(name, args)
  if (!prepared) return false
  // Реестр разговоров — тоже в таблицу состояний: он повторяется от случая к случаю.
  const stateArgs = STATE_ARGS[name] ?? (['applyDialogueEvent', 'normalizeDialogueState'].includes(name) ? [0] : [])
  return writer.call(name, RUNNERS[name], prepared, { stateArgs, cap, limit: 600 })
}

// ---------------------------------------------------------------------------
// 1. Настоящие вызовы из тестов

const captureFile = process.env.SK_STORY_CAPTURE
const captured = []
if (captureFile && existsSync(captureFile)) {
  for (const line of readFileSync(captureFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const entry = JSON.parse(line)
    if (MODULE_OF[entry.fn] !== 'campaign-dialogues') continue
    const args = entry.args.map((arg) => (arg === '\u0000undefined' ? undefined : arg))
    captured.push([entry.fn, args])
    record(entry.fn, args, 900)
  }
} else {
  console.warn('gen-campaign-dialogues: нет SK_STORY_CAPTURE — эталон без вызовов из тестов')
}
console.log(`из тестов: ${writer.cases.length}`)

// ---------------------------------------------------------------------------
// 2. Каталоги: настоящий (хешем) и сломанные малые

const realCatalog = JSON.parse(readFileSync(new URL('../../../../data/campaign-dialogues-v1.json', import.meta.url), 'utf8'))
record('normalizeDialogues', [realCatalog])
const base = { schema_version: 1, dialogues: [{ id: 'd', scenario_id: 's', npc_id: 'n', greeting: 'Здравствуй.', options: [{ id: 'bye', label: 'Пока.', reply: 'Пока.', ends: true }] }] }
const optionPool = realCatalog.dialogues.flatMap((dialogue) => dialogue.options)
const junk = [undefined, null, '', ' ', 0, 1, 15, 15.5, 4, 31, '15', true, false, [], {}, ['a'], { a: 1 }, 'Constructor', 'constructor', '__proto__', 'toString', 'Ok-id', 'ok-id', 'id with space', 'я', 'a'.repeat(81), 'a'.repeat(80), '  много   пробелов  ', 'persuasion', 'stealth', 'turn', 'burn', 'toban', 'ReceiveScenarioPurse', 'KillEveryone']
const optionKeys = ['id', 'label', 'reply', 'check', 'success', 'failure', 'action', 'group', 'requires', 'sets', 'reveal', 'reveal_topic', 'ends']
function mutateOption(option) {
  const copy = JSON.parse(JSON.stringify(option))
  for (let i = int(1, 3); i > 0; i -= 1) {
    const key = pick(optionKeys)
    const roll = random()
    if (roll < 0.25) delete copy[key]
    else if (roll < 0.55) copy[key] = pick(junk)
    else if (key === 'check') copy.check = { skill: pick(junk), dc: pick(junk) }
    else if (key === 'action') copy.action = { command_type: pick(['ReceiveScenarioPurse', 'ChooseScenarioArmoryItem', 'ReturnKnightHead', 'ReleaseCursedKnight', 'ResolveScenarioInformant', 'NegotiateScenarioTreaty', pick(junk)]), ...(chance(0.5) ? { catalog_id: pick(junk) } : {}), ...(chance(0.5) ? { informant_id: pick(['toban', 'lars', pick(junk)]) } : {}), ...(chance(0.5) ? { choice: pick(['expose', 'release', 'turn', pick(junk)]) } : {}) }
    else if (key === 'requires') copy.requires = { [pick(['flags', 'flags_none', 'clues_any', 'clues_all'])]: chance(0.5) ? [pick(['a-flag', 'bye', pick(junk)])] : pick(junk) }
    else if (key === 'success' || key === 'failure') copy[key] = chance(0.7) ? { reply: pick(['Да.', '', pick(junk)]), ...(chance(0.3) ? { reveal: pick(junk) } : {}), ...(chance(0.3) ? { reveal_topic: pick(junk) } : {}), ...(chance(0.3) ? { sets: [pick(['a-flag', pick(junk)])] } : {}) } : pick(junk)
    else copy[key] = pick(junk)
  }
  return copy
}
for (let i = 0; i < 900; i += 1) {
  const options = Array.from({ length: int(1, 4) }, () => (chance(0.6) ? mutateOption(pick(optionPool)) : JSON.parse(JSON.stringify(pick(optionPool)))))
  const dialogue = { ...base.dialogues[0], options }
  if (chance(0.2)) dialogue[pick(['id', 'scenario_id', 'npc_id', 'greeting', 'options'])] = pick(junk)
  const dialogues = chance(0.15) ? [dialogue, { ...dialogue, id: pick(['d', 'd2']) }] : [dialogue]
  if (chance(0.1)) dialogues.push({ ...base.dialogues[0], id: 'flags', options: [{ id: 'set', label: 'Ставлю.', reply: 'Да.', sets: ['a-flag'] }] })
  const raw = chance(0.05) ? pick(junk) : { schema_version: chance(0.05) ? pick(junk) : 1, dialogues: chance(0.03) ? pick(junk) : dialogues }
  record('normalizeDialogues', [raw])
}

// ---------------------------------------------------------------------------
// 3. Действия и строка проверки

for (const option of D.DIALOGUES.flatMap((dialogue) => dialogue.options)) if (option.action) record('dialogueActionChecks', [option.action])
for (const commandType of ['ReceiveScenarioPurse', 'ReleaseCursedKnight', 'NegotiateScenarioTreaty', 'ResolveScenarioInformant', 'ReturnKnightHead', '']) {
  for (const choice of [undefined, 'turn', 'expose', 'release']) record('dialogueActionChecks', [{ command_type: commandType, ...(choice ? { choice } : {}) }])
}
const skills = ['persuasion', 'deception', 'intimidation', 'insight', 'history', 'religion', 'arcana', 'performance', 'medicine', 'stealth', '', ...PROTOTYPE_KEYS]
for (const skill of skills) {
  for (const success of [true, false, 1, undefined]) {
    for (const total of [19, 0, -3, 7.5, '12', 'abc', undefined, null, Infinity]) record('dialogueCheckLine', [{ skill, success, total }])
  }
}
for (const check of [undefined, null, false, 0, '', 'x', [], {}, { skill: '  persuasion  ' }, { skill: 'a'.repeat(60) }]) record('dialogueCheckLine', [check])

// ---------------------------------------------------------------------------
// 4. Реестр разговоров: нормализация и свёртка событий

const heroes = ['hero', 'talk-hero', 'talk-ally', ' hero ', '', 'constructor']
const optionIds = [...new Set(D.DIALOGUES.flatMap((dialogue) => dialogue.options.map((option) => option.id)))]
const dialogueIds = D.DIALOGUES.map((dialogue) => dialogue.id)
const flagPool = [...new Set(D.DIALOGUES.flatMap((dialogue) => dialogue.options.flatMap((option) => [...option.success.sets, ...(option.failure?.sets ?? [])])))]
function randomRegistry() {
  if (chance(0.08)) return pick(junk)
  const registry = {}
  for (let i = int(0, 4); i > 0; i -= 1) {
    const id = chance(0.85) ? pick(dialogueIds) : pick(['', ' x ', '0', '12', 'constructor', '__proto__', pick(junk)])
    registry[String(id)] = chance(0.08) ? pick(junk) : {
      flags: chance(0.85) ? Array.from({ length: int(0, 4) }, () => (chance(0.85) ? pick(flagPool) : pick(junk))) : pick(junk),
      chosen: chance(0.85) ? Object.fromEntries(Array.from({ length: int(0, 3) }, () => [chance(0.9) ? pick(optionIds) : String(pick(junk)), chance(0.85) ? Array.from({ length: int(0, 3) }, () => pick(heroes)) : pick(junk)])) : pick(junk),
      attempted: chance(0.85) ? Object.fromEntries(Array.from({ length: int(0, 2) }, () => [pick(optionIds), Array.from({ length: int(0, 2) }, () => pick(heroes))])) : pick(junk),
      ...(chance(0.6) ? { granted: chance(0.9) ? Array.from({ length: int(0, 2) }, () => `fact:secret:scenario:astohan-dragon-hunt:${pick(['ash-gate', 'lomar-ward', 'x'])}`) : pick(junk) } : {}),
    }
  }
  return registry
}
function randomEvent() {
  if (chance(0.05)) return pick(junk)
  return {
    event_type: chance(0.9) ? 'DialogueOptionChosen' : pick(['NpcConversationRecorded', '', pick(junk)]),
    payload: chance(0.05) ? pick(junk) : {
      dialogue_id: chance(0.9) ? pick(dialogueIds) : pick(['constructor', '__proto__', ' x ', pick(junk)]),
      option_id: chance(0.9) ? pick(optionIds) : pick(['constructor', '__proto__', pick(junk)]),
      hero_id: chance(0.9) ? pick(heroes) : pick(junk),
      ...(chance(0.5) ? { sets: chance(0.9) ? Array.from({ length: int(0, 3) }, () => (chance(0.8) ? pick(flagPool) : pick(junk))) : pick(junk) } : {}),
      ...(chance(0.4) ? { check: pick([true, false, { skill: 'insight' }, 0, 1]) } : {}),
      ...(chance(0.3) ? { granted_fact_id: pick(['fact:secret:scenario:astohan-dragon-hunt:lomar-ward', '', pick(junk)]) } : {}),
    },
  }
}
for (let i = 0; i < 700; i += 1) record('normalizeDialogueState', [randomRegistry()])
for (let i = 0; i < 1200; i += 1) {
  let registry = randomRegistry()
  for (let step = int(1, 3); step > 0; step -= 1) {
    const event = randomEvent()
    record('applyDialogueEvent', [registry, event], 2000)
    try { registry = D.applyDialogueEvent(viaJson(registry), viaJson(event)) } catch { break }
  }
}

// ---------------------------------------------------------------------------
// 5. Состояния: корпус и мутации

function* corpusStates(dir) {
  const seenHashes = new Set()
  for (const entry of corpusRecords(dir)) {
    if (seenHashes.has(entry.state)) continue
    seenHashes.add(entry.state)
    const text = corpusStateText(dir, entry.state)
    if (!text || !text.includes('"astohan-dragon-hunt"')) continue
    yield { state: JSON.parse(text), entry }
  }
}

const npcIds = [...new Set(D.DIALOGUES.map((dialogue) => dialogue.npc_id))]
const outcomes = D.DIALOGUES.flatMap((dialogue) => dialogue.options.flatMap((option) => [option.success, option.failure].filter(Boolean)))
const baseStates = []
function exercise(state, { full = false } = {}) {
  const party = Array.isArray(state.partyMemberIds) ? state.partyMemberIds : (state.players ?? []).map((player) => player.id)
  const viewers = [...new Set([...party.slice(0, 2), ''])]
  for (const viewer of viewers) record('sceneDialoguesForViewer', [state, { playerId: viewer }], 1500)
  record('sceneDialoguesForViewer', [state, undefined], 1500)
  for (const npcId of full ? npcIds : [pick(npcIds), pick(npcIds)]) {
    for (const hero of viewers.slice(0, full ? 2 : 1)) record('dialogueOptionsFor', [state, npcId, hero], 3000)
  }
  record('dialogueFlags', [state], 600)
  record('dialogueGrantedFactIds', [state], 600)
  record('dialogueFor', [state, pick(npcIds)], 600)
  record('dialogueProgress', [state, pick(dialogueIds)], 600)
  record('normalizeDialogueState', [state.dialogues], 1200)
  for (const result of full ? outcomes : [pick(outcomes), pick(outcomes)]) record('dialogueRevealFactId', [state, result], 2500)
  const dialogue = pick(D.DIALOGUES)
  for (const option of full ? dialogue.options : [pick(dialogue.options)]) record('dialogueOptionUnlocked', [state, dialogue.id, option.id], 2500)
}

const dir = corpusDir(process.argv[2])
if (dir) {
  let count = 0
  for (const { state, entry } of corpusStates(dir)) {
    count += 1
    if (count <= 110) {
      exercise(state, { full: count <= 15 })
      if (baseStates.length < 20 && count % 6 === 1) baseStates.push(state)
    }
    for (const event of entry.outcome?.events ?? []) {
      if (event?.event_type === 'DialogueOptionChosen') record('applyDialogueEvent', [state.dialogues, event], 2600)
    }
    if (count >= 565) break
  }
  console.log(`корпус: состояний Асстохана ${count}`)
} else {
  console.warn('gen-campaign-dialogues: корпуса нет')
}
for (const [fn, args] of captured) if (STATE_ARGS[fn]?.length && baseStates.length < 60 && args[0]?.campaignConcept) baseStates.push(args[0])

// Мутации: флаги, тайны, рыцарь, осведомители, договор, мусор.
const clueIds = ['ash-gate', 'camp-gedrik', 'lomar-ward', 'chapel-riddle', 'toban-mill', 'x']
function mutateState(source) {
  const state = JSON.parse(JSON.stringify(source))
  for (let i = int(1, 4); i > 0; i -= 1) {
    const roll = int(0, 11)
    if (roll === 0) state.dialogues = randomRegistry()
    else if (roll === 1) {
      state.worldMemory = state.worldMemory ?? {}
      state.worldMemory.facts = [...(Array.isArray(state.worldMemory.facts) ? state.worldMemory.facts : []), { id: `fact-found-${int(0, 99)}`, predicate: 'discovery', supersedes_fact_id: `fact:secret:scenario:astohan-dragon-hunt:${pick(clueIds)}` }]
    } else if (roll === 2) {
      state.worldMemory = state.worldMemory ?? {}
      state.worldMemory.knowledge_revealed = [...(Array.isArray(state.worldMemory.knowledge_revealed) ? state.worldMemory.knowledge_revealed : []), { fact_id: chance(0.7) ? `fact:secret:scenario:astohan-dragon-hunt:${pick(clueIds)}` : pick(junk) }]
    } else if (roll === 3) state.scenario_knight = chance(0.8) ? { head_returned: chance(0.5), released: chance(0.2), attempts: chance(0.5) ? [`${pick(heroes)}:${int(0, 3)}`] : [] } : pick(junk)
    else if (roll === 4) state.scenario_attention = { ...(state.scenario_attention ?? {}), informants: chance(0.5) ? { [pick(['toban', 'lars', 'mirel'])]: pick(['expose', 'release', 'turn']) } : {}, informant_turn_failed: chance(0.5) ? [pick(['toban', 'lars'])] : pick([[], 'toban', null]), purse_paid: chance(0.4) ? [pick(heroes)] : [], armory_taken: chance(0.4) ? [pick(heroes)] : pick([[], 'hero']), treaty: chance(0.5) ? { attempts: [pick(heroes)], concluded: chance(0.2) } : undefined }
    else if (roll === 5) state.mechanics = { ...(state.mechanics ?? {}), combat: { active: chance(0.3) }, world_time: { elapsed_minutes: int(0, 4000) } }
    else if (roll === 6 && Array.isArray(state.social?.npcs) && state.social.npcs.length) {
      const npc = pick(state.social.npcs)
      if (npc && typeof npc === 'object') npc[pick(['available', 'location', 'visibility', 'reveal_on_presence'])] = pick([false, true, 'party', 'hidden', state.scene?.location, 'Где-то', null])
    } else if (roll === 7) state.npc_world = { vitals: { [pick(npcIds)]: { alive: chance(0.5) } } }
    else if (roll === 8) state.scene = { ...(state.scene ?? {}), location: pick([state.scene?.location, 'Штормберг', '  ШТОРМБЕРГ  ', '', pick(junk)]) }
    else if (roll === 9) state.campaignConcept = pick([state.campaignConcept, { ...(state.campaignConcept ?? {}), campaign_mode: 'persistent' }, null])
    else if (roll === 10 && Array.isArray(state.worldMemory?.facts)) state.worldMemory.facts.push({ id: `gm-${int(0, 9)}`, predicate: 'gm_secret', object: pick(['{"topic":"x"}', '{}', 'not json', 5, null, { topic: 'x' }]) })
    else if (roll === 11) state.social = chance(0.5) ? { npcs: [...(state.social?.npcs ?? []), pick(junk), { id: pick(npcIds), location: state.scene?.location }] } : pick(junk)
  }
  return state
}
for (let i = 0; i < 320 && baseStates.length; i += 1) exercise(mutateState(pick(baseStates)), { full: i % 20 === 0 })

writer.write(new URL('./campaign-dialogues.json.gz', import.meta.url))
console.log(`урезано ${stats.stripped}, расширено ${stats.widened}, отброшено ${stats.dropped}`)
