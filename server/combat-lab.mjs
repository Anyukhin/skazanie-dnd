import { randomUUID } from 'node:crypto'

import { COMBAT_SCENARIOS, runCombatScenario } from '../eval/combat-lab.mjs'
import { buildCombatLabState, combatLabCatalog } from './combat-lab-setup.mjs'

const SCENARIO_NAMES = Object.freeze({
  duel: 'Дуэль',
  approach: 'Сближение',
  'difficult-terrain': 'Труднопроходимая местность',
  'two-heroes': 'Два героя',
  ranged: 'Дальний бой',
  healing: 'Лечение',
  concentration: 'Концентрация',
  'opportunity-attack': 'Атака по возможности',
})

export class CombatLabError extends Error {
  constructor(message, code, status = 400) {
    super(message)
    this.name = 'CombatLabError'
    this.code = code
    this.status = status
  }
}

function clone(value) {
  return structuredClone(value)
}

function publicError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error?.code ? { code: String(error.code) } : {}),
  }
}

/** Небольшой процессный реестр асинхронных прогонов наблюдателя. */
export class CombatLabRuns {
  constructor({ run = runCombatScenario, loadCampaign = null, chooseCommand = null, maxRuns = 3, maxFrames = 2000 } = {}) {
    if (typeof run !== 'function') throw new TypeError('CombatLabRuns requires a run function')
    this.run = run
    this.loadCampaign = loadCampaign
    this.chooseCommand = chooseCommand
    this.maxRuns = Math.max(1, Number(maxRuns) || 3)
    this.maxFrames = Math.max(2, Number(maxFrames) || 2000)
    this.runs = new Map()
    this.activeRun = null
    this.creating = false
  }

  scenarios() {
    return COMBAT_SCENARIOS.map((id) => ({ id, name: SCENARIO_NAMES[id] || id }))
  }

  active() {
    return this.activeRun?.status === 'running' ? { id: this.activeRun.id } : null
  }

  async catalog() {
    return combatLabCatalog({ loadCampaign: this.loadCampaign })
  }

  async create({ scenario = 'duel', seed, config } = {}) {
    if (!COMBAT_SCENARIOS.includes(scenario)) {
      if (config === undefined) throw new CombatLabError('Неизвестный сценарий боевого стенда', 'INVALID_COMBAT_LAB_SCENARIO')
    }
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new CombatLabError('seed должен быть целым числом от 0 до 4294967295', 'INVALID_COMBAT_LAB_SEED')
    }
    if (this.activeRun || this.creating) throw new CombatLabError('Уже выполняется один прогон боевого стенда', 'COMBAT_LAB_BUSY', 409)
    this.creating = true
    try {
      const initialState = config === undefined ? null : await buildCombatLabState(config, { loadCampaign: this.loadCampaign })
      this.prune()
      if (this.runs.size >= this.maxRuns) {
        throw new CombatLabError('История прогонов боевого стенда заполнена', 'COMBAT_LAB_HISTORY_FULL', 503)
      }
      const run = {
        id: `combat-lab-${randomUUID()}`,
        status: 'running',
        scenario: initialState ? 'custom' : scenario,
        seed,
        initialState,
        frames: [],
        error: null,
        controller: new AbortController(),
        cancelRequested: false,
        done: null,
      }
      this.runs.set(run.id, run)
      this.activeRun = run
      run.done = this.execute(run)
      return this.public(run)
    } finally {
      this.creating = false
    }
  }

  get(id, after = -1) {
    const run = this.runs.get(String(id || ''))
    return run ? this.public(run, after) : null
  }

  report(id) {
    const run = this.runs.get(String(id || ''))
    return run ? { schema: 'combat-lab-observer/v1', ...this.public(run), trace: clone(run.trace ?? null) } : null
  }

  async cancel(id) {
    const run = this.runs.get(String(id || ''))
    if (!run) return null
    if (run.status !== 'running') return this.public(run)
    run.cancelRequested = true
    run.controller.abort()
    await run.done
    return this.public(run)
  }

  prune() {
    while (this.runs.size >= this.maxRuns) {
      const candidate = [...this.runs.values()].find((run) => run !== this.activeRun && run.status !== 'running')
      if (!candidate) return
      this.runs.delete(candidate.id)
    }
  }

  appendFrame(run, frame) {
    if (run.frames.length >= this.maxFrames) {
      throw new CombatLabError('Прогон остановлен: превышен лимит кадров', 'COMBAT_LAB_FRAME_LIMIT', 503)
    }
    run.frames.push(clone(frame))
  }

  async execute(run) {
    try {
      const report = await this.run({
        scenario: run.scenario,
        seed: run.seed,
        ...(run.initialState ? { initialState: clone(run.initialState), maxSteps: 500 } : {}),
        ...(run.initialState && this.chooseCommand ? { chooseCommand: this.chooseCommand } : {}),
        onFrame: async (frame) => {
          this.appendFrame(run, frame)
          await new Promise((resolve) => setImmediate(resolve))
        },
        signal: run.controller.signal,
      })
      run.trace = { initial_state: report.initial_state, final_state: report.final_state, rolls: report.rolls,
        error: report.error, steps: (report.steps ?? []).map(({ step, command, tactic, before_version, after_version }) => ({ step, command, tactic, before_version, after_version })) }
      if (run.cancelRequested || run.controller.signal.aborted) {
        run.status = 'cancelled'
        run.error = null
        return
      }
      if (report?.passed === true) run.status = 'passed'
      else {
        run.status = 'failed'
        run.error = report?.error ? clone(report.error) : { message: 'Боевой стенд завершился без результата' }
      }
    } catch (error) {
      if (run.cancelRequested || run.controller.signal.aborted) {
        run.status = 'cancelled'
        run.error = null
      } else {
        run.status = 'failed'
        run.error = publicError(error)
      }
    } finally {
      if (this.activeRun === run) this.activeRun = null
      run.controller = null
    }
  }

  public(run, after = -1) {
    return {
      id: run.id,
      status: run.status,
      scenario: run.scenario,
      seed: run.seed,
      frames: clone(run.frames.filter((frame) => frame.index > after)),
      ...(run.error ? { error: String(run.error.message || run.error) } : {}),
      ...(run.error?.code ? { error_code: String(run.error.code) } : {}),
    }
  }
}
