import { auditSpellOverrides } from '../server/spell-override-audit.mjs'

const verbose = process.argv.includes('--details')

try {
  const report = auditSpellOverrides()
  const { details, ...summary } = report
  process.stdout.write(`${JSON.stringify(verbose ? report : summary, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? 'SPELL_OVERRIDE_AUDIT_FAILED',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`)
  process.exitCode = 1
}
