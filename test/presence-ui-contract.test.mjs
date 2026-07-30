import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [serverSource, sessionSource, appSource] = await Promise.all([
  readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
])

test('typing обновляет отдельное presence-событие без полного reconcile комнаты', () => {
  const routeStart = serverSource.indexOf('if (campaignTypingMatch && req.method')
  const routeEnd = serverSource.indexOf('const campaignStreamMatch', routeStart)
  const route = serverSource.slice(routeStart, routeEnd)
  assert.ok(routeStart >= 0 && routeEnd > routeStart)
  assert.match(route, /const room = getRoom\(campaignId\)/u)
  assert.match(route, /broadcastCampaignTyping\(campaignId\)/u)
  assert.doesNotMatch(route, /reconcileCampaignProjection|broadcastCampaignRoom/u)
})

test('клиент сливает presence в текущий state и не показывает собственный typing', () => {
  assert.match(sessionSource, /addEventListener\('presence', receivePresence as EventListener\)/u)
  assert.match(sessionSource, /typing_actor_ids: typingActorIds/u)
  assert.match(appSource, /filter\(\(actorId\) => actorId !== activePlayer\.id\)/u)
  assert.match(appSource, /typingActorIds=\{visibleTypingActorIds\}/u)
})
