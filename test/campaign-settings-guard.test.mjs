import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * До выбора кампании кода сессии нет, и запрос настроек уходил на
 * `/api/campaigns//settings` — 404 в консоли браузера на каждой загрузке
 * страницы. Сторож текстовый: маршрут живёт в эффекте `useEffect`, а
 * браузерной автоматизации в проекте нет.
 */
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('настройки кампании не запрашиваются, пока код сессии пуст', () => {
  const guard = /if \(!state\.sessionCode\) return \(\) => controller\.abort\(\)\s*\n\s*void fetch\(`\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/settings`/u
  assert.match(app, guard, 'гвард обязан стоять непосредственно перед запросом настроек')

  // Сброс карточки идёт до возврата: иначе при выходе из кампании в интерфейсе
  // остались бы настройки прежней.
  const effect = app.slice(app.indexOf('setCampaignAi(null)'), app.indexOf('/settings`, { signal: controller.signal })'))
  assert.ok(effect.indexOf('setCampaignAi(null)') < effect.indexOf('if (!state.sessionCode)'), 'состояние сбрасывается до раннего возврата')
  assert.ok(effect.includes("setCampaignAiError('')"))

  // Второй потребитель того же маршрута — сохранение настроек. Оно живёт под
  // `canManage` и без кампании недостижимо, поэтому своего гварда не требует;
  // проверка стоит, чтобы правка не завела третий вызов без разбора.
  assert.equal((app.match(/\/api\/campaigns\/\$\{encodeURIComponent\(state\.sessionCode\)\}\/settings/gu) ?? []).length, 2)
  assert.match(app, /if \(!campaignAi\?\.canManage \|\| campaignAiBusy\) return/u)
})
