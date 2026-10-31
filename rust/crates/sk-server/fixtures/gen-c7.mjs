// Эталон «Г» настроек ИИ, редакции и домашних правил (С7):
// `node rust/crates/sk-server/fixtures/gen-c7.mjs` пишет `fixtures/c7.json`;
// сверка — `tests/c7_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1`:
// * кости сервера — правила `DICE` (тот же JSON читает Rust-набор);
// * токен приглашения в теле входа — ссылка `<invite:N>` (токен из ответа
//   обмена N), как в `gen-c6.mjs`;
// * тело ответа создания кампании — `<c6>`: его сверяет эталон С6, а здесь
//   важен только статус (в теле — время строк летописи `ЧЧ:ММ`);
// * `journals` — строки летописи «Настройки кампании» по кампаниям в конце
//   сценария (`GET /api/rooms/:id` администратором; в Rust комната читается
//   из ядра): `{ id, text }`, где у `id` отрезано время `-<Date.now()>`.
//   Кампания `HR-MULTI` не снимается: два правила одним запросом в одну
//   миллисекунду получают один `id`, и вторая строка теряется (JS как есть).
// * боя в сценарии нет: импорт с `mechanics.combat.active` в JS тут же
//   закрывает координатор боя (`onRoomSaved` → `nudge`, задача С17), отказ
//   `HOUSE_RULE_DURING_COMBAT` сторожит `tests/server_c7.rs`.
import '../../../fixtures-env.mjs'

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FIXTURES_DIR, GOLDEN_FORMAT, recorder, startGoldenServer } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 2 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const STRIKE = 'house:bg3-opening-strike'
const HANDS = 'house:bg3-spell-hands'
const JOURNAL_CAMPAIGNS = ['TALE-7', 'IMPORT-7']

/** Готовое состояние для импорта администратором. */
function importedState(code, extra = {}) {
  return {
    sessionCode: code,
    campaign: `Импорт ${code}`,
    partyName: 'Двое',
    partyMemberIds: ['hero-ivan'],
    players: [{ id: 'hero-ivan', character: 'Иван', name: 'Иван', hp: 10, maxHp: 10, x: 0, y: 0 }],
    messages: [],
    scene: { title: 'Начало', location: 'Таверна', mood: '', objective: '', turn: 0, cells: [] },
    ...extra,
  }
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  const settings = (code) => `/api/campaigns/${code}/settings`
  const patch = (role, code, body, headers) => send(role, 'PATCH', settings(code), { body, headers })

  // Без входа.
  await send('anon', 'GET', settings('TALE-7'))
  await patch('anon', 'TALE-7', {})
  // Аккаунты и кампании.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('owner', 'POST', '/api/auth/register', { body: OWNER })
  await send('guest', 'POST', '/api/auth/register', { body: GUEST })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await send('owner', 'POST', '/api/campaigns', {
    body: { code: 'TALE-7', name: 'Сказ', bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: { premise: 'Мост', startingLocation: 'Переправа' } } },
  })
  const inviteResponse = await send('owner', 'POST', '/api/campaigns/TALE-7/invites', { body: { hero_ids: ['hero-slot-2'] } })
  await send('guest', 'POST', '/api/campaigns/TALE-7/join', { body: { invite_token: inviteResponse.body?.token } })
  Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${exchanges.length - 2}>` } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-7', state: importedState('IMPORT-7') } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'HR-MULTI', state: importedState('HR-MULTI') } })

  // Чтение: участник, гость, посторонний, нет кампании, строка запроса, чужие методы.
  await send('owner', 'GET', settings('TALE-7'))
  await send('owner', 'GET', settings('tale-7'))
  await send('guest', 'GET', settings('TALE-7'))
  await send('outsider', 'GET', settings('TALE-7'))
  await send('owner', 'GET', settings('NOPE-7'))
  await send('owner', 'GET', `${settings('TALE-7')}?x=1`)
  await send('admin', 'GET', settings('IMPORT-7'))
  await send('owner', 'PUT', settings('TALE-7'), { body: {} })
  await send('owner', 'DELETE', settings('TALE-7'))
  await send('owner', 'GET', '/api/campaigns/TALE_7/settings')

  // Права записи.
  await patch('guest', 'TALE-7', { improvMode: 'chaos' })
  await patch('outsider', 'TALE-7', { improvMode: 'chaos' })
  await patch('owner', 'NOPE-7', { improvMode: 'chaos' })
  await patch('owner', 'IMPORT-7', { improvMode: 'chaos' })

  // Проверка настроек ИИ.
  await patch('owner', 'TALE-7', [])
  await patch('owner', 'TALE-7', { model: 'vendor/unknown' })
  await patch('owner', 'TALE-7', { model: null })
  await patch('owner', 'TALE-7', { narratorStyle: 'grim' })
  await patch('owner', 'TALE-7', { improvMode: 'wild' })
  await patch('owner', 'TALE-7', { reasoningLevel: 'ultra' })
  await patch('owner', 'TALE-7', { model: 'google/gemini-2.5-flash-lite', reasoningLevel: 'deep' })
  await patch('owner', 'TALE-7', {})
  await patch('owner', 'TALE-7', { model: ' openai/gpt-6-luna ', reasoningLevel: ' DEEP ', narratorStyle: 'FORMAL', improvMode: 'Chaos' })
  await patch('owner', 'TALE-7', { improvMode: 'chaos' })
  await patch('owner', 'TALE-7', { model: 'google/gemini-2.5-flash-lite' })
  await patch('owner', 'TALE-7', { improvMode: 'story', reasoningLevel: 'auto' })
  await send('guest', 'GET', settings('TALE-7'))

  // Редакция: без ключа, неизвестная, смена, повтор, чужой ключ, ключ заголовком.
  await patch('owner', 'TALE-7', { rulesetId: 'dnd_5e_2014' })
  await patch('owner', 'TALE-7', { rulesetId: 'nope', idempotency_key: 'rs-nope' })
  await patch('owner', 'TALE-7', { rulesetId: null, idempotency_key: 'rs-null' })
  await patch('owner', 'TALE-7', { rulesetId: 'dnd_5e_2014', idempotency_key: 'rs-1' })
  await patch('owner', 'TALE-7', { rulesetId: 'dnd_5e_2014', idempotency_key: 'rs-1' })
  await patch('owner', 'TALE-7', { ruleset_id: 'srd_5_2_1', idempotency_key: 'rs-1' })
  await patch('owner', 'TALE-7', { ruleset_id: ' srd_5_2_1 ' }, { 'x-idempotency-key': 'rs-2' })
  await patch('owner', 'TALE-7', { rulesetId: 'dnd_5e_2014', idempotency_key: 'rs-1' })
  await patch('admin', 'IMPORT-7', { rulesetId: 'dnd_5e_2014', idempotency_key: 'rs-import' })

  // Домашние правила: нельзя, не булево, без ключа, выключить, повтор, включить.
  await patch('owner', 'TALE-7', { houseRules: { 'house:nope': true }, idempotency_key: 'hr-0' })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: 'нет' }, idempotency_key: 'hr-0' })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: false } })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: false }, idempotency_key: 'hr-1' })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: false }, idempotency_key: 'hr-1' })
  // Тот же ключ с другим значением — повтор прежнего коммита без конфликта (JS как есть).
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: true }, idempotency_key: 'hr-1' })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: false }, idempotency_key: 'hr-2' })
  await patch('owner', 'TALE-7', { houseRules: [STRIKE], idempotency_key: 'hr-3' })
  await patch('owner', 'TALE-7', { houseRules: { [STRIKE]: true }, idempotency_key: 'hr-4', improvMode: 'chaos' })
  await patch('admin', 'IMPORT-7', { houseRules: { [HANDS]: false }, idempotency_key: 'hr-import' })
  await patch('admin', 'HR-MULTI', { houseRules: { [STRIKE]: false, [HANDS]: false }, idempotency_key: 'hr-multi' })
  await patch('admin', 'HR-MULTI', { houseRules: { [STRIKE]: true, 'house:nope': true }, idempotency_key: 'hr-multi-2' })
  await send('admin', 'GET', settings('HR-MULTI'))
  await send('owner', 'GET', settings('TALE-7'))

  /** @type {Record<string, Array<{ id: string, text: string }>>} */
  const journals = {}
  for (const code of JOURNAL_CAMPAIGNS) {
    const room = await send('admin', 'GET', `/api/rooms/${code}`)
    exchanges.pop()
    journals[code] = (room.body?.state?.messages ?? [])
      .filter((message) => message.author === 'Настройки кампании')
      .map((message) => ({ id: String(message.id).replace(/-\d+$/u, ''), text: message.text }))
  }

  for (const entry of /** @type {any[]} */ (exchanges)) {
    if (entry.method === 'POST' && entry.path === '/api/campaigns') entry.body_norm = '<c6>'
  }
  const file = join(FIXTURES_DIR, 'c7.json')
  writeFileSync(file, `${JSON.stringify({ format: GOLDEN_FORMAT, scenario: 'настройки ИИ, редакция и домашние правила: чтение, права, проверки, смена, повтор, бой, летопись', exchanges, journals }, null, 2)}\n`)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)

} finally {
  await close()
}
