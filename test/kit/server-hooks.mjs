// Предзагрузка JS-сервера (`node --import`), которая исполняет тестовые
// крючки из ДАННЫХ: `DND_TEST_DICE_RULES` и `DND_COMMIT_FAULTS` (формат —
// `test/kit/hooks-format.mjs`). Подключает её только `startTestServer`, когда
// тест передал `dice` или `faults`; сам тест предзагрузку не называет — так тот
// же тест без правок идёт и против Rust-бинаря, который читает те же переменные.
//
// Вне `NODE_ENV=test` и своего временного хранилища предзагрузка отказывает
// запуску целиком.
import {
  DICE_ENV,
  FAULTS_ENV,
  FAULT_EXIT_CODES,
  assertHookStorage,
  createDicePicker,
  parseDiceSpec,
  parseFaultsSpec,
} from './hooks-format.mjs'

assertHookStorage(process.env)

const diceSource = process.env[DICE_ENV]
const faultsSource = process.env[FAULTS_ENV]

if (diceSource) {
  const { DiceService } = await import('../../server/dice-service.mjs')
  const pick = createDicePicker(parseDiceSpec(diceSource))
  const originalRoll = DiceService.prototype.roll
  const originalRollD20 = DiceService.prototype.rollD20

  /**
   * Подменить генератор на время одного броска: контекст (актор, назначение)
   * известен только здесь, а грани — только в `randint`.
   *
   * @template T
   * @param {any} service
   * @param {unknown} actorId
   * @param {unknown} purpose
   * @param {() => T} callback
   * @returns {T}
   */
  const withRules = (service, actorId, purpose, callback) => {
    const originalRng = service.rng
    service.rng = {
      randint: (/** @type {number} */ minimum, /** @type {number} */ maximum) => pick({ actorId, purpose, minimum, maximum })
        ?? originalRng.randint(minimum, maximum),
    }
    try {
      return callback()
    } finally {
      service.rng = originalRng
    }
  }

  // Значения по умолчанию те же, что у сигнатур DiceService: правило видит то
  // назначение, которое сервер запишет в бросок.
  DiceService.prototype.roll = function kitRulesRoll(expression, purpose = 'unspecified', actorId = null, visibility = 'public') {
    return withRules(this, actorId, purpose, () => originalRoll.call(this, expression, purpose, actorId, visibility))
  }
  DiceService.prototype.rollD20 = function kitRulesRollD20(options = {}) {
    return withRules(this, options?.actorId ?? null, options?.purpose ?? 'check', () => originalRollD20.call(this, options))
  }
}

if (faultsSource) {
  const { FileEventStore } = await import('../../server/event-store.mjs')
  const spec = parseFaultsSpec(faultsSource)
  const commitFaults = new Map((spec.commit ?? []).map((entry) => [entry.idempotency_key, entry.mode]))
  const ackFaults = (spec.projection_ack ?? []).map((entry) => ({ ...entry, fired: false }))

  const originalCommit = FileEventStore.prototype.commit
  FileEventStore.prototype.commit = async function kitFaultCommit(input = {}) {
    const key = String(input.idempotency_key ?? input.idempotencyKey ?? '')
    const mode = commitFaults.get(key)
    if (!mode) return originalCommit.call(this, input)
    commitFaults.delete(key)
    if (mode === 'exit-before') process.exit(FAULT_EXIT_CODES['exit-before'])
    if (mode === 'exit-after') {
      await originalCommit.call(this, input)
      process.exit(FAULT_EXIT_CODES['exit-after'])
    }
    throw new Error('synthetic commit failure before journal write')
  }

  const originalAcknowledge = FileEventStore.prototype.acknowledgeProjection
  FileEventStore.prototype.acknowledgeProjection = async function kitFaultAcknowledge(campaignId, projectedVersion, options) {
    const fault = ackFaults.find((entry) => !entry.fired
      && entry.campaign.toUpperCase() === String(campaignId).toUpperCase()
      && entry.version === Number(projectedVersion))
    if (fault) {
      fault.fired = true
      throw new Error('synthetic projection acknowledgement failure')
    }
    return originalAcknowledge.call(this, campaignId, projectedVersion, options)
  }
}
