import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')

test('инструменты отката видны владельцу стола и используют отдельный owner-scoped API', () => {
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\)[\s\S]*?onRunCampaignControl\('rewind_turn'\)/u)
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\)[\s\S]*?onRunCampaignControl\('replay_scene'\)/u)
  assert.match(app, /\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/controls/u)
})
