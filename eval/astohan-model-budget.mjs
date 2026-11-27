import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const ROUTER_AI = 'https://routerai.ru/api/v1'
const LIMIT_RUB = 20
const SCALE = 1_000_000_000
const MAX_BODY_BYTES = 2 * 1024 * 1024
const PROMPT_RATES = new Set(['prompt', 'input_cache_read', 'input_cache_write', 'cache_read', 'cache_write'])
const RATE_FIELDS = new Set([...PROMPT_RATES, 'completion', 'request'])
const REQUEST_FIELDS = new Set([
  'model', 'messages', 'temperature', 'max_tokens', 'frequency_penalty', 'presence_penalty',
  'reasoning', 'provider', 'response_format', 'stream', 'stream_options',
])

function amount(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function reserveUnits(value) {
  const scaled = Math.ceil(value * SCALE)
  return Number.isSafeInteger(scaled) ? scaled : Infinity
}

function quoteEndpoint(endpoint, maxOutput) {
  if (!/^[a-z0-9-]+$/u.test(endpoint?.tag ?? '')) return null
  const promptTokens = endpoint.max_prompt_tokens ?? endpoint.context_length
  const completionTokens = endpoint.max_completion_tokens
  if (![promptTokens, completionTokens].every((value) => Number.isSafeInteger(value) && value > 0)) return null
  const pricing = endpoint.pricing
  const units = endpoint.pricing_units
  if (!pricing || units?.prompt !== 'token' || units?.completion !== 'token') return null
  const prices = Object.fromEntries(Object.entries(pricing).map(([key, value]) => [key, amount(value)]))
  if (prices.prompt == null || prices.completion == null) return null
  if (Object.entries(prices).some(([key, value]) => value == null || (value > 0 && !RATE_FIELDS.has(key)))) return null
  const tiers = endpoint.variable_pricings ?? []
  if (!Array.isArray(tiers) || tiers.some((tier) => tier?.type !== 'prompt-threshold')) return null
  for (const tier of tiers) {
    for (const [key, value] of Object.entries(tier)) {
      if (key === 'type' || key === 'threshold') continue
      const price = amount(value)
      if (price == null || (price > 0 && !RATE_FIELDS.has(key))) return null
      prices[key] = Math.max(prices[key] ?? 0, price)
    }
  }
  if (Object.entries(prices).some(([key, value]) => value > 0 && units[key] !== (key === 'request' ? 'request' : 'token'))) return null
  const promptRate = [...PROMPT_RATES].reduce((sum, key) => sum + reserveUnits(prices[key] ?? 0), 0)
  // Если endpoint не гарантирует max_tokens, резервируем по всему выходному
  // лимиту endpoint. В цене выхода уже учтены токены рассуждения.
  const boundedOutput = Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes('max_tokens')
  const output = boundedOutput ? Math.min(completionTokens, maxOutput) : completionTokens
  const reserve = promptTokens * promptRate + output * reserveUnits(prices.completion) + reserveUnits(prices.request ?? 0)
  return Number.isSafeInteger(reserve) ? { tag: endpoint.tag, reserve } : null
}

function textRequest(body) {
  if (!/^[a-z0-9][a-z0-9_.:-]*\/[a-z0-9][a-z0-9_.:-]*$/iu.test(body?.model ?? '')) return false
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0) return false
  if (Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) return false
  return Array.isArray(body.messages) && body.messages.length > 0 && body.messages.every((message) => (
    ['system', 'user', 'assistant', 'developer'].includes(message?.role)
    && typeof message.content === 'string'
    && Object.keys(message).every((key) => key === 'role' || key === 'content')
  ))
}

function catalogQuotes(endpoints, maxOutput) {
  // RouterAI закрепляет tag провайдера. Если под одним tag несколько
  // endpoint'ов, любой из них должен укладываться в общий резерв.
  const quotes = new Map()
  for (const endpoint of endpoints) {
    const previous = quotes.get(endpoint?.tag)
    const next = quoteEndpoint(endpoint, maxOutput)
    const candidate = next ? next.reserve : Infinity
    quotes.set(endpoint?.tag, Math.max(previous ?? 0, candidate))
  }
  return [...quotes].map(([tag, reserve]) => ({ tag, reserve })).filter(({ reserve }) => Number.isFinite(reserve))
}

async function readRequest(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function reply(response, status, code) {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) return response.end()
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { code, message: code } }))
}

function reportedCost(usage) {
  return amount(usage?.cost ?? usage?.total_cost)
}

function generationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/u.test(value) ? value : null
}

// Один шлюз обслуживает сервер игры и прямые запросы судьи. Незавершённые
// транзакции продолжают занимать свой резерв до получения подтверждённого usage.
export async function startAstohanBudgetRouter({ liveKey, upstream = ROUTER_AI, transport = fetch } = {}) {
  let address
  try { address = new URL(upstream) } catch { throw new Error('Неверный адрес провайдера стенда') }
  const real = address.href.replace(/\/$/u, '') === ROUTER_AI
  const local = address.protocol === 'http:' && address.hostname === '127.0.0.1' && !address.username && !address.password
  if ((!real && !local) || (real && !liveKey)) throw new Error('Для живого стенда нужен ключ RouterAI или локальная заглушка')
  const origin = address.href.replace(/\/$/u, '')
  const forwardingKey = real ? liveKey : 'skazanie-local-budget-provider'
  const standKey = randomUUID()
  const limit = LIMIT_RUB * SCALE
  const entries = []
  const pending = new Set()
  let admitted = 0
  let refusedBudget = 0
  let refusedTariff = 0
  let known = 0
  let closed = false

  function refuse(response, reason) {
    if (reason === 'STAND_BUDGET_EXCEEDED') refusedBudget++
    else refusedTariff++
    reply(response, 429, reason)
  }

  function settle(entry, cost) {
    if (cost == null || entry.cost != null) return
    const debit = reserveUnits(cost)
    entry.cost = cost
    entry.status = debit > entry.reserve ? 'exceeded_quote' : 'confirmed'
    known += cost
    admitted += debit - entry.reserve
    if (debit > entry.reserve) closed = true
  }

  async function reconcile(entry) {
    if (!entry.generationId || entry.cost != null) return
    try {
      const query = new URLSearchParams({ id: entry.generationId })
      const response = await transport(origin + '/generation?' + query, {
        redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Authorization: 'Bearer ' + forwardingKey },
      })
      if (!response.ok) return
      const data = await response.json()
      const generation = data?.data ?? data
      if (generation?.id === entry.generationId) settle(entry, amount(generation.total_cost))
    } catch { /* Неподтверждённая сумма сохраняет резерв. */ }
  }

  async function handle(request, response) {
    if (request.method !== 'POST' || request.url !== '/api/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + standKey) {
      reply(response, 404, 'STAND_ROUTE_UNAVAILABLE')
      return
    }
    let body
    try { body = await readRequest(request) } catch { reply(response, 400, 'STAND_INVALID_REQUEST'); return }
    if (!textRequest(body)) { refusedTariff++; reply(response, 400, 'STAND_UNBOUNDED_REQUEST'); return }
    if (closed) { refuse(response, 'STAND_BUDGET_EXCEEDED'); return }
    let quotes
    try {
      const modelPath = body.model.split('/').map(encodeURIComponent).join('/')
      const catalog = await transport(origin + '/models/' + modelPath + '/endpoints', { redirect: 'error', signal: AbortSignal.timeout(5_000) })
      if (!catalog.ok) throw new Error('catalog unavailable')
      const metadata = await catalog.json()
      quotes = metadata.data?.id === body.model ? catalogQuotes(metadata.data.endpoints, body.max_tokens) : []
    } catch {
      quotes = []
    }
    // Между проверкой и резервом нет await. Параллельные вызовы видят остаток
    // после чужих резервов, включая необъявленные списания за обрывы.
    const quote = quotes.find(({ reserve }) => reserve <= limit - admitted)
    if (response.destroyed) return
    if (!quote || closed) {
      refuse(response, quotes.length || closed ? 'STAND_BUDGET_EXCEEDED' : 'STAND_TARIFF_UNVERIFIED')
      return
    }
    admitted += quote.reserve
    const entry = { generationId: null, reserve: quote.reserve, cost: null, status: 'unconfirmed' }
    entries.push(entry)
    let usage
    try {
      const result = await transport(origin + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + forwardingKey },
        body: JSON.stringify({ ...body, provider: { only: [quote.tag], order: [quote.tag], allow_fallbacks: false },
          ...(body.stream ? { stream_options: { include_usage: true } } : {}) }),
      })
      entry.generationId = generationId(result.headers.get('x-generation-id'))
      if (entry.generationId && !response.destroyed) response.setHeader('X-Generation-Id', entry.generationId)
      if (!result.ok) {
        reply(response, result.status, 'STAND_PROVIDER_ERROR')
        return
      }
      const type = result.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream') && result.body) {
        if (!response.destroyed) response.writeHead(result.status, { 'Content-Type': 'text/event-stream' })
        const decoder = new TextDecoder()
        let buffered = ''
        for await (const chunk of result.body) {
          if (!response.destroyed) response.write(chunk)
          const lines = (buffered + decoder.decode(chunk, { stream: true })).split('\n')
          buffered = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            try {
              const frame = JSON.parse(line.slice(5))
              entry.generationId ??= generationId(frame.id)
              usage = frame.usage ?? usage
            } catch { /* [DONE] */ }
          }
        }
        if (!response.destroyed) response.end()
      } else {
        const data = await result.json()
        entry.generationId ??= generationId(data?.id)
        usage = data?.usage
        if (!response.destroyed) {
          response.writeHead(result.status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(data))
        }
      }
    } catch {
      reply(response, 502, 'STAND_PROVIDER_INTERRUPTED')
    } finally {
      settle(entry, reportedCost(usage))
      await reconcile(entry)
    }
  }

  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => reply(response, 500, 'STAND_BUDGET_FAILURE'))
    pending.add(task)
    task.finally(() => pending.delete(task))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/v1'
  return {
    baseUrl,
    standKey,
    env: { ROUTERAI_BASE_URL: baseUrl, ROUTERAI_API_KEY: standKey },
    checkpoint: () => ({ admitted: entries.length, budget: refusedBudget, tariff: refusedTariff }),
    stopReason(checkpoint) {
      if (entries.length !== checkpoint.admitted) return null
      if (refusedBudget > checkpoint.budget) return 'STAND_BUDGET_EXCEEDED'
      if (refusedTariff > checkpoint.tariff) return 'STAND_TARIFF_UNVERIFIED'
      return null
    },
    report() {
      const unknowns = entries.filter((entry) => entry.cost == null)
      return {
        limit_rub: LIMIT_RUB, known_rub: Number(known.toPrecision(14)),
        unknown_requests: unknowns.length, reserved_rub: unknowns.reduce((total, entry) => total + entry.reserve, 0) / SCALE,
        refused: refusedBudget + refusedTariff, refused_budget: refusedBudget, refused_tariff: refusedTariff,
        requests: entries.length, exceeded_quote: entries.filter((entry) => entry.status === 'exceeded_quote').length,
        unconfirmed_generations: unknowns.map((entry) => entry.generationId).filter(Boolean),
      }
    },
    async close() {
      closed = true
      const done = new Promise((resolve) => server.close(resolve))
      await Promise.allSettled([...pending])
      await Promise.all(entries.map(reconcile))
      await done
    },
  }
}
