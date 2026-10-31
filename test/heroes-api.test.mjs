import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaign, createClient, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * `GET /api/heroes` — список героев всех кампаний для ведущего
 * (`server/index.mjs`, маршрут после `GET /api/campaigns`): только
 * администратору, один герой на id, порядок — по имени в русской локали.
 */

/** Готовое состояние кампании: импорт состояния доступен только администратору. */
function campaignState(code, heroes) {
  return {
    sessionCode: code,
    campaign: `Кампания ${code}`,
    players: heroes.map(([id, character]) => ({ id, character, name: character, hp: 10, maxHp: 10, x: 0, y: 0 })),
    messages: [],
    scene: { title: 'Начало', location: 'Таверна', mood: '', objective: '', turn: 0, cells: [] },
  }
}

test('GET /api/heroes: только ведущему, герои всех кампаний без повторов, по имени в русской локали', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t)

  const anonymous = await createClient(server).get('/api/heroes')
  assert.equal(anonymous.status, 401, anonymous.text)
  assert.deepEqual(anonymous.body, { error: 'Нужно войти в аккаунт' })

  const { client: gm } = await setupAdmin(server)
  const { client: player } = await registerUser(server)

  const forbidden = await player.get('/api/heroes')
  assert.equal(forbidden.status, 403, forbidden.text)
  assert.deepEqual(forbidden.body, { error: 'Требуются права администратора' })

  assert.deepEqual(expectStatus(await gm.get('/api/heroes')), { heroes: [] }, 'кампаний ещё нет')

  // Латиница и кириллица вперемешку: в русской локали кириллица идёт раньше.
  await createCampaign(gm, { code: 'HEROES-A', state: campaignState('HEROES-A', [['hero-zed', 'Zed'], ['hero-shared', 'Борис'], ['hero-ya', 'Ярослава']]) })
  await createCampaign(gm, { code: 'HEROES-B', state: campaignState('HEROES-B', [['hero-ada', 'Ada'], ['hero-shared', 'Борис'], ['hero-arven', 'Арвен']]) })
  // Кампания игрока из мастера создания: пустое место — тоже герой списка.
  await createCampaign(player, { code: 'HEROES-C', bootstrap: { partyName: 'Один', slotCount: 1, rulesetId: 'srd_5_2_1' } })

  const listed = expectStatus(await gm.get('/api/heroes'))
  assert.deepEqual(listed.heroes.map((hero) => [hero.id, hero.character]), [
    ['hero-arven', 'Арвен'],
    ['hero-shared', 'Борис'],
    ['hero-slot-1', 'Место героя 1'],
    ['hero-ya', 'Ярослава'],
    ['hero-ada', 'Ada'],
    ['hero-zed', 'Zed'],
  ], 'один герой на id, кириллица раньше латиницы')
  const slot = listed.heroes.find((hero) => hero.id === 'hero-slot-1')
  assert.equal(slot.characterSetupRequired, true, 'герой — объект состояния кампании целиком')

  // Строка запроса маршруту не мешает; другой метод — не этот маршрут.
  assert.deepEqual(expectStatus(await gm.get('/api/heroes?view=all')), listed)
  const posted = await gm.post('/api/heroes', {})
  assert.equal(posted.status, 404, posted.text)
  assert.deepEqual(posted.body, { error: 'API endpoint не найден' })
})
