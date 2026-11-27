// Level-7 стенд. Проверяет class/level/slot gate, выборы, исполнение и replay.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyGameEvent, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { canonicalCombatSpellFor, combatSpellFor, spellSelectionRulesFor, spellSlotMaximumsFor } from '../server/combat-spells.mjs'
import { spellRuntimeFixture } from './spell-runtime-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'

const LEVEL = 7
const RULESET = 'dnd_5e_2014'
const CLASSES = ['wizard', 'cleric', 'druid', 'sorcerer', 'bard', 'warlock', 'paladin', 'ranger']
const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url))).spells
const outputDir = resolve('tmp/astohan-spell-review')
mkdirSync(outputDir, { recursive: true })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function dice(seed, high) {
  let n = 0
  return new DiceService({ rng: { randint: (min, max) => high ? max : min }, idFactory: () => 'level7:' + seed + ':' + (++n), now: () => '2026-11-22T12:00:00.000Z' })
}

function fixture(id, characterClass) {
  const base = spellRuntimeFixture(id)
  const state = structuredClone(base.state)
  const caster = state.players.find(actor => actor.id === 'caster')
  caster.characterClass = characterClass
  caster.role = characterClass
  caster.level = LEVEL
  caster.proficiency = 3
  caster.knownSpellIds = [id]
  caster.preparedSpellIds = [id]
  delete caster.creationSpellGrants
  delete caster.speciesBenefits
  const slots = spellSlotMaximumsFor(caster)
  state.mechanics.resources.caster = Object.fromEntries(Object.entries(slots).map(([resource, maximum]) => [resource, { current: maximum, max: maximum }]))
  const profile = canonicalCombatSpellFor(id, { rulesetId: RULESET })
  const runtime = combatSpellFor(caster, id, { rulesetId: RULESET })
  if (runtime?.slotResource && state.mechanics.combat.reaction_window) {
    state.mechanics.combat.reaction_window.action_options = [{ id: 'cast:' + id, resource: runtime.slotResource, slot_level: runtime.slotLevel ?? profile.level }]
  }
  return { state, caster, profile, runtime, command: { ...base.command, command_id: 'level7:' + characterClass + ':' + id }, rules: spellSelectionRulesFor(caster) }
}

export function level7SpellFixture(id, characterClass) {
  return fixture(id, characterClass)
}

export function buildLevel7SpellCommand(base, option) {
  const command = { ...base.command, target_ids: base.command.target_ids ? [...base.command.target_ids] : undefined }
  if (option !== undefined) command.spell_option = option
  return command
}

export function runLevel7SpellVariant(id, characterClass, option, high = false) {
  const base = fixture(id, characterClass)
  return runVariant(base, option, high)
}

function refusal(base, command, expectedCodes) {
  const state = structuredClone(base.state)
  const before = hash(state)
  let calls = 0
  const service = new DiceService({ rng: { randint: min => { calls += 1; return min } }, idFactory: () => 'level7:refusal:' + calls })
  try {
    resolveCommand(command, state, { diceService: service, context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
    return { passed: false, code: 'ACCEPTED', inputUnchanged: hash(state) === before, diceCalls: calls }
  } catch (error) {
    return { passed: expectedCodes.includes(error.code) && hash(state) === before && calls === 0, code: error.code ?? error.name, reason: error.message, inputUnchanged: hash(state) === before, diceCalls: calls }
  }
}

function runVariant(base, option, high) {
  const state = structuredClone(base.state)
  const before = hash(state)
  const command = buildLevel7SpellCommand(base, option)
  const refusals = {
    foreignActor: refusal(base, { ...command, actor_id: 'ally' }, ['ACTOR_FORBIDDEN']),
  }
  if (base.profile.spellOptions?.length) {
    const missing = { ...command }
    delete missing.spell_option
    refusals.missingChoice = refusal(base, missing, ['SPELL_OPTION_REQUIRED'])
  }
  if (base.profile.target === 'point') refusals.invalidPoint = refusal(base, { ...command, to: { x: 9999, y: 9999 } }, ['INVALID_DESTINATION'])
  else if (base.profile.target !== 'self') refusals.invalidTarget = refusal(base, { ...command, target_id: 'unknown-actor', target_ids: ['unknown-actor'] }, ['INVALID_SPELL_TARGET', 'TARGET_NOT_FOUND'])
  try {
    const result = resolveCommand(command, state, { diceService: dice(base.caster.characterClass + ':' + base.profile.id + ':' + String(option), high), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
    let live = result.events.reduce(applyGameEvent, state)
    const events = [...result.events]
    let declined = 0
    while (live.mechanics.combat.reaction_window && declined < 20) {
      const actorId = live.mechanics.combat.reaction_window.actor_id
      const decline = resolveCommand({ command_type: 'UseCombatAction', command_id: command.command_id + ':decline:' + (++declined), actor_id: actorId, action_id: 'decline-reaction', server_authoritative: true }, live, { diceService: dice(command.command_id + ':decline:' + declined, high), context: { serverAuthoritativeCombat: true, allowedActorIds: [actorId] } })
      events.push(...decline.events)
      live = decline.events.reduce(applyGameEvent, live)
    }
    if (live.mechanics.combat.reaction_window) return { outcome: 'needs-investigation', code: 'REACTION_LOOP', reason: 'Окно реакции не завершилось за 20 отказов', inputUnchanged: hash(state) === before, refusals }
    const replayed = replayEvents(state, JSON.parse(JSON.stringify(events)))
    const eventTypes = [...new Set(events.map(event => event.event_type))]
    const resourceSpent = base.runtime?.slotResource ? events.some(event => event.event_type === 'ResourceSpent' && event.actor_id === 'caster' && event.payload?.resource === base.runtime.slotResource) : true
    const effectTypes = new Set(['SpellCast', 'DamageApplied', 'HealingApplied', 'ConditionAdded', 'ConditionRemoved', 'SpellCountered', 'ReactionDamageReduced', 'SummonCreated', 'ForcedMovementApplied', 'AreaEffectCreated', 'CombatActionUsed'])
    const effectApplied = eventTypes.some(type => effectTypes.has(type))
    const actionApplied = command.command_type === 'UseCombatAction' ? eventTypes.includes('CombatActionUsed') : eventTypes.includes('SpellCast')
    const replay = hash(replayed) === hash(live)
    const inputUnchanged = hash(state) === before
    const refusalsPassed = Object.values(refusals).every(item => item.passed)
    const checks = { resourceSpent, effectApplied, actionApplied, replay, inputUnchanged, refusalsPassed }
    const valid = Object.values(checks).every(Boolean)
    return { outcome: valid ? 'executed' : 'needs-investigation', eventTypes, checks, replay, inputUnchanged, declinedReactions: declined, refusals }
  } catch (error) {
    const safe = ['MECHANICS_NOT_VERIFIED', 'RULING_REQUIRED'].includes(error.code)
      || (error.code === 'SPELL_CAST_TIME_TOO_LONG' && base.profile.actionType === 'long_cast')
    return { outcome: safe ? 'safely-blocked' : 'needs-investigation', code: error.code ?? error.name, reason: error.message, inputUnchanged: hash(state) === before, refusals }
  }
}

function auditOne(id, characterClass) {
  let base
  try { base = fixture(id, characterClass) } catch (error) { return { id, characterClass, status: 'needs-investigation', error: error.message } }
  if (!base.runtime || base.profile.level > base.rules.maximumSpellLevel) return { id, characterClass, level: base.profile.level, status: 'unavailable-at-level-7', maximumSpellLevel: base.rules.maximumSpellLevel }
  const options = base.profile.spellOptions?.length ? base.profile.spellOptions : [undefined]
  const variants = options.flatMap(option => ['low', 'high'].map(diceName => ({ option: option ?? null, dice: diceName, ...runVariant(base, option, diceName === 'high') })))
  const status = variants.some(v => v.outcome === 'needs-investigation') ? 'needs-investigation' : variants.every(v => v.outcome === 'safely-blocked') ? 'safely-blocked' : 'executed'
  return { id, name: base.profile.name, characterClass, level: base.profile.level, support: base.profile.mechanicsSupport, maximumSpellLevel: base.rules.maximumSpellLevel, spellOptions: base.profile.spellOptions ?? [], variants, status }
}

export function auditLevel7Spells() {
  const rows = []
  for (const spell of catalog) {
    const profile = canonicalCombatSpellFor(spell.id, { rulesetId: RULESET })
    if (!profile || profile.level > 4) continue
    for (const characterClass of CLASSES) if (profile.classes.includes(characterClass)) rows.push(auditOne(spell.id, characterClass))
  }
  const summary = {
    ruleset: RULESET, level: LEVEL, classes: CLASSES, catalogProfiles: catalog.length, rows: rows.length,
    available: rows.filter(row => row.status !== 'unavailable-at-level-7').length,
    unavailable: rows.filter(row => row.status === 'unavailable-at-level-7').length,
    executed: rows.filter(row => row.status === 'executed').length,
    safelyBlocked: rows.filter(row => row.status === 'safely-blocked').length,
    needsInvestigation: rows.filter(row => row.status === 'needs-investigation').length,
    replayFailures: rows.reduce((n, row) => n + (row.variants?.filter(v => v.outcome === 'executed' && !v.replay).length ?? 0), 0),
  }
  return { schemaVersion: 'astohan-level7-spell-audit/v1', generatedAt: new Date().toISOString(), summary, rows }
}

function markdown(report) {
  const summary = report.summary
  const lines = [
    '# Заклинания 7-го уровня в «Асстоханских равнинах»', '',
    'Правила: ' + summary.ruleset + '. Проверены круги 0–4 для ' + summary.classes.join(', ') + '. Каждый вариант прогнан на низком и высоком результате кости, затем проверен replay событий.', '',
    'Профилей каталога: ' + summary.catalogProfiles + '. Связок класс × заклинание: ' + summary.rows + '. Доступны: ' + summary.available + '. Исполнены: ' + summary.executed + '. Безопасно заблокированы: ' + summary.safelyBlocked + '. Требуют расследования: ' + summary.needsInvestigation + '. Replay-ошибок: ' + summary.replayFailures + '.', '',
    '| Заклинание | Класс | Круг | Поддержка | Выбор | Результат |', '| --- | --- | ---: | --- | --- | --- |',
  ]
  for (const row of report.rows) if (row.status !== 'unavailable-at-level-7') {
    const variants = row.variants.map(v => v.dice + '/' + (v.option ?? '—') + ': ' + v.outcome).join(', ')
    lines.push('| ' + (row.name ?? row.id) + ' (' + row.id + ') | ' + row.characterClass + ' | ' + row.level + ' | ' + row.support + ' | ' + ((row.spellOptions ?? []).join(', ') || '—') + ' | ' + row.status + '; ' + variants + ' |')
  }
  const investigations = report.rows.filter(row => row.status === 'needs-investigation')
  if (investigations.length) {
    lines.push('', '## Требуют расследования', '')
    for (const row of investigations) lines.push('- ' + row.characterClass + '/' + row.id + ': ' + (row.error ?? row.variants?.find(v => v.outcome === 'needs-investigation')?.reason))
  }
  lines.push('', 'Стенд проверяет level/class gate, слот, выбор, исполнение события и replay штатного Rules Engine. Он не заменяет полную приёмку браузерного UX.')
  return lines.join('\n') + '\n'
}

if (process.argv[1]?.endsWith('astohan-level7-spell-audit.mjs')) {
  const report = auditLevel7Spells()
  writeFileSync(resolve(outputDir, 'level7-spell-audit.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(resolve(outputDir, 'level7-spell-audit.md'), markdown(report))
  console.log(JSON.stringify(report.summary, null, 2))
  if (report.summary.needsInvestigation || report.summary.replayFailures) process.exitCode = 1
}
