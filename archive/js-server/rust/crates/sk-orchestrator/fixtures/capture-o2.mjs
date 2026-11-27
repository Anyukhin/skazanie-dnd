import '../../../fixtures-env.mjs'
// Перехват вызовов `server/game-orchestrator.mjs` из тестов JS для эталонов О2:
//
//   SK_CAPTURE=<файл> node --import ./capture-o2.mjs --test --test-isolation=none test/….test.mjs
//
// Пишутся две формы записей (по строке JSON):
// - чистые экспорты модуля — `{ fn, test, args, undef? }`;
// - внешний вызов `handle(input)` — `{ method: 'handle', test, campaignId,
//   input, state, roles, flags, clarifications }`: вход без функций (метка
//   Режиссёра — поле `__director`), состояние журнала на входе
//   (`eventStore.load`), ответы внедрённых ролей, которые не являются
//   стандартными классами без модели, и снимок реестра уточнений. Генератор
//   переиграет вызов на чистом журнале с этими ответами.
// `dotenv/config` подменён пустым модулем: в worktree нет `node_modules`.
import { registerHooks } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const out = process.env.SK_CAPTURE
const limit = Number(process.env.SK_CAPTURE_LIMIT ?? 200)
const PURE = ['narrationStoryContext', 'narrationNpcReactions', 'withDetailReactions', 'rollPurposeLabel', 'eventsToClientEffects', 'structuredCommandsFingerprint', 'narrationRequestFingerprint', 'speechAddressee', 'spellSpeechFollowUp']

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/game-orchestrator.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const pure = PURE.map((name) => `${name} = globalThis.__skO2Pure(${JSON.stringify(name)}, ${name})`).join('\n')
    const method = 'GameOrchestrator.prototype.handle = globalThis.__skO2Handle(GameOrchestrator.prototype.handle, DIRECTOR_COMMAND_CAPABILITY)'
    return { ...result, source: `${source}\n;${pure}\n${method}\n` }
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

globalThis.__skO2Pure = (name, fn) => function wrapped(...args) {
  if (!out || (counts[name] ?? 0) >= limit) return fn(...args)
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

/** Стандартный класс без модели гоняется настоящим кодом обеих сторон. */
function standard(role, name) {
  return Boolean(role) && role.constructor?.name === name && !role.llmClient
}

const strip = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, field]) => typeof field !== 'function'))
}

globalThis.__skO2Handle = (fn, capability) => async function wrapped(input = {}) {
  if (depth > 0 || !out || (counts.handle ?? 0) >= limit) return fn.call(this, input)
  const campaignId = String(input?.campaignId ?? input?.campaign_id ?? input?.state?.sessionCode ?? input?.state?.campaign_id ?? '')
  let loaded = null
  try { loaded = await this.eventStore.load(campaignId) } catch { loaded = null }
  let record = null
  let restore = []
  if (loaded) {
    try {
      const unknown = this.unknownActionHandler
      const o1 = unknown?.constructor?.name === 'AutonomousCampaignOrchestrator'
      const o1Adjudicator = o1 ? unknown.actionAdjudicator : null
      const registry = this.clarificationRegistry
      record = {
        method: 'handle', test: label, campaignId,
        input: { ...plain(strip({ ...input, commandCapability: undefined })), ...(input?.commandCapability === capability ? { __director: true } : {}) },
        hooks: { start: typeof input?.onNarrationStart === 'function', progress: typeof input?.onNarrationProgress === 'function' },
        state: plain(loaded.state),
        roles: { parse: [], plan: [], render: [], respond: [], retell: [], discuss: [], unknown: [], read: [], search: [] },
        flags: {
          parser: !standard(this.intentParser, 'IntentParser'),
          adjudicator: !standard(this.adjudicator, 'Adjudicator'),
          narrator: this.narrator ? (standard(this.narrator, 'Narrator') ? 'plain' : 'replay') : 'none',
          social: this.npcSocialController ? (standard(this.npcSocialController, 'NpcSocialController') ? 'plain' : 'replay') : 'none',
          lore: this.loreVoice ? (standard(this.loreVoice, 'LoreVoice') ? 'plain' : 'replay') : 'none',
          discuss: !standard(this.actionAdjudicator, 'ActionAdjudicator'),
          unknown: !o1,
          read: o1Adjudicator ? (standard(o1Adjudicator, 'ActionAdjudicator') ? 'plain' : 'replay') : 'none',
          awaits: Boolean(o1Adjudicator?.llmClient?.completeJson),
          retriever: Boolean(this.ruleRetriever),
          trace: Boolean(this.traceStore),
          registry: Boolean(this.rollRegistry),
          o1Registry: Boolean(o1 && unknown.rollRegistry),
        },
        clarifications: registry ? {
          schema_version: 1,
          entries: [...registry.entries.entries()],
          revoked_proposals: [...registry.revokedProposals.entries()],
          proposals: [...registry.proposals.entries()],
          dialogues: [...registry.dialogues.entries()],
        } : null,
      }
      const roles = record.roles
      restore = [
        record.flags.parser ? tap(this.intentParser, 'parse', roles.parse) : () => {},
        record.flags.adjudicator ? tap(this.adjudicator, 'createPlan', roles.plan) : () => {},
        record.flags.narrator === 'replay' ? tap(this.narrator, 'render', roles.render) : () => {},
        record.flags.social === 'replay' ? tap(this.npcSocialController, 'respond', roles.respond) : () => {},
        record.flags.lore === 'replay' ? tap(this.loreVoice, 'retell', roles.retell) : () => {},
        record.flags.discuss ? tap(this.actionAdjudicator, 'discuss', roles.discuss) : () => {},
        record.flags.unknown ? tap(unknown, 'handleUnknownAction', roles.unknown) : () => {},
        record.flags.read === 'replay' ? tap(o1Adjudicator, 'read', roles.read) : () => {},
        record.flags.retriever ? tap(this.ruleRetriever, 'search', roles.search) : () => {},
      ]
    } catch {
      record = null
    }
  }
  depth += 1
  try {
    return await fn.call(this, input)
  } finally {
    depth -= 1
    for (const undo of restore) undo()
    if (record) {
      try {
        write('handle', sha([record.input, record.state, record.roles, record.clarifications?.entries]), record)
      } catch {
        // Запись без JSON-формы пропускается.
      }
    }
  }
}

const { default: test } = await import('node:test')
test.beforeEach?.((context) => { label = context?.name ?? '' })
