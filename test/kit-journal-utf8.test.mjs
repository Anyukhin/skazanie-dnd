// Журнал глазами теста (`readJournal`) отдаёт кириллицу целой и на большом
// журнале. В режиме rust журнал приходит stdout подкоманды бинаря кусками по
// 64 КБ; склейка кусков строками разрывала двухбайтовые буквы на границе
// («Благослове��ие»), и перекрёстный replay стенда Асстохана
// (`eval/stand-server.mjs`) видел расхождение там, где его нет.
//
// Тело запроса уходит экранированным ASCII (`\uXXXX`): JS-сервер склеивает
// куски тела строками и сам рвёт буквы большого тела (`readBody`,
// server/index.mjs; docs/rust-port-js-findings.md) — здесь проверяется только
// чтение журнала.
import assert from 'node:assert/strict'
import test from 'node:test'

import { expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const NAME = 'Благословение'
// Нечётная длина в байтах сдвигает буквы относительно границ кусков.
const NOTE = `${'Пепельная застава хранит клятву. '.repeat(40)}ё`

function cells(width = 16, height = 16) {
  const result = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) result.push({ x, y, type: 'floor', revealed: true })
  return result
}

function initialState(code) {
  const players = Array.from({ length: 6 }, (_, index) => ({
    id: `hero-${index + 1}`,
    character: `${NAME} ${index + 1}`,
    characterClass: 'fighter',
    level: 3,
    hp: 20,
    maxHp: 20,
    armor: 15,
    speed: 30,
    x: index,
    y: 1,
    abilities: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [],
    backstory: NOTE,
  }))
  return {
    state_version: 0,
    sessionCode: code,
    campaign: `${NAME} — проверка журнала`,
    activePlayerId: 'hero-1',
    partyMemberIds: players.map((player) => player.id),
    players,
    messages: Array.from({ length: 80 }, (_, index) => ({ id: `m-${index}`, author: 'Ведущий', text: `${index}: ${NOTE}` })),
    scene: { turn: 1, title: 'Пепельная застава', location: 'utf8-journal', cells: cells() },
  }
}

test('readJournal: кириллица большого журнала приходит без разрывов букв', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t)
  const { client } = await setupAdmin(server)
  const code = 'UTF8-JOURNAL'
  const ascii = JSON.stringify({ code, name: `${NAME} — журнал`, state: initialState(code) })
    .replace(/[\u0080-￿]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const created = await client.fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ascii })
  expectStatus({ status: created.status, text: await created.text(), body: null, headers: created.headers, cookie: '' }, 201)

  const journal = await readJournal(server, code)
  const text = JSON.stringify(journal)
  assert.ok(Buffer.byteLength(text) > 4 * 65_536, `журнал должен быть больше нескольких кусков потока: ${Buffer.byteLength(text)} байт`)
  assert.equal(text.includes('�'), false, 'в журнале нет символа замены U+FFFD')
  assert.equal(journal.state.campaign, `${NAME} — проверка журнала`)
  assert.equal(journal.state.players[0].character, `${NAME} 1`)
  assert.ok(text.includes(NOTE), 'длинная кириллическая строка цела')
})
