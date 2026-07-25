export const ENGINE_MODES = Object.freeze(['enforce'])
export const RETIRED_ENGINE_MODES = Object.freeze(['legacy', 'shadow'])

const ENGINE_MODE_SET = new Set(ENGINE_MODES)
const RETIRED_ENGINE_MODE_SET = new Set(RETIRED_ENGINE_MODES)

export class EngineModeError extends Error {
  constructor(message, { source = null, value = null } = {}) {
    super(message)
    this.name = 'EngineModeError'
    this.code = 'INVALID_ENGINE_MODE'
    this.source = source
    this.value = value
  }
}

export function isEngineMode(value) {
  return ENGINE_MODE_SET.has(String(value ?? '').trim().toLowerCase())
}

export function normalizeEngineMode(value, { source = null, allowEmpty = false, acceptRetired = true } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowEmpty) return null
    throw new EngineModeError('Режим движка не задан', { source, value })
  }
  const normalized = String(value).trim().toLowerCase()
  if (acceptRetired && RETIRED_ENGINE_MODE_SET.has(normalized)) return 'enforce'
  if (!ENGINE_MODE_SET.has(normalized)) throw new EngineModeError(`Неизвестный режим движка: ${normalized}`, { source, value })
  return normalized
}

const firstDefined = (...values) => values.find((value) => value != null && String(value).trim() !== '')

function modeCandidates(context, environment) {
  return [
    ['test', firstDefined(context.testMode, context.test_mode, context.testOverride, typeof context.test === 'string' ? context.test : null, context.test?.mode, context.test?.engineMode, context.test?.engine_mode, environment.GAME_ENGINE_TEST_MODE)],
    ['user', firstDefined(context.userMode, context.user_mode, context.userOverride, typeof context.user === 'string' ? context.user : null, context.user?.mode, context.user?.engineMode, context.user?.engine_mode, context.user?.game_engine_mode)],
    ['campaign', firstDefined(context.campaignMode, context.campaign_mode, context.campaignOverride, typeof context.campaign === 'string' ? context.campaign : null, context.campaign?.mode, context.campaign?.engineMode, context.campaign?.engine_mode, context.campaign?.game_engine_mode)],
    ['global', firstDefined(context.globalMode, context.global_mode, context.globalOverride, typeof context.global === 'string' ? context.global : null, context.global?.mode, context.global?.engineMode, context.global?.engine_mode, context.global?.game_engine_mode, environment.GAME_ENGINE_MODE)],
  ]
}

/** Runtime is enforce-only. Retired values are read solely so old environment
 * files and snapshots cannot reactivate the removed mutation paths. */
export function explainEngineMode(context = {}, { env = process.env, defaultMode = 'enforce' } = {}) {
  const environment = env && typeof env === 'object' ? env : {}
  for (const [source, value] of modeCandidates(context ?? {}, environment)) {
    if (value == null || String(value).trim() === '') continue
    const raw = String(value).trim().toLowerCase()
    const mode = normalizeEngineMode(raw, { source })
    return RETIRED_ENGINE_MODE_SET.has(raw)
      ? { mode, source, retired_value: raw }
      : { mode, source }
  }
  return { mode: normalizeEngineMode(defaultMode, { source: 'default' }), source: 'default' }
}

export function resolveEngineMode(context = {}, options = {}) {
  return explainEngineMode(context, options).mode
}

export class EngineModeResolver {
  constructor({ env = process.env, defaultMode = 'enforce' } = {}) {
    this.env = env
    this.defaultMode = normalizeEngineMode(defaultMode, { source: 'default' })
  }
  resolve(context = {}) { return resolveEngineMode(context, { env: this.env, defaultMode: this.defaultMode }) }
  explain(context = {}) { return explainEngineMode(context, { env: this.env, defaultMode: this.defaultMode }) }
}
