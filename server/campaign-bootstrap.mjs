import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { generateSceneCells } from './adventure-director.mjs'
import { ECONOMY_POLICY_ID, createStarterMerchant, normalizeMerchants } from './merchant-economy.mjs'
import { withStarterKit } from './starter-kit.mjs'
import { ensureSceneWorldMemory } from './scene-memory.mjs'
import { createCampaignWorldMap } from './world-map.mjs'
import { DEFAULT_PARTY_DECISION_POLICY } from './party-decision.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { buildCampaignArcPlan } from './campaign-loop-policy.mjs'

const prompt = readFileSync(fileURLToPath(new URL('../prompts/campaign_creator/v3.txt', import.meta.url)), 'utf8')

/**
 * Создание кампании — не ход. Оно просит у модели на порядок больше текста
 * (история мира, глобальная карта, пролог, NPC — до 3200 токенов), и общий
 * боевой таймаут в 9 секунд ей не по размеру: живой замер 2026-07-28 показал
 * три подряд таймаута и 35 секунд ожидания, прежде чем ответила четвёртая
 * модель. Операция разовая и происходит на экране создания мира, где
 * ожидание уместно, а сожжённые впустую попытки — нет.
 */
export const CAMPAIGN_BOOTSTRAP_TIMEOUT_MS = 45_000

function clean(value, maximum = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function prose(value, maximum = 4000) {
  return String(value ?? '').replace(/\r/g, '').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maximum)
}

function integer(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function decimal(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function normalizeWorld(input = {}) {
  return {
    preset: clean(input.preset, 300),
    era: clean(input.era, 80),
    genre: clean(input.genre, 100),
    tone: clean(input.tone, 160),
    premise: clean(input.premise, 1000),
    themes: clean(input.themes, 400),
    boundaries: clean(input.boundaries, 500),
    magicLevel: clean(input.magicLevel, 80),
    technologyLevel: clean(input.technologyLevel, 80),
    startingLocation: clean(input.startingLocation, 160),
    openingSituation: clean(input.openingSituation, 800),
  }
}

function normalizeHero(input, index) {
  const id = clean(input?.id, 40)
  const character = clean(input?.character, 80)
  if (!/^[a-z0-9-]{1,40}$/i.test(id)) throw new Error(`У героя ${index + 1} некорректный id`)
  if (!character) throw new Error(`У героя ${index + 1} нет имени персонажа`)
  const maxHp = integer(input.maxHp, 10, 1, 999)
  return {
    ...structuredClone(input),
    id,
    name: clean(input.name, 80) || 'Свободный герой',
    character,
    role: clean(input.role, 120) || 'Искатель приключений · ур. 1',
    species: clean(input.species, 80) || 'Человек',
    background: clean(input.background, 120) || 'Странник',
    backstory: clean(input.backstory, 2000),
    traits: clean(input.traits, 500),
    ideals: clean(input.ideals, 500),
    bonds: clean(input.bonds, 500),
    flaws: clean(input.flaws, 500),
    features: clean(input.features, 1000),
    notes: clean(input.notes, 1000),
    level: integer(input.level, 1, 1, 20),
    speed: integer(input.speed, 30, 5, 120),
    proficiency: integer(input.proficiency, 2, 2, 8),
    hp: maxHp,
    maxHp,
    armor: integer(input.armor, 10, 1, 30),
    online: input.online !== false,
    inventory: Array.isArray(input.inventory) ? structuredClone(input.inventory).slice(0, 100) : [],
    currency: input.currency && typeof input.currency === 'object' ? structuredClone(input.currency) : { copper: 0, silver: 0, gold: 0, platinum: 0 },
    abilities: input.abilities && typeof input.abilities === 'object' ? structuredClone(input.abilities) : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    color: clean(input.color, 20) || ['#d79b5b', '#758f78', '#8b789e', '#9a745d'][index % 4],
    initials: clean(input.initials, 4) || character.slice(0, 2).toLocaleUpperCase('ru'),
    portrait: clean(input.portrait, 240),
    portraitPosition: clean(input.portraitPosition, 40) || '50% 50%',
    experience: integer(input.experience, 0, 0, 9999999),
    alignment: clean(input.alignment, 100) || 'Не определено',
  }
}

function fallbackTheme(world, entropy = '') {
  const value = `${world.preset} ${world.era} ${world.genre} ${world.premise}`.toLocaleLowerCase('ru')
  if (/будущ|косм|кибер|зв[её]зд|станци|технолог/u.test(value)) return { location: 'Кольцевая станция «Гелиос»', theme: 'футуристическая орбитальная станция', layout: 'rooms', danger: 'средняя', water: 0 }
  if (/соврем|детектив|нуар|город/u.test(value)) return { location: 'Ночной район Ривермарк', theme: 'современный город', layout: 'streets', danger: 'низкая', water: 0.03 }
  if (/дик|постапок|пустош|выжив/u.test(value)) return { location: 'Поселение у Разломанной трассы', theme: 'постапокалиптическая пустошь', layout: 'open', danger: 'высокая', water: 0.02 }
  if (value.trim()) return { location: 'Пограничный город Эйрхольм', theme: 'средневековый пограничный город', layout: 'streets', danger: 'средняя', water: 0.04 }
  const automaticThemes = [
    { location: 'Пограничный город Эйрхольм', theme: 'средневековый пограничный город', layout: 'streets', danger: 'средняя', water: 0.04 },
    { location: 'Кольцевая станция «Гелиос»', theme: 'футуристическая орбитальная станция', layout: 'rooms', danger: 'средняя', water: 0 },
    { location: 'Ночной район Ривермарк', theme: 'современный мистический город', layout: 'streets', danger: 'низкая', water: 0.03 },
    { location: 'Поселение у Разломанной трассы', theme: 'постапокалиптическая пустошь', layout: 'open', danger: 'высокая', water: 0.02 },
  ]
  const index = createHash('sha256').update(entropy || String(Date.now())).digest()[0] % automaticThemes.length
  return automaticThemes[index]
}

const MAP_SCALES = new Set(['room', 'site', 'stronghold', 'region'])
const MAP_PATTERNS = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])
const MAP_MATERIALS = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])

function startingVisualSpec(theme, world) {
  const value = `${theme.location} ${theme.theme} ${world.startingLocation} ${world.openingSituation}`.toLocaleLowerCase('ru')
  if (/крепост|замок|цитадел/u.test(value)) return { scale: 'stronghold', pattern: 'keep', material: 'stone', width: 23, height: 17 }
  if (/комнат|кабинет|мал.*зал|кают/u.test(value)) return { scale: 'room', pattern: 'small-room', material: /станци|косм|тех/u.test(value) ? 'metal' : /дом|таверн/u.test(value) ? 'wood' : 'stone', width: 9, height: 7 }
  if (theme.layout === 'streets') return { scale: 'site', pattern: 'village', material: /станци|тех|кибер/u.test(value) ? 'metal' : 'stone', width: 17, height: 11 }
  if (theme.layout === 'rooms') return { scale: 'site', pattern: 'great-hall', material: /станци|тех|косм/u.test(value) ? 'metal' : 'stone', width: 15, height: 11 }
  if (/лес|роща|луг/u.test(value)) return { scale: 'site', pattern: 'natural', material: 'grass', width: 15, height: 11 }
  if (/пустын|пес/u.test(value)) return { scale: 'site', pattern: 'natural', material: 'sand', width: 15, height: 11 }
  return { scale: 'site', pattern: 'natural', material: 'earth', width: 15, height: 11 }
}

function fallbackOpening({ name, partyName, world, heroes, entropy }) {
  const theme = fallbackTheme(world, entropy)
  const location = world.startingLocation || theme.location
  const unnamedPartySize = ['одного', 'двух', 'трёх', 'четырёх', 'пяти'][Math.max(1, Math.min(5, heroes.length)) - 1]
  const heroNames = heroes.every((hero) => hero.characterSetupRequired)
    ? `${unnamedPartySize} ${heroes.length === 1 ? 'героя, которому игрок ещё даст имя и прошлое' : 'героев, которым игроки ещё дадут имена и прошлое'}`
    : heroes.map((hero) => hero.character).join(', ')
  const era = world.era || 'необычной авторской эпохе'
  const genre = world.genre || world.preset || 'приключенческой истории'
  const tone = world.tone || 'Атмосфера полна тайн и обещает открытия'
  const premise = world.premise || 'Привычный порядок нарушает событие, которое может навсегда изменить этот мир.'
  const situation = world.openingSituation || premise
  const visual = startingVisualSpec(theme, world)
  return {
    campaignName: name === 'Новая кампания' ? `Хроники: ${location}` : name,
    partyName: partyName === 'Новый отряд' ? 'Искатели нового мира' : partyName,
    worldSummary: `${name} — самостоятельный мир в ${era}, жанр: ${genre}. ${premise}`,
    worldHistory: `Земли вокруг ${location} менялись задолго до появления героев. ${premise} Теперь старые дороги, границы и забытые места снова определяют судьбы тех, кто здесь живёт.`,
    worldMap: {},
    openingNarration: `${location}. ${tone}. ${situation}\n\nЗдесь впервые сходятся пути героев: ${heroNames}. У каждого есть причина не пройти мимо, но решение о первом шаге остаётся за отрядом.`,
    scene: {
      title: 'Точка пересечения', location,
      mood: tone,
      objective: 'Разобраться в происходящем и решить, кому можно доверять',
      theme: theme.theme, danger: theme.danger,
      map: { layout: theme.layout, ...visual, openness: 0.66, water: theme.water, featureCount: 6 },
    },
    hook: situation,
    npcs: [{
      name: 'Мира Ветрокрыл', role: 'проводница и очевидец',
      summary: 'Местная проводница знает дороги и следит за переменами вокруг.',
      voice: 'Говорит коротко, внимательно и по делу.',
      goals: ['Защитить путников', 'Понять источник угрозы'],
      beliefs: ['Обещания важнее красивых слов'],
    }],
  }
}

/**
 * Собеседники первой сцены. Раньше в кампанию всегда попадала одна и та же
 * захардкоженная «Мира Ветрокрыл», которой не было в прологе, а названные в
 * прологе трактирщик и рыбак не существовали как NPC — заговорить с ними было
 * нельзя, парсер отвечал «Уточните имя собеседника».
 */
function normalizeOpeningNpcs(value, fallback) {
  const source = Array.isArray(value) ? value : []
  const normalized = source
    .map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}))
    .map((entry) => ({
      name: clean(entry.name, 80),
      role: clean(entry.role, 120),
      summary: clean(entry.summary, 400),
      voice: clean(entry.voice, 240),
      goals: (Array.isArray(entry.goals) ? entry.goals : []).map((goal) => clean(goal, 160)).filter(Boolean).slice(0, 4),
      beliefs: (Array.isArray(entry.beliefs) ? entry.beliefs : []).map((belief) => clean(belief, 160)).filter(Boolean).slice(0, 4),
    }))
    .filter((entry) => entry.name)
    .slice(0, 3)
  return normalized.length ? normalized : fallback
}

function normalizeOpening(input, fallback) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const scene = source.scene && typeof source.scene === 'object' && !Array.isArray(source.scene) ? source.scene : {}
  const map = scene.map && typeof scene.map === 'object' && !Array.isArray(scene.map) ? scene.map : {}
  const layouts = new Set(['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'])
  const danger = new Set(['низкая', 'средняя', 'высокая'])
  const scale = MAP_SCALES.has(map.scale) ? map.scale : fallback.scene.map.scale
  const scaleMinimum = scale === 'stronghold' ? { width: 19, height: 13 }
    : scale === 'region' ? { width: 21, height: 15 }
      : scale === 'site' ? { width: 11, height: 9 }
        : { width: 7, height: 7 }
  return {
    campaignName: clean(source.campaignName, 120) || fallback.campaignName,
    partyName: clean(source.partyName, 120) || fallback.partyName,
    worldSummary: clean(source.worldSummary, 1200) || fallback.worldSummary,
    worldHistory: prose(source.worldHistory, 5000) || fallback.worldHistory,
    worldMap: source.worldMap && typeof source.worldMap === 'object' && !Array.isArray(source.worldMap) ? structuredClone(source.worldMap) : fallback.worldMap,
    openingNarration: prose(source.openingNarration, 4000) || fallback.openingNarration,
    scene: {
      title: clean(scene.title, 100) || fallback.scene.title,
      location: clean(scene.location, 160) || fallback.scene.location,
      mood: clean(scene.mood, 240) || fallback.scene.mood,
      objective: clean(scene.objective, 240) || fallback.scene.objective,
      theme: clean(scene.theme, 120) || fallback.scene.theme,
      danger: danger.has(scene.danger) ? scene.danger : fallback.scene.danger,
      map: {
        layout: layouts.has(map.layout) ? map.layout : fallback.scene.map.layout,
        scale,
        pattern: MAP_PATTERNS.has(map.pattern) ? map.pattern : fallback.scene.map.pattern,
        material: MAP_MATERIALS.has(map.material) ? map.material : fallback.scene.map.material,
        width: integer(map.width, fallback.scene.map.width, scaleMinimum.width, 25),
        height: integer(map.height, fallback.scene.map.height, scaleMinimum.height, 19),
        openness: decimal(map.openness, fallback.scene.map.openness, 0.35, 0.85),
        water: decimal(map.water, fallback.scene.map.water, 0, 0.3),
        featureCount: integer(map.featureCount, fallback.scene.map.featureCount, 2, 12),
      },
    },
    hook: clean(source.hook, 500) || fallback.hook,
    npcs: normalizeOpeningNpcs(source.npcs, fallback.npcs),
  }
}

function startingCells(cells, count) {
  const floors = cells.filter((cell) => cell.revealed && cell.type === 'floor')
    .sort((left, right) => left.x - right.x || left.y - right.y)
  return Array.from({ length: count }, (_, index) => floors[index] ?? floors[0] ?? { x: 1, y: 1 })
}

export class CampaignBootstrapper {
  constructor({ llmClient = null, loreAuthor = null } = {}) { this.llmClient = llmClient; this.loreAuthor = loreAuthor }

  async create({ code, name, partyName, world: rawWorld, players: rawPlayers, merchants: rawMerchants } = {}) {
    const campaignCode = clean(code, 24).toUpperCase()
    const campaignName = clean(name, 120) || 'Новая кампания'
    const groupName = clean(partyName, 120) || 'Новый отряд'
    if (!/^[A-Z0-9-]{3,24}$/.test(campaignCode)) throw new Error('Некорректный код кампании')
    if (!Array.isArray(rawPlayers) || rawPlayers.length < 1 || rawPlayers.length > 12) throw new Error('Для новой кампании выберите от 1 до 12 героев')
    const heroes = rawPlayers.map(normalizeHero).map((hero) => hero.characterSetupRequired ? hero : withStarterKit(hero))
    if (new Set(heroes.map((hero) => hero.id)).size !== heroes.length) throw new Error('В кампании повторяются id героев')
    const world = normalizeWorld(rawWorld)
    const fallback = fallbackOpening({ name: campaignName, partyName: groupName, world, heroes, entropy: campaignCode })
    let opening = fallback
    let generatedBy = 'local-storyteller'
    if (this.llmClient) {
      try {
        const result = await this.llmClient.completeJson({
          messages: [
            { role: 'system', content: prompt },
            // Вводные владельца и листы героев — свободный текст игроков. Они
            // уходят только внутри UNTRUSTED_DATA: предыстория героя не должна
            // уметь командовать автором кампании.
            { role: 'user', content: buildDataOnlyContext({ campaign_setup: { campaign: campaignName, party: groupName, party_size: heroes.length, world, heroes: heroes.map((hero) => ({ character: hero.character, role: hero.role, species: hero.species, background: hero.background, backstory: hero.backstory, traits: hero.traits, ideals: hero.ideals, bonds: hero.bonds, flaws: hero.flaws })) } }) },
          ],
          temperature: 0.8,
          maxTokens: 3200,
          timeoutMs: CAMPAIGN_BOOTSTRAP_TIMEOUT_MS,
        })
        opening = normalizeOpening(result, fallback)
        generatedBy = 'ai-storyteller'
      } catch { /* A new campaign must still be playable when the provider is unavailable. */ }
    }
    const seed = createHash('sha256').update(JSON.stringify({ campaignCode, world, heroes: heroes.map((hero) => hero.id) })).digest('hex').slice(0, 24)
    const arc = buildCampaignArcPlan(seed)
    // Пролог — необязательное украшение: письмо-завязка, которое владелец
    // зачитает перед первым вечером. Отказ летописца кампанию не задерживает.
    const prologue = this.loreAuthor
      ? await this.loreAuthor.composePrologue({
        campaign: campaignName,
        worldSummary: opening.worldSummary,
        worldHistory: opening.worldHistory,
        heroes,
      })
      : ''
    const campaignConcept = {
      ...world,
      worldSummary: opening.worldSummary,
      worldHistory: opening.worldHistory,
      ...(prologue ? { prologue } : {}),
      generatedBy,
      arc,
    }
    // Через тот же выбор генератора, что и переходы Режиссёра: первая сцена
    // кампании — такая же локация, и таверна в её начале обязана быть таверной,
    // а не серой коробкой. Прежде здесь стоял прямой вызов процедурного
    // генератора, и стартовая сцена не могла получить тему ни при каких словах.
    const cells = generateSceneCells({
      seed,
      theme: opening.scene.theme,
      danger: opening.scene.danger,
      location: opening.scene.location,
      map: opening.scene.map,
    })
    const positions = startingCells(cells, heroes.length)
    const positionedHeroes = heroes.map((hero, index) => ({ ...hero, x: positions[index].x, y: positions[index].y }))
    const merchants = normalizeMerchants(Array.isArray(rawMerchants) && rawMerchants.length
      ? rawMerchants
      : [createStarterMerchant({ location: opening.scene.location })])
    const campaignWorldMap = createCampaignWorldMap({
      seed,
      campaignName: campaignName === 'Новая кампания' ? opening.campaignName : campaignName,
      concept: campaignConcept,
      source: opening.worldMap,
      startingLocation: opening.scene.location,
    })
    const starterFactionId = `faction-${seed.slice(0, 12)}`
    const starterQuestId = `quest-${seed.slice(0, 12)}`
    const openingNpcs = opening.npcs.map((npc, index) => ({
      id: `npc-${seed.slice(0, 12)}-${index + 1}`,
      name: npc.name,
      role: npc.role || 'житель этих мест',
      location: opening.scene.location,
      public_summary: npc.summary || `${npc.name} — часть первой сцены.`,
      voice: npc.voice || 'Говорит спокойно и по делу.',
      goals: npc.goals.length ? npc.goals : ['Пережить происходящее'],
      beliefs: npc.beliefs.length ? npc.beliefs : ['Слухам верить нельзя'],
      known_fact_ids: [], visibility: 'party', available: true,
      tags: [`faction:${starterFactionId}`],
    }))
    const starterNpcId = openingNpcs[0].id
    const sceneMemory = ensureSceneWorldMemory({}, {
      scene: { title: opening.scene.title, location: opening.scene.location, mood: opening.scene.mood, objective: opening.scene.objective },
      campaignConcept,
      adventure: {
        chapter: 1, currentHook: opening.hook,
        visitedLocations: [opening.scene.location], unresolvedThreads: [opening.hook], history: [],
      },
    })
    const initialWorldMemory = {
      ...sceneMemory,
      entities: [...(sceneMemory.entities ?? []), {
        id: starterFactionId, kind: 'faction', name: 'Хранители дороги',
        summary: 'Небольшое объединение проводников и дозорных, защищающее пути между поселениями.',
        aliases: [], visibility: 'party', tags: ['starter-faction'],
      }],
      quests: [...(sceneMemory.quests ?? []), {
        id: starterQuestId,
        title: opening.hook || opening.scene.objective || 'Первая зацепка',
        summary: opening.scene.objective,
        status: 'active', visibility: 'party', entity_ids: [starterFactionId],
        objectives: [opening.scene.objective],
        clock: { current: 0, max: arc.target_scenes, label: 'Прогресс расследования' },
      }],
    }
    return {
      sessionCode: campaignCode,
      campaign: campaignName === 'Новая кампания' ? opening.campaignName : campaignName,
      partyName: groupName === 'Новый отряд' ? opening.partyName : groupName,
      partyMemberIds: positionedHeroes.map((hero) => hero.id),
      partyDecisionPolicy: structuredClone(DEFAULT_PARTY_DECISION_POLICY),
      campaignConcept,
      worldMap: campaignWorldMap,
      worldMemory: initialWorldMemory,
      social: {
        npcs: openingNpcs,
        relationships: Object.fromEntries(openingNpcs.map((npc) => [npc.id, Object.fromEntries(positionedHeroes.map((hero) => [hero.id, 0]))])),
        conversations: [],
        promises: [{
          id: `promise-${seed.slice(0, 12)}`, npc_id: starterNpcId, hero_id: positionedHeroes[0].id,
          direction: 'npc_to_party', text: opening.scene.objective, due_hint: 'до следующего продолжительного отдыха',
          status: 'open', visibility: 'party', source_conversation_id: null, created_at_minutes: 0, deadline_minutes: 1_440,
        }],
      },
      state_version: 0,
      ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], enabled_house_rules: merchants.length ? [ECONOMY_POLICY_ID] : [], ruleset_locked_at: new Date().toISOString(), engine_mode: 'enforce',
      players: positionedHeroes,
      merchants,
      enemies: [], entities: [], mapFeedback: [], battleLog: [], mechanics: {}, rulings: [],
      activePlayerId: positionedHeroes[0].id,
      tacticalTurn: { sceneTurn: 1, actorId: positionedHeroes[0].id, movementSpent: 0, actionUsed: false },
      isNarrating: false, pendingCheck: null, agentInteraction: null, lastDiceRoll: null,
      scene: { title: opening.scene.title, location: opening.scene.location, mood: opening.scene.mood, objective: opening.scene.objective, turn: 1, cells },
      adventure: { chapter: 1, currentHook: opening.hook, visitedLocations: [opening.scene.location], unresolvedThreads: [opening.hook], history: [] },
      messages: [{ id: `opening-${seed}`, speaker: 'narrator', author: 'Рассказчик', timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()), text: opening.openingNarration, turnConsumed: false }],
    }
  }
}
