import { performance } from 'node:perf_hooks'

import { AUTONOMY_EVAL_SCENARIOS, LONG_CAMPAIGN_EVALS } from '../eval/autonomous-scenarios.mjs'

function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

/** Machine-readable evaluator: every score is derived from counters or canonical event comparisons. */
export function createAutonomyEvalReport({ runs = [], longCampaigns = [], tokenUsage = [] } = {}) {
  const latencies = runs.map((run) => Number(run.latency_ms) || 0)
  const totalTurns = runs.reduce((sum, run) => sum + (Number(run.turns) || 1), 0)
  const contradictions = runs.reduce((sum, run) => sum + (Number(run.contradictions) || 0), 0)
  const forgotten = runs.reduce((sum, run) => sum + (Number(run.forgotten_facts) || 0), 0)
  const invented = runs.reduce((sum, run) => sum + (Number(run.invented_facts) || 0), 0)
  const mechanicalErrors = runs.reduce((sum, run) => sum + (Number(run.mechanical_errors) || 0), 0)
  const replayMismatches = runs.reduce((sum, run) => sum + Number(run.replay_identical === false), 0)
  const restartMismatches = runs.reduce((sum, run) => sum + Number(run.restart_identical === false), 0)
  const adminInterventions = runs.reduce((sum, run) => sum + (Number(run.admin_interventions) || 0), 0)
  const inputTokens = tokenUsage.reduce((sum, usage) => sum + (Number(usage.input_tokens) || 0), 0)
  const outputTokens = tokenUsage.reduce((sum, usage) => sum + (Number(usage.output_tokens) || 0), 0)
  return {
    schema_version: 1,
    scenario_count: AUTONOMY_EVAL_SCENARIOS.length,
    long_campaign_definitions: LONG_CAMPAIGN_EVALS,
    executed_runs: runs.length,
    executed_long_campaigns: longCampaigns.length,
    total_turns: totalTurns,
    story_coherence: { contradictions, rate: totalTurns ? 1 - contradictions / totalTurns : 1 },
    memory: { forgotten_facts: forgotten, invented_facts: invented, error_rate: totalTurns ? (forgotten + invented) / totalTurns : 0 },
    mechanics: { incorrect_consequences: mechanicalErrors, accuracy: totalTurns ? 1 - mechanicalErrors / totalTurns : 1 },
    repeatability: { replay_mismatches: replayMismatches, restart_mismatches: restartMismatches, identical_rate: runs.length ? 1 - (replayMismatches + restartMismatches) / (runs.length * 2) : 1 },
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(0, ...latencies) },
    llm_tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, cost_per_turn_tokens: totalTurns ? (inputTokens + outputTokens) / totalTurns : 0 },
    admin_interventions: { count: adminInterventions, per_100_turns: totalTurns ? adminInterventions * 100 / totalTurns : 0 },
  }
}

export async function measureAutonomyRun(operation) {
  const started = performance.now()
  const result = await operation()
  return { result, latency_ms: Math.round((performance.now() - started) * 1000) / 1000 }
}
