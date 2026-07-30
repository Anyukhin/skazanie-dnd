import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const sessionSource = await readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const serverSource = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('клиентский recovery polling не будит NPC, сервер публикует их ход через SSE', () => {
  assert.match(sessionSource, /new EventSource\(/u)
  assert.match(sessionSource, /setInterval\(sync,\s*15_000\)/u)
  assert.doesNotMatch(sessionSource, /system-tick/u)
  assert.match(serverSource, /new CombatTurnCoordinator\(/u)
  assert.match(serverSource, /onRoomSaved\([^]*combatTurnCoordinator\.nudge/u)
  assert.match(serverSource, /broadcastCampaignRoom/u)
})

test('серверный clock доступен в room/SSE projection, а compatibility endpoint сохранён', () => {
  assert.match(serverSource, /turn_clock:\s*combatTurnCoordinator\.clockFor/u)
  assert.match(serverSource, /\/system-tick/u)
})
