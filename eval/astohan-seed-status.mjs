/** Итог одного прогона для серии без запуска стенда. */
const SCENARIO_ENDINGS = new Set(['slain', 'banished', 'treaty', 'defeat'])

export function endingFor(report) {
  return report?.final?.lifecycle?.ending?.id ?? report?.scorecard?.ending ?? null
}

export function victoryFor(ending) {
  if (!SCENARIO_ENDINGS.has(ending)) return null
  return ending !== 'defeat'
}

export function seedPassed(report) {
  return Boolean(
    report
      && report.scorecard?.blockers === 0
      && report.scorecard?.critical === 0
      && report.audit?.status === 0
      && report.audit?.ready !== false,
  )
}
