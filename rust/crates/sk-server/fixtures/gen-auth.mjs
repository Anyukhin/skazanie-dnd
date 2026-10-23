// Эталон «Г» входа и сессий: `node rust/crates/sk-server/fixtures/gen-auth.mjs`
// пишет `fixtures/auth.json`; сверка — `tests/auth_golden.rs`.
import '../../../fixtures-env.mjs'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }

const { server, close } = await startGoldenServer()
try {
  const { send, exchanges } = recorder(server)
  await send('anon', 'GET', '/api/auth/me')
  await send('anon', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'неверный' } })
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' }, responseHeaders: ['set-cookie'] })
  await send('admin', 'GET', '/api/auth/me')
  await send('anon', 'POST', '/api/auth/setup-admin', { body: { ...PLAYER, email: 'other@mail.ru', setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER, responseHeaders: ['set-cookie'] })
  await send('anon', 'POST', '/api/auth/register', { body: PLAYER })
  await send('anon', 'POST', '/api/auth/register', { body: { ...PLAYER, email: 'не-почта' } })
  await send('anon', 'POST', '/api/auth/register', { body: { ...PLAYER, email: 'short@mail.ru', password: 'коротко' } })
  await send('anon', 'POST', '/api/auth/login', { body: { email: PLAYER.email, password: 'неверный-пароль' } })
  await send('second', 'POST', '/api/auth/login', { body: { email: PLAYER.email.toUpperCase(), password: PLAYER.password } })
  await send('second', 'GET', '/api/auth/me')
  await send('admin', 'GET', '/api/admin/users')
  await send('player', 'GET', '/api/admin/users')
  await send('second', 'POST', '/api/auth/logout', { responseHeaders: ['set-cookie'] })
  await send('second', 'GET', '/api/auth/me')
  await send('player', 'GET', '/api/auth/me')
  const file = writeGolden('auth', 'вход, регистрация, сессии, список пользователей', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
