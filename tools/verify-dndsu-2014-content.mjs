#!/usr/bin/env node
/** Read-only verifier. Run from the archive root or from the target repository. */
import { access } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadDndsu2014Content, loadReferenceRulePack } from '../server/dndsu-2014-content.mjs'

try {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--repository-loader') || new Set(args).size !== args.length) {
    throw new Error('Usage: node tools/verify-dndsu-2014-content.mjs [--repository-loader]')
  }
  const content = await loadDndsu2014Content()
  const report = {
    status: 'passed', ...content.summary,
    checksum_files_checked: Object.keys(content.manifest.files).length,
    runtime_activation_allowed: false,
    repository_rule_loader: 'not_run',
    full_repository_test_suite: 'not_run',
  }
  if (args.includes('--repository-loader')) {
    const loaderFile = fileURLToPath(new URL('../server/rule-pack.mjs', import.meta.url))
    try { await access(loaderFile) } catch {
      throw new Error('server/rule-pack.mjs is absent. Copy this package into the real skazanie-dnd checkout before using --repository-loader.')
    }
    const { loadRulePack } = await import(pathToFileURL(loaderFile).href)
    const pack = await loadReferenceRulePack(loadRulePack)
    report.repository_rule_loader = 'passed'
    report.repository_rule_pack_summary = pack.summary
  }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
}
