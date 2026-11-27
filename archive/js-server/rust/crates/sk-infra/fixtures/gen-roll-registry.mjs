// Эталон `server/roll-registry.mjs` для `tests/roll_registry_fixture.rs`.
//
// Случайные сценарии (seeded mulberry32): карточки, выдача, потребление,
// резервы, отмены, время, перезапуск, сверка осиротевших резервов. После
// каждой операции записаны её результат и текст durable-файла — Rust
// повторяет сценарий и сравнивает файл байт в байт.
//
// Запуск из корня репозитория:
//   node rust/crates/sk-infra/fixtures/gen-roll-registry.mjs
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DiceService, SequenceDiceRng } from '../../../../server/dice-service.mjs'
import { RollRegistry } from '../../../../server/roll-registry.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const UNDEFINED = { undefined: true }
const pick = (random, list) => list[Math.floor(random() * list.length)]
// Поле со значением UNDEFINED в объект не попадает (как `undefined` в JS).
function options(fields) {
  const result = {}
  for (const [key, value] of Object.entries(fields)) if (value !== UNDEFINED) result[key] = value
  return result
}

const CAMPAIGNS = ['ROOM', 'ROOM', 'OTHER', '', UNDEFINED, 0]
const ACTORS = ['hero', 'hero', 'ally', '', UNDEFINED]
const LABELS = [UNDEFINED, 'Атлетика', 'Скрытность', '', null, 7, 'Очень длинная подпись проверки, которая заведомо длиннее восьмидесяти символов и будет обрезана']
const MODIFIERS = [UNDEFINED, 0, 3, -2, 5, '4', null, 2.5, 150]
const DIFFICULTIES = [UNDEFINED, 10, 15, 0, 100, '12', null, 101, 7.5]
const ABILITIES = [UNDEFINED, null, 'dex', 'str', 5]
const FLAGS = [UNDEFINED, true, false, 1, 0, '']
const VISIBILITIES = [UNDEFINED, 'public', 'party', 'gm_only', 'weird', null]
const CONTEXTS = [
  UNDEFINED, UNDEFINED, null, 0, '',
  { kind: 'free_action', action: 'Прыгаю через ручей', state_version: 3, proposal_id: 'p-1', proposal: { text: 'Прыжок', dc: 12 }, reading: { skill: 'athletics' } },
  { kind: 'ability_action', action: 'Крадусь', state_version: 4, skill: 'stealth', proposal_id: 'p-2' },
  { kind: 'free_action', action: '', state_version: 3 },
  { kind: 'other', action: 'x', state_version: 3, proposal_id: 'p-1' },
  { kind: 'free_action', action: 'Лезу', state_version: '4', reading: { skill: null }, skill: 'climb' },
]
const KEYS = ['turn-1', 'turn-2', 'turn-3', '', UNDEFINED, 0]
const VERSIONS = [3, 4, '3', UNDEFINED, 5]

// `releaseOrphanReservations` асинхронный: чтобы снимок файла после него был
// честным, сценарий исполняется пошагово с ожиданием микрозадач.
async function run(seed) {
  const random = mulberry32(seed)
  const directory = mkdtempSync(join(tmpdir(), 'sk-infra-roll-'))
  const storageFile = join(directory, 'rolls.json')
  let now = 1_000_000
  let checkCounter = 0
  let rollCounter = 0
  const values = Array.from({ length: 4000 }, () => 1 + Math.floor(random() * 20))
  const dice = new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `roll-${++rollCounter}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  const ttlMs = pick(random, [300_000, 600_000])
  const build = () => new RollRegistry({ diceService: dice, ttlMs, now: () => now, checkIdFactory: () => `check-${++checkCounter}`, storageFile })
  let registry = build()
  const steps = []
  const issuedRolls = []
  const knownChecks = []
  const scope = () => options({ campaignId: pick(random, CAMPAIGNS), actorId: pick(random, ACTORS) })
  const mainScope = () => (random() < 0.85 ? { campaignId: 'ROOM', actorId: 'hero' } : scope())
  const recent = (list) => (random() < 0.7 ? list[Math.max(0, list.length - 1 - Math.floor(random() * 3))] : pick(random, list))
  const rollId = () => (issuedRolls.length && random() < 0.9 ? recent(issuedRolls) : pick(random, ['missing', '', null, 'roll-999']))
  const checkId = () => (knownChecks.length && random() < 0.9 ? recent(knownChecks) : pick(random, ['missing', '', null]))
  const count = 60 + Math.floor(random() * 60)
  for (let index = 0; index < count; index += 1) {
    const kind = pick(random, ['register', 'register', 'issue', 'issue', 'issue', 'consume', 'consume', 'consume', 'finish', 'finish', 'get', 'has_open', 'pending', 'invalidate', 'invalidate_proposal', 'advance', 'restart', 'release'])
    const step = { op: kind }
    try {
      if (kind === 'register') {
        step.options = { ...mainScope(), ...options({
          label: pick(random, LABELS), modifier: pick(random, MODIFIERS), difficulty: pick(random, DIFFICULTIES),
          ability: pick(random, ABILITIES), advantage: pick(random, FLAGS), disadvantage: pick(random, FLAGS),
          visibility: pick(random, VISIBILITIES), context: pick(random, CONTEXTS),
        }) }
        step.result = registry.registerCheck(step.options)
        knownChecks.push(step.result.check_id)
      } else if (kind === 'issue') {
        const id = checkId()
        step.options = { ...mainScope(), ...(random() < 0.8 ? { checkId: id } : random() < 0.5 ? { check_id: id } : {}),
          ...(random() < 0.2 ? { label: 'Подмена', modifier: 99, difficulty: 1 } : {}) }
        step.result = registry.issue(step.options)
        if (step.result?.roll_id && !issuedRolls.includes(step.result.roll_id)) issuedRolls.push(step.result.roll_id)
      } else if (kind === 'consume') {
        step.roll_id = rollId()
        step.options = { ...mainScope(), ...options({ idempotencyKey: pick(random, KEYS) }) }
        step.reject_context = random() < 0.1
        step.result = registry.consume(step.roll_id, {
          ...step.options,
          ...(step.reject_context ? { validateContext: () => { throw Object.assign(new Error('Проверка относится к другой заявке'), { code: 'ROLL_CONTEXT_MISMATCH' }) } } : {}),
        })
      } else if (kind === 'finish') {
        step.roll_id = rollId()
        step.options = options({ idempotencyKey: pick(random, KEYS), committed: pick(random, [UNDEFINED, true, false, null, 0, 1]) })
        step.result = registry.finishReservation(step.roll_id, step.options)
      } else if (kind === 'get') {
        step.check_id = checkId()
        step.options = { ...mainScope(), ...options({ includeContext: pick(random, FLAGS) }) }
        step.result = registry.getCheck(step.check_id, step.options)
      } else if (kind === 'has_open') {
        step.options = options({ campaignId: pick(random, CAMPAIGNS), stateVersion: pick(random, VERSIONS) })
        step.result = registry.hasOpenCheck(step.options)
      } else if (kind === 'pending') {
        step.options = { ...mainScope(), ...options({ stateVersion: pick(random, VERSIONS) }) }
        step.result = registry.pendingNarrationCheck(step.options)
      } else if (kind === 'invalidate') {
        step.check_id = checkId()
        step.options = { ...mainScope(), ...options({ reason: pick(random, [UNDEFINED, 'edited', null, 'x'.repeat(100)]) }) }
        step.result = registry.invalidateCheck(step.check_id, step.options)
      } else if (kind === 'invalidate_proposal') {
        step.proposal_id = pick(random, ['p-1', 'p-2', 'missing', ...(knownChecks.length ? [pick(random, knownChecks)] : [])])
        step.options = mainScope()
        step.result = registry.invalidateProposal(step.proposal_id, step.options)
      } else if (kind === 'advance') {
        step.ms = pick(random, [0, 1_000, 5_000, 30_000, 30_000, 299_999, 300_000, 700_000])
        now += step.ms
      } else if (kind === 'restart') {
        registry = build()
      } else if (kind === 'release') {
        step.commits = {}
        for (const key of ['turn-1', 'turn-2', 'turn-3']) step.commits[key] = pick(random, [true, false, 'throw'])
        step.result = await registry.releaseOrphanReservations(async (campaignId, key) => {
          const answer = step.commits[key]
          if (answer === 'throw' || answer === undefined) throw new Error('журнал не прочитан')
          return answer
        })
      }
    } catch (error) {
      step.error = { code: error?.code ?? error?.name, message: error?.message }
      delete step.result
    }
    const file = existsSync(storageFile) ? readFileSync(storageFile, 'utf8') : null
    step.file_sha256 = file == null ? null : createHash('sha256').update(file, 'utf8').digest('hex')
    if (index === count - 1) step.file = file
    steps.push(step)
  }
  rmSync(directory, { recursive: true, force: true })
  return { seed, ttl_ms: ttlMs, dice: values, steps }
}

const cases = []
for (let seed = 1; seed <= 30; seed += 1) cases.push(await run(seed))
writeFileSync(join(here, 'roll-registry.json'), `${JSON.stringify(cases)}\n`, 'utf8')
console.log(`roll-registry: ${cases.length} сценариев, ${cases.reduce((total, entry) => total + entry.steps.length, 0)} операций`)
