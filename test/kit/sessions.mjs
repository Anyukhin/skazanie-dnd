// Сессия глазами теста — без знания, как сервер её хранит.
//
// Истечение сессии события не присылает: тест живого потока
// (`stream-live-access-api`) проверяет, что ближайшая рассылка закрывает поток
// истёкшей сессии. Раньше он правил `<storage>/auth.json` сам, а у Rust-сервера
// сессии в SQLite. Здесь одна операция с одинаковым смыслом в обоих режимах:
//
// * `expireSession` — истечь ровно одну сессию по её cookie.
//
// Режим `js` правит `auth.json` так же атомарно, как хранилище JS. Режим
// `rust` зовёт подкоманду бинаря (токен — через stdin, не в аргументах):
//
//   skazanie-server session --storage <dir> --expire   (JSON { "token": "…" } на stdin)
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runRustTool } from './http.mjs'

/**
 * Истечь сессию cookie `skazanie_session=<токен>`: срок — миг назад. Сервер
 * узнаёт об этом на ближайшей сверке; события нет.
 *
 * @param {{ impl: 'js' | 'rust', storageDir: string }} server объект из startTestServer
 * @param {string} cookie `skazanie_session=…` из ответа входа
 */
export async function expireSession(server, cookie) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
  if (server.impl === 'rust') {
    await runRustTool(['session', '--storage', server.storageDir, '--expire'], { storageDir: server.storageDir, input: { token } })
    return
  }
  // Хранилище JS держит хеш токена, а не сам токен.
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const file = join(server.storageDir, 'auth.json')
  const auth = JSON.parse(readFileSync(file, 'utf8'))
  const session = auth.sessions.find((/** @type {{ tokenHash: string }} */ candidate) => candidate.tokenHash === tokenHash)
  if (!session) throw new Error('expireSession: сессия для истечения не найдена')
  session.expiresAt = Date.now() - 1
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(auth, null, 2), 'utf8')
  renameSync(temporary, file)
}
