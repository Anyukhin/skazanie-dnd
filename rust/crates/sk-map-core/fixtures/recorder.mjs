// Запись вызовов модулей sk-map-core изнутри настоящих генераторов карт.
//
// Генераторы (`building-generator`, `settlement-generator`, `scene-themes`,
// `level-generator`) зовут `thinWalls`, `applyRoomFloors`, `raiseDais`,
// `deepestRoom`, `auditTacticalMap`, `programReport` на промежуточных картах,
// которых снаружи не видно. Хук загрузки модулей (`module.registerHooks`)
// дописывает в конец этих файлов переприсваивание экспортов обёрткой —
// привязка функции в модуле изменяема, и импортёры видят обёртку. Исходники
// `server/` на диске не меняются.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, а серверные модули грузить
// после этого динамическим `import()`: статические импорты связываются раньше,
// чем хук успеет встать.
import { registerHooks } from 'node:module'

const TARGETS = {
  'server/thin-walls.mjs': ['thinWalls'],
  'server/room-floors.mjs': ['applyRoomFloors'],
  'server/scene-features.mjs': ['raiseDais', 'deepestRoom'],
  'server/map-quality.mjs': ['auditTacticalMap', 'programReport'],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__mapCoreWrap(${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

globalThis.__mapCoreWrap = (name, fn) => function recorded(...args) {
  const recorder = globalThis.__mapCoreRecorder
  return recorder ? recorder(name, fn, args) : fn(...args)
}

/**
 * Записывающий перехватчик: каждый вызов из `names` исполняется дважды — на
 * копии карты, прочитанной из сериализации (это эталон: Rust получает ровно
 * эту карту), и на настоящей карте генератора (её результат уходит дальше).
 * Совпадение двух исполнений — `agrees`.
 *
 * `extras[name]` — что ещё снять с той же прочитанной карты перед вызовом
 * (например, аудит карты, на которой проверяют программу сцены).
 *
 * @param {typeof import('../../../../server/tactical-map.mjs')} t
 * @param {Set<string>} names
 * @param {Record<string, (map: any) => unknown>} [extras]
 */
export function startRecording(t, names, extras = {}) {
  const calls = []
  let depth = 0
  const serialize = (map) => JSON.stringify(t.serializeTacticalMap(map))
  const restore = (text) => t.deserializeTacticalMap(JSON.parse(text))
  globalThis.__mapCoreRecorder = (name, fn, args) => {
    if (depth > 0 || !names.has(name)) return fn(...args)
    depth += 1
    try {
      const [map, ...rest] = args
      const before = serialize(map)
      const copy = restore(before)
      // Карта, какой её видит читатель: порядок ключей зоны после чтения свой.
      const canonicalBefore = serialize(copy)
      const input = inputOf(name, map, rest)
      const extra = extras[name] ? extras[name](restore(before)) : undefined
      let expected
      let failure = null
      try {
        expected = fn(copy, ...rest)
      } catch (error) {
        failure = error
      }
      const after = serialize(copy)
      let real
      let realFailure = null
      try {
        real = fn(map, ...rest)
      } catch (error) {
        realFailure = error
      }
      const realAfter = serialize(map)
      const sameResult = JSON.stringify(real ?? null) === JSON.stringify(expected ?? null)
        && String(realFailure?.message ?? '') === String(failure?.message ?? '')
      const canonicalAfter = serialize(restore(after))
      // `agrees` — карта в памяти и прочитанная копия дали одно и то же;
      // `agreesAfterRead` — одно и то же после чтения (расходится только
      // порядок ключей зоны, см. отчёт переноса).
      const agrees = realAfter === after && sameResult
      const agreesAfterRead = serialize(restore(realAfter)) === canonicalAfter && sameResult
      calls.push({
        name, mapRef: map, before: canonicalBefore, input,
        result: failure ? { error: { name: failure.name, code: failure.code ?? null, message: failure.message } } : { ok: expected ?? null },
        after, canonicalAfter, agrees, agreesAfterRead, ...(extra === undefined ? {} : { extra }),
      })
      if (realFailure) throw realFailure
      return real
    } finally {
      depth -= 1
    }
  }
  return {
    calls,
    stop() {
      globalThis.__mapCoreRecorder = undefined
    },
  }
}

/** Входы вызова, кроме карты, в виде JSON. */
function inputOf(name, map, rest) {
  switch (name) {
    case 'thinWalls':
      return { options: rest[0] ?? null }
    case 'applyRoomFloors': {
      const options = rest[0] ?? {}
      // Предикат зон — функцией; эталон хранит, что он ответил по каждой зоне.
      const zones = typeof options.zones === 'function' ? map.zones.map((zone) => Boolean(options.zones(zone))) : null
      const { zones: _zones, ...plain } = options
      return { options: plain, zones }
    }
    case 'raiseDais':
      return { zoneId: rest[0], options: rest[1] ?? null }
    case 'deepestRoom':
    case 'auditTacticalMap':
      return {}
    case 'programReport':
      return { program: rest[0] ?? null, options: rest[1] ?? null }
    default:
      throw new Error(`неизвестная функция ${name}`)
  }
}

/**
 * Вызовы одной карты подряд — цепочка: если карта перед вызовом (после
 * чтения) совпадает с эталоном после предыдущего вызова той же карты (тоже
 * после чтения), вход не хранится — Rust продолжает своей картой, прочитанной
 * заново. Иначе — полная сериализация.
 */
export function chainsOf(calls, { keep = () => true } = {}) {
  const chains = []
  const state = new WeakMap()
  for (const call of calls) {
    const previous = state.get(call.mapRef)
    const entry = { fn: call.name, input: call.input, result: call.result, after: call.after, agrees: call.agrees, agreesAfterRead: call.agreesAfterRead, ...(call.extra === undefined ? {} : { extra: call.extra }) }
    if (previous && previous.after === call.before) {
      previous.chain.calls.push(entry)
    } else {
      if (!keep(call)) continue
      const chain = { before: JSON.parse(call.before), calls: [entry] }
      chains.push(chain)
      state.set(call.mapRef, { chain, after: call.canonicalAfter })
      continue
    }
    previous.after = call.canonicalAfter
  }
  return chains
}
