// Временный export для Rust integration level 7. Использует тот же fixture и
// builder, что и `astohan-level7-spell-audit`, а список партии берёт из
// `docs/reviews/astohan-level7-spells.json`.
import { readFileSync, writeFileSync } from 'node:fs'
import { applyGameEvent, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { buildLevel7SpellCommand, level7SpellFixture } from './astohan-level7-spell-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'

const output = process.argv[2] ?? 'tmp/astohan-spell-review/level7-named.json'
const selections = JSON.parse(readFileSync(new URL('../docs/reviews/astohan-level7-spells.json', import.meta.url))).partySelections
const profiles = Object.entries(selections).flatMap(([characterClass, selection]) => selection.activeIds.map(id => ({ characterClass, id })))

function dice(id, variant) {
  let count = 0
  return new DiceService({
    rng: { randint: (min, max) => variant === 'low' ? min : max },
    idFactory: () => `level7:${id}:${variant}:${++count}`,
    now: () => '2026-11-22T12:00:00.000Z',
  })
}

function run(base, option, variant) {
  const state = structuredClone(base.state)
  const command = buildLevel7SpellCommand(base, option)
  try {
    const result = resolveCommand(command, state, { diceService: dice(command.spell_id, variant), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
    let live = result.events.reduce(applyGameEvent, state)
    const events = [...result.events]
    let declines = 0
    while (live.mechanics.combat.reaction_window && declines < 20) {
      const reactor = live.mechanics.combat.reaction_window.actor_id
      const decline = resolveCommand({ command_type: 'UseCombatAction', command_id: `${command.command_id}:decline:${++declines}`, actor_id: reactor, action_id: 'decline-reaction', server_authoritative: true }, live, { diceService: dice(`${command.spell_id}:decline:${declines}`, variant), context: { serverAuthoritativeCombat: true, allowedActorIds: [reactor] } })
      events.push(...decline.events)
      live = decline.events.reduce(applyGameEvent, live)
    }
    return { outcome: 'ok', event_types: [...new Set(events.map(event => event.event_type))].sort(), replay: JSON.stringify(replayEvents(state, JSON.parse(JSON.stringify(events)))) === JSON.stringify(live) }
  } catch (error) {
    return { outcome: 'error', code: error.code ?? error.name, message: error.message }
  }
}

const rows = []
for (const { characterClass, id } of profiles) {
  const base = level7SpellFixture(id, characterClass)
  if (!base.profile || base.profile.level > 4) continue
  const options = base.profile.spellOptions?.length ? base.profile.spellOptions : [undefined]
  for (const option of options) for (const variant of ['low', 'high']) rows.push({
    name: characterClass, spell_id: id, class: characterClass, level: base.profile.level, support: base.profile.mechanicsSupport,
    state: base.state, command: buildLevel7SpellCommand(base, option), option: option ?? null, variant,
    expected: run(base, option, variant),
  })
}
writeFileSync(output, JSON.stringify({ ruleset_id: 'dnd_5e_2014', level: 7, rows }, null, 2) + '\n')
console.log(JSON.stringify({ rows: rows.length, spells: new Set(rows.map(row => row.spell_id)).size, output }))
