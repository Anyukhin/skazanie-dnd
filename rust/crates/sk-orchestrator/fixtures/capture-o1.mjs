import '../../../fixtures-env.mjs'
// Перехват вызовов `server/autonomous-orchestrator.mjs` из тестов JS для
// эталонов О1:
//
//   SK_CAPTURE=<файл> node --import ./capture-o1.mjs --test --test-isolation=none test/….test.mjs
//
// Пишутся две формы записей (по строке JSON):
// - чистые экспорты модуля — `{ fn, test, args, undef? }`;
// - методы оркестратора — `{ method, test, campaignId, args, state, reads,
//   renders, chronicles, awaits, registry }`: состояние журнала на входе
//   (`eventStore.load`), аргументы и ответы внедрённых ролей (судья,
//   рассказчик, летописец) — генератор переиграет вызов на чистом журнале с
//   этими ответами.
// `dotenv/config` подменён пустым модулем: в worktree нет `node_modules`.
import { registerHooks } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const out = process.env.SK_CAPTURE
const limit = Number(process.env.SK_CAPTURE_LIMIT ?? 200)
const PURE = ['partyOrderIds', 'isUnresolvedDeadHero', 'lootOwnerId', 'sceneResolutionProof', 'transitionDecisionMatches', 'materialConsequenceCommands', 'directorStepNarration', 'incapacitatedActionRefusal']
const METHODS = ['runIntent', 'handleUnknownAction', 'runCombat', 'completeEncounter', 'advanceTime', 'bindPromise', 'propagateWitnesses']

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/autonomous-orchestrator.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const pure = PURE.map((name) => `${name} = globalThis.__skO1Pure(${JSON.stringify(name)}, ${name})`).join('\n')
    const methods = METHODS.map((name) => `AutonomousCampaignOrchestrator.prototype.${name} = globalThis.__skO1Method(${JSON.stringify(name)}, AutonomousCampaignOrchestrator.prototype.${name})`).join('\n')
    return { ...result, source: `${source}\n;${pure}\n${methods}\n` }
  },
})

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
let depth = 0
let label = ''
const seen = new Set()
const counts = {}
if (out) writeFileSync(out, '')

function argsOf(args) {
  const undef = []
  const values = args.map((value, index) => {
    if (value === undefined) undef.push(index)
    return value === undefined ? null : plain(value)
  })
  return undef.length ? { args: values, undef } : { args: values }
}

function write(name, key, record) {
  if ((counts[name] ?? 0) >= limit || seen.has(key)) return
  seen.add(key)
  counts[name] = (counts[name] ?? 0) + 1
  appendFileSync(out, `${JSON.stringify(record)}\n`)
}

globalThis.__skO1Pure = (name, fn) => function wrapped(...args) {
  if (depth > 0 || !out || (counts[name] ?? 0) >= limit) return fn(...args)
  try {
    const record = { fn: name, test: label, ...argsOf(args) }
    write(name, sha([name, record.args, record.undef]), record)
  } catch {
    // Аргумент без JSON-формы — вызов не записывается.
  }
  return fn(...args)
}

/** Подменить метод роли на время вызова и записать его ответы. */
function tap(target, method, sink) {
  if (!target || typeof target[method] !== 'function') return () => {}
  const original = target[method]
  target[method] = async function tapped(...args) {
    try {
      const value = await original.apply(this, args)
      sink.push({ ok: plain(value) ?? null })
      return value
    } catch (error) {
      sink.push({ err: { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) } })
      throw error
    }
  }
  return () => { target[method] = original }
}

globalThis.__skO1Method = (name, fn) => async function wrapped(...args) {
  if (depth > 0 || !out || (counts[name] ?? 0) >= limit) return fn.apply(this, args)
  const campaignId = typeof args[0] === 'string' ? args[0] : args[0]?.campaignId
  let loaded = null
  try { loaded = await this.eventStore.load(campaignId) } catch { loaded = null }
  const record = loaded ? {
    method: name, test: label, campaignId, ...argsOf(args), state: plain(loaded.state),
    reads: [], renders: [], chronicles: [],
    awaits: Boolean(this.actionAdjudicator?.llmClient?.completeJson),
    adjudicator: Boolean(this.actionAdjudicator), narrator: Boolean(this.narrator), lore: Boolean(this.loreAuthor), registry: Boolean(this.rollRegistry),
  } : null
  const restore = record ? [
    tap(this.actionAdjudicator, 'read', record.reads),
    tap(this.narrator, 'render', record.renders),
    tap(this.loreAuthor, 'composeArcChronicle', record.chronicles),
  ] : []
  depth += 1
  try {
    return await fn.apply(this, args)
  } finally {
    depth -= 1
    for (const undo of restore) undo()
    if (record) {
      try {
        write(name, sha([name, record.args, record.state, record.reads, record.renders]), record)
      } catch {
        // Запись без JSON-формы пропускается.
      }
    }
  }
}

const { default: test } = await import('node:test')
test.beforeEach?.((context) => { label = context?.name ?? '' })
