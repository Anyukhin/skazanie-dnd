import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { buildDataOnlyContext } from './security.mjs'
import { atomicWrite } from './store.mjs'
import { npcSocialForViewer } from './npc-social.mjs'
import { worldMemoryForViewer } from './world-memory.mjs'

/**
 * Рекап «В прошлой серии» — задача 2.3 плана `docs/experience-upgrade-plan.md`.
 *
 * Источник честный: сводки сцен, которые пишет переход сцены (задача 2.1),
 * открытые квесты и нити, открытые обещания. Ничего не придумывается с нуля.
 *
 * Видимость — главный инвариант этого модуля. Рекап читается **только** через
 * те же проекции, которыми игрок видит память кампании
 * (`worldMemoryForViewer`, `npcSocialForViewer`). Сырое состояние сюда не
 * попадает никогда: рекап показывается всему столу, и утёкший gm_only-факт
 * испортил бы кампанию необратимо.
 *
 * Модель только полирует текст. Её отсутствие, таймаут или невалидный ответ —
 * не ошибка: детерминированный текст из тех же данных это полноценный
 * результат, а не заглушка.
 */

const CACHE_SCHEMA_VERSION = 1
export const DEFAULT_RECAP_GAP_HOURS = 8
const RECAP_SUMMARY_LIMIT = 5
const RECAP_SUMMARY_MINIMUM = 3
const RECAP_OPEN_ITEM_LIMIT = 3
const CACHE_ENTRY_LIMIT = 200

const prompt = readFileSync(fileURLToPath(new URL('../prompts/recap/v1.txt', import.meta.url)), 'utf8')

const clean = (value, maximum = 400) => String(value ?? '')
  .normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

const campaignKey = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9-]/gu, '').slice(0, 24)

/**
 * Durable-кеш рекапа. Ключ — кампания и версия состояния: любое новое событие
 * поднимает версию, и кеш инвалидируется сам, без ручной сборки мусора.
 * Паттерн хранения тот же, что у `architect-usage.mjs`.
 */
export class RecapCacheStore {
  constructor({ storageFile } = {}) {
    if (!storageFile) throw new TypeError('RecapCacheStore requires storageFile')
    this.storageFile = resolve(storageFile)
  }

  _read() {
    if (!existsSync(this.storageFile)) return { schema_version: CACHE_SCHEMA_VERSION, entries: {} }
    try {
      const value = JSON.parse(readFileSync(this.storageFile, 'utf8'))
      if (value?.schema_version !== CACHE_SCHEMA_VERSION || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
        return { schema_version: CACHE_SCHEMA_VERSION, entries: {} }
      }
      return value
    } catch {
      // Испорченный кеш — это лишний вызов модели, а не сломанный вход в игру.
      return { schema_version: CACHE_SCHEMA_VERSION, entries: {} }
    }
  }

  key(campaignId, stateVersion) {
    return `${campaignKey(campaignId)}:${Math.max(0, Number(stateVersion) || 0)}`
  }

  get(campaignId, stateVersion) {
    const entry = this._read().entries[this.key(campaignId, stateVersion)]
    return entry && typeof entry.text === 'string' && entry.text ? { ...entry } : null
  }

  set(campaignId, stateVersion, value) {
    const state = this._read()
    const key = this.key(campaignId, stateVersion)
    // Прошлые версии той же кампании больше не нужны: рекап отвечает на вопрос
    // «что было к этому моменту», и старый ответ уже никем не запрашивается.
    const others = Object.entries(state.entries).filter(([entryKey]) => !entryKey.startsWith(`${campaignKey(campaignId)}:`))
    state.entries = Object.fromEntries([...others.slice(-CACHE_ENTRY_LIMIT), [key, { ...value }]])
    atomicWrite(this.storageFile, state)
    return { ...value }
  }
}

/**
 * Зритель рекапа — всегда отряд целиком и никогда конкретный игрок.
 *
 * Это не перестраховка, а следствие кеша: один текст показывается всему столу.
 * Собери его от лица игрока — и его личные `specific_player` факты уедут
 * соседям при следующем запросе. Пустой `playerId` оставляет только `public` и
 * `party`, а `isAdmin` не выставляется никогда, даже когда рекап просит админ.
 */
const PARTY_VIEWER = Object.freeze({ playerId: '', isPartyMember: true })

/**
 * Одна рубрика — одна строка, и всегда свежая.
 *
 * Окно рекапа маленькое (`RECAP_SUMMARY_MINIMUM` сводок в тексте), а сводки с
 * одним и тем же заголовком пишутся повторяющимися рубриками: врезка «Пока вас
 * не было…» (`server/offscreen-world.mjs`) ложится в память после каждого хода
 * мира, то есть после каждой ночёвки. Две-три ночёвки подряд вытеснили бы из
 * «В прошлой серии» всё, что делал стол, и вечер открылся бы чужими новостями.
 * Поэтому из каждой рубрики остаётся последняя запись — она и отвечает на
 * вопрос «что там сейчас», — а места в окне хватает на дела отряда.
 */
function freshestByTitle(summaries) {
  const byTitle = new Map()
  for (const summary of summaries) {
    const key = clean(summary?.title, 160) || `id:${clean(summary?.id, 120)}`
    // Свежая запись обязана занять и место в порядке, а не только значение:
    // `Map.set` по существующему ключу оставил бы её на позиции старой.
    byTitle.delete(key)
    byTitle.set(key, summary)
  }
  return [...byTitle.values()]
}

/**
 * Материал рекапа, приведённый к видимости отряда. Возвращает только то, что
 * стол имеет право прочитать вслух.
 */
export function recapSources(state = {}, viewer = PARTY_VIEWER) {
  const memory = worldMemoryForViewer(state.worldMemory, viewer)
  const social = npcSocialForViewer(state.social, viewer)
  const summaries = freshestByTitle((memory.summaries ?? []).filter((summary) => clean(summary?.summary, 1_000)))
    .slice(-RECAP_SUMMARY_LIMIT)
    .map((summary) => ({
      id: clean(summary.id, 120),
      title: clean(summary.title, 160),
      summary: clean(summary.summary, 1_000),
    }))
  const quests = (memory.quests ?? [])
    .filter((quest) => quest?.status === 'active')
    .slice(-RECAP_OPEN_ITEM_LIMIT)
    .map((quest) => ({ title: clean(quest.title, 160), summary: clean(quest.summary, 400) }))
    .filter((quest) => quest.title)
  const threads = (memory.threads ?? [])
    .filter((thread) => thread?.status === 'active')
    .slice(-RECAP_OPEN_ITEM_LIMIT)
    .map((thread) => ({ title: clean(thread.title, 160), summary: clean(thread.summary, 400) }))
    .filter((thread) => thread.title)
  const promises = (social.promises ?? [])
    .filter((entry) => entry?.status === 'open')
    .slice(-RECAP_OPEN_ITEM_LIMIT)
    .map((entry) => ({ text: clean(entry.text, 300), due_hint: clean(entry.due_hint, 120) }))
    .filter((entry) => entry.text)
  return { summaries, quests, threads, promises }
}

const sentence = (value) => {
  const text = clean(value, 400)
  if (!text) return ''
  return /[.!?…]$/u.test(text) ? text : `${text}.`
}

/**
 * Детерминированный рекап из тех же данных. Это не заглушка: без ключа модели
 * игра обязана оставаться играбельной, и такой текст честно отвечает на вопрос
 * «на чём мы остановились».
 */
export function deterministicRecapText(sources = {}) {
  const parts = []
  for (const summary of (sources.summaries ?? []).slice(-RECAP_SUMMARY_MINIMUM)) {
    parts.push(sentence(summary.title ? `${summary.title}: ${summary.summary}` : summary.summary))
  }
  const quest = (sources.quests ?? [])[0]
  if (quest) parts.push(sentence(`Открытая цель — ${quest.summary ? `${quest.title}: ${quest.summary}` : quest.title}`))
  const thread = (sources.threads ?? [])[0]
  if (thread) parts.push(sentence(`Незакрытая нить — ${thread.summary ? `${thread.title}: ${thread.summary}` : thread.title}`))
  const promise = (sources.promises ?? [])[0]
  if (promise) parts.push(sentence(`Отряд остался должен: ${promise.text}${promise.due_hint ? ` (${promise.due_hint})` : ''}`))
  return parts.filter(Boolean).join(' ')
}

const hasMaterial = (sources) => (sources.summaries ?? []).length > 0

export class CampaignRecapService {
  constructor({ llmClient = null, cache = null, gapHours = DEFAULT_RECAP_GAP_HOURS, now = () => Date.now() } = {}) {
    this.llmClient = llmClient
    this.cache = cache
    const hours = Number(gapHours)
    this.gapHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RECAP_GAP_HOURS
    this.now = now
  }

  /** Перерыв достаточной длины — единственный признак «нового вечера». */
  hasGap(lastEventAt) {
    const last = Date.parse(String(lastEventAt ?? ''))
    if (!Number.isFinite(last)) return false
    return Number(this.now()) - last >= this.gapHours * 3_600_000
  }

  async polish(sources) {
    if (!this.llmClient?.completeJson) return null
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ recap_sources: sources }) },
        ],
        temperature: 0.5,
        maxTokens: 400,
      })
      const text = clean(result?.recap, 1_500)
      return text || null
    } catch {
      return null
    }
  }

  /**
   * @returns {Promise<{recap: null, reason: string} | {recap: {text: string, version: number, provider: string}}>}
   */
  async recapFor({ campaignId, state = {}, stateVersion = 0, lastEventAt = null } = {}) {
    if (!this.hasGap(lastEventAt)) return { recap: null, reason: 'no_gap' }
    // Зритель не принимается снаружи намеренно: рекап кешируется на кампанию,
    // и вызывающий не должен иметь возможности собрать его от лица игрока.
    const sources = recapSources(state, PARTY_VIEWER)
    if (!hasMaterial(sources)) return { recap: null, reason: 'no_summaries' }
    const cached = this.cache?.get(campaignId, stateVersion) ?? null
    if (cached) {
      return { recap: { text: cached.text, version: Number(stateVersion) || 0, provider: clean(cached.provider, 40) || 'cache' } }
    }
    const polished = await this.polish(sources)
    const text = polished || deterministicRecapText(sources)
    if (!text) return { recap: null, reason: 'no_summaries' }
    const provider = polished ? 'model' : 'deterministic'
    this.cache?.set(campaignId, stateVersion, { text, provider, created_at: new Date(Number(this.now())).toISOString() })
    return { recap: { text, version: Number(stateVersion) || 0, provider } }
  }
}
