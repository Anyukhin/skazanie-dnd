import { createServer } from 'node:net'

/**
 * Свободный порт на 127.0.0.1 для тестового сервера.
 *
 * Раньше эта функция жила копией в каждом HTTP-тесте — 59 копий в 12
 * вариантах записи с одним и тем же смыслом: занять порт 0, прочитать
 * выданный номер и отпустить его.
 *
 * @returns {Promise<number>}
 */
export async function freePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve(undefined)))
  return port
}
