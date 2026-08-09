// Корпус тестов не ходит в интернет. Сторож написан по конкретной аварии, а не
// из осторожности: `party-interaction-api` и `solo-party-exit-api` поднимали
// сервер с непустым `ROUTERAI_API_KEY` и адресом провайдера по умолчанию. Ключ
// был выдуманный, но серверу это неизвестно — он честно стучался в routerai.ru,
// ждал таймаут соединения на каждой модели каскада и только потом уходил в тот
// самый детерминированный fallback, который тест и проверял. Прогон плавал от
// полутора секунд до минуты с лишним и падал по таймауту на медленной сети.
//
// Правило простое: тест, поднимающий `server/index.mjs`, либо оставляет ключ
// пустым (LLM не настроен, все пути детерминированные), либо подставляет свой
// локальный провайдер через `ROUTERAI_BASE_URL`.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const testDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Адрес заглушки подставляется переменной с портом локального сервера, поэтому
 * строкой в исходнике его не увидеть. Значение имеет лишь то, что поле вообще
 * задано и не указывает наружу явным доменом.
 */
function providerStaysOnThisMachine(source) {
  const declared = source.match(/ROUTERAI_BASE_URL:\s*([^,\n]+)/u)
  if (!declared) return false
  const value = declared[1].trim()
  return !/https?:\/\//u.test(value) || /https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/u.test(value)
}

test('тесты, поднимающие сервер, не стучатся в настоящего провайдера LLM', () => {
  const offenders = []
  for (const name of readdirSync(testDir)) {
    if (!name.endsWith('.test.mjs')) continue
    const source = readFileSync(join(testDir, name), 'utf8')
    if (!source.includes("'server/index.mjs'")) continue
    const keys = [...source.matchAll(/ROUTERAI_API_KEY:\s*'([^']*)'/gu)].map((match) => match[1])
    if (!keys.some((key) => key.trim())) continue
    if (providerStaysOnThisMachine(source)) continue
    offenders.push(name)
  }
  assert.deepEqual(offenders, [],
    'непустой ROUTERAI_API_KEY без локального ROUTERAI_BASE_URL уводит тест в настоящую сеть')
})

test('распознавание локального провайдера не пропускает внешний адрес', () => {
  assert.equal(providerStaysOnThisMachine("      ROUTERAI_BASE_URL: routerBaseUrl,\n"), true)
  assert.equal(providerStaysOnThisMachine("      ROUTERAI_BASE_URL: 'http://127.0.0.1:41234/api/v1',\n"), true)
  assert.equal(providerStaysOnThisMachine("      ROUTERAI_BASE_URL: 'https://routerai.ru/api/v1',\n"), false)
  assert.equal(providerStaysOnThisMachine("      ADMIN_SETUP_TOKEN: 'setup',\n"), false)
})
