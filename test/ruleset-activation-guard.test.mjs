import assert from 'node:assert/strict'
import test from 'node:test'

import { startTestServer } from './kit/http.mjs'

test('campaign-selectable D&D 2014 preview cannot become the process-wide runtime default', { timeout: 10_000 }, async (t) => {
  // Сервер обязан отказаться стартовать: кит сообщает выход до health кодом
  // процесса и хвостом его вывода.
  const failure = await startTestServer(t, {
    storagePrefix: 'skazanie-ruleset-guard-',
    env: { DND_DEFAULT_RULESET_ID: 'dnd_5e_2014' },
  }).then(() => null, (error) => error)
  assert.ok(failure instanceof Error, 'сервер не должен был дойти до health')
  const exited = /^Тестовый сервер завершился до health: exit=(\S+), signal=/u.exec(failure.message)
  assert.ok(exited, failure.message)
  const exitCode = exited[1] === 'null' ? null : Number(exited[1])
  const output = failure.message
  assert.notEqual(exitCode, 0)
  assert.match(output, /dnd_5e_2014.*process-wide runtime default/u)
})
