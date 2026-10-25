import '../../../fixtures-env.mjs'
// Эталон замыканий времени мира `resolveCommandInternal` (13119–13313):
// `appendTimeAdvance`, `appendScenarioKnightPresence`,
// `appendWorldTimeConsequences` (задача Р4б).
//
// Блок исполняется в области имён открытой копии движка (`blockFunction`) над
// `events`, `rolls`, детерминированными костями и проектором команды
// (`createCommandProjector`). Состояния — из корпуса паритета (у кого есть
// стабилизированные герои, нокаут, призывы со сроком, пленные, письма,
// обещания NPC, концентрация, сценарий) и несколько синтетических. Эталон —
// sha256 `JSON.stringify({ events, rolls })` и типы событий для отладки;
// состояния корпуса в git не кладутся, синтетические лежат целиком.
//
//   node rust/crates/sk-rules/fixtures/gen-world-time.mjs <корпус>
//   node …/gen-world-time.mjs <корпус> --dump <номер случая>   — события JS
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { blockFunction, loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const [corpus, flag, dumpIndex] = process.argv.slice(2)
if (!corpus) throw new Error('Укажите каталог корпуса')
const E = await loadOpenCopy()
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const block = await blockFunction(
  [[13141, 13335]],
  ['const appendTimeAdvance'],
  ['events', 'rolls', 'diceService', 'projectEvents', 'sourceCommand0', 'amount0', 'unit0', 'options0'],
  'return appendWorldTimeConsequences(sourceCommand0, amount0, unit0, options0)',
)

function service(values) {
  let counter = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `roll-${++counter}`, now: () => '2026-01-01T00:00:00.000Z' })
}

// --- выбор состояний корпуса по признакам -----------------------------------
const FEATURES = {
  stable: (s) => Object.values(s.mechanics?.death?.saving_throws ?? {}).some((t) => t?.stable === true),
  knockout: (s) => Object.values(s.mechanics?.resting ?? {}).some((r) => r?.reason === 'knockout'),
  summons: (s) => [...(s.actors ?? []), ...(s.enemies ?? [])].some((a) => a?.expires_at_seconds != null),
  captives: (s) => (s.captives?.captives ?? []).length > 0,
  letters: (s) => (s.courier_letters?.letters ?? []).length > 0,
  promises: (s) => (s.social?.promises ?? []).length > 0,
  concentration: (s) => Object.keys(s.mechanics?.concentration ?? {}).length > 0,
  scenario: (s) => Boolean(s.campaignConcept?.scenario_id ?? s.scenario_id),
  offscreen: (s) => (s.offscreen_world?.steps ?? []).length > 0,
  dawn: (s) => (s.players ?? []).some((p) => (p.inventory ?? []).some((i) => i?.charges != null)),
  plain: () => true,
}
const PER_FEATURE = 6
const picked = new Map()
const counts = Object.fromEntries(Object.keys(FEATURES).map((name) => [name, 0]))
const names = readdirSync(join(corpus, 'states')).filter((name) => name.endsWith('.json')).sort()
for (const name of names) {
  if (Object.values(counts).every((count) => count >= PER_FEATURE)) break
  const state = JSON.parse(readFileSync(join(corpus, 'states', name), 'utf8'))
  for (const [feature, test] of Object.entries(FEATURES)) {
    if (counts[feature] >= PER_FEATURE || picked.has(name)) continue
    let hit = false
    try { hit = test(state) } catch { hit = false }
    if (hit) {
      counts[feature] += 1
      picked.set(name, feature)
    }
  }
}

// --- синтетические состояния --------------------------------------------------
const hero = (id, extra = {}) => ({ id, name: id, class: 'fighter', level: 3, hp: 20, maxHp: 24, abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], ...extra })
const synthetic = [
  {
    players: [hero('h1', { hp: 0 }), hero('h2', { hp: 0 }), hero('h3', { hp: 5 })],
    mechanics: {
      death: { saving_throws: { h1: { stable: true }, h2: { stable: true, recovery_minutes_remaining: 30 }, h3: { stable: true }, ghost: { stable: true } } },
      resting: { h3: { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 15 }, h2: { kind: 'short', reason: 'knockout' } },
      world_time: { elapsed_minutes: 100, second_remainder: 30 },
    },
  },
  {
    players: [hero('caster', { class: 'wizard' })],
    actors: [
      { id: 'sum-1', name: 'Волк', hp: 5, maxHp: 5, summoned: true, summon_kind: 'party', ownerId: 'caster', sourceEffectId: 'eff-1', summon_lifecycle_version: 2, expires_at_seconds: 6060 },
      { id: 'sum-2', name: 'Волк', hp: 5, maxHp: 5, summoned: true, summon_kind: 'party', ownerId: 'caster', sourceEffectId: 'eff-1', summon_lifecycle_version: 2, expires_at_seconds: 9000 },
    ],
    mechanics: {
      concentration: { caster: { effect_id: 'eff-1', spell_id: 'conjure-animals' } },
      conditions: {
        caster: [
          { id: 'protected', effect_id: 'eff-1', source_actor: 'caster', expiry_policy: 'protection-from-energy/v1', expires_at_seconds: 6100, spell_id: 'protection-from-energy' },
          { id: 'skilled', effect_id: 'eff-2', source_actor: 'caster', skill_buff_version: 1, spell_id: 'skill-empowerment', expires_at_seconds: 6001 },
        ],
      },
      world_time: { elapsed_minutes: 100 },
    },
  },
]

const AMOUNTS = [[1, 'round'], [10, 'minute'], [1, 'hour'], [8, 'hour'], [1, 'day'], [3, 'day'], [0, 'minute'], [90, 'second']]
const DICE = [[3, 2, 4, 1, 5, 6, 2, 3, 1, 4, 2, 3, 4, 1, 2, 3, 6, 5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6, 1, 2]]
const cases = []
const syntheticStates = synthetic.map((state) => JSON.parse(JSON.stringify(state)))
const sources = [
  ...[...picked.entries()].map(([name, feature]) => ({ state_hash: name.slice(0, -5), feature })),
  ...syntheticStates.map((_, index) => ({ synthetic: index, feature: 'synthetic' })),
]
let index = 0
for (const source of sources) {
  const raw = source.state_hash ? JSON.parse(readFileSync(join(corpus, 'states', `${source.state_hash}.json`), 'utf8')) : syntheticStates[source.synthetic]
  for (const [amount, unit] of AMOUNTS) {
    const options = index % 5 === 3 ? { policyId: 'world-time-test' } : index % 7 === 4 ? { elapsedSeconds: 120 } : {}
    const command = {
      campaign_id: 'c1', command_id: `cmd-${index}`, command_type: 'AdvanceTime', actor_id: (raw.players ?? [])[0]?.id ?? null,
      target_ids: [], source_rule_ids: [], ruleset_id: raw.ruleset_id, visibility: index % 3 === 0 ? 'party' : undefined,
    }
    const events = []
    const rolls = []
    let outcome
    try {
      const state = E.normalizeCampaignState(raw)
      const projectEvents = E.createCommandProjector(state)
      block(events, rolls, service(DICE[0]), projectEvents, command, amount, unit, options)
      outcome = { sha: sha({ events, rolls }), types: events.map((event) => event.event_type) }
    } catch (error) {
      outcome = { throws: String(error?.message ?? error).slice(0, 200), code: error?.code ?? null }
    }
    if (flag === '--dump' && Number(dumpIndex) === index) {
      console.log(JSON.stringify({ events, rolls }, null, 1))
      process.exit(0)
    }
    cases.push({ ...source, command: JSON.parse(JSON.stringify(command)), amount, unit, options, dice: DICE[0], ...outcome })
    index += 1
  }
}
const output = new URL('./world-time.json', import.meta.url)
writeFileSync(output, `${JSON.stringify({ source_sha256: sourceSha256(), synthetic: syntheticStates, cases })}\n`)
console.log(`world-time.json: случаев ${cases.length} (бросает ${cases.filter((entry) => entry.throws).length}), состояний корпуса ${picked.size}`, counts)
