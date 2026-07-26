import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normalizeFreeActionReading } from './free-action-adjudication.mjs'
import { ENVIRONMENT_HAZARD_IDS, IMPROVISED_EFFECT_IDS } from './improvised-effects.mjs'
import { buildDataOnlyContext } from './security.mjs'

/**
 * Арбитр свободного действия. Единственная роль модели здесь — **понять
 * задумку**: какой характеристикой и навыком её судить, насколько она вообще
 * возможна, чем игрок рискует и чего это стоит в бою.
 *
 * Модель не бросает кубики, не выбирает СЛ, не описывает исход и не может
 * назначить эффект вне закрытого списка. Всё, что она вернула, проходит через
 * `normalizeFreeActionReading` и каталог `improvised-effects.mjs`; при любой
 * ошибке, таймауте или отсутствии ключа предложение молча заменяется
 * детерминированным прочтением, и игра продолжается.
 */
const prompt = readFileSync(fileURLToPath(new URL('../prompts/action_adjudicator/v1.txt', import.meta.url)), 'utf8')

const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** Лист героя в том объёме, который нужен для выбора кубика, и не шире. */
function heroBrief(state, actorId) {
  const hero = (state?.players ?? []).find((actor) => String(actor?.id) === String(actorId)) ?? {}
  const sheet = hero.characterSheet ?? {}
  return {
    id: String(hero.id ?? actorId),
    name: clean(hero.character ?? hero.name, 80),
    role: clean(hero.role, 80),
    abilities: sheet.abilities ?? hero.abilities ?? {},
    skill_proficiencies: (hero.classSkillProficiencies ?? []).map((entry) => clean(entry, 60)),
    prepared_spells: (hero.preparedSpellIds ?? []).map((entry) => clean(entry, 60)).slice(0, 20),
    known_spells: (hero.knownSpellIds ?? []).map((entry) => clean(entry, 60)).slice(0, 20),
    features: (hero.selectedFeatureIds ?? []).map((entry) => clean(entry, 60)).slice(0, 20),
    inventory: (hero.inventory ?? []).map((item) => ({
      id: clean(item?.id, 120), name: clean(item?.name, 80), equipped: item?.equipped === true,
    })).slice(0, 30),
    speed: Number(hero.speed) || 30,
  }
}

/** Кто на поле. Без этого модель не может назвать корректный `effect_target`. */
function participantsBrief(state) {
  const position = (actor) => (Number.isFinite(Number(actor?.x)) ? { x: Number(actor.x), y: Number(actor.y) } : null)
  return [
    ...(state?.players ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.character ?? actor.name, 80), side: 'party', at: position(actor) })),
    ...(state?.actors ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), side: 'party', at: position(actor) })),
    ...(state?.enemies ?? []).filter((actor) => actor?.alive !== false && Number(actor?.hp ?? 1) > 0)
      .map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), side: 'enemy', at: position(actor) })),
  ].slice(0, 24)
}

function economyBrief(state, actorId) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return { in_combat: false }
  const economy = combat.action_economy?.[String(actorId)] ?? {}
  return {
    in_combat: true,
    round: Number(combat.round) || 1,
    action_available: economy.action !== false,
    bonus_action_available: economy.bonus_action !== false,
    movement_spent_feet: Number(economy.movement_spent) || 0,
  }
}

export function adjudicationBrief(state, actorId, text) {
  return {
    player_action: clean(text, 1_000),
    hero: heroBrief(state, actorId),
    scene: {
      title: clean(state?.scene?.title, 120),
      location: clean(state?.scene?.location, 120),
      mood: clean(state?.scene?.mood, 160),
      objective: clean(state?.scene?.objective, 160),
    },
    participants: participantsBrief(state),
    turn_economy: economyBrief(state, actorId),
    allowed: {
      effects: [...IMPROVISED_EFFECT_IDS],
      hazards: [...ENVIRONMENT_HAZARD_IDS],
    },
  }
}

export class ActionAdjudicator {
  constructor({ llmClient = null, timeoutMs = 9_000 } = {}) {
    this.llmClient = llmClient
    this.timeoutMs = timeoutMs
  }

  /**
   * Возвращает прочтение задумки. Никогда не бросает: отказ модели — это
   * возврат к детерминированной таблице, а не сломанный ход.
   */
  async read(state, actorId, text, fallbackReading) {
    if (!this.llmClient?.completeJson) return fallbackReading
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ free_action_brief: adjudicationBrief(state, actorId, text) }) },
        ],
        temperature: 0.2,
        maxTokens: 500,
      })
      const reading = normalizeFreeActionReading({ ...result, source: 'agent-adjudicator' }, text)
      // Модель могла назвать эффект, которого нет в каталоге. Оставлять такой
      // ключ нельзя: дальше он всё равно превратится в «ничего не произошло»,
      // но в трассе выглядел бы как решение агента.
      if (!IMPROVISED_EFFECT_IDS.includes(reading.effect)) reading.effect = 'none'
      if (reading.hazard && !ENVIRONMENT_HAZARD_IDS.includes(reading.hazard)) reading.hazard = ''
      return reading
    } catch {
      return { ...fallbackReading, source: `${fallbackReading.source}-after-agent-error` }
    }
  }
}
