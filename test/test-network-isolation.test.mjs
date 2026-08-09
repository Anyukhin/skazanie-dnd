// Корпус тестов не ходит в интернет. Сторож написан по конкретной аварии, а не
// из осторожности: `party-interaction-api` и `solo-party-exit-api` поднимали
// сервер с непустым `ROUTERAI_API_KEY` и адресом провайдера по умолчанию. Ключ
// был выдуманный, но серверу это неизвестно — он честно стучался в routerai.ru,
// ждал таймаут соединения на каждой модели каскада и только потом уходил в тот
// самый детерминированный fallback, который тест и проверял. Прогон плавал от
// полутора секунд до минуты с лишним и падал по таймауту на медленной сети.
//
// Правило простое: **каждый** запуск `server/index.mjs` либо оставляет ключ
// пустым (LLM не настроен, все пути детерминированные), либо подставляет свой
// локальный провайдер через `ROUTERAI_BASE_URL`.
//
// Самый дорогой случай — не выдуманный ключ, а его отсутствие. `server/index.mjs`
// первой строкой делает `import 'dotenv/config'`, в рабочем дереве владельца
// лежит `.env` с настоящим ключом, и dotenv не перезаписывает уже заданные
// переменные. Поэтому `ROUTERAI_API_KEY: ''` безопасен, а запуск, где поля нет
// вовсе, наследует боевой ключ и уходит в настоящий routerai.ru за настоящие
// деньги. Отсутствие поля здесь — нарушение наравне с чужим адресом.
//
// Проверка идёт по каждому `spawn`, а не по файлу целиком: файл с двумя
// запусками — первый с локальной заглушкой, второй голый — раньше белился
// целиком по первому совпадению.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDir = fileURLToPath(new URL('.', import.meta.url))
const selfName = basename(fileURLToPath(import.meta.url))

const SERVER_LAUNCH = /spawn\(\s*process\.execPath\s*,\s*\[\s*'server\/index\.mjs'\s*\]/gu

/** @param {string} address */
function addressStaysOnThisMachine(address) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/u.test(address)
}

/**
 * Адрес заглушки подставляется переменной с портом локального сервера, поэтому
 * строкой в env его не увидеть. Идентификатор разрешается по файлу — по его
 * строковым присваиваниям, — и «локальным» считается только адрес, который явно
 * указывает на эту машину. Голое имя без единого присваивания локального адреса
 * не засчитывается: `ROUTERAI_BASE_URL: someRemoteUrl` — такой же выход наружу,
 * как записанный домен.
 *
 * @param {string} envSource текст литерала `env` одного запуска
 * @param {string} fileSource весь файл — в нём ищется значение идентификатора
 */
function providerStaysOnThisMachine(envSource, fileSource = envSource) {
  const declared = envSource.match(/ROUTERAI_BASE_URL:\s*([^,\n]+)/u)
  if (!declared) return false
  const value = declared[1].trim().replace(/,$/u, '')
  const literal = value.match(/^[`'"]([^`'"]*)/u)
  if (literal) return addressStaysOnThisMachine(literal[1])
  if (!/^[A-Za-z_$][\w$]*$/u.test(value)) return false
  const bindings = [...fileSource.matchAll(new RegExp(`\\b${value}\\s*[:=]\\s*[\`'"]([^\`'"]*)`, 'gu'))]
    .map((match) => match[1])
  return bindings.length > 0 && bindings.every(addressStaysOnThisMachine)
}

/**
 * Литерал `env: { … }` того запуска, с которого начинается кусок исходника.
 * Скобки считаются, поэтому вложенные объекты и `${…}` внутри шаблонов не сбивают
 * границу.
 *
 * @param {string} region
 * @returns {string | null}
 */
function envLiteralIn(region) {
  const marker = region.indexOf('env:')
  if (marker < 0) return null
  const open = region.indexOf('{', marker)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < region.length; index += 1) {
    if (region[index] === '{') depth += 1
    else if (region[index] === '}') {
      depth -= 1
      if (depth === 0) return region.slice(open, index + 1)
    }
  }
  return null
}

/**
 * @param {string} region кусок исходника от `spawn` до следующего запуска
 * @param {string} fileSource
 * @returns {string | null} причина нарушения или `null`
 */
function launchOffence(region, fileSource) {
  const env = envLiteralIn(region)
  if (env === null) return 'запуск без собственного env — настоящий ключ владельца наследуется из окружения'
  const declared = env.match(/ROUTERAI_API_KEY:\s*([^,\n]+)/u)
  if (!declared) return 'ROUTERAI_API_KEY не задан вовсе — наследуется настоящий ключ из .env владельца'
  const value = declared[1].trim().replace(/,$/u, '')
  const literal = value.match(/^'([^']*)'$|^"([^"]*)"$|^`([^`]*)`$/u)
  if (literal && !(literal[1] ?? literal[2] ?? literal[3] ?? '').trim()) return null
  if (providerStaysOnThisMachine(env, fileSource)) return null
  return 'ROUTERAI_API_KEY не пуст, а локальный ROUTERAI_BASE_URL не подставлен — запуск уйдёт в настоящую сеть'
}

/**
 * @param {string} name
 * @param {string} source
 * @returns {string[]}
 */
function networkOffences(name, source) {
  const launches = [...source.matchAll(SERVER_LAUNCH)].map((match) => match.index)
  return launches.flatMap((index, order) => {
    const region = source.slice(index, launches[order + 1] ?? source.length)
    const offence = launchOffence(region, source)
    return offence ? [`${name}: ${offence}`] : []
  })
}

test('тесты, поднимающие сервер, не стучатся в настоящего провайдера LLM', () => {
  const offenders = []
  for (const name of readdirSync(testDir)) {
    if (!name.endsWith('.test.mjs')) continue
    // Собственные запуски есть только в образцах ниже, и часть из них нарушает
    // правило намеренно.
    if (name === selfName) continue
    offenders.push(...networkOffences(name, readFileSync(join(testDir, name), 'utf8')))
  }
  assert.deepEqual(offenders, [])
})

const LAUNCH = "  const child = spawn(process.execPath, ['server/index.mjs'], {\n    cwd: process.cwd(),\n"

test('запуск без ROUTERAI_API_KEY — нарушение: ключ наследуется из .env владельца', () => {
  const source = `${LAUNCH}    env: { ...process.env, AGENT_PORT: String(port), ADMIN_SETUP_TOKEN: 'setup' },\n  })\n`
  assert.deepEqual(networkOffences('образец', source), [
    'образец: ROUTERAI_API_KEY не задан вовсе — наследуется настоящий ключ из .env владельца',
  ])
})

test('запуск вообще без env — нарушение', () => {
  assert.deepEqual(networkOffences('образец', `${LAUNCH}    stdio: 'ignore',\n  })\n`), [
    'образец: запуск без собственного env — настоящий ключ владельца наследуется из окружения',
  ])
})

test('пустой ключ и локальная заглушка нарушением не считаются', () => {
  const empty = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'setup' },\n  })\n`
  assert.deepEqual(networkOffences('образец', empty), [])

  const stub = `${LAUNCH}    env: {\n      ...process.env,\n      ROUTERAI_API_KEY: 'fake-key',\n      ROUTERAI_BASE_URL: routerBaseUrl,\n    },\n  })\n`
    + '  const options = { routerBaseUrl: `http://127.0.0.1:${routerPort}/api/v1` }\n'
  assert.deepEqual(networkOffences('образец', stub), [])
})

test('второй запуск в том же файле проверяется отдельно от первого', () => {
  const source = `${LAUNCH}    env: {\n      ...process.env,\n      ROUTERAI_API_KEY: 'fake-key',\n      ROUTERAI_BASE_URL: 'http://127.0.0.1:41234/api/v1',\n    },\n  })\n`
    + `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: 'fake-key' },\n  })\n`
  assert.deepEqual(networkOffences('образец', source), [
    'образец: ROUTERAI_API_KEY не пуст, а локальный ROUTERAI_BASE_URL не подставлен — запуск уйдёт в настоящую сеть',
  ])
})

test('внешний адрес не белит запуск — ни строкой, ни через переменную', () => {
  const literal = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: 'fake-key', ROUTERAI_BASE_URL: 'https://routerai.ru/api/v1' },\n  })\n`
  const remote = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: 'fake-key', ROUTERAI_BASE_URL: someRemoteUrl },\n  })\n`
    + "  const someRemoteUrl = 'https://routerai.ru/api/v1'\n"
  const unresolved = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: 'fake-key', ROUTERAI_BASE_URL: mysteryUrl },\n  })\n`
  const reason = 'образец: ROUTERAI_API_KEY не пуст, а локальный ROUTERAI_BASE_URL не подставлен — запуск уйдёт в настоящую сеть'
  assert.deepEqual(networkOffences('образец', literal), [reason])
  assert.deepEqual(networkOffences('образец', remote), [reason])
  assert.deepEqual(networkOffences('образец', unresolved), [reason])
})

test('ключ выражением засчитывается только вместе с локальной заглушкой', () => {
  // Пустоту `process.env.SOMETHING` в исходнике не доказать, поэтому такой
  // запуск обязан объявить локальный адрес.
  const bare = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: apiKey },\n  })\n`
  assert.equal(networkOffences('образец', bare).length, 1)
  const stubbed = `${LAUNCH}    env: { ...process.env, ROUTERAI_API_KEY: apiKey, ROUTERAI_BASE_URL: 'http://localhost:41234/api/v1' },\n  })\n`
  assert.deepEqual(networkOffences('образец', stubbed), [])
})
