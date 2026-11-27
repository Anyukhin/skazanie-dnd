export function finishBrowserReport(report) {
  // ANGLE перевёл шейдер отражений Three.js и успешно связал программу.
  // Сохраняем предупреждение и кадр игры, ошибки компиляции остаются в гейте.
  for (const warning of report.console.filter(entry => entry.type === 'warning' && /X4122/u.test(entry.text))) {
    const program = report.shaders.find(shader => shader.seat === warning.seat && shader.linked
      && warning.text.includes(shader.log.trim().split('\n')[0]) && shader.stages.some(stage => stage.name === 'PMREMGGXConvolution'))
    const drawn = report.steps.some(step => step.seats?.some(seat => seat.seat === warning.seat
      && Number(seat.browser.canvas?.frames) > 0 && seat.browser.actors.some(actor => actor.source === 'glb')))
    if (!program || !drawn) continue
    report.compilerWarnings.push({ ...warning, program: 'PMREMGGXConvolution', linked: true,
      impact: 'ANGLE округлил выражение. Опубликован кадр WebGL с загруженными фигурами.' })
    report.console.splice(report.console.indexOf(warning), 1)
  }
  for (const step of report.steps) {
    const id = `Ш${Number(step.id)}`
    const failures = [...report.network, ...report.console, ...report.failures].some(issue => issue.step === id)
    const obscured = (step.seats ?? step.ballots)?.some(seat => seat.overlaps.length)
    step.gate = failures || obscured ? 'failed' : 'passed'
  }
  const completed = new Set(report.steps.filter(step => step.coverage === 'completed').map(step => Number(step.id)))
  report.reached = 0
  while (completed.has(report.reached + 1)) report.reached += 1
  report.missing = Array.from({ length: report.requestedThrough }, (_, index) => index + 1).filter(id => !completed.has(id))
  const failed = report.missing.length || report.failures.length || report.network.length || report.console.length
    || report.shaders.some(shader => !shader.linked) || report.steps.some(step => step.gate === 'failed')
  report.gate = failed ? 'failed' : report.mode === 'partial' ? 'partial-pass' : 'passed'
  return failed ? 1 : 0
}
