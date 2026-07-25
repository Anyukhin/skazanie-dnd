import { verifyContentIntegrity } from '../server/content-integrity.mjs'

const strictRelease = process.argv.includes('--release')

try {
  const report = await verifyContentIntegrity()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (strictRelease && !report.release.ready) process.exitCode = 2
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code ?? 'CONTENT_VERIFY_FAILED',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`)
  process.exitCode = 1
}
