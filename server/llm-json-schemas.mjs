/**
 * JSON Schema ответов JSON-ролей для `response_format: json_schema` (strict).
 *
 * Схема — дополнительная гарантия формы на стороне провайдера, а не замена
 * проверки: ответ по-прежнему проходит собственный валидатор роли
 * (`normalizeDirectorIntent`, `structurallyValidSocialResponse`,
 * `normalizeOpening`). Поэтому схема описывает только то, что валидатор и так
 * требует или терпит, и ничего не ослабляет.
 *
 * Ограничения strict-режима, общие для проверенных провайдеров RouterAI
 * (`eval/structured-outputs-probe-2026-10-01.json`):
 * - каждое свойство перечислено в `required`, лишние запрещены
 *   (`additionalProperties: false`); необязательное поле валидатора здесь
 *   обязано присутствовать, но может быть `null`;
 * - корень — объект; `pattern`, `minimum`/`maximum` и `anyOf` не используются,
 *   потому что их поддержка у провайдеров разная, — эти границы держит валидатор.
 *
 * Модуль только описывает форму. Отправлять ли схему конкретной модели, решает
 * `supportsJsonSchema` (`server/model-style-profiles.mjs`) в `RouterAIClient`,
 * а форму объекта перед отправкой проверяет `usableJsonSchema` (`server/llm-client.mjs`).
 */
import { DIRECTOR_INTENT_TYPES } from './autonomous-campaign.mjs'
import { ENCOUNTER_DIFFICULTIES, ENCOUNTER_THEMES } from './encounter-assembler.mjs'

const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] })
const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] })
const text = { type: 'string' }
const strictObject = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Способы `resolve_scene`. Копия allowlist валидатора: там он не экспортирован.
 * Совпадение сторожит `test/llm-json-schemas.test.mjs`.
 */
export const DIRECTOR_SCENE_RESOLUTIONS = Object.freeze(['negotiation', 'objective', 'decision'])

/**
 * DirectorIntent. Поля — ровно `TOP_LEVEL_FIELDS` валидатора без `version`:
 * версию контракта ставит сервер, модели её писать незачем. Механических
 * полей (HP, DC, координаты…) в схеме нет, а лишние ключи запрещены — модель
 * физически не может их вернуть.
 */
export const DIRECTOR_INTENT_JSON_SCHEMA = deepFreeze({
  name: 'director_intent',
  strict: true,
  schema: strictObject({
    type: { type: 'string', enum: [...DIRECTOR_INTENT_TYPES] },
    theme: nullableEnum(ENCOUNTER_THEMES),
    difficulty: nullableEnum(ENCOUNTER_DIFFICULTIES),
    quest_id: nullable(text),
    npc_id: nullable(text),
    hook: nullable(text),
    destination: nullable(text),
    resolution: nullableEnum(DIRECTOR_SCENE_RESOLUTIONS),
    reason: nullable(text),
  }),
})

/** Отношение NPC и направление обещания — allowlist `npc-social-controller.mjs`. */
export const NPC_SOCIAL_STANCES = Object.freeze(['friendly', 'neutral', 'guarded', 'hostile'])
export const NPC_PROMISE_DIRECTIONS = Object.freeze(['npc_to_party', 'party_to_npc'])

/**
 * Ответ NPC в социальной сцене: ровно `NPC_SOCIAL_RESPONSE_FIELDS`. `promise`
 * — объект или `null`, как в промпте `social_v6`. Диапазон
 * `relationship_delta` (−2…2) и допустимые id фактов держит сервер.
 */
export const NPC_SOCIAL_RESPONSE_JSON_SCHEMA = deepFreeze({
  name: 'npc_social_response',
  strict: true,
  schema: strictObject({
    npc_id: text,
    reply: text,
    stance: { type: 'string', enum: [...NPC_SOCIAL_STANCES] },
    disclosed_fact_ids: { type: 'array', items: text },
    disclosed_claim_ids: { type: 'array', items: text },
    relationship_delta: { type: 'number' },
    promise: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['direction', 'text', 'due_hint'],
      properties: {
        direction: { type: 'string', enum: [...NPC_PROMISE_DIRECTIONS] },
        text,
        due_hint: text,
      },
    },
    confidence: { type: 'number' },
  }),
})

/**
 * Создание кампании (`prompts/campaign_creator/v5.txt`). Перечисления взяты из
 * формата промпта и совпадают с allowlist `normalizeOpening`; значения вне них
 * сервер и раньше заменял запасными. В бою схема пока не подключена:
 * `server/campaign-bootstrap.mjs` ведёт другой трек, и схема передаётся только
 * из замера (`eval/json-roles-bootstrap-eval-2026-10-01.mjs --json-schema`).
 */
export const CAMPAIGN_CREATION_JSON_SCHEMA = deepFreeze({
  name: 'campaign_creation',
  strict: true,
  schema: strictObject({
    campaignName: text,
    partyName: text,
    worldSummary: text,
    worldHistory: text,
    worldMap: strictObject({
      name: text,
      regions: { type: 'array', items: strictObject({
        name: text,
        biome: { type: 'string', enum: ['plains', 'forest', 'mountains', 'marsh', 'desert', 'tundra', 'coast', 'wastes'] },
        x: { type: 'number' },
        y: { type: 'number' },
        radius: { type: 'number' },
      }) },
      locations: { type: 'array', items: strictObject({
        name: text,
        kind: { type: 'string', enum: ['capital', 'city', 'town', 'village', 'port', 'fortress', 'ruin', 'dungeon', 'landmark', 'wilds'] },
        region: text,
        x: { type: 'number' },
        y: { type: 'number' },
        summary: text,
        known: { type: 'boolean' },
        visited: { type: 'boolean' },
      }) },
      routes: { type: 'array', items: strictObject({
        from: text,
        to: text,
        kind: { type: 'string', enum: ['road', 'trail', 'river', 'sea', 'pass'] },
        distance: { type: 'number' },
        danger: { type: 'string', enum: ['низкая', 'средняя', 'высокая'] },
        discovered: { type: 'boolean' },
      }) },
    }),
    openingNarration: text,
    scene: strictObject({
      title: text,
      location: text,
      mood: text,
      objective: text,
      theme: text,
      danger: { type: 'string', enum: ['низкая', 'средняя', 'высокая'] },
      map: strictObject({
        layout: { type: 'string', enum: ['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'] },
        scale: { type: 'string', enum: ['room', 'site', 'stronghold', 'region'] },
        pattern: { type: 'string', enum: ['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'] },
        material: { type: 'string', enum: ['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        openness: { type: 'number' },
        water: { type: 'number' },
        featureCount: { type: 'integer' },
        design: strictObject({
          topology: { type: 'string', enum: ['organic', 'linear', 'crossroads', 'market', 'courtyard', 'harbor', 'river', 'terraced', 'gate'] },
          climate: { type: 'string', enum: ['temperate', 'arid', 'cold', 'wetland'] },
          architecture: { type: 'string', enum: ['wood', 'stone', 'sand', 'metal', 'marble', 'ice'] },
          density: { type: 'string', enum: ['sparse', 'mixed', 'dense'] },
          building_use: { type: 'string', enum: ['dwelling', 'tavern', 'shop', 'manor'] },
        }),
      }),
    }),
    npcs: { type: 'array', items: strictObject({
      name: text,
      role: text,
      summary: text,
      voice: text,
      goals: { type: 'array', items: text },
      beliefs: { type: 'array', items: text },
    }) },
    hook: text,
  }),
})

