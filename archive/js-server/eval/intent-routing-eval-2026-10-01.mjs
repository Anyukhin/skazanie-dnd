// Замер маршрутизации свободного текста игрока: какой путь сервера выбирает
// детерминированный слой и совпадает ли он с эталоном.
//
//   node eval/intent-routing-eval-2026-10-01.mjs --output eval/intent-routing-before-2026-10-01.json
//   node eval/intent-routing-eval-2026-10-01.mjs --live --prompt v7 --output eval/intent-routing-live-2026-10-01.json --budget-rub 7
//
// Без `--live` сеть не используется: проходят настоящие модули сервера в том же
// порядке, что в `/api/narrate` (`server/index.mjs`) и `GameOrchestrator._handle`:
//   inferRequestKind → proposeAgentInteraction → answerKnownLore → actionSequence
//   → IntentParser.parse → (свободное действие) handleUnknownAction.
// Ветки, которым нужна живая карта и event store (`resolveExplorationCommand`,
// пропсы, двери), здесь заменены их входным условием — это отмечено в отчёте.
//
// С `--live` для реплик, которые детерминированный слой отдаёт судье свободных
// действий, вызывается настоящий `ActionAdjudicator` (контракт v6 или v7) на
// модели openai/gpt-6-luna без reasoning. Ключ берётся из .env и не печатается.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// `INTENT_ROUTING_ROOT` — каталог с копией `server/` в состоянии «до»: так
// замер BEFORE повторяется на том же наборе после правки эталона или набора.
const root = process.env.INTENT_ROUTING_ROOT
  ? pathToFileURL(`${process.env.INTENT_ROUTING_ROOT.replace(/[\\/]+$/u, '')}/`).href
  : new URL('../', import.meta.url).href
const { inferRequestKind, IntentParser, actionSequence, classifyFreeActionKind } = await import(`${root}server/intent-parser.mjs`)
const { proposeAgentInteraction, answerKnownLore } = await import(`${root}server/player-request-router.mjs`)

/** Смысловой класс → маршруты кода, которые для него правильны. Первый — основной. */
export const GOLD_ROUTES = Object.freeze({
  travel_exit: ['travel_exit'],
  // Шаг по доске: к названному собеседнику — `MoveActor` через
  // `resolveExplorationCommand`; к углу или окну — судья свободных действий.
  // Ошибка здесь одна — уйти из локации.
  move_in_scene: ['move_in_scene', 'free_action'],
  social_talk: ['social'],
  // Механическая покупка — карточка торговца; текстом торговля идёт разговором
  // с торговцем (`NpcSocialController`), а не проверкой навыка.
  trade: ['social'],
  ability_check: ['ability_check'],
  attack: ['attack'],
  cast_spell: ['cast_spell'],
  rest: ['rest'],
  ask_gm_question: ['question'],
  ooc_party_chat: ['discussion'],
  free_action_improv: ['free_action'],
  multi_step: ['multi_step'],
})

/** Намерение `IntentParser` → маршрут кода. */
const INTENT_ROUTES = Object.freeze({
  social: 'social',
  attack: 'attack', approach_attack: 'attack', compound_maneuver: 'attack', damage: 'attack',
  cast_spell: 'cast_spell',
  ability_check: 'ability_check', saving_throw: 'ability_check',
  rest: 'rest',
  healing: 'other_rule', start_combat: 'other_rule', end_combat: 'other_rule', end_turn: 'other_rule', why: 'other_rule',
  improvised_action: 'free_action', explore: 'free_action', unknown: 'free_action',
})

/** Состояние стола: таверна в портовом городе, рядом — точки карты мира. */
export function fixtureState() {
  const scene = { title: 'Вечер в «Ржавом Якоре»', location: 'Таверна «Ржавый Якорь»', location_id: 'ржавый-якорь', mood: 'дымно и шумно', objective: 'Найти сына Финна' }
  const npcs = [
    { id: 'npc:finn', name: 'Старый Финн', role: 'рыбак', location: scene.location, available: true, tags: ['рыбак'] },
    { id: 'npc:marta', name: 'Марта', role: 'innkeeper', location: scene.location, available: true, tags: ['трактирщица', 'хозяйка'] },
    { id: 'npc:boris', name: 'Борис', role: 'guard', location: scene.location, available: true, tags: ['стражник'] },
  ]
  const location = (id, name, kind, extra = {}) => ({ id, name, kind, x: 0, y: 0, regionId: 'побережье', known: true, visited: false, ...extra })
  return {
    sessionCode: 'eval-routing',
    activePlayerId: 'hero-1',
    players: [
      { id: 'hero-1', name: 'Эйра', character: 'Эйра', role: 'Плут' },
      { id: 'hero-2', name: 'Торвальд', character: 'Торвальд', role: 'Воин' },
    ],
    enemies: [],
    scene,
    scene_npcs: npcs,
    social: { npcs, relationships: {}, promises: [], conversations: [] },
    merchants: [{ id: 'merchant:ilsa', name: 'Ильса', role: 'merchant', location: scene.location, available: true }],
    adventure: { chapter: 1, currentHook: 'Сын Финна пропал у маяка', visitedLocations: ['Аквилон'] },
    worldMemory: {
      quests: [{ id: 'quest:finn', title: 'Пропавший сын Финна', status: 'active', objectives: ['Узнать, где видели сына Финна'] }],
      entities: [], facts: [],
    },
    worldMap: {
      version: 1, currentLocationId: 'ржавый-якорь',
      regions: [{ id: 'побережье', name: 'Побережье' }],
      locations: [
        location('аквилон', 'Аквилон', 'city', { visited: true }),
        location('ржавый-якорь', 'Таверна «Ржавый Якорь»', 'landmark', { visited: true }),
        location('морской-змей', 'Таверна "Морской Змей"', 'landmark'),
        location('плавучий-рынок', 'Плавучий Рынок', 'landmark'),
        location('каменный-град', 'Каменный Град', 'city'),
        location('пепельный-лес', 'Пепельный Лес', 'wilds'),
        location('мглистые-топи', 'Мглистые Топи', 'wilds'),
        location('солеварня', 'Солеварня', 'landmark'),
        location('маяк', 'Маяк Старого Рыбака', 'landmark'),
        location('храм-приливов', 'Храм Приливов', 'landmark'),
        location('северный-форт', 'Северный форт', 'fort'),
        location('ведьмина-падь', 'Ведьмина Падь', 'wilds', { known: false }),
      ],
      routes: [],
    },
    mechanics: { combat: { active: false } },
  }
}

const parser = new IntentParser()

/**
 * Маршрут, который выбрал бы сервер. Порядок шагов — тот же, что в
 * `/api/narrate`: вид реплики решается до карточки ухода, а лор и разбивка на
 * шаги — до разбора намерения.
 */
export async function routeDeterministic(text, state = fixtureState()) {
  const requestKind = inferRequestKind(text)
  if (requestKind === 'question') return { route: 'question', stage: 'inferRequestKind' }
  if (requestKind === 'discussion') return { route: 'discussion', stage: 'inferRequestKind' }
  const interaction = proposeAgentInteraction(text, state)
  if (interaction?.type === 'vote') return { route: 'travel_exit', stage: 'proposeAgentInteraction', options: interaction.options }
  if (interaction) return { route: 'fate_roll', stage: 'proposeAgentInteraction' }
  if (answerKnownLore(text, state)) return { route: 'question', stage: 'answerKnownLore' }
  if (actionSequence(text).length) return { route: 'multi_step', stage: 'actionSequence' }
  const intent = await parser.parse({ message: text, playerId: 'hero-1', visibleState: state })
  const route = INTENT_ROUTES[intent.intent] ?? 'free_action'
  if (route !== 'free_action') return { route, stage: 'IntentParser', intent: intent.intent, approach: intent.approach }
  // Свободное действие. «Подхожу к Марте» исполняет `resolveExplorationCommand`
  // (`MoveActor`) раньше судьи; его входное условие воспроизведено дословно.
  if (/^(?:я\s+)?(?:подхожу|приближаюсь|иду)\s+к\s+/iu.test(text)
    && !/(?:затем|потом|и\s+(?:прошу|спрашиваю|атакую|открываю))/iu.test(text)) {
    return { route: 'move_in_scene', stage: 'resolveExplorationCommand', intent: intent.intent }
  }
  return {
    route: 'free_action', stage: 'ActionAdjudicator', intent: intent.intent, approach: intent.approach,
    free_action_kind: classifyFreeActionKind(text),
    route_hint: intent.route_hint ?? null,
  }
}

function metrics(results) {
  const routes = [...new Set([...Object.values(GOLD_ROUTES).flat(), ...results.map((entry) => entry.predicted)])].sort()
  const perRoute = {}
  for (const route of routes) {
    const tp = results.filter((entry) => entry.gold_route === route && entry.predicted === route).length
    const fp = results.filter((entry) => entry.gold_route !== route && entry.predicted === route).length
    const fn = results.filter((entry) => entry.gold_route === route && entry.predicted !== route).length
    if (!tp && !fp && !fn) continue
    perRoute[route] = {
      support: tp + fn,
      predicted: tp + fp,
      precision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : null,
      recall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : null,
    }
  }
  const perGold = {}
  for (const gold of Object.keys(GOLD_ROUTES)) {
    const rows = results.filter((entry) => entry.gold === gold)
    if (rows.length) perGold[gold] = { cases: rows.length, correct: rows.filter((entry) => entry.correct).length }
  }
  const confusion = {}
  for (const entry of results.filter((row) => !row.correct)) {
    const key = `${entry.gold} → ${entry.predicted}`
    confusion[key] = (confusion[key] ?? 0) + 1
  }
  const travelFalsePositives = results.filter((entry) => entry.predicted === 'travel_exit' && entry.gold !== 'travel_exit').length
  return {
    cases: results.length,
    correct: results.filter((entry) => entry.correct).length,
    accuracy: Number((results.filter((entry) => entry.correct).length / results.length).toFixed(3)),
    travel_false_positives: travelFalsePositives,
    to_adjudicator: results.filter((entry) => entry.predicted === 'free_action').length,
    per_route: perRoute,
    per_gold_class: perGold,
    confusion_pairs: Object.fromEntries(Object.entries(confusion).sort((left, right) => right[1] - left[1])),
  }
}

export async function runDeterministic(cases) {
  const state = fixtureState()
  const results = []
  for (const entry of cases) {
    const accepted = GOLD_ROUTES[entry.gold]
    assert.ok(accepted, `неизвестный класс ${entry.gold}`)
    const outcome = await routeDeterministic(entry.text, state)
    const correct = accepted.includes(outcome.route)
    results.push({
      id: entry.id, text: entry.text, gold: entry.gold, gold_route: correct ? outcome.route : accepted[0],
      predicted: outcome.route, correct, stage: outcome.stage, tags: entry.tags ?? [],
      ...(outcome.intent ? { intent: outcome.intent } : {}),
      ...(outcome.options ? { vote_options: outcome.options } : {}),
    })
  }
  return results
}

// ---------- живой прогон судьи ----------
async function runLive({ cases, promptVersion, output, budgetRub, label = '' }) {
  process.loadEnvFile(new URL('../.env', import.meta.url))
  const { RouterAIClient } = await import(`${root}server/llm-client.mjs`)
  const { ActionAdjudicator } = await import(`${root}server/action-adjudicator.mjs`)
  const { interpretFreeAction } = await import(`${root}server/free-action-adjudication.mjs`)
  const { normalizeCampaignState } = await import(`${root}server/rules-engine.mjs`)
  const { proposeRoutedTravel } = await import(`${root}server/player-request-router.mjs`)
  const catalog = JSON.parse(readFileSync(new URL('./routerai-catalog-2026-10-01.json', import.meta.url), 'utf8'))
  const model = 'openai/gpt-6-luna'
  const pricing = catalog.data.find((entry) => entry.id === model).pricing
  const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {
    schema_version: 1, created_at: new Date().toISOString(), model, reasoning: { enabled: false },
    note: 'Реплики, которые детерминированный слой отдаёт судье свободных действий. Эталонный маршрут судьи: travel для travel_exit, talk для social_talk/trade, clarify для ooc_party_chat/ask_gm_question, check для остальных. v6 не умеет называть маршрут: его маршрут всегда check.',
    runs: [],
  }
  const spent = () => report.runs.flatMap((run) => run.calls).reduce((sum, call) => sum + (call.usage_cost ?? call.catalog_cost_rub ?? 0), 0)
  // Запись повторяется: на Windows файл отчёта изредка держит индексатор, и
  // оборванный прогон стоил бы денег второй раз.
  const save = () => {
    for (let attempt = 0; ; attempt += 1) {
      try { writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); return } catch (error) {
        if (attempt >= 5) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      }
    }
  }
  // Незавершённый прогон той же версии продолжается, а не начинается заново.
  // Звонок без записанного случая (оборван на записи) уже оплачен и остаётся в
  // счёте, а сам случай прогоняется снова.
  const unfinished = report.runs.at(-1)
  const run = unfinished && !unfinished.summary && unfinished.prompt === `action_adjudicator/${promptVersion}` && (unfinished.label ?? '') === label
    ? unfinished
    : { prompt: `action_adjudicator/${promptVersion}`, ...(label ? { label } : {}), started_at: new Date().toISOString(), calls: [], cases: [] }
  if (run !== unfinished) report.runs.push(run)
  const done = new Set(run.cases.map((row) => row.id))
  const inner = new RouterAIClient({ model, reasoning: { enabled: false }, timeoutMs: 20_000, maxTokens: 900 })
  const client = {
    async completeJson(input, options = {}) {
      const ceiling = (Buffer.byteLength(JSON.stringify(input.messages)) + 1024) * pricing.prompt + 900 * pricing.completion
      assert.ok(spent() + ceiling < budgetRub, `бюджет ${budgetRub} ₽ исчерпан`)
      const started = performance.now()
      const call = { production_timeout_ms: Number(options.timeoutMs) || null }
      try {
        const result = await inner.complete({ ...input, timeoutMs: 20_000 }, { json: true, timeoutMs: 20_000 })
        Object.assign(call, {
          ok: true, response_model: result.model, usage: result.usage,
          usage_cost: typeof result.usage?.cost === 'number' ? result.usage.cost : null,
          catalog_cost_rub: result.usage ? (Number(result.usage.prompt_tokens) || 0) * pricing.prompt + (Number(result.usage.completion_tokens) || 0) * pricing.completion : null,
          json_parsed: result.json != null, raw: result.json,
        })
        return result.json
      } catch (error) {
        Object.assign(call, { ok: false, error_code: String(error?.code ?? error?.name ?? 'ERROR').slice(0, 80) })
        throw error
      } finally {
        call.latency_ms = Math.round(performance.now() - started)
        run.calls.push(call)
        save()
      }
    },
  }
  // Обе версии контракта идут через один и тот же модуль: v6 подаётся текстом,
  // так что разница замера — только в промпте.
  const systemPrompt = readFileSync(new URL(`../prompts/action_adjudicator/${promptVersion}.txt`, import.meta.url), 'utf8')
  const adjudicator = new ActionAdjudicator({ llmClient: client, timeoutMs: 20_000, systemPrompt })
  const state = normalizeCampaignState({
    ...fixtureState(),
    players: [{
      id: 'hero-1', name: 'Эйра', character: 'Эйра', characterClass: 'rogue', level: 2, hp: 14, maxHp: 14, armor: 14, speed: 30, x: 2, y: 2,
      abilities: { str: 10, dex: 16, con: 12, int: 12, wis: 13, cha: 14 },
      classSkillProficiencies: ['stealth', 'perception', 'persuasion', 'sleight_of_hand'],
      inventory: [{ id: 'rope', name: 'Верёвка', quantity: 1 }, { id: 'dagger', name: 'Кинжал', quantity: 1, equipped: true }],
    }, { id: 'hero-2', name: 'Торвальд', character: 'Торвальд', characterClass: 'fighter', level: 2, hp: 20, maxHp: 20, armor: 16, speed: 30, x: 3, y: 2 }],
  })
  const expectedRoute = (gold) => gold === 'travel_exit' ? 'travel'
    : ['social_talk', 'trade'].includes(gold) ? 'talk'
      : ['ooc_party_chat', 'ask_gm_question'].includes(gold) ? 'clarify'
        : 'check'
  for (const entry of cases) {
    if (done.has(entry.id)) continue
    const before = run.calls.length
    const started = performance.now()
    const reading = await adjudicator.read(state, 'hero-1', entry.text, interpretFreeAction(entry.text))
    const call = run.calls[before] ?? null
    const route = reading.route ?? 'check'
    run.cases.push({
      id: entry.id, text: entry.text, gold: entry.gold, expected_route: expectedRoute(entry.gold), route,
      route_correct: route === expectedRoute(entry.gold),
      destination: reading.destination ?? '', npc_hint: reading.npc_hint ?? '',
      // Откроется ли карточка ухода по этому назначению (тот же словарь мест).
      ...(route === 'travel' ? { travel_card_opened: Boolean(proposeRoutedTravel({ route, destination: reading.destination ?? '' }, fixtureState())) } : {}),
      skill: reading.skill, source: reading.source,
      json_valid: Boolean(call?.ok && call?.json_parsed && !String(reading.source).includes('after-agent-error')),
      latency_ms: Math.round(performance.now() - started),
    })
    save()
  }
  const rows = run.cases
  run.summary = {
    cases: rows.length,
    route_correct: rows.filter((row) => row.route_correct).length,
    route_accuracy: Number((rows.filter((row) => row.route_correct).length / Math.max(1, rows.length)).toFixed(3)),
    json_valid: rows.filter((row) => row.json_valid).length,
    latency_ms_median: [...rows.map((row) => row.latency_ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null,
    latency_ms_max: Math.max(0, ...rows.map((row) => row.latency_ms)),
    cost_rub: Number(run.calls.reduce((sum, call) => sum + (call.usage_cost ?? call.catalog_cost_rub ?? 0), 0).toFixed(4)),
    by_expected_route: Object.fromEntries(['travel', 'talk', 'clarify', 'check'].map((route) => {
      const subset = rows.filter((row) => row.expected_route === route)
      return [route, { cases: subset.length, correct: subset.filter((row) => row.route_correct).length }]
    })),
  }
  report.total_cost_rub = Number(spent().toFixed(4))
  save()
  console.log(JSON.stringify({ prompt: run.prompt, ...run.summary }, null, 2))
}

// ---------- запуск ----------
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const opt = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const output = opt('--output')
  assert.ok(output, 'нужен --output')
  // `--cases` — другой набор того же формата (отложенный контрольный набор).
  const casesFile = opt('--cases')
  const { cases } = JSON.parse(readFileSync(casesFile ?? new URL('./intent-routing-cases-2026-10-01.json', import.meta.url), 'utf8'))
  if (args.includes('--pipeline')) {
    // Сквозная точность: детерминированный слой плюс маршрут судьи для того,
    // что до него дошло. Маршрут travel засчитывается, только если карточка
    // ухода действительно открылась бы; talk — для разговора и торговли;
    // clarify — для вопроса и обсуждения; check — там, где эталон допускает
    // свободное действие.
    //   --pipeline --output <live.json> --det <отчёт> --run <номер прогона> --name <ключ>
    const report = JSON.parse(readFileSync(output, 'utf8'))
    const det = JSON.parse(readFileSync(opt('--det'), 'utf8')).results
    const run = report.runs[Number(opt('--run'))]
    const llm = new Map(run.cases.map((row) => [row.id, row]))
    const rows = det.map((row) => {
      if (row.predicted !== 'free_action') return { id: row.id, gold: row.gold, final: row.predicted, correct: row.correct }
      const answer = llm.get(row.id)
      const route = answer?.route ?? 'check'
      const correct = route === 'travel' ? row.gold === 'travel_exit' && answer?.travel_card_opened === true
        : route === 'talk' ? ['social_talk', 'trade'].includes(row.gold)
          : route === 'clarify' ? ['ooc_party_chat', 'ask_gm_question'].includes(row.gold)
            : GOLD_ROUTES[row.gold].includes('free_action')
      return { id: row.id, gold: row.gold, final: `adjudicator:${route}`, correct, ...(answer ? {} : { missing_llm_answer: true }) }
    })
    report.pipeline ??= {}
    report.pipeline[opt('--name')] = {
      deterministic_report: opt('--det'), llm_run: `${run.prompt}${run.label ? ` (${run.label})` : ''}`,
      cases: rows.length, correct: rows.filter((row) => row.correct).length,
      accuracy: Number((rows.filter((row) => row.correct).length / rows.length).toFixed(3)),
      missing_llm_answers: rows.filter((row) => row.missing_llm_answer).length,
      errors: rows.filter((row) => !row.correct).map(({ id, gold, final }) => ({ id, gold, final })),
    }
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    const { errors: _errors, ...headline } = report.pipeline[opt('--name')]
    console.log(JSON.stringify(headline))
  } else if (args.includes('--live')) {
    const promptVersion = opt('--prompt', 'v7')
    const budgetRub = Number(opt('--budget-rub', '7'))
    assert.ok(['v6', 'v7'].includes(promptVersion) && budgetRub > 0 && budgetRub <= 15)
    // Судья получает ровно то, что до него дошло бы: реплики, у которых
    // детерминированный маршрут — free_action. Набор фиксируется флагом
    // `--subset-from <отчёт>`, чтобы v6 и v7 видели одни и те же фразы.
    const subsetFrom = opt('--subset-from')
    // Можно перечислить несколько отчётов через запятую: берётся объединение
    // реплик, которые хоть в одном из них дошли до судьи (BEFORE ∪ AFTER).
    const source = subsetFrom
      ? subsetFrom.split(',').flatMap((file) => JSON.parse(readFileSync(file, 'utf8')).results)
      : await runDeterministic(cases)
    const ids = new Set(source.filter((row) => row.predicted === 'free_action').map((row) => row.id))
    await runLive({ cases: cases.filter((entry) => ids.has(entry.id)), promptVersion, output, budgetRub, label: opt('--label', '') })
  } else {
    const results = await runDeterministic(cases)
    const report = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      method: 'Детерминированный стек сервера без сети: inferRequestKind → proposeAgentInteraction → answerKnownLore → actionSequence → IntentParser.parse → вход resolveExplorationCommand. Эталонные маршруты — GOLD_ROUTES в eval/intent-routing-eval-2026-10-01.mjs.',
      summary: metrics(results),
      failures: results.filter((entry) => !entry.correct).map(({ id, text, gold, predicted, stage }) => ({ id, text, gold, predicted, stage })),
      results,
    }
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    const { per_route: _perRoute, ...headline } = report.summary
    console.log(JSON.stringify(headline, null, 2))
  }
}
