// Тестовые крючки сервера в виде ДАННЫХ: детерминированные кости и сбои вокруг
// журнала. Один и тот же JSON читают JS-сервер (предзагрузка
// `test/kit/server-hooks.mjs`) и будущий Rust-сервер (`src/test_hooks.rs`,
// задача С2), поэтому формат — контракт, а не деталь реализации набора.
//
// Переменные окружения дочернего сервера:
//
// * `DND_TEST_DICE_RULES` — JSON правил костей, формат `skazanie.test-dice/1`;
// * `DND_COMMIT_FAULTS`   — JSON сбоев, формат `skazanie.test-faults/1`.
//
// Сервер обязан принимать их только при `NODE_ENV=test` и хранилище —
// прямом подкаталоге системного временного каталога с именем `skazanie-*`
// (см. `assertHookStorage`); иначе — отказ старта, а не тихое игнорирование.
//
// Регулярные выражения в правилах — общее подмножество JS `RegExp` (флаг `u`)
// и Rust-крейта `regex`: классы, `^`, `$`, `|`, `+`, `*`, `?`, `{m,n}`; без
// lookaround и обратных ссылок. Поиск — частичный (`test`), якоря ставит автор.
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

export const DICE_FORMAT = 'skazanie.test-dice/1'
export const FAULTS_FORMAT = 'skazanie.test-faults/1'
export const DICE_ENV = 'DND_TEST_DICE_RULES'
export const FAULTS_ENV = 'DND_COMMIT_FAULTS'

/** Коды выхода процесса при сбоях `exit-before` / `exit-after`. */
export const FAULT_EXIT_CODES = Object.freeze({ 'exit-before': 70, 'exit-after': 71 })
export const COMMIT_FAULT_MODES = Object.freeze(['throw', 'exit-before', 'exit-after'])

const RULE_KEYS = new Set(['actor', 'purpose', 'sides', 'value', 'values', 'note'])
const UNSAFE_PATTERN = /\(\?[=!<]|\\[1-9]|\\k</u

/**
 * Хранилище, в котором крючки разрешены: прямой подкаталог `os.tmpdir()` с
 * именем `skazanie-*`, и `NODE_ENV=test`.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertHookStorage(env) {
  const storageDir = resolve(String(env.DND_STORAGE_DIR ?? ''))
  const isolated = dirname(storageDir) === resolve(tmpdir()) && /^skazanie-[^/\\]+$/u.test(basename(storageDir))
  if (env.NODE_ENV !== 'test' || !isolated) {
    throw new Error(`Тестовые крючки (${DICE_ENV}, ${FAULTS_ENV}) разрешены только при NODE_ENV=test и хранилище skazanie-* прямо во временном каталоге`)
  }
}

/** @param {unknown} pattern @param {string} where */
function compilePattern(pattern, where) {
  if (pattern === undefined) return null
  if (typeof pattern !== 'string' || !pattern) throw new Error(`${where}: шаблон должен быть непустой строкой`)
  if (UNSAFE_PATTERN.test(pattern)) throw new Error(`${where}: lookaround и обратные ссылки не поддерживает Rust regex`)
  return new RegExp(pattern, 'u')
}

/**
 * @typedef {object} DiceRule
 * @property {string} [actor] шаблон id актора (`''` — бросок без актора)
 * @property {string} [purpose] шаблон назначения броска (`initiative`, `attack`, …)
 * @property {number} [sides] только кости с этим числом граней
 * @property {number | 'max' | 'min'} [value] значение, прижатое к грани
 * @property {number[]} [values] очередь значений; кончилась — `value` или отказ
 * @property {string} [note] комментарий
 */

/**
 * @typedef {object} DiceSpec
 * @property {string} format
 * @property {string} [description]
 * @property {'random' | 'error'} [unmatched] кость без правила: настоящая (по умолчанию) или отказ
 * @property {DiceRule[]} rules первое подходящее правило побеждает
 */

/**
 * Проверить и нормализовать правила костей. Строка — JSON.
 *
 * @param {unknown} input
 * @returns {DiceSpec}
 */
export function parseDiceSpec(input) {
  const spec = typeof input === 'string' ? JSON.parse(input) : input
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Правила костей — JSON-объект')
  const value = /** @type {Record<string, unknown>} */ (spec)
  if (value.format !== DICE_FORMAT) throw new Error(`Правила костей: format должен быть ${DICE_FORMAT}`)
  for (const key of Object.keys(value)) {
    if (!['format', 'description', 'unmatched', 'rules'].includes(key)) throw new Error(`Правила костей: неизвестное поле ${key}`)
  }
  if (value.unmatched !== undefined && value.unmatched !== 'random' && value.unmatched !== 'error') {
    throw new Error('Правила костей: unmatched — random или error')
  }
  if (!Array.isArray(value.rules) || !value.rules.length) throw new Error('Правила костей: rules — непустой массив')
  value.rules.forEach((rule, index) => {
    const where = `Правила костей, rules[${index}]`
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where}: правило — объект`)
    for (const key of Object.keys(rule)) if (!RULE_KEYS.has(key)) throw new Error(`${where}: неизвестное поле ${key}`)
    compilePattern(rule.actor, `${where}.actor`)
    compilePattern(rule.purpose, `${where}.purpose`)
    if (rule.sides !== undefined && !(Number.isSafeInteger(rule.sides) && rule.sides >= 2)) throw new Error(`${where}.sides: целое не меньше 2`)
    if (rule.value === undefined && rule.values === undefined) throw new Error(`${where}: нужно value или values`)
    if (rule.value !== undefined && rule.value !== 'max' && rule.value !== 'min' && !Number.isSafeInteger(rule.value)) {
      throw new Error(`${where}.value: целое, "max" или "min"`)
    }
    if (rule.values !== undefined && !(Array.isArray(rule.values) && rule.values.every((entry) => Number.isSafeInteger(entry)))) {
      throw new Error(`${where}.values: массив целых`)
    }
  })
  return /** @type {DiceSpec} */ (structuredClone(spec))
}

/**
 * Выбор значения одной кости. Возвращает `null`, если правила нет и
 * `unmatched` не `error`: тогда кость бросает настоящий генератор.
 *
 * Состояние (очереди `values`) живёт в замыкании — одно на процесс сервера.
 *
 * @param {DiceSpec} spec
 * @returns {(roll: { actorId?: unknown, purpose?: unknown, minimum: number, maximum: number }) => number | null}
 */
export function createDicePicker(spec) {
  const rules = spec.rules.map((rule) => ({
    rule,
    actor: compilePattern(rule.actor, 'actor'),
    purpose: compilePattern(rule.purpose, 'purpose'),
    queue: [...(rule.values ?? [])],
  }))
  return ({ actorId, purpose, minimum, maximum }) => {
    const actor = String(actorId ?? '')
    const reason = String(purpose ?? '')
    const match = rules.find((entry) => (!entry.actor || entry.actor.test(actor))
      && (!entry.purpose || entry.purpose.test(reason))
      && (entry.rule.sides === undefined || (minimum === 1 && maximum === entry.rule.sides)))
    if (!match) {
      if (spec.unmatched === 'error') {
        throw new RangeError(`Тестовые кости: нет правила для d${maximum} (actor=${actor || '—'}, purpose=${reason || '—'})`)
      }
      return null
    }
    if (match.queue.length) {
      const next = Number(match.queue.shift())
      if (next < minimum || next > maximum) throw new RangeError(`Тестовое значение ${next} не входит в диапазон ${minimum}..${maximum}`)
      return next
    }
    const { value } = match.rule
    if (value === undefined) throw new RangeError(`Тестовые кости: очередь values исчерпана (actor=${actor || '—'}, purpose=${reason || '—'})`)
    if (value === 'max') return maximum
    if (value === 'min') return minimum
    return Math.min(maximum, Math.max(minimum, value))
  }
}

/**
 * @typedef {object} FaultsSpec
 * @property {string} format
 * @property {string} [description]
 * @property {Array<{ idempotency_key: string, mode: 'throw' | 'exit-before' | 'exit-after' }>} [commit]
 *   сбой commit по ключу идемпотентности; каждый срабатывает один раз за жизнь процесса:
 *   `throw` — отказ до записи журнала, `exit-before` — выход 70 до записи,
 *   `exit-after` — журнал записан, выход 71 до ответа
 * @property {Array<{ campaign: string, version: number }>} [projection_ack]
 *   отказ подтверждения проекции кампании (код без учёта регистра) на версии; один раз
 */

/**
 * Проверить и нормализовать описание сбоев. Строка — JSON.
 *
 * @param {unknown} input
 * @returns {FaultsSpec}
 */
export function parseFaultsSpec(input) {
  const spec = typeof input === 'string' ? JSON.parse(input) : input
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Сбои — JSON-объект')
  const value = /** @type {Record<string, unknown>} */ (spec)
  if (value.format !== FAULTS_FORMAT) throw new Error(`Сбои: format должен быть ${FAULTS_FORMAT}`)
  for (const key of Object.keys(value)) {
    if (!['format', 'description', 'commit', 'projection_ack'].includes(key)) throw new Error(`Сбои: неизвестное поле ${key}`)
  }
  const commit = value.commit ?? []
  if (!Array.isArray(commit)) throw new Error('Сбои: commit — массив')
  commit.forEach((entry, index) => {
    if (!entry || typeof entry.idempotency_key !== 'string' || !entry.idempotency_key) throw new Error(`Сбои, commit[${index}]: нужен idempotency_key`)
    if (!COMMIT_FAULT_MODES.includes(entry.mode)) throw new Error(`Сбои, commit[${index}].mode: ${COMMIT_FAULT_MODES.join(' | ')}`)
  })
  const ack = value.projection_ack ?? []
  if (!Array.isArray(ack)) throw new Error('Сбои: projection_ack — массив')
  ack.forEach((entry, index) => {
    if (!entry || typeof entry.campaign !== 'string' || !entry.campaign) throw new Error(`Сбои, projection_ack[${index}]: нужен campaign`)
    if (!Number.isSafeInteger(entry.version) || entry.version < 0) throw new Error(`Сбои, projection_ack[${index}].version: целое ≥ 0`)
  })
  return /** @type {FaultsSpec} */ (structuredClone({ ...value, commit, projection_ack: ack }))
}
