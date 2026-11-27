// Аудит онтологии памяти мира: какие предикаты фактов и отношения сущностей
// пишутся модулями server/*.mjs, какие читаются, и где они расходятся.
//
//   node eval/ontology-audit-2026-10-01.mjs [выходной.json]
//
// Сканер — `scanOntologyUsage`/`auditOntology` из server/world-ontology.mjs
// (чистые функции над текстом, без fs). Этот скрипт читает файлы, сверяет
// результат с реестром PREDICATES/RELATIONS и отдельно прогоняет вариант, где
// server/world-memory.mjs взят из HEAD (`git show`), — чтобы показать, что
// аудит ловит разрыв `discovery`, существовавший до правки
// `freeActionDiscoveryCommands`.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'

import {
  auditOntology,
  EXTERNAL_ONLY_PREDICATES,
  PREDICATES,
  RELATIONS,
} from '../server/world-ontology.mjs'

const root = resolve(import.meta.dirname, '..')
const serverDir = join(root, 'server')
// --without-registry: снимок «до» — реестра ещё не было, сверяется только код.
const withoutRegistry = process.argv.includes('--without-registry')
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const output = outputArgument ? resolve(outputArgument) : null

function serverFiles() {
  return readdirSync(serverDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => ({ file: name.replace(/\.mjs$/u, ''), source: readFileSync(join(serverDir, name), 'utf8') }))
}

function headSource(relativePath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

function registryCheck(audit) {
  const registeredPredicate = (name) => Object.hasOwn(PREDICATES, name)
    || Object.keys(PREDICATES).some((key) => key.endsWith(':') && name.startsWith(key))
  const producedUnregistered = Object.entries(audit.predicates)
    .filter(([name, entry]) => entry.producers.length && !registeredPredicate(name)).map(([name]) => name)
  const consumedUnregistered = Object.entries(audit.predicates)
    .filter(([name, entry]) => entry.consumers.length && !registeredPredicate(name)).map(([name]) => name)
  const relationsUnregistered = Object.keys(audit.relations).filter((name) => !Object.hasOwn(RELATIONS, name))
  const stale = []
  for (const [name, entry] of Object.entries(PREDICATES)) {
    const scanned = audit.predicates[name] ?? { producers: [], consumers: [] }
    if (JSON.stringify([...entry.producers].sort()) !== JSON.stringify(scanned.producers)) stale.push({ name, field: 'producers', registry: entry.producers, scanned: scanned.producers })
    if (JSON.stringify([...entry.consumers].sort()) !== JSON.stringify(scanned.consumers)) stale.push({ name, field: 'consumers', registry: entry.consumers, scanned: scanned.consumers })
  }
  const consumedWithoutCodeProducer = Object.entries(PREDICATES)
    .filter(([, entry]) => entry.consumers.length && !entry.producers.length).map(([name]) => name)
  return {
    registered_predicates: Object.keys(PREDICATES).length,
    registered_relations: Object.keys(RELATIONS).length,
    produced_unregistered: producedUnregistered,
    consumed_unregistered: consumedUnregistered,
    relations_unregistered: relationsUnregistered,
    stale_entries: stale,
    consumed_without_code_producer: consumedWithoutCodeProducer,
    declared_external_only: [...EXTERNAL_ONLY_PREDICATES],
  }
}

function summary(audit) {
  return {
    predicates_seen: Object.keys(audit.predicates).length,
    predicates_produced: Object.values(audit.predicates).filter((entry) => entry.producers.length).length,
    predicates_consumed: Object.values(audit.predicates).filter((entry) => entry.consumers.length).length,
    relations_seen: Object.keys(audit.relations).length,
    consumed_but_never_produced: audit.gaps.consumed_but_never_produced.predicates.length + audit.gaps.consumed_but_never_produced.relations.length,
    produced_but_never_consumed: audit.gaps.produced_but_never_consumed.predicates.length + audit.gaps.produced_but_never_consumed.relations.length,
    dynamic_produced_sites: audit.dynamic.produced.length,
    dynamic_consumed_sites: audit.dynamic.consumed.length,
  }
}

const files = serverFiles()
const started = performance.now()
const current = auditOntology(files)
const elapsed = performance.now() - started

const headWorldMemory = headSource('server/world-memory.mjs')
const headAudit = headWorldMemory == null
  ? null
  : auditOntology(files.map((entry) => entry.file === 'world-memory' ? { ...entry, source: headWorldMemory } : entry))

const report = {
  generated_at: new Date().toISOString(),
  scope: 'server/*.mjs',
  files_scanned: files.length,
  scan_ms: Math.round(elapsed * 10) / 10,
  summary: summary(current),
  gaps: current.gaps,
  registry_check: withoutRegistry ? null : registryCheck(current),
  head_world_memory_variant: headAudit && {
    note: 'server/world-memory.mjs взят из HEAD (до freeActionDiscoveryCommands), остальные модули — из рабочего дерева',
    summary: summary(headAudit),
    consumed_but_never_produced: headAudit.gaps.consumed_but_never_produced,
  },
  predicates: current.predicates,
  relations: current.relations,
  dynamic: current.dynamic,
}

const text = `${JSON.stringify(report, null, 2)}\n`
if (output) writeFileSync(output, text, 'utf8')
process.stdout.write(JSON.stringify({ summary: report.summary, gaps: report.gaps, registry_check: report.registry_check, head: report.head_world_memory_variant }, null, 2))
process.stdout.write('\n')
