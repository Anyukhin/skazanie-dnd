// Эталон для `clarification_registry.rs`: сценарии операций реестра уточнений
// с детерминированными часами и идентификаторами — прогоном самого JS.
//
//   node rust/crates/sk-narration-base/fixtures/gen-clarification-registry.mjs
//
// Шаг сценария: операция, её аргументы, итог (`result` — строка
// JSON.stringify или ошибка с кодом) и содержимое файла хранилища после шага.
// Rust повторяет шаги и сверяет всё байт в байт.
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClarificationRegistry } from '../../../../server/clarification-registry.mjs'

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(777)
const chance = (p) => random() < p
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const choice = (list) => list[Math.floor(random() * list.length)]
const maybe = (object, key, values, p = 0.85) => { if (chance(p)) object[key] = choice(values) }

// Частые значения повторены: иначе почти каждый шаг упирается в отказ.
const CAMPAIGNS = ['camp', 'camp', 'camp', 'camp', ' camp ', 'ｃａｍｐ', 'camp-2', '', null, 7]
const ACTORS = ['hero', 'hero', 'hero', 'hero', 'other', ' hero\t', '', null]
const VERSIONS = [1, 1, 2, 2, '1', ' 2 ', 1.5, null, 'x', 9007199254740993, -0, true]
const QUESTIONS = ['куда идти?', 'куда идти?', '  что   дальше? ', '', 'q', 'q', 'Какую дверь\nвыбрать?', 'ｑ', 'вопрос '.repeat(90)]
const ACTIONS = ['', 'осмотреться', null, '  открыть   дверь  ', 'действие '.repeat(230)]
const ANSWERS = ['к северным воротам', '', 'ответ', '  да  ', 'ответ '.repeat(340)]
const FINGERPRINTS = ['fp-1', 'fp-1', 'fp-1', '', ' fp-2 ', null, 'f'.repeat(200)]

function randomIntent() {
  return choice([
    () => null,
    () => 'намерение',
    () => [1, 2],
    () => {
      const intent = {}
      maybe(intent, 'actor_id', ['hero', ' ｈｅｒｏ ', null, 5])
      maybe(intent, 'intent', ['clarify', 'attack', '', null])
      maybe(intent, 'approach', ['ask', 'force', '  тихо  '])
      maybe(intent, 'targets', [['goblin', '', '  wolf '], 'goblin', Array.from({ length: 10 }, (_, i) => `t${i}`), [null, 5, { a: 1 }]], 0.6)
      maybe(intent, 'mentioned_entities', [['Мира'], [], ['  ', 'x']], 0.5)
      maybe(intent, 'missing_information', [['цель'], 'цель', null], 0.5)
      maybe(intent, 'free_action_kind', ['social', '', 7], 0.5)
      maybe(intent, 'confidence', [0.75, '0.5', 'abc', null, 1e21, true], 0.6)
      maybe(intent, 'target_candidates', [[{ id: 'g1', name: 'Гоблин', role: 'enemy' }, null, 'x', { id: 5 }], [], Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` })), 'нет'], 0.5)
      maybe(intent, 'action_steps', [['шаг 1', '', 'шаг 2'], [], 'шаг', Array.from({ length: 8 }, (_, i) => `s${i}`)], 0.5)
      maybe(intent, 'constraints', [['не шуметь'], [], ['  ']], 0.4)
      maybe(intent, 'pending_step', ['proposal', 'выбрать дверь', null, '', 0], 0.5)
      return intent
    },
  ])()
}

function options(keys) {
  const result = {}
  if (keys.includes('campaignId')) maybe(result, 'campaignId', CAMPAIGNS, 0.95)
  if (keys.includes('actorId')) maybe(result, 'actorId', ACTORS, 0.95)
  if (keys.includes('stateVersion')) maybe(result, 'stateVersion', VERSIONS, 0.8)
  if (keys.includes('question')) maybe(result, 'question', QUESTIONS, 0.95)
  if (keys.includes('action')) maybe(result, 'action', ACTIONS, 0.6)
  if (keys.includes('answer')) maybe(result, 'answer', ANSWERS, 0.95)
  if (keys.includes('intent')) { if (chance(0.7)) result.intent = randomIntent() }
  if (keys.includes('planFingerprint')) maybe(result, 'planFingerprint', FINGERPRINTS, 0.9)
  if (keys.includes('proposal')) maybe(result, 'proposal', [{ title: 'Маршрут', steps: ['a'] }, { title: 'Маршрут', steps: ['a'] }, { title: 'Маршрут', steps: ['a'] }, { title: '' }, null, { title: 'X', id: 'old' }, { 1: 2, title: 'Y' }, 'строка', { title: 0 }], 0.9)
  return result
}

const ID_OPS = ['resolve', 'complete', 'revokeProposal', 'isProposalRevoked', 'resolveProposal', 'getProposal']

function randomStep(known) {
  const op = choice(['create', 'create', 'create', 'complete', 'issueProposal', 'resolveProposal', 'resolve', 'rememberDialogue', 'rememberDialogue', 'recentDialogue', 'resetDialogue', 'current', 'resolve', 'resolve', 'complete', 'issueProposal', 'issueProposal', 'revokeProposal', 'isProposalRevoked', 'resolveProposal', 'getProposal', 'advance', 'restart'])
  if (op === 'advance') return { op, ms: choice([0, 1000, 1000, 5 * 60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 61 * 60 * 1000]) }
  if (op === 'restart') return { op }
  // Идентификатор своего вида чаще чужого, чтобы доходить до проверок владельца и версии.
  const prefix = op === 'resolve' || op === 'complete' ? 'clarification:' : 'proposal:'
  const own = known.filter((candidate) => candidate.startsWith(prefix))
  // `complete` с идентификатором в пробелах в JS падает на `undefined.completed`
  // (см. отчёт переноса) — такой шаг в эталон не идёт.
  const padded = op === 'complete' ? [] : [` ${choice(own.length ? own : ['x'])} `]
  const id = () => choice([...own, ...own, ...own, ...known, 'clarification:nope', '', null, ...padded])
  switch (op) {
    case 'create': return { op, args: [options(['campaignId', 'actorId', 'stateVersion', 'action', 'question', 'intent'])] }
    case 'rememberDialogue': return { op, args: [options(['campaignId', 'actorId', 'question', 'answer', 'action', 'stateVersion'])] }
    case 'recentDialogue':
    case 'resetDialogue': return { op, args: [options(['campaignId', 'actorId'])] }
    case 'current': return { op, args: [options(['campaignId', 'actorId', 'stateVersion'])] }
    case 'issueProposal': return { op, args: [options(['campaignId', 'actorId', 'stateVersion', 'proposal', 'planFingerprint'])] }
    default: return { op, args: [id(), options(op === 'complete' || op === 'revokeProposal' || op === 'isProposalRevoked' ? ['campaignId', 'actorId'] : ['campaignId', 'actorId', 'stateVersion'])] }
  }
}

function runScenario(name, steps, { ttlMs, seedFile } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clarification-fixture-'))
  const file = join(directory, 'registry.json')
  if (seedFile != null) writeFileSync(file, seedFile)
  const clock = { value: 1_000 }
  let counter = 0
  const config = { storageFile: file, now: () => clock.value, idFactory: () => `id-${++counter}`, ...(ttlMs === undefined ? {} : { ttlMs }) }
  const record = []
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : null)
  let registry
  try {
    registry = new ClarificationRegistry(config)
    let lastFile = read()
    record.push({ op: 'new', file: lastFile })
    const known = []
    for (const step of steps(known)) {
      const entry = { ...step }
      try {
        if (step.op === 'advance') {
          clock.value += step.ms
          entry.result = 'null'
        } else if (step.op === 'restart') {
          registry = new ClarificationRegistry(config)
          entry.result = 'null'
        } else {
          const result = registry[step.op](...step.args)
          entry.result = JSON.stringify(result ?? null)
          for (const candidate of [result?.id, result?.proposal?.id]) if (typeof candidate === 'string' && !known.includes(candidate)) known.push(candidate)
        }
      } catch (error) {
        if (typeof error.code !== 'string') throw new Error(`шаг ${JSON.stringify(step)} упал без кода: ${error.message}`)
        entry.error = { code: error.code, message: error.message }
      }
      // Содержимое хранилища пишется только при изменении; шаг без поля `file`
      // значит «файл прежний».
      const file = read()
      if (file !== lastFile) entry.file = file
      lastFile = file
      record.push(JSON.parse(JSON.stringify(entry)))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return { name, ttlMs: ttlMs ?? null, seedFile: seedFile ?? null, steps: record }
}

const scenarios = []

// Сценарий из JS-теста: шесть записей памяти, чужой аккаунт, сброс, перезапуск, TTL.
scenarios.push(runScenario('dialogue-memory', () => [
  ...Array.from({ length: 8 }, (_, i) => ({ op: 'rememberDialogue', args: [{ campaignId: 'camp', actorId: 'hero', question: `q${i}`, answer: `a${i}` }] })),
  { op: 'rememberDialogue', args: [{ campaignId: 'camp', actorId: 'other', question: 'чужой', answer: 'чужой ответ' }] },
  { op: 'recentDialogue', args: [{ campaignId: 'camp', actorId: 'hero' }] },
  { op: 'resetDialogue', args: [{ campaignId: 'camp', actorId: 'hero' }] },
  { op: 'recentDialogue', args: [{ campaignId: 'camp', actorId: 'other' }] },
  { op: 'restart' },
  { op: 'advance', ms: 60 * 60 * 1000 + 1 },
  { op: 'recentDialogue', args: [{ campaignId: 'camp', actorId: 'other' }] },
]))

// Уточнения и предложения по шагам: повтор, завершение, устаревание, отзыв.
scenarios.push(runScenario('clarify-and-propose', () => [
  { op: 'create', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 3, action: 'открыть дверь', question: 'Какую?', intent: { actor_id: 'hero', intent: 'open', action_steps: ['шаг'], pending_step: 'proposal', target_candidates: [{ id: 'd1', name: 'Дверь', role: 'object' }] } }] },
  { op: 'create', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: '3', action: 'открыть   дверь', question: 'Какую?' }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 3 }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero' }] },
  { op: 'resolve', args: ['clarification:id-1', { campaignId: 'camp', actorId: 'hero', stateVersion: 3 }] },
  { op: 'resolve', args: [' clarification:id-1 ', { campaignId: 'camp', actorId: 'hero', stateVersion: 4 }] },
  { op: 'resolve', args: ['clarification:id-1', { campaignId: 'camp', actorId: 'other' }] },
  { op: 'resolve', args: ['clarification:none', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'create', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 4, question: 'Ещё?' }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 3 }] },
  { op: 'complete', args: ['clarification:id-3', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 4 }] },
  { op: 'create', args: [{ campaignId: 'camp', actorId: '', question: 'Пусто' }] },
  { op: 'issueProposal', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 4, proposal: { title: 'Через лес', steps: ['идти'] }, planFingerprint: 'fp-1' }] },
  { op: 'issueProposal', args: [{ campaignId: 'camp', actorId: 'hero', proposal: { steps: [] }, planFingerprint: 'fp-1' }] },
  { op: 'resolveProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero', stateVersion: 4 }] },
  { op: 'resolveProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero', stateVersion: 5 }] },
  { op: 'isProposalRevoked', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'revokeProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'isProposalRevoked', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'getProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'revokeProposal', args: ['proposal:never', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'isProposalRevoked', args: ['proposal:never', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'restart' },
  { op: 'getProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'other' }] },
  { op: 'advance', ms: 61 * 60 * 1000 },
  { op: 'getProposal', args: ['proposal:id-5', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 4 }] },
]))

// Хранилище из «старой» версии: пары-строки, поля странных типов, записи без срока.
const seedFile = JSON.stringify({
  schema_version: 1,
  entries: [
    ['a', { campaign_id: 'camp', actor_id: 'hero', state_version: '2', question: 'q', action: '', expires_at: 'never' }],
    'xy',
    [10, { campaign_id: 'camp', actor_id: 'hero', state_version: 2, question: 'q2', action: '', original_intent: { action_steps: 'строка' }, expires_at: 5_000 }],
    ['a', { campaign_id: 'camp', actor_id: 'other', state_version: 1, question: 'q3', action: '', original_intent: { action_steps: { length: 2 } }, expires_at: 9e15 }],
  ],
  revoked_proposals: [['camp\u0000hero\u0000p', { expires_at: 2_000 }]],
  proposals: [['p', { campaign_id: 'camp', actor_id: 'hero', state_version: 0, proposal: { title: 'T', id: 'p' }, plan_fingerprint: 'f', expires_at: 1e15, revoked: 'да' }]],
  dialogues: 'не массив',
})
scenarios.push(runScenario('legacy-file', () => [
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 2 }] },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'other', stateVersion: '1' }] },
  { op: 'resolve', args: ['a', { campaignId: 'camp', actorId: 'other', stateVersion: 1 }] },
  { op: 'resolve', args: ['x', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'isProposalRevoked', args: ['p', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'resolveProposal', args: ['p', { campaignId: 'camp', actorId: 'hero' }] },
  { op: 'advance', ms: 4_500 },
  { op: 'current', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 2 }] },
  { op: 'create', args: [{ campaignId: 'camp', actorId: 'hero', stateVersion: 2, question: 'q' }] },
  { op: 'complete', args: ['a', { campaignId: 'camp', actorId: 'other' }] },
], { ttlMs: '120000', seedFile }))

// Случайные сценарии на тесном пространстве значений — много совпадений и отказов.
for (const [index, ttlMs] of [[0, undefined], [1, 60_000], [2, -5], [3, 'abc'], [4, 30 * 60 * 1000], [5, undefined]]) {
  scenarios.push(runScenario(`random-${index}`, (known) => {
    // Генератор шагов ленивый: идентификаторы берутся из уже выданных.
    const steps = []
    return {
      *[Symbol.iterator]() {
        for (let step = 0; step < 90; step += 1) {
          const next = randomStep(known)
          steps.push(next)
          yield next
        }
      },
    }
  }, { ttlMs }))
}

const lines = scenarios.map((scenario) => JSON.stringify(scenario)).join(',\n')
writeFileSync(new URL('./clarification-registry.json', import.meta.url), `[\n${lines}\n]\n`)
const stepCount = scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0)
const errorCount = scenarios.reduce((sum, scenario) => sum + scenario.steps.filter((step) => step.error).length, 0)
console.log(`сценариев ${scenarios.length}, шагов ${stepCount}, из них отказов ${errorCount}`)
