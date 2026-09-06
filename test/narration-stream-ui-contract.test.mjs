import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [clientSource, sessionSource, serverSource] = await Promise.all([
  readFile(new URL('../src/ai-client.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/useGameSession.ts', import.meta.url), 'utf8'),
  readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'),
])

test('клиентский контракт использует только стабильный id, текст и фазу', () => {
  const interfaceStart = clientSource.indexOf('export interface NarrationPreview')
  const interfaceEnd = clientSource.indexOf('}', interfaceStart)
  const contract = clientSource.slice(interfaceStart, interfaceEnd)
  assert.match(contract, /messageId: string/u)
  assert.match(contract, /text: string/u)
  assert.match(contract, /phase: NarrationPreviewPhase/u)
  assert.match(contract, /replayed\?: boolean/u)
  assert.doesNotMatch(contract, /roomVersion|state|mechanics/u)
  assert.match(clientSource, /onNarrationPreview\?: \(preview: NarrationPreview\) => void/u)
})

test('hook подписывается на все фазы и снимает те же обработчики', () => {
  for (const event of ['narration.start', 'narration.chunk', 'narration.complete']) {
    assert.match(sessionSource, new RegExp(`addEventListener\\('${event.replace('.', '\\.')}'`, 'u'))
    assert.match(sessionSource, new RegExp(`removeEventListener\\('${event.replace('.', '\\.')}'`, 'u'))
  }
  assert.match(sessionSource, /NARRATION_PREVIEW_TEXT_MAX_BYTES = 12 \* 1024/u)
  assert.match(sessionSource, /NARRATION_PREVIEW_EVENT_MAX_BYTES = 16 \* 1024/u)
  assert.match(sessionSource, /messages\?\.some\(\(message\) => message\.id === current\.messageId\)/u)
  assert.match(sessionSource, /stateRef\.current\.messages\.some\(\(message\) => message\.id === preview\.messageId\)/u)
  assert.match(sessionSource, /const submitAction = useCallback\(async \(text: string, actorId\?: string, npcId\?: string(?:,[^)]*)?\)/u)
  assert.match(sessionSource, /narrationPreview,/u)
})

test('финал публикуется после записи летописи и не зависит от HTTP-соединения инициатора', () => {
  const routeStart = serverSource.indexOf("if (req.url === '/api/narrate'")
  const route = serverSource.slice(routeStart, serverSource.indexOf("if (parsedUrl.pathname.startsWith('/api/'))", routeStart))
  const journal = route.indexOf('appendRoomJournal')
  const complete = route.indexOf('campaignNarrationStream.complete')
  const response = route.indexOf('return json(res, 200')
  assert.ok(journal >= 0 && complete > journal && response > complete)
  assert.match(route, /if \(res\.destroyed \|\| res\.writableEnded\) return/u)
})
