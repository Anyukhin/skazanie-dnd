// Проверка связи боевого результата с объёмным эффектом без видеокарты.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compileClientModules } from '../test/kit/client-ts.mjs'
import { createTacticalMap, serializeTacticalMap, setCell } from '../server/tactical-map.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { applyGameEvent, resolveCommand } from '../server/rules-engine.mjs'
import { buildLevel7SpellCommand, level7SpellFixture } from './astohan-level7-spell-audit.mjs'

const { modules: [animations, effects, client, visuals] } = await compileClientModules([
  'src/combat-animation.ts', 'src/board3d-spell-effects.ts', 'src/tactical-map-client.ts', 'src/spell-effects.ts',
])
const raw = createTacticalMap({ width: 20, height: 8, seed: 'spell-review' })
for (let y = 0; y < raw.height; y++) for (let x = 0; x < raw.width; x++) setCell(raw, x, y, { passable: true, revealed: true })
const map = client.decodeTacticalMap(serializeTacticalMap(raw))
const index = JSON.parse(readFileSync(new URL('../docs/reviews/astohan-level7-spells.json', import.meta.url)))

function check(card, option) {
  const base = level7SpellFixture(card.id, card.availableTo[0])
  const command = buildLevel7SpellCommand(base, option)
  let state = base.state
  let serial = 0
  const diceService = new DiceService({ rng: { randint: min => min }, idFactory: () => 'effect-roll-' + ++serial })
  const events = []
  function run(cmd) {
    const result = resolveCommand(cmd, state, { diceService, context: { serverAuthoritativeCombat: true, allowedActorIds: [cmd.actor_id] } })
    events.push(...result.events)
    state = result.events.reduce(applyGameEvent, state)
  }
  run(command)
  for (let i = 0; state.mechanics.combat.reaction_window; i++) {
    if (i === 20) throw Error('Не завершена реакция')
    run({ actor_id: state.mechanics.combat.reaction_window.actor_id, command_type: 'UseCombatAction', action_id: 'decline-reaction', command_id: 'decline-' + i, server_authoritative: true })
  }
  const actors = [...state.players, ...state.enemies].map(actor => ({ id: actor.id, ...state.mechanics.positions[actor.id] }))
  const cues = animations.combatAnimationCuesFromEvents(events).filter(cue => cue.spellId === card.id)
  const kinds = []
  for (const cue of cues) {
    const effect = effects.createSpellEffect3D(cue, actors, map)
    if (!effect) continue
    try {
      effect.update(.5)
      effect.group.updateMatrixWorld(true)
      let meshes = 0
      effect.group.traverse(node => {
        if (node.isMesh || node.isSprite || node.isPoints || node.isLine) meshes++
        if (!node.matrixWorld.elements.every(Number.isFinite)) throw Error('Неверная позиция 3D')
      })
      if (meshes) kinds.push(cue.kind)
    } finally { effect.dispose() }
  }
  return { option, kinds, events: [...new Set(events.map(e => e.event_type))] }
}

const results = index.spells.map(card => {
  const profile = visuals.spellVisualProfile(card.id)
  const row = { id: card.id, family: profile.family, sound: profile.soundFamily, status: card.mechanicsSupport, casts: [] }
  if (['verified', 'partial'].includes(card.mechanicsSupport)) {
    for (const option of card.spellOptions.length ? card.spellOptions : [undefined]) {
      try { row.casts.push(check(card, option)) }
      catch (error) { row.casts.push({ option, error: error.message }) }
    }
  }
  return row
})
const folder = new URL('../tmp/astohan-spell-review/', import.meta.url)
mkdirSync(folder, { recursive: true })
writeFileSync(new URL('visuals.json', folder), JSON.stringify(results, null, 2))
const missing = results.filter(row => row.casts.some(cast => !cast.kinds?.length))
console.log(JSON.stringify({ profiles: results.length, castProfiles: results.filter(row => row.casts.length).length,
  variants: results.flatMap(row => row.casts).length, missing: missing.map(r => r.id) }))
if (missing.length) process.exitCode = 1
