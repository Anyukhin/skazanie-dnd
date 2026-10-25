import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

test('инструменты отката видны владельцу стола и используют отдельный owner-scoped API', () => {
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\)[\s\S]*?onRunCampaignControl\('rewind_turn'\)/u)
  assert.match(app, /canManageLifecycle && \['active', 'paused'\]\.includes\(lifecycleStatus\)[\s\S]*?onRunCampaignControl\('replay_scene'\)/u)
  assert.match(app, /\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/controls/u)
})

// JS-only: проверка читает текст server/index.mjs. После переключения на Rust она
// проверяла бы мёртвый код — удалить вместе с server/index.mjs (С19). Права владельца, повтор и конфликт ключа
// и replay после restart в обоих режимах держит test/campaign-controls-api.test.mjs.
test('JS-only (server/index.mjs): маршрут /controls: только владелец, ключ привязан к действию, снимок после отката', () => {
  assert.match(server, /campaignControlMatch.*\/controls/u)
  assert.match(server, /membership\?\.role !== 'owner'/u)
  assert.match(server, /committedAction !== action/u)
  assert.match(server, /IDEMPOTENCY_CONFLICT/u)
  assert.match(server, /forceSnapshot: true/u)
})
