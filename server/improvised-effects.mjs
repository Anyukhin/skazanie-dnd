/**
 * Каталог того, что импровизация вообще может сделать с миром.
 *
 * Это граница полномочий агента, записанная кодом. Модель называет **ключ** из
 * закрытого списка и цель; всё остальное — какие кости, сколько, какое условие,
 * сколько это стоит хода — принадлежит серверу. Модель не может ни придумать
 * новый эффект, ни назначить число: незнакомый ключ просто отбрасывается.
 *
 * Модуль детерминированный и без обращений к LLM, как `campaign-loop-policy.mjs`.
 */

import { actorPosition } from './rules-engine.mjs'

const clean = (value, maximum = 120) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/**
 * Чем импровизация платит в бою. Вне боя цена всегда `free`.
 *
 * Перемещения в списке нет намеренно: движок списывает футы только событием
 * `ActorMoved` с настоящим путём, и «потратить движение» без перемещения было бы
 * фикцией. Если импровизация двигает героя — это обычная команда перемещения.
 */
export const ACTION_COSTS = Object.freeze(['action', 'bonus_action', 'free'])

const MELEE_REACH_FEET = 5
/**
 * Окрик и брошенная в глаза горсть песка достают дальше касания — решение
 * пользователя от 2026-07-27. Тридцать футов, а не «сколько слышно»: дальность
 * обязана быть конечной и проверяемой, иначе отвлечь можно было бы кого угодно
 * на карте.
 */
const SHOUTING_RANGE_FEET = 30

/**
 * Эффекты успеха. Каждый опирается на правило, которое движок уже исполняет,
 * поэтому новых механик здесь нет — есть новый повод применить старые.
 *
 * `target` говорит, на кого эффект вообще можно навести: попытка наложить
 * «помощь» на врага или «сбить с ног» на себя отбрасывается до броска.
 *
 * `range_feet` — досягаемость, и она у эффектов разная. Подсечь, подхватить под
 * руку, опутать и подставить под опасность — это касание, обычная ближняя
 * досягаемость SRD, та же, что движок уже применяет к ближней атаке. Отвлечь
 * окриком и ослепить брошенным в глаза можно с расстояния.
 *
 * Досягаемость объявлена полем каталога, а не константой в логике: разрешить
 * очередной эффект на расстоянии — правка одной строки данных.
 */
export const IMPROVISED_EFFECTS = Object.freeze({
  none: Object.freeze({
    id: 'none', target: 'none', label: 'без механического следствия',
    summary: 'Успех меняет обстановку описанием, без механического следствия.',
  }),
  prone: Object.freeze({
    id: 'prone', target: 'enemy', range_feet: MELEE_REACH_FEET, condition: 'prone', label: 'сбить с ног',
    summary: 'Цель сбита с ног.',
  }),
  help_ally: Object.freeze({
    id: 'help_ally', target: 'ally', range_feet: MELEE_REACH_FEET, condition: 'helped', duration: 'until-used', label: 'помочь союзнику',
    summary: 'Союзник получает преимущество на следующую атаку.',
  }),
  distract: Object.freeze({
    id: 'distract', target: 'enemy', range_feet: SHOUTING_RANGE_FEET, condition: 'disadvantage-next-attack', duration: 'until-next-turn', label: 'отвлечь противника',
    summary: 'Противник отвлечён: его следующая атака идёт с помехой.',
  }),
  blind: Object.freeze({
    id: 'blind', target: 'enemy', range_feet: SHOUTING_RANGE_FEET, condition: 'blinded', duration: 'until-next-turn', label: 'ослепить',
    summary: 'Цель ослеплена до конца своего следующего хода.',
  }),
  restrain: Object.freeze({
    id: 'restrain', target: 'enemy', range_feet: MELEE_REACH_FEET, condition: 'restrained', duration: 'until-next-turn', label: 'опутать',
    summary: 'Цель опутана до конца своего следующего хода.',
  }),
  hazard_damage: Object.freeze({
    id: 'hazard_damage', target: 'enemy', range_feet: MELEE_REACH_FEET, label: 'подставить под опасность',
    summary: 'Цель попадает под опасность окружения.',
    requiresHazard: true,
  }),
  // Обстановка как оружие из свободной фразы (задача 3.2c). Эти два эффекта
  // ничего не исполняют сами: они называют предмет сцены и глагол, а всю
  // механику — досягаемость, проверку Атлетики, источник огня, урон, зону и
  // цену действия — снова считает `OperateSceneObject`, та же команда, которой
  // пользуются кнопки пропса. Отсюда `target: 'scene_prop'`: цель здесь не
  // участник, и планировщик эффектов таких целей не разрешает.
  topple_prop: Object.freeze({
    id: 'topple_prop', target: 'scene_prop', range_feet: MELEE_REACH_FEET, sceneIntent: 'topple',
    label: 'опрокинуть предмет обстановки',
    summary: 'Тяжёлый предмет обстановки валится на то, что оказалось под ним.',
  }),
  ignite_prop: Object.freeze({
    id: 'ignite_prop', target: 'scene_prop', range_feet: MELEE_REACH_FEET, sceneIntent: 'ignite',
    label: 'поджечь предмет обстановки',
    summary: 'Горючий предмет обстановки занимается огнём.',
  }),
})

/**
 * Глагол `OperateSceneObject` за эффектом обстановки, либо `null`.
 *
 * Это весь мост между свободной фразой и механикой 3.2: маршрут выбирается по
 * закрытому каталогу, а не по тексту игрока и не по слову модели.
 *
 * @param {string} effectId
 * @returns {string|null}
 */
export function scenePropIntentFor(effectId) {
  const effect = IMPROVISED_EFFECTS[clean(effectId, 40)] ?? null
  return effect?.target === 'scene_prop' ? String(effect.sceneIntent) : null
}

/**
 * Опасности окружения. Урон за импровизацию раньше не делали намеренно: без
 * таблицы он был бы произвольным наказанием (`docs/known-limitations.md`).
 * Таблица закрывает именно это — кости фиксированы здесь, а не выбираются
 * моделью, и растут только со ставкой, которую сервер уже определил сам.
 *
 * Значения держатся в масштабе SRD: падение — 1к6 за 10 футов, огонь и кипяток
 * сопоставимы с ловушкой низкого уровня.
 */
export const ENVIRONMENT_HAZARDS = Object.freeze({
  fall: Object.freeze({
    id: 'fall', damage_type: 'bludgeoning', label: 'падение с высоты',
    expressions: Object.freeze({ none: '1d6', minor: '1d6', serious: '2d6', deadly: '3d6' }),
  }),
  fire: Object.freeze({
    id: 'fire', damage_type: 'fire', label: 'открытый огонь',
    expressions: Object.freeze({ none: '1d6', minor: '1d6', serious: '2d6', deadly: '3d6' }),
  }),
  scalding: Object.freeze({
    id: 'scalding', damage_type: 'fire', label: 'кипяток или пар',
    expressions: Object.freeze({ none: '1d4', minor: '1d4', serious: '2d4', deadly: '3d4' }),
  }),
  crush: Object.freeze({
    id: 'crush', damage_type: 'bludgeoning', label: 'обрушение или тяжёлый предмет',
    expressions: Object.freeze({ none: '1d6', minor: '2d6', serious: '3d6', deadly: '4d6' }),
  }),
  caustic: Object.freeze({
    id: 'caustic', damage_type: 'acid', label: 'едкое вещество',
    expressions: Object.freeze({ none: '1d4', minor: '1d6', serious: '2d6', deadly: '3d6' }),
  }),
  shards: Object.freeze({
    id: 'shards', damage_type: 'piercing', label: 'осколки или обломки',
    expressions: Object.freeze({ none: '1d4', minor: '1d6', serious: '2d6', deadly: '2d6' }),
  }),
})

export const IMPROVISED_EFFECT_IDS = Object.freeze(Object.keys(IMPROVISED_EFFECTS))
export const ENVIRONMENT_HAZARD_IDS = Object.freeze(Object.keys(ENVIRONMENT_HAZARDS))

function actorSide(state, actorIdValue) {
  const id = clean(actorIdValue, 120)
  if (!id) return null
  if ((state?.players ?? []).some((actor) => String(actor?.id) === id)) return 'party'
  if ((state?.actors ?? []).some((actor) => String(actor?.id) === id)) return 'party'
  if ((state?.enemies ?? []).some((actor) => String(actor?.id) === id)) return 'enemy'
  return null
}

/** Расстояние берётся из той же серверной позиции, по которой ходит движок. */
function distanceInFeet(state, firstActorId, secondActorId) {
  const first = actorPosition(state, clean(firstActorId, 120))
  const second = actorPosition(state, clean(secondActorId, 120))
  return first && second ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) * 5 : null
}

function isAlive(state, actorIdValue) {
  const id = clean(actorIdValue, 120)
  const actor = [...(state?.players ?? []), ...(state?.actors ?? []), ...(state?.enemies ?? [])]
    .find((candidate) => String(candidate?.id) === id)
  if (!actor) return false
  return actor.alive !== false && Number(actor.hp ?? 1) > 0
}

/**
 * Сверка предложенного эффекта с миром. Единственное место, где «сбить с ног
 * дракона» отличается от «сбить с ног того, кого на поле нет».
 *
 * Возвращает либо исполнимый план, либо причину отказа — отказ тоже честный
 * ответ игроку, а не молчаливое превращение в «ничего не произошло».
 */
export function planImprovisedEffect(state, { actorId = '', effectId = 'none', targetId = '', hazardId = '', risk = 'minor' } = {}) {
  const effect = IMPROVISED_EFFECTS[clean(effectId, 40)] ?? null
  if (!effect) return { effect: IMPROVISED_EFFECTS.none, commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  if (effect.target === 'none') return { effect, commands: [], summary: effect.summary }
  // Предмет обстановки сюда доходить не должен: маршрут в `OperateSceneObject`
  // выбирается до броска. Если дошёл — значит, предмет не подтвердился картой,
  // и придумывать вместо него команду нельзя.
  if (effect.target === 'scene_prop') {
    return { effect: IMPROVISED_EFFECTS.none, rejected: 'предмет обстановки не подтверждён картой', commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  }

  const target = clean(targetId, 120)
  if (!target) return { effect: IMPROVISED_EFFECTS.none, rejected: 'цель не названа', commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  if (!isAlive(state, target)) return { effect: IMPROVISED_EFFECTS.none, rejected: 'цели нет на поле', commands: [], summary: IMPROVISED_EFFECTS.none.summary }

  const actorTeam = actorSide(state, actorId)
  const targetTeam = actorSide(state, target)
  if (effect.target === 'enemy' && (!targetTeam || targetTeam === actorTeam)) {
    return { effect: IMPROVISED_EFFECTS.none, rejected: 'этот эффект применяется к противнику', commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  }
  if (effect.target === 'ally' && (targetTeam !== actorTeam || target === clean(actorId, 120))) {
    return { effect: IMPROVISED_EFFECTS.none, rejected: 'этот эффект применяется к союзнику', commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  }

  // Дальность сервер меряет сам. Без этой проверки агенту достаточно было
  // назвать любого живого противника на карте, и сервер сбивал его с ног или
  // подставлял под огонь через весь коридор.
  const reach = Math.max(0, Number(effect.range_feet) || 0)
  const distance = distanceInFeet(state, actorId, target)
  if (distance == null || distance > reach) {
    return { effect: IMPROVISED_EFFECTS.none, rejected: `цель слишком далеко: досягаемость ${reach} фт`, commands: [], summary: IMPROVISED_EFFECTS.none.summary }
  }

  if (effect.requiresHazard) {
    const hazard = ENVIRONMENT_HAZARDS[clean(hazardId, 40)] ?? null
    if (!hazard) return { effect: IMPROVISED_EFFECTS.none, rejected: 'такой опасности нет в списке', commands: [], summary: IMPROVISED_EFFECTS.none.summary }
    const expression = hazard.expressions[clean(risk, 20)] ?? hazard.expressions.minor
    return {
      effect,
      hazard,
      commands: [{
        command_type: 'ApplyDamage',
        actor_id: clean(actorId, 120),
        target_id: target,
        expression,
        damage_type: hazard.damage_type,
        source: `improvised:${hazard.id}`,
      }],
      summary: `${hazard.label}: цель получает урон (${expression}).`,
    }
  }

  return {
    effect,
    commands: [{
      command_type: 'AddCondition',
      actor_id: clean(actorId, 120),
      target_id: target,
      condition: effect.condition,
      ...(effect.duration ? { duration: effect.duration } : {}),
      source: 'improvised-action',
    }],
    summary: effect.summary,
  }
}

/**
 * Цена хода. Модель предлагает слот, но потратить можно только свободный: если
 * действие уже израсходовано, импровизация не проходит — как за столом.
 */
export function resolveActionCost(state, actorId, requestedCost) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return { cost: 'free', available: true }
  const cost = ACTION_COSTS.includes(String(requestedCost)) ? String(requestedCost) : 'action'
  if (cost === 'free') return { cost, available: true, slot: 'свободное взаимодействие' }
  const economy = combat.action_economy?.[String(actorId)] ?? {}
  if (cost === 'bonus_action') return { cost, available: economy.bonus_action !== false, slot: 'бонусное действие' }
  return { cost, available: economy.action !== false, slot: 'действие' }
}
