// Эталон `server/post-commit-coordinator.mjs` для sk-society:
// `node gen-post-commit-coordinator.mjs`.
//
// Ключи позиции (`combatPositionKey`, `directorPositionKey`) на мусорных
// состояниях и сценарии координатора: какие стадии выполнены, пропущены и
// упали, в каком порядке вызваны зависимости, с какими ключами стадии и
// коммита, и что вернулось вызывающему — в том числе при повторных прогонах.
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const coordinatorModule = await import(server('post-commit-coordinator'))
const random = rng(606)
const c = collector()

const maybe = (value, p = 0.7) => (random.chance(p) ? value : undefined)

const constants = {
  STAGE_KEY_KINDS: coordinatorModule.STAGE_KEY_KINDS,
  stageOrderForReview: coordinatorModule.stageOrderForReview(),
}

const ROUNDS = [undefined, null, 0, 1, 2, '3', 1.5, 'x', true, -1]
const INDEXES = [undefined, null, 0, 1, 2, '1', 0.5, 'x', -0, 5]
const INITIATIVE = [undefined, [], [{ actor_id: 'hero' }, { actor_id: 'wolf' }], [{ actor_id: null }, {}], 'ab', { 0: { actor_id: 'obj-hero' }, 1: { actor_id: 7 } }, [null, { actor_id: 'wolf' }]]

function combatState() {
  if (random.chance(0.05)) return random.pick(JUNK)
  return {
    mechanics: random.chance(0.95) ? {
      encounter: maybe({ id: random.pick(['enc-1', '', null, 7, undefined]), status: random.pick(['active', 'ended', 'ended ', undefined, null]) }),
      combat: maybe({
        active: random.pick([true, true, false, 'yes', 0, 1, undefined]),
        round: random.pick(ROUNDS),
        active_index: random.pick(INDEXES),
        initiative: random.pick(INITIATIVE),
        truce: random.chance(0.2) ? random.pick([{ leader_id: 'enemy' }, { leader_id: '' }, 'x']) : undefined,
      }, 0.9),
    } : random.pick(JUNK),
    campaignConcept: maybe({ current_arc_number: random.pick([undefined, null, 1, 2, '3', 'x', 2.5]) }),
    adventure: maybe({ chapter: random.pick([undefined, null, 1, 4, '2', 'глава']), objective: random.pick([undefined, null, '', 'Найти переправу', 'Перейти реку', 42, ['a', 'b']]) }),
  }
}

for (let index = 0; index < 400; index += 1) {
  const state = combatState()
  c.call('combatPositionKey', coordinatorModule.combatPositionKey, [state])
  c.call('directorPositionKey', coordinatorModule.directorPositionKey, [state])
}

// ---------------------------------------------------------------------------
// Сценарии координатора
// ---------------------------------------------------------------------------

const DEP_NAMES = ['applyQuestConsequences', 'continueCombat', 'completeEncounter', 'weaveHeroHooks', 'runDirector', 'persistProjection', 'narrate']
const EVENT_TYPES = ['QuestResolved', 'NpcPromiseResolved', 'ObjectiveUpdated', 'SceneAdvanced', 'EncounterRewardsDistributed', 'TurnStarted', '', undefined]
const STAGE_NAMES = coordinatorModule.STAGES.map((stage) => stage.name)

/** Прогнать сценарий: зависимости пишут порядок вызовов, ключ стадии и ключ коммита. */
async function runScenario(config) {
  const order = []
  const errors = []
  const failures = new Map(config.deps.fail.map((name) => [name, config.deps.failTimes]))
  const deps = {}
  for (const name of config.deps.present) {
    deps[name] = async (context) => {
      order.push(`${name}|${context.stageKey}|${context.commitKey}|${context.campaignId}|${context.extra ?? ''}`)
      const left = failures.get(name) ?? 0
      if (left > 0) {
        failures.set(name, left - 1)
        throw new Error(`${name} упал`)
      }
      return config.deps.results ? { stage: name, events: context.events.length } : undefined
    }
  }
  if (config.deps.heroes !== undefined) deps.heroesNeedingHooks = () => config.deps.heroes
  const coordinator = new coordinatorModule.PostCommitCoordinator({ deps, onError: (error, stage) => errors.push(`${stage}: ${error.message}`) })
  const runs = []
  for (const run of config.runs) {
    const result = await coordinator.run({
      campaignId: run.campaignId, state: run.state, events: run.events, commitKey: run.commitKey, stages: run.stages, context: run.context,
    })
    runs.push(plain(result))
  }
  return { runs, order, errors }
}

function event() {
  if (random.chance(0.05)) return random.pick([null, 'e', {}])
  return { event_id: random.pick(['e1', 'e2', '', undefined, null, 0, 7, 'событие']), event_type: random.pick(EVENT_TYPES) }
}

function runConfig(previous) {
  const reuse = previous && random.chance(0.5)
  return {
    campaignId: reuse ? previous.campaignId : random.pick(['C1', 'C2', 'КАМПАНИЯ']),
    state: reuse && random.chance(0.6) ? previous.state : combatState(),
    events: reuse && random.chance(0.6) ? previous.events : Array.from({ length: random.int(0, 3) }, event),
    commitKey: reuse && random.chance(0.6) ? previous.commitKey : random.pick([undefined, '', 'commit-1', 'commit-2']),
    stages: random.chance(0.15) ? random.some([...STAGE_NAMES, 'bogus'], 3) : undefined,
    context: random.chance(0.2) ? { extra: 'x' } : undefined,
  }
}

const scenarios = []
for (let index = 0; index < 150; index += 1) {
  const runs = []
  for (let run = 0; run < random.int(1, 4); run += 1) runs.push(runConfig(runs.at(-1)))
  const config = {
    deps: {
      present: DEP_NAMES.filter(() => random.chance(0.8)),
      fail: DEP_NAMES.filter(() => random.chance(0.1)),
      failTimes: random.int(1, 2),
      results: random.chance(0.5),
      heroes: random.pick([undefined, [], ['hero'], ['mate', 'hero', 3], [null]]),
    },
    runs,
  }
  scenarios.push(plain(config))
}
for (const config of scenarios) {
  const out = await runScenario(config)
  c.call('coordinatorScenario', () => out, [config])
}

write('post-commit-coordinator.json', { generator: 'gen-post-commit-coordinator.mjs', constants, values: c.values, cases: c.cases, skipped: c.skipped })
