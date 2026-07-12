export const ENGINE_MODES = Object.freeze(['legacy', 'shadow', 'enforce'])

const ENGINE_MODE_SET = new Set(ENGINE_MODES)

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

export function normalizeEngineMode(value, { source = null, allowEmpty = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowEmpty) return null
    throw new EngineModeError('Режим движка не задан', { source, value })
  }

  const normalized = String(value).trim().toLowerCase()
  if (!ENGINE_MODE_SET.has(normalized)) {
    throw new EngineModeError(`Неизвестный режим движка: ${normalized}`, { source, value })
  }
  return normalized
}

function firstDefined(...values) {
  return values.find((value) => value != null && String(value).trim() !== '')
}

function modeCandidates(context, environment) {
  const test = firstDefined(
    context.testMode,
    context.test_mode,
    context.testOverride,
    typeof context.test === 'string' ? context.test : null,
    context.test?.mode,
    context.test?.engineMode,
    context.test?.engine_mode,
    environment.GAME_ENGINE_TEST_MODE,
  )
  const user = firstDefined(
    context.userMode,
    context.user_mode,
    context.userOverride,
    typeof context.user === 'string' ? context.user : null,
    context.user?.mode,
    context.user?.engineMode,
    context.user?.engine_mode,
    context.user?.game_engine_mode,
  )
  const campaign = firstDefined(
    context.campaignMode,
    context.campaign_mode,
    context.campaignOverride,
    typeof context.campaign === 'string' ? context.campaign : null,
    context.campaign?.mode,
    context.campaign?.engineMode,
    context.campaign?.engine_mode,
    context.campaign?.game_engine_mode,
  )
  const global = firstDefined(
    context.globalMode,
    context.global_mode,
    context.globalOverride,
    typeof context.global === 'string' ? context.global : null,
    context.global?.mode,
    context.global?.engineMode,
    context.global?.engine_mode,
    context.global?.game_engine_mode,
    environment.GAME_ENGINE_MODE,
  )

  return [
    ['test', test],
    ['user', user],
    ['campaign', campaign],
    ['global', global],
  ]
}

/**
 * Resolves a feature flag without silently accepting a misspelled high-priority
 * override. Precedence is always test > user > campaign > global > legacy.
 */
export function explainEngineMode(context = {}, { env = process.env, defaultMode = 'legacy' } = {}) {
  const environment = env && typeof env === 'object' ? env : {}
  for (const [source, value] of modeCandidates(context ?? {}, environment)) {
    if (value == null || String(value).trim() === '') continue
    return { mode: normalizeEngineMode(value, { source }), source }
  }
  return { mode: normalizeEngineMode(defaultMode, { source: 'default' }), source: 'default' }
}

export function resolveEngineMode(context = {}, options = {}) {
  return explainEngineMode(context, options).mode
}

export class EngineModeResolver {
  constructor({ env = process.env, defaultMode = 'legacy' } = {}) {
    this.env = env
    this.defaultMode = normalizeEngineMode(defaultMode, { source: 'default' })
  }

  resolve(context = {}) {
    return resolveEngineMode(context, { env: this.env, defaultMode: this.defaultMode })
  }

  explain(context = {}) {
    return explainEngineMode(context, { env: this.env, defaultMode: this.defaultMode })
  }
}
