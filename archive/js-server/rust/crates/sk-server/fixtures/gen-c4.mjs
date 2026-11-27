// Эталон «Г» служебных маршрутов и справочников (С4):
// `node rust/crates/sk-server/fixtures/gen-c4.mjs` пишет `fixtures/c4.json`;
// сверка — `tests/c4_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1` (сверку делает свой прогон
// в `tests/c4_golden.rs`, правила те же):
// * `models` в health и admin/usage — состояние клиентов модели процесса: JS
//   строит их по списку моделей и без ключа, набор Rust подставляет заглушку.
//   Поле вынимается (`omit_models`), остальное сверяется;
// * `day` учёта расхода и Архитектора — `<day>`;
// * большие ветви тела (каталоги создания героя) — хешем, см. `shrink`.
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
/** Тело длиннее (в символах `JSON.stringify`) хранится хешем. */
const BIG_BODY = 32_000
/** @param {string} text */
const q = (text) => encodeURIComponent(text)

/**
 * Сжать большое тело: у значения, чей `JSON.stringify` длиннее `BIG_BODY`
 * символов, сжимаются части; если и после этого оно длиннее `BIG_BODY`, оно
 * целиком заменяется строкой `<sha256:хеш:длина>` своего текста (UTF-8).
 * Так у health видно, какая ветвь каталога разошлась, а файл эталона мал.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function shrink(value) {
  const text = JSON.stringify(value)
  if (text === undefined || text.length <= BIG_BODY || value === null || typeof value !== 'object') return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (JSON.stringify(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

const { server, close } = await startGoldenServer()
try {
  const { send, exchanges } = recorder(server)
  // Справочники без входа и маршрутизация до health.
  await send('anon', 'GET', '/api/health')
  await send('anon', 'POST', '/api/health')
  await send('anon', 'GET', '/api/health?x=1')
  await send('anon', 'GET', '/api/rulesets/dnd_5e_2014/character-creation')
  await send('anon', 'GET', '/api/rulesets/srd_5_2_1/character-creation?x=1')
  await send('anon', 'GET', '/api/rulesets/unknown_ruleset/character-creation')
  await send('anon', 'GET', '/api/rulesets/Bad-Id/character-creation')
  await send('anon', 'POST', '/api/rulesets/srd_5_2_1/character-creation')
  // Без входа.
  await send('anon', 'GET', '/api/admin/usage')
  await send('anon', 'GET', '/api/speech/status')
  await send('anon', 'GET', '/api/rules/search?q=x')
  await send('anon', 'GET', '/api/world-templates')
  await send('anon', 'PATCH', '/api/campaigns/ANY-1/engine-mode', { body: { mode: 'legacy' } })
  // Аккаунты.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await send('admin', 'GET', '/api/admin/usage')
  await send('admin', 'GET', '/api/admin/usage?x=1')
  await send('player', 'GET', '/api/admin/usage')
  await send('player', 'PATCH', '/api/campaigns/ANY-1/engine-mode', { body: { mode: 'legacy' } })
  await send('admin', 'PATCH', '/api/campaigns/ANY-1/engine-mode', { body: { mode: 'legacy' } })
  await send('admin', 'PATCH', '/api/campaigns/A_B/engine-mode', { body: {} })
  await send('admin', 'GET', '/api/campaigns/ANY-1/engine-mode')
  // Поиск правил: обе редакции, пакеты, предел и отказы движка поиска.
  await send('player', 'GET', `/api/rules/search?q=${q('Как работает помеха?')}&ruleset_id=srd_5_2_1`)
  await send('player', 'GET', `/api/rules/search?q=${q('Как работает удушье?')}&ruleset_id=dnd_5e_2014`)
  await send('player', 'GET', `/api/rules/search?q=${q('помеха')}&q=&q=${q('укрытие')}&limit=2`)
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&limit=50`)
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&limit=-3`)
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&limit=abc&ruleset_id=`)
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&enabled_packs=srd_5_2_1,,`)
  await send('player', 'GET', '/api/rules/search')
  await send('player', 'GET', '/api/rules/search?q=')
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&ruleset_id=nope`)
  await send('player', 'GET', `/api/rules/search?q=${q('атака')}&enabled_packs=nope`)
  // Шаблоны мира и голосовой ввод (распознаватель не настроен).
  await send('player', 'GET', '/api/world-templates')
  await send('player', 'GET', '/api/world-templates?x=1')
  await send('player', 'POST', '/api/world-templates', { body: {} })
  await send('player', 'GET', '/api/speech/status')
  await send('player', 'GET', '/api/speech/status?x=1')
  for (const entry of /** @type {any[]} */ (exchanges)) {
    const body = entry.body_norm
    if (body && typeof body === 'object' && 'models' in body) {
      delete body.models
      entry.omit_models = true
    }
    // Сутки учёта (`day: 'YYYY-MM-DD'`) меняются каждый день.
    for (const section of [body?.usage, body?.architect]) {
      if (section && /^\d{4}-\d{2}-\d{2}$/u.test(section.day)) section.day = '<day>'
    }
    entry.body_norm = shrink(entry.body_norm)
  }
  const file = writeGolden('c4', 'health, каталоги создания героя, поиск правил, шаблоны мира, usage, speech status, engine-mode', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
