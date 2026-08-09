import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CampaignRecapService,
  DEFAULT_RECAP_GAP_HOURS,
  RecapCacheStore,
  deterministicRecapText,
  recapSources,
} from '../server/campaign-recap.mjs'
import { FakeLLM } from '../server/llm-client.mjs'

/**
 * Задача 2.3 плана: стол вернулся через неделю и вспоминает, на чём
 * остановился. Два инварианта, ради которых сторож и написан: в рекап не может
 * попасть закрытая память, и без ключа модели он всё равно работает.
 */

const HOUR = 3_600_000

function stateWithMemory() {
  return {
    worldMemory: {
      summaries: [
        { id: 'summary:1', kind: 'scene', title: 'Северные ворота', summary: 'Отряд нашёл синюю нить на засове', visibility: 'party' },
        { id: 'summary:2', kind: 'scene', title: 'Трактир', summary: 'Отряд поджёг разлитое масло и ушёл через окно', visibility: 'party' },
        { id: 'summary:secret', kind: 'scene', title: 'Замысел культа', summary: 'Культ готовит ритуал в новолуние', visibility: 'gm_only' },
      ],
      quests: [
        { id: 'quest:caravan', title: 'Пропавший караван', summary: 'Найти караван из Волчьего брода', status: 'active', visibility: 'party' },
        { id: 'quest:secret', title: 'Тайный приказ', summary: 'Скрытая цель', status: 'active', visibility: 'gm_only' },
      ],
      threads: [
        { id: 'thread:mill', title: 'Сгоревшая мельница', summary: 'Телега с меткой каравана', status: 'active', visibility: 'party' },
      ],
      facts: [
        { id: 'fact:secret', subject_id: 'npc:x', predicate: 'plots', object: 'Предательство стражи', summary: 'Начальник стражи предаст отряд', visibility: 'gm_only', status: 'active' },
      ],
      entities: [{ id: 'npc:mira', kind: 'npc', name: 'Мира', visibility: 'party' }],
      relationships: [], epistemic_claims: [], knowledge_ledger: [], knowledge_revealed: [],
    },
    social: {
      schema_version: 4,
      npcs: [{ id: 'npc:mira', name: 'Мира', visibility: 'party', available: true }],
      relationships: {}, relationship_tiers: {}, conversations: [],
      promises: [
        { id: 'promise:1', npc_id: 'npc:mira', hero_id: 'hero-1', direction: 'party_to_npc', text: 'Вернуть Мире долг до заката', due_hint: 'к вечеру', status: 'open', visibility: 'party' },
        { id: 'promise:secret', npc_id: 'npc:mira', hero_id: 'hero-2', direction: 'party_to_npc', text: 'Личная услуга второго героя', status: 'open', visibility: 'specific_player' },
      ],
    },
  }
}

function temporaryCache() {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-recap-'))
  return { directory, cache: new RecapCacheStore({ storageFile: join(directory, 'campaign-recap.json') }) }
}

test('источники рекапа берутся только из party-видимой памяти', () => {
  const sources = recapSources(stateWithMemory())
  assert.deepEqual(sources.summaries.map((entry) => entry.id), ['summary:1', 'summary:2'])
  assert.deepEqual(sources.quests.map((entry) => entry.title), ['Пропавший караван'])
  assert.deepEqual(sources.threads.map((entry) => entry.title), ['Сгоревшая мельница'])
  assert.deepEqual(sources.promises.map((entry) => entry.text), ['Вернуть Мире долг до заката'])
  const serialized = JSON.stringify(sources)
  assert.equal(/gm_only|Культ готовит|Тайный приказ|предаст|Личная услуга/u.test(serialized), false, 'закрытая память в рекап не попадает')
})

test('gm_only-факт не доходит до текста рекапа даже через модель', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  // Модель видит ровно то, что ей передали: если бы закрытая память утекла в
  // источники, она оказалась бы в этом запросе.
  const llm = new FakeLLM({ responses: [{ recap: 'Отряд шёл по следу каравана.' }, { recap: 'Отряд снова в пути.' }] })
  const service = new CampaignRecapService({ llmClient: llm, cache: fixture.cache, now: () => 100 * HOUR })
  const result = await service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 7, lastEventAt: new Date(10 * HOUR).toISOString(),
  })
  assert.ok(result.recap.text)
  const sent = JSON.stringify(llm.requests[0].messages)
  assert.equal(/Культ готовит|Тайный приказ|предаст|Личная услуга/u.test(sent), false)
  assert.match(sent, /<<<UNTRUSTED_DATA:recap_sources>>>/u)
})

test('без перерыва рекапа нет, с перерывом и сводками — есть', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const service = new CampaignRecapService({ cache: fixture.cache, gapHours: 8, now: () => 100 * HOUR })

  const fresh = await service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 1, lastEventAt: new Date(97 * HOUR).toISOString(),
  })
  assert.deepEqual(fresh, { recap: null, reason: 'no_gap' })

  const returned = await service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 1, lastEventAt: new Date(90 * HOUR).toISOString(),
  })
  assert.ok(returned.recap.text)
  assert.equal(returned.recap.version, 1)

  // Ваншот за один вечер под правило перерыва не подпадает — отдельного
  // признака «ваншот» не заводится.
  assert.equal(service.hasGap(new Date(99 * HOUR).toISOString()), false)
  assert.equal(service.hasGap(null), false)
  assert.equal(service.hasGap('не дата'), false)
})

test('кампания без сводок рекапа не получает', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const service = new CampaignRecapService({ cache: fixture.cache, now: () => 100 * HOUR })
  const state = stateWithMemory()
  state.worldMemory.summaries = []
  const result = await service.recapFor({
    campaignId: 'RECAP', state, stateVersion: 1, lastEventAt: new Date(10 * HOUR).toISOString(),
  })
  assert.deepEqual(result, { recap: null, reason: 'no_summaries' })
})

test('без модели рекап собирается детерминированно и это полноценный результат', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const service = new CampaignRecapService({ llmClient: null, cache: fixture.cache, now: () => 100 * HOUR })
  const result = await service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 3, lastEventAt: new Date(10 * HOUR).toISOString(),
  })
  assert.equal(result.recap.provider, 'deterministic')
  assert.match(result.recap.text, /синюю нить/u)
  assert.match(result.recap.text, /Открытая цель — Пропавший караван/u)
  assert.match(result.recap.text, /Отряд остался должен: Вернуть Мире долг до заката/u)
  assert.equal(/gm_only|Культ готовит/u.test(result.recap.text), false)
})

test('невалидный ответ модели откатывается к детерминированному тексту', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const llm = new FakeLLM({ responses: [{ wrong_field: 'мусор' }] })
  const service = new CampaignRecapService({ llmClient: llm, cache: fixture.cache, now: () => 100 * HOUR })
  const result = await service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 4, lastEventAt: new Date(10 * HOUR).toISOString(),
  })
  assert.equal(result.recap.provider, 'deterministic')
  assert.ok(result.recap.text)
})

test('кеш не жжёт токены на повторных входах, а новое событие его инвалидирует', async (t) => {
  const fixture = temporaryCache()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const llm = new FakeLLM({ responses: [{ recap: 'Отряд шёл по следу каравана.' }, { recap: 'Отряд снова в пути.' }] })
  const service = new CampaignRecapService({ llmClient: llm, cache: fixture.cache, now: () => 100 * HOUR })
  const call = (stateVersion) => service.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion, lastEventAt: new Date(10 * HOUR).toISOString(),
  })

  const first = await call(5)
  assert.equal(first.recap.provider, 'model')
  assert.equal(llm.requests.length, 1)

  // Второй игрок за тем же столом получает тот же текст без вызова модели.
  const second = await call(5)
  assert.equal(second.recap.text, first.recap.text)
  assert.equal(llm.requests.length, 1, 'повторный вход модель не зовёт')

  // Кеш durable: новый экземпляр поверх того же файла — это перезапуск сервера.
  const restarted = new CampaignRecapService({
    llmClient: llm, cache: new RecapCacheStore({ storageFile: fixture.cache.storageFile }), now: () => 100 * HOUR,
  })
  await restarted.recapFor({
    campaignId: 'RECAP', state: stateWithMemory(), stateVersion: 5, lastEventAt: new Date(10 * HOUR).toISOString(),
  })
  assert.equal(llm.requests.length, 1, 'кеш переживает перезапуск')

  // Новое событие поднимает версию состояния — ключ меняется, рекап пересобран.
  const afterEvent = await call(6)
  assert.equal(afterEvent.recap.version, 6)
  assert.equal(llm.requests.length, 2, 'новое событие инвалидирует кеш')
})

test('детерминированный текст остаётся связным на скудных данных', () => {
  assert.equal(deterministicRecapText({}), '')
  assert.equal(
    deterministicRecapText({ summaries: [{ title: '', summary: 'Отряд ушёл на север' }] }),
    'Отряд ушёл на север.',
  )
  // Точка не удваивается, если сводка уже закончена знаком препинания.
  assert.equal(
    deterministicRecapText({ summaries: [{ title: 'Ворота', summary: 'Отряд ушёл на север.' }] }),
    'Ворота: Отряд ушёл на север.',
  )
})

test('повторяющаяся рубрика не вытесняет из рекапа дела отряда', () => {
  // Окно рекапа маленькое, а рубрики, которые пишутся сами, повторяются: врезка
  // «Пока вас не было…» ложится в память после каждой ночёвки. Без свёртки по
  // заголовку три ночёвки подряд заняли бы весь рекап, и вечер открылся бы
  // чужими новостями вместо того, что делал стол.
  const state = stateWithMemory()
  state.worldMemory.summaries = [
    ...state.worldMemory.summaries,
    { id: 'summary:offscreen:1', kind: 'scene', title: 'Пока вас не было...', summary: 'Ватага усилила посты.', visibility: 'party' },
    { id: 'summary:offscreen:2', kind: 'scene', title: 'Пока вас не было...', summary: 'Ватага снялась со стоянки.', visibility: 'party' },
    { id: 'summary:offscreen:3', kind: 'scene', title: 'Пока вас не было...', summary: 'Ватага увела заложника.', visibility: 'party' },
  ]
  const sources = recapSources(state)
  assert.deepEqual(
    sources.summaries.map((entry) => entry.id),
    ['summary:1', 'summary:2', 'summary:offscreen:3'],
    'из рубрики остаётся последняя запись, и место в окне достаётся столу',
  )
  const text = deterministicRecapText(sources)
  assert.match(text, /синюю нить/u)
  assert.match(text, /разлитое масло/u)
  assert.match(text, /увела заложника/u)
})

test('порог перерыва берётся из настройки, мусор откатывается к умолчанию', () => {
  assert.equal(new CampaignRecapService({ gapHours: 24 }).gapHours, 24)
  assert.equal(new CampaignRecapService({ gapHours: 0 }).gapHours, DEFAULT_RECAP_GAP_HOURS)
  assert.equal(new CampaignRecapService({ gapHours: -1 }).gapHours, DEFAULT_RECAP_GAP_HOURS)
  assert.equal(new CampaignRecapService({ gapHours: 'вечер' }).gapHours, DEFAULT_RECAP_GAP_HOURS)
  assert.equal(new CampaignRecapService().gapHours, DEFAULT_RECAP_GAP_HOURS)
})
