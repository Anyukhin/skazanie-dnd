import '../../../fixtures-env.mjs'
// Эталоны костей и пауз `rules-engine.mjs` (12263–12553) для `sk-rules`:
//
// 1. `recordingDiceService` над `DiceService` с последовательностью значений:
//    сценарии вызовов `roll`, `rollD20`, `rollCheck` с мусорными аргументами
//    (порядок ключей места вызова, приведения, ошибки) — итоги и стенограмма.
// 2. `replayDiceService`: точный повтор, расхождение метода, лишние броски
//    (с `allowAdditionalRolls` и без), подмена Несгибаемого (переброс и
//    готовый итог), подмена не d20, испорченные записи.
// 3. `rollIndomitableReplacement`, `failedSavingThrowEvent`.
// 4. Четыре класса пауз: имя, текст, команда и событие окна.
// 5. Выборы Сопротивления и реакций из контекста, `pendingExecutionFor`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-dice-pause.mjs
import { writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const root = new URL('../../../../', import.meta.url)
const E = await loadOpenCopy()
const { DiceService, SequenceDiceRng } = await import(new URL('server/dice-service.mjs', root).href)
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

let seed = 0xd1ce0001
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]

function service(values, prefix = 'roll') {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `${prefix}-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}
function errorOf(error) {
  return { name: error.name, code: error.code ?? null }
}
function perform(dice, call) {
  try {
    const result = call.method === 'roll' ? dice.roll(...call.args) : dice[call.method](call.args[0])
    return { result: json(result) }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

// ---------- вызовы ----------
const expressions = ['1d6', '2d8+3', '1d20-2', ' 3 D 4 ', 'd12', '1d1', 'кость', '', '101d6', '1d6+99999', 7]
const purposes = [undefined, null, '', 'damage', 'урон:огонь', 0, 'x'.repeat(100)]
const actors = [undefined, null, 'hero', 5, '', 'a'.repeat(130)]
const visibilities = [undefined, null, 'public', 'party', 'gm_only', 'secret', 5]
function randomRollCall() {
  const args = [pick(expressions)]
  const length = Math.floor(random() * 4)
  if (length >= 1) args.push(pick(purposes))
  if (length >= 2) args.push(pick(actors))
  if (length >= 3) args.push(pick(visibilities))
  return { method: 'roll', args: json(args.map((value) => value === undefined ? null : value)) }
}
const modifiers = [undefined, 0, 3, -2, '4', 1.5, 101, -100, null, true, 'x']
function randomOptions(check) {
  const options = {}
  const keys = ['modifier', 'purpose', 'actorId', 'advantage', 'disadvantage', 'visibility', ...(check ? ['difficulty'] : []), 'extra']
  for (const key of keys.sort(() => random() - 0.5)) {
    if (random() < 0.4) continue
    if (key === 'modifier') options.modifier = pick(modifiers)
    else if (key === 'purpose') options.purpose = pick(purposes)
    else if (key === 'actorId') options.actorId = pick(actors)
    else if (key === 'advantage' || key === 'disadvantage') options[key] = pick([true, false, 1, 0, 'yes', null])
    else if (key === 'visibility') options.visibility = pick(visibilities)
    else if (key === 'difficulty') options.difficulty = pick([undefined, 10, 15, '12', 0, 100, 101, -1, null, 2.5])
    else options.extra = pick([1, 'x', { a: 1 }])
  }
  return json(options)
}
function randomCall() {
  const roll = random()
  if (roll < 0.4) return randomRollCall()
  if (roll < 0.7) return { method: 'rollD20', args: [randomOptions(false)] }
  return { method: 'rollCheck', args: [randomOptions(true)] }
}
const values = () => Array.from({ length: 40 }, () => 1 + Math.floor(random() * 20))

const recording = []
for (let index = 0; index < 120; index += 1) {
  const sequence = random() < 0.1 ? [3, 4] : values()
  const calls = Array.from({ length: 1 + Math.floor(random() * 6) }, randomCall)
  const transcript = []
  const dice = E.recordingDiceService(service(sequence), transcript)
  const results = calls.map((call) => perform(dice, call))
  recording.push({ values: sequence, calls, results, transcript: json(transcript) })
}

// ---------- повтор ----------
const replay = []
for (const [sourceIndex, source] of recording.entries()) {
  if (!source.transcript.length) continue
  const okCalls = source.calls.filter((_, index) => source.results[index].result)
  const transcript = source.transcript
  const d20 = transcript.filter((entry) => entry.method !== 'roll')
  const variants = [
    { label: 'exact', calls: okCalls },
    { label: 'extra', calls: [...okCalls, randomCall()], allow: false },
    { label: 'extra-allowed', calls: [...okCalls, randomCall(), randomCall()], allow: true },
    { label: 'swapped', calls: okCalls.map((call) => ({ ...call, method: call.method === 'roll' ? 'rollD20' : 'roll', args: call.method === 'roll' ? [{}] : ['1d6'] })) },
  ]
  if (d20.length) {
    const target = pick(d20)
    variants.push({ label: 'indomitable-reroll', calls: okCalls, replacements: { roll_id: target.result.roll_id, bonus: pick([0, 3, '4', -2, 'x']) } })
    variants.push({ label: 'indomitable-result', calls: okCalls, replacements: [{ roll_id: target.result.roll_id, bonus: 2, result: { roll_id: 'ready', total: 19, kept: 18 } }, { roll_id: 'other' }] })
  }
  const rolls = transcript.filter((entry) => entry.method === 'roll')
  if (rolls.length) variants.push({ label: 'indomitable-not-d20', calls: okCalls, replacements: { roll_id: rolls[0].result.roll_id, bonus: 1 } })
  for (const variant of variants) {
    const base = service(values(), 'base')
    const dice = E.replayDiceService(base, transcript, variant.replacements ?? null, { allowAdditionalRolls: variant.allow === true })
    const results = []
    for (const call of variant.calls) {
      const outcome = perform(dice, call)
      results.push(outcome)
      if (outcome.error) break
    }
    replay.push({ label: variant.label, source: sourceIndex, base_values: base.rng.values, replacements: variant.replacements ?? null, allow: variant.allow === true, calls: variant.calls, results })
  }
}
for (const transcript of [[null], [{ method: 'roll' }], [{ method: 'roll', result: null }], [{ method: 'roll', result: 5 }], [{ method: 'rollD20', result: { roll_id: 'r', total: 3 } }]]) {
  const base = service([5, 6, 7], 'base')
  const dice = E.replayDiceService(base, transcript, { roll_id: 'r', bonus: 2 }, {})
  const call = transcript[0]?.method === 'rollD20' ? { method: 'rollD20', args: [{ modifier: 1 }] } : { method: 'roll', args: ['1d6'] }
  replay.push({ label: 'broken', transcript, base_values: [5, 6, 7], replacements: { roll_id: 'r', bonus: 2 }, allow: false, calls: [call], results: [perform(dice, call)] })
}

const indomitable = []
for (const [sourceIndex, source] of recording.entries()) {
  if (!source.transcript.length || indomitable.length >= 180) continue
  const entry = pick(source.transcript)
  for (const rollId of [entry.result.roll_id, 'missing', null]) {
    const base = service(values(), 'reroll')
    const bonus = pick([3, '2', -1, 'x', undefined])
    try {
      indomitable.push({ source: sourceIndex, roll_id: rollId, bonus: bonus ?? null, base_values: base.rng.values, result: json(E.rollIndomitableReplacement(base, source.transcript, rollId, bonus)) })
    } catch (error) {
      indomitable.push({ source: sourceIndex, roll_id: rollId, bonus: bonus ?? null, base_values: base.rng.values, error: errorOf(error) })
    }
  }
}

const savingEvents = []
for (const eventType of ['SpellSavingThrowResolved', 'ConcentrationSavingThrowResolved', 'SavingThrowResolved', 'DeathSavingThrowRolled', 'AttackResolved']) {
  for (const payload of [undefined, {}, { roll_id: 'r' }, { roll_id: 'r', saved: false }, { roll_id: 'r', saved: true }, { roll_id: 'r', success: false }, { roll_id: 'r', success: 0 },
    { roll_id: 'r', saved: false, willing_target: true }, { roll_id: 'r', saved: false, no_initial_save: true }, { roll_id: '', saved: false }]) {
    const event = { event_type: eventType, ...(payload ? { payload } : {}) }
    savingEvents.push({ event, expected: E.failedSavingThrowEvent(event) })
  }
}

// ---------- паузы ----------
const commands = [
  { command_id: 'cmd-1', command_type: 'CastSpell', actor_id: 'mage', target_ids: ['goblin'], source_rule_ids: ['srd_5_2_1:combat:turn-economy'], ruleset_id: 'srd_5_2_1', house_rule_id: null, ruling_id: null, visibility: 'public' },
  { command_id: 'cmd-2', command_type: 'MakeAttack', actor_id: 'goblin', target_ids: ['hero'], source_rule_ids: [], ruleset_id: 'dnd_5e_2014', campaign_id: 'C' },
  { command_id: 7, command_type: 'UseMonsterAction', actor_id: null, target_ids: [], source_rule_ids: ['dnd_5e_2014:combat:damage'], ruleset_id: 'dnd_5e_2014' },
]
const transcripts = [[], recording.find((entry) => entry.transcript.length > 1)?.transcript ?? []]
const choiceObjects = [undefined, {}, { 'save:a': true }, { 'save:b': { mode: 'after-use', note: 1 }, 'save:c': null, 2: [1, 2], 'save:d': 'yes' }]
const conditions = [null, undefined, { id: 'resistance-d4' }, { id: 'resistance-d4', effect_id: 'eff', source_actor: 'cleric' }, { effect_id: 5 }]
const targets = ['hero', 5, null]
const pauses = []
for (const command of commands) for (const condition of conditions) {
  const args = {
    command, targetId: pick(targets), condition, saveKey: pick(['save:a', 3, 'spell:x:dex']), diceTranscript: pick(transcripts),
    choices: pick(choiceObjects), elementalChoices: pick(choiceObjects), protectiveChoices: pick(choiceObjects),
  }
  for (const phase of [undefined, 'before-roll', 'after-roll']) {
    const pause = new E.ResistanceChoicePause(phase ? { ...args, phase } : args)
    pauses.push({ kind: 'ResistanceChoicePause', args: json({ ...args, ...(phase ? { phase } : {}) }), name: pause.name, message: pause.message, command: json(pause.command), window_event: json(pause.windowEvent) })
  }
  for (const save of [undefined, { roll_id: 'r-1', kept: 12, modifier: 2, total: 14 }, { natural_roll: 9, total: '11' }]) {
    for (const options of [undefined, { ability: 'dex', difficulty: 15 }, { ability: 5, difficulty: null }, { difficulty: '13' }]) {
      const pause = new E.ResistanceAfterRollPause({ ...args, save, options })
      pauses.push({ kind: 'ResistanceAfterRollPause', args: json(args), save: save ?? null, options: options ?? null, name: pause.name, message: pause.message, command: json(pause.command), window_event: json(pause.windowEvent) })
    }
  }
}
const actionOptions = [[{ id: 'cast:absorb-elements', name: 'Поглощение стихий' }, { id: 'decline-reaction' }], [], [{ name: 'без id' }]]
for (const command of commands) for (let index = 0; index < 6; index += 1) {
  const args = {
    command, targetId: pick(targets), damage: pick([undefined, null, { amount: 7, damage_type: 'fire' }, 0]), damageKey: pick(['area:1:hero', 4]),
    actionOptions: pick(actionOptions), diceTranscript: pick(transcripts), choices: pick(choiceObjects), resistanceChoices: pick(choiceObjects), protectiveChoices: pick(choiceObjects),
  }
  const pause = new E.ElementalDamageReactionPause(args)
  pauses.push({ kind: 'ElementalDamageReactionPause', args: json({ ...args, damage: args.damage === undefined ? '__undefined__' : args.damage }), name: pause.name, message: pause.message, command: json(pause.command), window_event: json(pause.windowEvent) })
}
for (const command of commands) for (let index = 0; index < 10; index += 1) {
  const args = {
    command, targetId: pick(targets), reactorId: pick([undefined, null, 'hero', 'paladin', 6]), sourceActorId: pick([undefined, null, 'goblin', 9]),
    trigger: pick(['attack-hit', 'spell-damage', 3]), kind: pick(['shield', 'parry', 'protection']), decisionKey: pick([undefined, null, 'shield:hero:1', 0]),
    actionOptions: pick(actionOptions), triggerRoll: pick([undefined, null, { roll_id: 'a', total: 17 }]), damage: pick([undefined, null, { amount: 4 }, 0]),
    diceTranscript: pick(transcripts), choices: pick(choiceObjects), resistanceChoices: pick(choiceObjects), elementalChoices: pick(choiceObjects),
  }
  const pause = new E.ProtectiveReactionPause(args)
  const stored = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  pauses.push({ kind: 'ProtectiveReactionPause', args: json(stored), name: pause.name, message: pause.message, command: json(pause.command), window_event: json(pause.windowEvent) })
}

// ---------- выборы из контекста ----------
const modes = [undefined, null, true, false, 'before-roll', 'decline', 'after', 'after-use', 'after-skip', 'other', 1, {}, { mode: 'after' }, { use: true }, { use: 'yes' }, { mode: 5 }, [], ['before-roll']]
const choiceModes = modes.map((value) => ({ value: value === undefined ? '__undefined__' : value, expected: E.resistanceChoiceMode(value) }))
const contexts = [
  {}, { resistanceChoices: null }, { resistanceChoices: 'x' }, { resistanceChoices: [] },
  { resistanceChoices: [{ save_key: 'a', use: true }, { saveKey: 'b', mode: 'after' }, { save_key: '' }, null, 'before-roll', { save_key: 'a', mode: 'decline' }, { save_key: 3 }] },
  { resistanceChoices: { a: true, b: 'after-use', '': true, 2: { mode: 'before-roll' }, c: null } },
  { elementalDamageChoices: [{ damage_key: 'k', use: true }, { damage_key: '' }, { damage_key: 'k', use: 1 }, null], protectiveReactionChoices: { p: true, q: { use: false, extra: 2 }, '': 'x', r: [1] } },
  { elementalDamageChoices: { e: false, f: { use: true } }, protectiveReactionChoices: [{ key: 'p', use: true }, { key: 7 }, 'z'] },
]
const fromContext = contexts.map((context) => {
  const resistance = E.resistanceChoicesFromContext(context)
  // Выборы реакций — выражение `resolveCommandInternal` (13077–13089) дословно.
  const elemental = new Map(
    Array.isArray(context.elementalDamageChoices)
      ? context.elementalDamageChoices.map((entry) => [String(entry?.damage_key ?? ''), { ...(entry ?? {}), use: entry?.use === true }]).filter(([key]) => key)
      : Object.entries(context.elementalDamageChoices && typeof context.elementalDamageChoices === 'object' ? context.elementalDamageChoices : {})
        .map(([key, choice]) => [String(key), choice && typeof choice === 'object' ? choice : { use: choice === true }]),
  )
  const protective = new Map(
    Array.isArray(context.protectiveReactionChoices)
      ? context.protectiveReactionChoices.map((entry) => [String(entry?.key ?? ''), { ...(entry ?? {}), use: entry?.use === true }]).filter(([key]) => key)
      : Object.entries(context.protectiveReactionChoices && typeof context.protectiveReactionChoices === 'object' ? context.protectiveReactionChoices : {})
        .map(([key, choice]) => [String(key), choice && typeof choice === 'object' ? choice : { use: choice === true }]),
  )
  return {
    context,
    resistance: json([...resistance.entries()]),
    resistance_object: json(E.resistanceChoicesObject(resistance)),
    elemental: json([...elemental.entries()]),
    protective: json([...protective.entries()]),
  }
})
const conditionStates = [{}, { mechanics: { conditions: { hero: [{ id: 'bless-d4' }, { id: 'resistance-d4', effect_id: 'e' }], foe: ['resistance-d4'], odd: [null] } } }]
const resistanceConditions = conditionStates.flatMap((state) => ['hero', 'foe', 'odd', 'none'].map((id) => ({ state, id, expected: json(E.resistanceConditionFor(state, id)) })))
const pendingExecution = [{}, { readiedRelease: true }, { additionalBeam: 'yes', reactionResolution: true }, { finalizeFleeActorId: 'goblin' }, { finalizeFleeActorId: 0 }, { finalizeFleeActorId: 5, readiedRelease: 1 }]
  .map((context) => ({ context, expected: E.pendingExecutionFor(context) }))

const out = { source_sha256: sourceSha256(), recording, replay, indomitable, saving_events: savingEvents, pauses, choice_modes: choiceModes, from_context: fromContext, resistance_conditions: resistanceConditions, pending_execution: pendingExecution }
writeFileSync(new URL('dice-pause.json', import.meta.url), `${JSON.stringify(out)}\n`)
console.log('dice-pause.json:', Object.entries(out).filter(([, value]) => Array.isArray(value)).map(([key, list]) => `${key} ${list.length}`).join(', '))
