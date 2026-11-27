import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRulePack } from '../server/rule-pack.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const scanRoots = ['server', 'src', 'data', 'test']
const scannedExtensions = new Set(['.mjs', '.js', '.ts', '.tsx', '.json', '.yaml', '.yml'])
const markers = ['srd_5_2_1', '5e_2024', 'dndsu-5e-2014-official', 'dnd_5e_2014']

async function filesBelow(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(path))
    else if (scannedExtensions.has(extname(entry.name))) result.push(path)
  }
  return result
}

function countOccurrences(source, needle) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

async function main() {
  const cutover = JSON.parse(await readFile(join(projectRoot, 'data', 'ruleset-cutover-2014.json'), 'utf8'))
  if (cutover.schema_version !== 1) throw new Error('ruleset cutover inventory must use schema_version 1')
  if (cutover.target?.ruleset_id !== 'dnd_5e_2014') throw new Error('target ruleset must be dnd_5e_2014')
  if (cutover.current_runtime?.ruleset_id !== 'srd_5_2_1') throw new Error('current runtime baseline must remain explicit')

  const [currentPack, targetPack] = await Promise.all([
    loadRulePack(cutover.current_runtime.ruleset_id),
    loadRulePack(cutover.target.ruleset_id),
  ])
  if (!['audit_only', 'preview'].includes(targetPack.manifest.activation_status) && cutover.activation.allowed !== true) {
    throw new Error('target pack cannot become active while process-wide activation is blocked')
  }

  const domains = new Map()
  for (const domain of cutover.domains ?? []) {
    if (!domain?.id || domains.has(domain.id)) throw new Error(`duplicate or empty cutover domain ${domain?.id ?? '<empty>'}`)
    if (!['complete', 'partial', 'pending', 'blocked'].includes(domain.status)) throw new Error(`invalid status for ${domain.id}`)
    if (!Array.isArray(domain.evidence) || !domain.evidence.length) throw new Error(`domain ${domain.id} has no evidence`)
    for (const evidence of domain.evidence) await readFile(resolve(projectRoot, evidence)).catch(() => {
      throw new Error(`domain ${domain.id} references missing evidence ${evidence}`)
    })
    domains.set(domain.id, domain)
  }

  const blockers = [...domains.values()].filter((domain) => domain.status !== 'complete').map((domain) => domain.id)
  if (cutover.activation.allowed === true && blockers.length) {
    throw new Error(`ruleset activation is declared while domains remain incomplete: ${blockers.join(', ')}`)
  }

  const files = (await Promise.all(scanRoots.map((root) => filesBelow(join(projectRoot, root))))).flat()
  const markerSummary = Object.fromEntries(markers.map((marker) => [marker, { occurrences: 0, files: 0 }]))
  for (const path of files) {
    const source = await readFile(path, 'utf8')
    for (const marker of markers) {
      const occurrences = countOccurrences(source, marker)
      if (!occurrences) continue
      markerSummary[marker].occurrences += occurrences
      markerSummary[marker].files += 1
    }
  }

  const report = {
    ok: true,
    activation_allowed: cutover.activation.allowed,
    target_pack: targetPack.summary,
    current_pack: currentPack.summary,
    incomplete_domains: blockers,
    marker_summary: markerSummary,
    scanned_files: files.length,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  if (process.argv.includes('--strict-activation') && !cutover.activation.allowed) process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  process.exitCode = 1
})
