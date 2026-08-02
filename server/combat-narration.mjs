import { NARRATOR_PRIORITY, assertNarratorContract } from './deterministic-narration.mjs'
import { sceneInteractionNarration } from './scene-interactions.mjs'

/**
 * Боевой текст для ленты: удары, состояния, спасброски, ход времени.
 *
 * Жил в `server/index.mjs` до 2026-07-27 и там был непроверяем — функция не
 * экспортировалась, а импорт `index.mjs` поднимает HTTP-слушателя. Из-за этого
 * ветка про концентрацию годами печатала модификаторы врага без проверки на
 * сторону, и записать это можно было только в `known-limitations`.
 *
 * Перенесён сюда вместе с разбором долга `*-narration`: теперь это обычный
 * рассказчик того же контракта, что сцена, торговля и столкновение, и он
 * покрыт тестом.
 *
 * Важно: сюда приходят **сырые** committed events, а не проекция. Поэтому всё,
 * что принадлежит врагу, закрывается здесь вручную — флагом `targetIsEnemy`.
 */
function tacticalActorName(state, id) {
  const expected = String(id || '')
  const actor = [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
  return String(actor?.character || actor?.name || expected || 'Участник')
}

function tacticalActorIsEnemy(state, id) {
  const expected = String(id || '')
  return (state?.enemies ?? []).some((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
}

const COVER_SCENERY_LABELS = Object.freeze({
  altar: 'алтарь', barrel: 'бочку', bed: 'кровать', bookshelf: 'шкаф', bush: 'куст',
  chest: 'сундук', console: 'пульт', crate: 'ящик', fireplace: 'очаг', grave: 'могилу',
  pillar: 'колонну', rock: 'камень', statue: 'статую', table: 'стол', tree: 'дерево', well: 'колодец',
})

const CONDITION_LABELS = Object.freeze({
  blinded: 'ослеплена', frightened: 'испугана', grappled: 'схвачена', incapacitated: 'недееспособна',
  invisible: 'невидима', paralyzed: 'парализована', petrified: 'окаменела', poisoned: 'отравлена',
  prone: 'сбита с ног', restrained: 'опутана', stunned: 'оглушена', unconscious: 'без сознания',
})

const ATTACKER_CONDITION_LABELS = Object.freeze({
  blinded: 'ослеплён', frightened: 'испуган', grappled: 'схвачен', incapacitated: 'недееспособен',
  invisible: 'невидим', paralyzed: 'парализован', petrified: 'окаменел', poisoned: 'отравлен',
  prone: 'сбит с ног', restrained: 'опутан', stunned: 'оглушён', unconscious: 'без сознания',
})

/**
 * Названия видов урона в именительном падеже — для фразы «яд не действует».
 * Точный список защит существа не раскрывается: игрок узнаёт ровно то, что
 * увидел за столом, — что именно этот удар не сработал.
 */
const DAMAGE_TYPE_LABELS = Object.freeze({
  acid: 'Кислота', bludgeoning: 'Дробящий удар', cold: 'Холод', fire: 'Огонь',
  force: 'Силовая волна', lightning: 'Молния', necrotic: 'Некротическая энергия',
  piercing: 'Колющий удар', poison: 'Яд', psychic: 'Психическая атака',
  radiant: 'Свет', slashing: 'Рубящий удар', thunder: 'Грохот',
})

function damageTypeLabel(damageType) {
  return DAMAGE_TYPE_LABELS[String(damageType ?? '').toLowerCase()] ?? 'Этот урон'
}

/**
 * Explains why an attack was rolled with advantage or disadvantage.  When both
 * sides contribute they cancel and the roll is ordinary, so naming either one
 * would misdescribe what happened.
 */
function attackConditionReason(payload) {
  const advantage = payload.condition_advantage ?? []
  const disadvantage = payload.condition_disadvantage ?? []
  if ((advantage.length > 0) === (disadvantage.length > 0)) return ''
  const entries = advantage.length ? advantage : disadvantage
  const described = entries.map((entry) => {
    const [side, condition] = String(entry).split(':')
    return side === 'target'
      ? `цель ${CONDITION_LABELS[condition] ?? condition}`
      : `атакующий ${ATTACKER_CONDITION_LABELS[condition] ?? condition}`
  }).join(', ')
  return ` ${advantage.length ? 'с преимуществом' : 'с помехой'} (${described})`
}

function tacticalNarration(events, state) {
  const meaningful = []
  const turns = []
  const sceneInteraction = sceneInteractionNarration(events)
  if (sceneInteraction) meaningful.push(sceneInteraction)
  const partyFailed = (events ?? []).some((event) => event?.event_type === 'CampaignFailed')
  for (const event of events ?? []) {
    const payload = event.payload ?? {}
    const actor = tacticalActorName(state, event.actor_id)
    const targetId = event.target_ids?.[0] ?? payload.target_id
    const target = tacticalActorName(state, targetId)
    const targetIsEnemy = tacticalActorIsEnemy(state, targetId)
    if (event.event_type === 'EncounterCreated') {
      const names = (payload.encounter?.enemies ?? []).map((enemy) => String(enemy?.name ?? '')).filter(Boolean).slice(0, 12)
      meaningful.push(`На поле появляются противники: ${names.join(', ')}.`)
    } else if (event.event_type === 'EncounterEnded') {
      meaningful.push(`Столкновение завершено: ${String(payload.reason ?? payload.outcome ?? 'resolved')}.`)
    } else if (event.event_type === 'CombatStarted') {
      meaningful.push(`Бой начался, инициатива определена для ${(event.target_ids ?? []).length} участников.`)
      const surprised = (payload.surprised ?? []).map((id) => tacticalActorName(state, id))
      if (surprised.length) meaningful.push(`Застигнуты врасплох: ${surprised.join(', ')} — первый ход они теряют и не могут использовать реакцию.`)
    } else if (event.event_type === 'ActorMoved') {
      meaningful.push(`${actor} перемещается на ${Math.max(0, Number(payload.distance) || 0)} фт.`)
    } else if (event.event_type === 'AttackResolved') {
      // Особый приём объявляется отдельной строкой: иначе он тонет в обычном
      // «атакует — попадание», и стол не замечает, что существо потратило то,
      // чего у него больше нет до следующего броска.
      if (payload.recharge_action === true) meaningful.push(`${actor} пускает в ход «${String(payload.action_name || payload.action_id || 'особый приём')}».`)
      const reason = attackConditionReason(payload)
        + (payload.high_ground === 'higher' ? ' с возвышенности' : payload.high_ground === 'lower' ? ' снизу вверх' : '')
        + (payload.cover ? ` сквозь ${[
          ...(payload.cover_blockers ?? []).map((id) => tacticalActorName(state, id)),
          ...(payload.cover_scenery ?? []).map((feature) => COVER_SCENERY_LABELS[feature] ?? feature),
        ].join(', ') || 'помеху'} (${payload.cover === 'three-quarters' ? 'три четверти укрытия' : 'половинное укрытие'}, +${Number(payload.cover_bonus) || 2} к КД)` : '')
      const outcome = payload.hit
        ? payload.automatic_critical
          ? 'критическое попадание — цель не может защищаться'
          : payload.critical ? 'критическое попадание' : 'попадание'
        : 'промах'
      meaningful.push(targetIsEnemy
        ? `${actor} атакует ${target}${reason}: ${outcome}.`
        : `${actor} атакует ${target}${reason}: ${Number(payload.total) || 0} против КД ${Number(payload.armor_class) || 0} — ${outcome}.`)
    } else if (event.event_type === 'ItemEffectIneffective') {
      meaningful.push(`${payload.item_name || 'Склянка'} разбивается о ${target}, но вреда не причиняет.`)
    } else if (event.event_type === 'MonsterAbilityRecharged') {
      // Качественно и без чисел: порог recharge — часть стат-блока, и за столом
      // его не объявляют. Игрок узнаёт ровно то, что видит: приём снова готов.
      meaningful.push(`${target}: «${String(payload.name || payload.action_id || 'особый приём')}» снова наготове.`)
    } else if (event.event_type === 'AreaAttackResolved') {
      meaningful.push(`${actor} бросает ${payload.item_name || 'снаряд'} в область радиусом ${Number(payload.radius_feet) || 0} фт.`)
    } else if (event.event_type === 'SpellCast') {
      meaningful.push(`${actor} творит заклинание «${payload.name || payload.spell_id || 'магия'}».`)
    } else if (event.event_type === 'SummonedCreatureCreated') {
      meaningful.push(`${actor} призывает ${payload.summon?.name || 'помощника'}; его ход поставлен сразу после хозяина.`)
    } else if (event.event_type === 'SummonedCreatureDismissed') {
      meaningful.push(`${target} исчезает с поля боя.`)
    } else if (event.event_type === 'EquipmentChanged') {
      meaningful.push(`${actor} экипирует ${payload.item_name || 'оружие'}${payload.turns_spent ? ', затрачивая действие' : ' перед атакой'}.`)
    } else if (event.event_type === 'DamageApplied' && payload.immune === true && Number(payload.raw_amount) > 0) {
      meaningful.push(`${damageTypeLabel(payload.damage_type)} не действует на ${target}.`)
    } else if (event.event_type === 'ConditionImmunityResolved') {
      meaningful.push(`${target} не поддаётся: состояние не пристаёт к такому существу.`)
    } else if (event.event_type === 'DamageApplied' && Number(payload.applied_amount) > 0) {
      meaningful.push(targetIsEnemy
        ? payload.death_ward_triggered
          ? `${target} получает ${Number(payload.applied_amount)} урона, но Охрана от смерти удерживает цель на ногах.`
          : `${target} получает ${Number(payload.applied_amount)} урона.`
        : payload.death_ward_triggered
          ? `${target} получает ${Number(payload.applied_amount)} урона, но Охрана от смерти срабатывает и оставляет 1 ОЗ.`
          : payload.resistance_cantrip_reduction
            ? `Сопротивление уменьшает урон по ${target} на ${Number(payload.resistance_cantrip_reduction)}; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}.`
            : `${target} получает ${Number(payload.applied_amount)} урона; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}.`)
      // Качественно, без списков: за столом видно, что удар «не пошёл», а не то,
      // от чего именно существо защищено.
      if (payload.resistant === true) meaningful.push('Удар словно вязнет — цель сопротивляется такому урону.')
      else if (payload.vulnerable === true) meaningful.push('Удар приходится по уязвимому месту — рана вдвое тяжелее.')
    } else if (event.event_type === 'CreatureKnockedOut') {
      meaningful.push(targetIsEnemy ? `${target} нокаутирован и больше не сопротивляется.` : `${target} нокаутирован, остаётся с 1 ОЗ и начинает короткий отдых.`)
    } else if (event.event_type === 'KnockoutEnded') {
      meaningful.push(`${target} приходит в сознание после успешной первой помощи.`)
    } else if (event.event_type === 'RestCompleted' && payload.reason === 'knockout') {
      meaningful.push(`${target} приходит в сознание после завершения короткого отдыха.`)
    } else if (event.event_type === 'HitPointsReducedToZero') {
      meaningful.push(`${target} падает без сознания и начинает делать спасброски от смерти.`)
    } else if (event.event_type === 'DeathSavingThrowRolled') {
      const outcome = payload.result === 'revived' ? 'натуральная 20 возвращает 1 ОЗ' : payload.result === 'stabilized' ? 'герой стабилизирован' : payload.result === 'died' ? 'третий провал' : payload.success ? 'успех' : 'провал'
      const natural = Number(payload.natural_roll) || 0
      const modifier = Number(payload.modifier) || 0
      const total = Number(payload.total) || natural + modifier
      const rollText = modifier === 0 ? `${natural}` : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total}`
      const auraText = payload.aura_of_protection_bonus ? ` Аура защиты даёт +${Number(payload.aura_of_protection_bonus)}.` : ''
      meaningful.push(`${target} делает спасбросок от смерти: ${rollText} — ${outcome}.${auraText}`)
    } else if (event.event_type === 'ConcentrationSavingThrowResolved') {
      const natural = Number(payload.kept) || 0
      const modifier = Number(payload.modifier) || 0
      const total = Number(payload.total) || natural + modifier
      // Концентрацию проверяет тот, кого ударили, и модификатор здесь — его
      // собственный. У врага это часть stat block, которую продуктовые принципы
      // держат закрытой: игрок видит исход, а не из чего он сложился.
      const rollText = modifier === 0 ? `${natural}` : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total}`
      const auraText = payload.aura_of_protection_bonus ? ` Аура защиты даёт +${Number(payload.aura_of_protection_bonus)}.` : ''
      meaningful.push(targetIsEnemy
        ? `${target} пытается удержать концентрацию — ${payload.saved ? 'успех' : 'провал'}.`
        : `${target} проверяет концентрацию: ${rollText} против СЛ ${Number(payload.difficulty) || 10} — ${payload.saved ? 'успех' : 'провал'}.${auraText}`)
    } else if (event.event_type === 'ConcentrationEnded') {
      meaningful.push(`Концентрация ${target} прекращается (${String(payload.reason ?? 'эффект завершён')}).`)
    } else if (event.event_type === 'ActionReadied') {
      meaningful.push(`${target} замирает с оружием наготове и ждёт, когда ${String(payload.trigger_label ?? 'сработает выбранный триггер')}.`)
    } else if (event.event_type === 'ReadiedActionExpired') {
      // Про использованную заготовку расскажет сам удар, а вот сгоревшую иначе
      // никто не заметит: игрок просто не поймёт, куда делось действие.
      if (payload.reason !== 'used') meaningful.push(`${target} так и не дождался повода: заготовленный удар пропадает.`)
    } else if (event.event_type === 'DeathSaveFailureRecorded') {
      meaningful.push(`${target} получает ${Number(payload.failure_increment) === 2 ? 'два провала' : 'провал'} спасброска от смерти из-за урона.`)
    } else if (event.event_type === 'HeroStabilized') {
      meaningful.push(`${target} стабилизирован и остаётся без сознания.`)
    } else if (event.event_type === 'StableRecoveryScheduled') {
      meaningful.push(`${target} стабилен и восстановит 1 ОЗ через ${Math.max(1, Number(payload.recovery_hours) || 1)} ч.`)
    } else if (event.event_type === 'HealingApplied' && payload.reason === 'stable-recovery-after-1d4-hours') {
      meaningful.push(`${target} приходит в сознание с 1 ОЗ после необходимого времени покоя.`)
    } else if (event.event_type === 'HealingApplied' && payload.spell_id === 'aura-of-life') {
      meaningful.push(`Аура жизни возвращает ${target} 1 ОЗ в начале хода.`)
    } else if (event.event_type === 'HitPointMaximumReductionPrevented') {
      meaningful.push(`Аура жизни защищает максимум ОЗ ${target} от уменьшения.`)
    } else if (event.event_type === 'HitPointMaximumReduced') {
      meaningful.push(targetIsEnemy ? `Жизненные силы ${target} ослаблены.` : `Максимум ОЗ ${target} снижается: ${Number(payload.maximum_hp_before) || 0} → ${Number(payload.maximum_hp_after) || 0}.`)
    } else if (event.event_type === 'HeroDied') {
      meaningful.push(partyFailed
        ? `${target} погибает. Последний герой отряда пал, и история завершилась поражением.`
        : `${target} погибает. Его судьбу нужно разрешить: воскресить героя или заменить новым.`)
    } else if (event.event_type === 'HeroResurrected') {
      meaningful.push(`${target} возвращается к жизни с 1 ОЗ.`)
    } else if (event.event_type === 'HeroReplaced') {
      meaningful.push(`${payload.replacement_name || target} присоединяется к группе вместо погибшего героя.`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'fled') {
      meaningful.push(`${target} отступает и покидает бой.`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'surrendered') {
      meaningful.push(`${target} прекращает сопротивление и сдаётся.`)
    } else if (event.event_type === 'CombatEnded') {
      meaningful.push(`Бой завершён в раунде ${Number(payload.round) || 1}.`)
    } else if (event.event_type === 'TurnEnded') {
      turns.push(`${actor} завершает ход.`)
    } else if (event.event_type === 'TurnStarted') {
      turns.push(`Начинается ход ${target}, раунд ${Number(payload.round) || 1}.`)
    }
  }
  const selected = meaningful.length ? meaningful : turns
  return selected.slice(0, 8).join(' ')
}

/** Типы событий, про которые этот рассказчик умеет говорить. */
export const COMBAT_NARRATION_EVENT_TYPES = Object.freeze(new Set([
  'ActionReadied', 'ActorMoved', 'AreaAttackResolved', 'AttackResolved',
  'CombatEnded', 'CombatStarted', 'ConcentrationEnded', 'ConcentrationSavingThrowResolved',
  'ConditionAdded', 'ConditionImmunityResolved', 'CreatureKnockedOut', 'DamageApplied', 'DeathSaveFailureRecorded',
  'DeathSavingThrowRolled', 'EncounterCreated', 'EncounterEnded', 'EquipmentChanged',
  'HealingApplied', 'HeroDied', 'HeroReplaced', 'HeroResurrected',
  'HeroStabilized', 'HitPointMaximumReduced', 'HitPointMaximumReductionPrevented', 'HitPointsReducedToZero',
  'ItemEffectIneffective', 'MonsterAbilityRecharged',
  'KnockoutEnded', 'ReadiedActionExpired', 'RestCompleted', 'SpellCast',
  'SceneObjectCheckResolved', 'SceneObjectEffectApplied', 'SceneObjectInspected', 'SceneObjectLootRevealed',
  'SceneObjectKnowledgeRevealed', 'SceneObjectLootGranted', 'SceneObjectOperated',
  'SceneObjectStateChanged',
  'StableRecoveryScheduled', 'SummonedCreatureCreated', 'SummonedCreatureDismissed', 'TurnEnded',
  'TurnStarted',
]))

export function hasCombatNarrationEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => COMBAT_NARRATION_EVENT_TYPES.has(String(event?.event_type ?? '')))
}

export { tacticalNarration as combatNarration }

/**
 * Объявлен по общему контракту, но **намеренно не зарегистрирован** в реестре
 * `deterministic-narration.mjs`. Реестром пользуется `game-orchestrator`, а
 * боевой текст живёт в другом потоке — маршруты `server/index.mjs` зовут его
 * напрямую. Зарегистрировать его значило бы молча перехватить у оркестратора
 * ходы, которые сейчас уходят Рассказчику; такое решение принимает владелец, а
 * не разбор долга. Форма готова: включение — одна строка.
 */
export const combatNarrator = Object.freeze(assertNarratorContract({
  id: 'combat',
  priority: NARRATOR_PRIORITY.combat,
  promptVersion: 'combat-narrator/v1',
  provider: 'deterministic-combat',
  matches: hasCombatNarrationEvent,
  narrate: (events, state) => tacticalNarration(events, state) || null,
}))
