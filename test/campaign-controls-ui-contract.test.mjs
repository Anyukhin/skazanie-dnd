import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('инструменты отката видны владельцу стола и используют отдельный owner-scoped API', () => {
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\).*runCampaignControl\('rewind_turn'\)/u)
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\).*runCampaignControl\('replay_scene'\)/u)
  assert.match(app, /\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/controls/u)
  assert.match(server, /campaignControlMatch.*\/controls/u)
  assert.match(server, /membership\?\.role !== 'owner'/u)
  assert.match(server, /committedAction !== action/u)
  assert.match(server, /IDEMPOTENCY_CONFLICT/u)
  assert.match(server, /forceSnapshot: true/u)
})
