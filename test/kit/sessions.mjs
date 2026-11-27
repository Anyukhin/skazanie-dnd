// Сессия глазами теста — без знания, как сервер её хранит.
//
// Истечение сессии события не присылает: тест живого потока
// (`stream-live-access-api`) проверяет, что ближайшая рассылка закрывает поток
// истёкшей сессии. Сессии Rust-сервера лежат в SQLite, поэтому одна операция
// идёт подкомандой бинаря (только с фичей `test-hooks`,
// `rust/crates/sk-server/src/test_hooks/session_cli.rs`; токен — через stdin,
// не в аргументах):
//
// * `expireSession` — истечь ровно одну сессию по её cookie.
//
//   skazanie-server session --storage <dir> --expire   (JSON { "token": "…" } на stdin)
import { runRustTool } from './http.mjs'

/**
 * Истечь сессию cookie `skazanie_session=<токен>`: срок — миг назад. Сервер
 * узнаёт об этом на ближайшей сверке; события нет.
 *
 * @param {{ storageDir: string }} server объект из startTestServer
 * @param {string} cookie `skazanie_session=…` из ответа входа
 */
export async function expireSession(server, cookie) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
  await runRustTool(['session', '--storage', server.storageDir, '--expire'], { storageDir: server.storageDir, input: { token } })
}
