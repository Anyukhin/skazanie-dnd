import type { CombatMechanics, GameState, Player, ReputationTier, SummonedCreature } from './types'


/**
 * Общие мелочи интерфейса, которые нужны и основному экрану, и вынесенным
 * разделам. Отдельный модуль нужен, чтобы `App.tsx` и `AppViews.tsx` не
 * импортировали друг друга по кругу.
 *
 * Разделение по задаче 0 бэклога: поведение не меняется, только адрес кода.
 */

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-header"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
}

export function battleEventText(state: GameState, event: NonNullable<GameState['battleLog']>[number]) {
  const actorName = (id?: string) => state.players.find((player) => player.id === id)?.character
    ?? state.actors?.find((actor) => actor.id === id)?.name
    ?? state.enemies?.find((enemy) => enemy.id === id)?.name
    ?? id
    ?? 'Участник'
  const enemyTarget = state.enemies?.find((enemy) => enemy.id === event.targetId)
  const enemyActor = state.enemies?.find((enemy) => enemy.id === event.actorId)
  const hideTargetFacts = Boolean(enemyTarget && enemyTarget.healthKnown !== 'exact')
  const hideActorFacts = Boolean(enemyActor && enemyActor.healthKnown !== 'exact')
  if (event.type === 'combat-start') {
    const participants = (event.participantIds ?? []).map(actorName).join(', ')
    return participants ? `Бой начался. Участники: ${participants}.` : 'Бой начался, порядок инициативы определён.'
  }
  if (event.type === 'combat-end') return `Бой завершён в раунде ${event.round ?? 1}${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'parley') {
    if (event.result === 'refused') return `${actorName(event.actorId)} кричит о переговорах — ответа нет.`
    const roll = event.roll ? ` ${event.roll.total} против СЛ ${event.roll.difficulty ?? '?'}` : ''
    return `${actorName(event.actorId)} предлагает переговоры:${roll} — ${event.result === 'success' ? 'противник слушает' : 'противник не слушает'}.`
  }
  if (event.type === 'parley-rejected') return `Переговоры отвергнуты${event.reason === 'zealots' ? ': эти дерутся до конца' : event.reason === 'mindless' ? ': договариваться не с кем' : ''}.`
  if (event.type === 'truce') return `Объявлено перемирие: говорит ${actorName(event.targetId)}.`
  if (event.type === 'truce-broken') return `${actorName(event.actorId)} наносит удар под перемирием — уговор разорван.`
  if (event.type === 'parley-settled') {
    const outcomes: Record<string, string> = {
      withdraw: 'противник уходит с миром',
      tribute: 'противник уходит, оставив добычу',
      surrender: 'противник складывает оружие',
      resume: 'уговора нет, бой продолжается',
    }
    return `Переговоры завершены: ${outcomes[String(event.reason)] ?? 'условия приняты'}.`
  }
  // Подпись приходит с сервера готовой и намеренно неточной: за столом видно,
  // что противник приложился к склянке, а не то, что именно он выпил.
  if (event.type === 'npc-item') return `${actorName(event.actorId)} ${event.label || 'пускает в ход своё снаряжение'}.`
  if (event.type === 'move') return `${actorName(event.actorId)} перемещается на ${event.distanceFeet ?? 0} фт.`
  if (event.type === 'turn-end') return `${actorName(event.actorId)} завершает ход.`
  if (event.type === 'spell') return `${actorName(event.actorId)} применяет «${event.spellName ?? event.spellId ?? 'заклинание'}»${event.targetId ? ` к ${actorName(event.targetId)}` : ''}.`
  if (event.type === 'spell-save') {
    const modifier = Number(event.roll?.modifier) || 0
    const formula = `${event.roll?.die ?? '?'} ${modifier >= 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    const outcome = event.result === 'success' ? 'успех' : 'провал'
    const damage = event.damage != null ? ` · ${event.damage} урона` : ''
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    const automatic = event.automaticSuccess ? ' · автоматический успех' : event.immunity ? ` · иммунитет: ${event.immunity}` : ''
    const itemBonus = event.itemSavingThrowBonus ? ` · предмет +${event.itemSavingThrowBonus}` : ''
    return hideTargetFacts
      ? `${actorName(event.targetId)} делает спасбросок от «${event.spellName ?? event.spellId ?? 'заклинания'}» — ${outcome}${automatic}${itemBonus}${damage}.`
      : `${actorName(event.targetId)}: спасбросок ${event.ability?.toUpperCase() ?? ''} от «${event.spellName ?? event.spellId ?? 'заклинания'}» ${formula} против СЛ ${event.roll?.difficulty ?? '?'} — ${outcome}${automatic}${itemBonus}${damage}${hp}.`
  }
  if (event.type === 'spell-damage') return `${actorName(event.actorId)} применяет «${event.spellName ?? event.spellId ?? 'заклинание'}» к ${actorName(event.targetId)}: ${event.damage ?? 0} урона${hideTargetFacts ? '' : ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter ?? '?'}`}.`
  if (event.type === 'healing') {
    const source = event.spellId ? ` заклинанием «${event.spellName ?? event.spellId}»` : ''
    // «Лечит себя» — для любого участника, а не только для противника: зелье
    // пьют сами, и «Берсерк лечит Берсерка» читалось как две фигуры на доске.
    const whom = event.targetId && event.targetId === event.actorId ? 'себя' : actorName(event.targetId)
    // Числа у чужого лечения нет вовсе: сервер не присылает величину, пока
    // здоровье цели не опознано точно, — ровная десятка выдала бы зелье на
    // 2к4 + 2 не хуже его названия. За столом видно ровно то, что видно: враг
    // приложился к склянке и раны затянулись.
    if (event.healing == null) return `${actorName(event.actorId)} лечит ${whom}${source}: раны затягиваются.`
    return `${actorName(event.actorId)} лечит ${whom}${source}: +${event.healing} ОЗ${hideTargetFacts ? '' : ` · ${event.hpBefore ?? '?'} → ${event.hpAfter ?? '?'}`}.`
  }
  if (event.type === 'area-attack') return `${actorName(event.actorId)} применяет «${event.itemName ?? 'областную атаку'}» в области радиусом ${event.area?.radiusFeet ?? '?'} фт.`
  if (event.type === 'equipment') return `${actorName(event.actorId)} экипирует «${event.itemName ?? 'оружие'}».`
  if (event.type === 'summon') return `${actorName(event.actorId)} призывает ${actorName(event.targetId)}.`
  if (event.type === 'summon-end') return `${actorName(event.actorId)}: призыв ${actorName(event.targetId)} завершён.`
  if (event.type === 'death-save') {
    const natural = event.roll?.die ?? event.roll?.total ?? '?'
    const modifier = Number(event.roll?.modifier) || 0
    const rollText = modifier === 0 ? natural : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    return `${actorName(event.actorId)}: спасбросок от смерти ${rollText} — ${event.result === 'revived' ? 'натуральная 20, 1 ОЗ' : event.result === 'stabilized' ? 'стабилизация' : event.result === 'died' ? 'смерть' : event.result === 'success' ? 'успех' : 'провал'} (${event.successes ?? 0} успехов / ${event.failures ?? 0} провалов).${event.itemSavingThrowBonus ? ` Предмет: +${event.itemSavingThrowBonus}.` : ''}${event.auraBonus ? ` Аура защиты: +${event.auraBonus}.` : ''}${event.indomitableBonus ? ` Несгибаемый: +${event.indomitableBonus}, исходный итог ${event.indomitableOriginalTotal ?? '?'}.` : ''}`
  }
  if (event.type === 'death-save-damage') return `${actorName(event.actorId)} получает ${event.critical ? 'два провала' : 'провал'} спасброска от смерти из-за урона.`
  if (event.type === 'hero-stabilized') return `${actorName(event.actorId)} стабилизирован и больше не делает спасброски от смерти.`
  if (event.type === 'concentration-save') {
    const natural = event.roll?.die ?? '?'
    const modifier = Number(event.roll?.modifier) || 0
    const rollText = modifier === 0 ? natural : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${event.roll?.total ?? '?'}`
    return `${actorName(event.actorId)}: концентрация ${rollText} против СЛ ${event.roll?.difficulty ?? 10} — ${event.result === 'success' ? 'сохранена' : 'провалена'}.${event.itemSavingThrowBonus ? ` Предмет: +${event.itemSavingThrowBonus}.` : ''}${event.auraBonus ? ` Аура защиты: +${event.auraBonus}.` : ''}${event.indomitableBonus ? ` Несгибаемый: +${event.indomitableBonus}, исходный итог ${event.indomitableOriginalTotal ?? '?'}.` : ''}`
  }
  if (event.type === 'concentration-end') return `Концентрация ${actorName(event.actorId)} прекращена${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'max-hp-reduction') return hideTargetFacts ? `Жизненные силы ${actorName(event.targetId)} ослаблены.` : `${actorName(event.targetId)}: максимум ОЗ ${event.maximumHpBefore ?? '?'} → ${event.maximumHpAfter ?? '?'}.`
  if (event.type === 'max-hp-reduction-prevented') return `Аура жизни защищает максимум ОЗ ${actorName(event.targetId)}.`
  if (event.type === 'action') return event.indomitableBonus
    ? `${actorName(event.actorId)} использует «${event.actionName ?? 'Несгибаемый'}»: исходный итог ${event.indomitableOriginalTotal ?? '?'}, бонус переброска +${event.indomitableBonus}.`
    : `${actorName(event.actorId)} использует «${event.actionName ?? event.actionId ?? 'боевое действие'}».`
  if (event.type === 'attack') {
    const outcome = event.roll?.hit ? `попадание${event.damage != null ? `, ${event.damage} урона` : ''}` : 'промах'
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    return hideActorFacts
      ? `${actorName(event.actorId)} атакует ${actorName(event.targetId)} — ${outcome}${hp}.`
      : `${actorName(event.actorId)} атакует ${actorName(event.targetId)}: ${event.roll?.total ?? '?'}${hideTargetFacts ? '' : ` против КД ${event.roll?.difficulty ?? '?'}`} — ${outcome}${hp}.`
  }
  return event.type
}

export function locationsMatch(left: unknown, right: unknown) {
  const leftObject = left && typeof left === 'object' ? left as { location_id?: unknown; location?: unknown } : null
  const rightObject = right && typeof right === 'object' ? right as { location_id?: unknown; location?: unknown } : null
  const leftId = String(leftObject?.location_id ?? '').trim()
  const rightId = String(rightObject?.location_id ?? '').trim()
  if (leftId && rightId) return leftId === rightId
  return canonicalLocationKey(leftObject?.location ?? left) === canonicalLocationKey(rightObject?.location ?? right)
}

export const SKILL_LABELS: Record<string, string> = {
  acrobatics: 'Акробатика', animal_handling: 'Уход за животными', arcana: 'Магия', athletics: 'Атлетика',
  deception: 'Обман', history: 'История', insight: 'Проницательность', intimidation: 'Запугивание',
  investigation: 'Расследование', medicine: 'Медицина', nature: 'Природа', perception: 'Восприятие',
  performance: 'Выступление', persuasion: 'Убеждение', religion: 'Религия', sleight_of_hand: 'Ловкость рук',
  stealth: 'Скрытность', survival: 'Выживание',
}
export const ABILITY_LABELS: Record<string, string> = {
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
}
export const DIFFICULTY_LABELS: Record<string, string> = {
  trivial: 'просто', easy: 'легко', medium: 'непросто', hard: 'трудно', extreme: 'почти невозможно',
}

/** Масштаб интерфейса: настройки его меняют, корень приложения применяет. */
export const UI_SCALE_MIN = 80
export const UI_SCALE_MAX = 150
export const UI_SCALE_PRESETS = [80, 90, 100, 110, 115, 125, 150]
export const clampUiScale = (value: number) => Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value / 5) * 5))

export function canonicalLocationKey(value: unknown) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 180).toLocaleLowerCase('ru')
}

/**
 * Разделяют доска и корень приложения: тип участника доски, набор вредящих
 * школ, причина блокировки траектории и текущее состояние боя.
 */
export type BoardCombatant = Player | SummonedCreature
export function boardTrajectoryBlockReason(state: GameState, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cells = new Map(state.scene.cells.map((cell) => [`${cell.x},${cell.y}`, cell]))
  let x = from.x
  let y = from.y
  const dx = Math.abs(to.x - x)
  const sx = x < to.x ? 1 : -1
  const dy = -Math.abs(to.y - y)
  const sy = y < to.y ? 1 : -1
  let error = dx + dy
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
    if (x === to.x && y === to.y) return null
    const cell = cells.get(`${x},${y}`)
    if (!cell) return `Траектория выходит за край карты у клетки ${x + 1}:${y + 1}`
    if (cell.type === 'wall') return `Линию огня перекрывает стена в клетке ${x + 1}:${y + 1}`
  }
  return null
}

export function combatState(state: GameState): CombatMechanics {
  return state.mechanics?.combat ?? {}
}

export const HARMFUL_SPELL_KINDS = new Set(['attack', 'damage', 'area-damage', 'save', 'area-save', 'debuff'])

export const REPUTATION_TIER_LABELS: Record<ReputationTier, string> = {
  reviled: 'ненавидят',
  distrusted: 'не доверяют',
  unknown: 'не знают',
  respected: 'уважают',
  honoured: 'чтут',
}

