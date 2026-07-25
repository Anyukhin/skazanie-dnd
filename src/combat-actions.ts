import catalogPayload from '../data/dndsu-class-actions-1-12.json'
import buildRules from '../data/dndsu-class-build-rules-1-12.json'
import type { CombatAction, Player } from './types'

const defaultPartialActionNote = 'Сервер исполняет только формализованную часть способности; остальные свойства пока представлены маркером.'

type CatalogUsage = { maximum: number | 'proficiency' | `ability:${string}`; recovery: string }
type CatalogAction = CombatAction & { classKey: string; subclass?: string | null; uses?: CatalogUsage | null }
type CatalogClass = { classKey: string; label: string; subclassLevel: number; sourceUrl: string; subclasses: Array<{ id: string; name: string; sourceUrl: string }>; actions: CatalogAction[] }

const generatedClasses = new Map((catalogPayload.classes as unknown as CatalogClass[]).map((entry) => [entry.classKey, entry]))
const curatedPassiveFeatures: Partial<Record<NonNullable<Player['characterClass']>, CatalogAction[]>> = {
  fighter: [{
    id: 'fighter-indomitable', classKey: 'fighter', name: 'Несгибаемый', category: 'class', target: 'self', actionType: 'free', range: 0, minimumLevel: 9,
    description: 'После проваленного спасброска перебросьте его с бонусом, равным уровню воина. Новый результат обязателен; одно использование восстанавливается долгим отдыхом.',
    sourceUrl: 'https://www.dndbeyond.com/sources/dnd/br-2024/character-classes#Level9Indomitable', uses: null,
  }],
  paladin: [{
    id: 'paladin-aura-of-protection', classKey: 'paladin', name: 'Аура защиты', category: 'class', target: 'self', actionType: 'free', range: 10, minimumLevel: 6,
    description: 'Пассивная аура 10 футов: вы и союзники добавляете к спасброскам ваш модификатор Харизмы (минимум +1). Аура не действует, пока вы недееспособны; несколько аур не складываются.',
    sourceUrl: 'https://www.dndbeyond.com/sources/dnd/br-2024/character-classes#Paladin', uses: null,
  }],
}
const normalizedName = (value?: string | null) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim()
const featureChoiceGroups = buildRules.featureChoiceGroups as Array<{ classKey: string; subclass?: string; unlockLevel: number; options: Array<{ id: string }> }>

export const DND_CLASS_OPTIONS = (catalogPayload.classes as unknown as CatalogClass[]).map((entry) => ({ key: entry.classKey as NonNullable<Player['characterClass']>, label: entry.label, subclassLevel: entry.subclassLevel, sourceUrl: entry.sourceUrl }))

export function playerClassKey(player?: Player): NonNullable<Player['characterClass']> | null {
  if (player?.characterClass && generatedClasses.has(player.characterClass)) return player.characterClass
  const role = String(player?.role ?? '').toLocaleLowerCase('ru')
  for (const [key, pattern] of [
    ['barbarian', /варвар|barbarian/u], ['bard', /бард|bard/u], ['cleric', /жрец|cleric/u], ['druid', /друид|druid/u],
    ['fighter', /воин|fighter/u], ['monk', /монах|monk/u], ['paladin', /паладин|paladin/u], ['ranger', /следопыт|ranger/u],
    ['rogue', /плут|разбойник|rogue/u], ['sorcerer', /чарод|sorcer/u], ['warlock', /колдун|warlock/u], ['wizard', /волшеб|wizard|маг\b/u],
  ] as const) if (pattern.test(role)) return key
  return null
}

function optionalFeatureSelected(player: Player, featureId: string) {
  if (!Array.isArray(player.selectedFeatureIds)) return true
  const classKey = playerClassKey(player)
  const level = Math.max(1, Math.min(12, Number(player.level) || 1))
  const optional = featureChoiceGroups.some((group) => group.classKey === classKey && level >= group.unlockLevel && (!group.subclass || normalizedName(group.subclass) === normalizedName(player.subclass)) && group.options.some((option) => option.id === featureId))
  return !optional || player.selectedFeatureIds.includes(featureId)
}

export function subclassOptionsFor(player?: Player) {
  const classKey = playerClassKey(player)
  return classKey ? generatedClasses.get(classKey)?.subclasses ?? [] : []
}

export function classFeatureCatalogFor(player?: Player, includeLocked = false): CatalogAction[] {
  const classKey = playerClassKey(player)
  const catalog = classKey ? generatedClasses.get(classKey) : undefined
  const level = Math.max(1, Math.min(12, Number(player?.level) || 1))
  const selectedSubclass = normalizedName(player?.subclass)
  const generatedEntries = (catalog?.actions ?? []).map((entry): CatalogAction => ({ ...entry, mechanicsSupport: entry.effect?.kind === 'special' ? 'ruling-only' : 'heuristic' }))
  const passiveEntries = (classKey ? curatedPassiveFeatures[classKey] ?? [] : []).map((entry): CatalogAction => ({ ...entry, mechanicsSupport: 'partial', supportNote: entry.supportNote ?? defaultPartialActionNote }))
  const entries = [...generatedEntries, ...passiveEntries]
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    .filter((entry) => (!entry.subclass || normalizedName(entry.subclass) === selectedSubclass) && (includeLocked || level >= Number(entry.minimumLevel ?? 1)))
    .map((entry) => structuredClone(entry))
}

const common: CombatAction[] = [
  { id: 'stand-up', name: 'Встать', category: 'common', target: 'self', actionType: 'free', range: 0, description: 'Потратить половину скорости и прекратить состояние «сбит с ног».' },
  { id: 'break-free', name: 'Высвободиться', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Проверка Силы против Сл удерживающего эффекта, чтобы прекратить опутывание.' },
  { id: 'steady-nerves', name: 'Совладать со страхом', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Проверка Мудрости против Сл «Гневной кары», чтобы прекратить испуг.' },
  { id: 'extinguish-self', name: 'Потушить пламя', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Потушить на себе пламя «Пылающей кары».' },
  { id: 'extinguish-ally', name: 'Потушить союзника', category: 'common', target: 'ally', actionType: 'action', range: 5, description: 'Потушить пламя «Пылающей кары» на соседнем союзнике.' },
  { id: 'expeditious-retreat-dash', name: 'Стремительный рывок', category: 'common', target: 'self', actionType: 'bonus_action', range: 0, description: 'Пока активно «Поспешное отступление», совершить Рывок бонусным действием.' },
  { id: 'dash', name: 'Рывок', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Получить дополнительное перемещение, равное скорости, до конца текущего хода.' },
  { id: 'disengage', name: 'Отход', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Перемещение не провоцирует атак по возможности до конца хода.' },
  { id: 'dodge', name: 'Уклонение', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Атаки по вам совершаются с помехой до начала следующего хода.' },
  { id: 'hide', name: 'Спрятаться', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Совершить проверку Ловкости (Скрытность) и получить преимущество из укрытия.' },
  { id: 'help', name: 'Помощь', category: 'common', target: 'ally', actionType: 'action', range: 5, description: 'Дать союзнику преимущество на следующую атаку.' },
  { id: 'grapple', name: 'Захват', category: 'common', target: 'enemy', actionType: 'action', range: 5, description: 'Состязание Атлетики; при успехе цель схвачена.' },
  { id: 'shove', name: 'Толчок', category: 'common', target: 'enemy', actionType: 'action', range: 5, description: 'Состязание Силы: при успехе цель сбита с ног.' },
  { id: 'ready', name: 'Подготовка', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Подготовить действие и условие для реакции.', mechanicsSupport: 'partial', supportNote: 'Сервер фиксирует подготовку до следующего хода; настройка условия и автоматический запуск реакции пока не реализованы.' },
  { id: 'search', name: 'Поиск', category: 'common', target: 'self', actionType: 'action', range: 0, description: 'Проверка Мудрости (Восприятие).' },
]

const fighter: CombatAction[] = [
  { id: 'second-wind', name: 'Второе дыхание', category: 'class', target: 'self', actionType: 'bonus_action', range: 0, resource: 'second_wind', cost: 1, description: 'Восстановить 1к10 + уровень хитов бонусным действием.' },
  { id: 'action-surge', name: 'Всплеск действий', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'action_surge', cost: 1, description: 'Немедленно получить ещё одно действие. Дополнительное действие нельзя потратить на магию.' },
  { id: 'trip-attack', name: 'Подсекающая атака', category: 'class', target: 'enemy', actionType: 'action', range: 600, resource: 'superiority_dice', cost: 1, requiresWeapon: true, description: 'Атака оружием наносит дополнительный к8 урона и может сбить цель с ног.' },
  { id: 'menacing-attack', name: 'Устрашающая атака', category: 'class', target: 'enemy', actionType: 'action', range: 600, resource: 'superiority_dice', cost: 1, requiresWeapon: true, description: 'Атака оружием наносит дополнительный к8 урона и может испугать цель.' },
]

export function fallbackCombatActions(player: Player): CombatAction[] {
  const role = player.role.toLocaleLowerCase('ru')
  const level = Math.max(1, player.level || 1)
  const result = [...common]
  if (/варвар|barbarian/u.test(role)) result.push({ id: 'rage', name: 'Ярость', category: 'class', target: 'self', actionType: 'bonus_action', range: 0, resource: 'rage', cost: 1, description: 'Сопротивление физическому урону и бонус к урону атак Силой.' })
  if (/бард|bard/u.test(role)) result.push({ id: 'bardic-inspiration', name: 'Вдохновение барда', category: 'class', target: 'ally', actionType: 'bonus_action', range: 60, resource: 'bardic_inspiration', cost: 1, description: 'Дать союзнику кость вдохновения.' })
  if (/друид|druid/u.test(role) && level >= 2) result.push({ id: 'wild-shape', name: 'Дикая форма', category: 'class', target: 'self', actionType: 'action', range: 0, resource: 'wild_shape', cost: 1, description: 'Принять звериный облик.' })
  if (/воин|fighter/u.test(role)) result.push(fighter[0], ...(level >= 2 ? [fighter[1]] : []), ...(level >= 3 ? fighter.slice(2).filter((entry) => optionalFeatureSelected(player, entry.id)) : []))
  if (/следопыт|ranger/u.test(role) && level >= 2) result.push({ id: 'hunters-mark', name: 'Метка охотника', category: 'class', target: 'enemy', actionType: 'bonus_action', range: 90, resource: 'spell_slots_1', cost: 1, concentration: true, description: 'Пометить врага: ваши атаки оружием наносят цели дополнительно 1к6 урона.' })
  if (/жрец|cleric/u.test(role) && level >= 2) result.push({ id: 'divine-spark', name: 'Божественная искра', category: 'class', target: 'ally', actionType: 'action', range: 30, resource: 'channel_divinity', cost: 1, description: 'Направить божественную силу и восстановить союзнику 1к8 + модификатор Мудрости хитов.' })
  if (/монах|monk/u.test(role) && level >= 2) result.push({ id: 'flurry-of-blows', name: 'Шквал ударов', category: 'class', target: 'enemy', actionType: 'bonus_action', range: 5, resource: 'ki', cost: 1, description: 'Потратить ци и совершить две безоружные атаки.' })
  if (/паладин|paladin/u.test(role)) result.push({ id: 'lay-on-hands', name: 'Наложение рук', category: 'class', target: 'ally', actionType: 'action', range: 5, resource: 'lay_on_hands', cost: 5, description: 'Передать хиты из запаса целительной силы.' })
  if (/плут|rogue/u.test(role)) result.push({ id: 'sneak-attack', name: 'Скрытая атака', category: 'class', target: 'enemy', actionType: 'action', range: 600, requiresWeapon: true, description: 'Атака оружием с дополнительным уроном.' })
  if (/чарод|sorcer/u.test(role) && level >= 3) {
    const metamagic: CombatAction[] = [
      { id: 'careful-spell', name: 'Аккуратное заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Союзники в области следующего заклинания автоматически преуспевают в спасброске.' },
      { id: 'distant-spell', name: 'Далёкое заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Удвоить дальность следующего заклинания.' },
      { id: 'empowered-spell', name: 'Непреодолимое заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Перебросить часть костей урона следующего заклинания.' },
      { id: 'extended-spell', name: 'Продлённое заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Удвоить длительность следующего заклинания.' },
      { id: 'heightened-spell', name: 'Усиленное заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 3, description: 'Первая цель следующего заклинания спасается с помехой.' },
      { id: 'quickened-spell', name: 'Ускоренное заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 2, description: 'Следующее заклинание накладывается бонусным действием.' },
      { id: 'subtle-spell', name: 'Неуловимое заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Следующее заклинание не требует слов и жестов.' },
      { id: 'twinned-spell', name: 'Удвоенное заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Следующее одноцелевое заклинание может выбрать вторую цель.' },
      { id: 'seeking-spell', name: 'Ищущее заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 2, description: 'Перебросить промах атакой заклинанием.' },
      { id: 'transmuted-spell', name: 'Преобразованное заклинание', category: 'class', target: 'self', actionType: 'free', range: 0, resource: 'sorcery_points', cost: 1, description: 'Изменить стихийный тип урона следующего заклинания.' },
    ]
    result.push(...metamagic.filter((entry) => optionalFeatureSelected(player, entry.id)))
  }
  if (/колдун|warlock/u.test(role) && level >= 3) {
    const pacts: CombatAction[] = [
      { id: 'pact-blade', name: 'Оружие договора', category: 'class', target: 'self', actionType: 'action', range: 0, description: 'Создать или призвать оружие договора.' },
      { id: 'pact-chain', name: 'Спутник договора', category: 'class', target: 'self', actionType: 'action', range: 0, description: 'Призвать особого фамильяра договора Цепи.' },
      { id: 'pact-tome', name: 'Книга Теней', category: 'class', target: 'self', actionType: 'action', range: 0, description: 'Открыть заговоры и ритуалы дара Книги.' },
      { id: 'pact-talisman', name: 'Талисман договора', category: 'class', target: 'self', actionType: 'action', range: 0, description: 'Наделить владельца талисмана поддержкой покровителя.' },
    ]
    result.push(...pacts.filter((entry) => optionalFeatureSelected(player, entry.id)))
  }
  if (/волшеб|wizard/u.test(role)) result.push({ id: 'arcane-recovery', name: 'Магическое восстановление', category: 'class', target: 'self', actionType: 'action', range: 0, resource: 'arcane_recovery', cost: 1, description: 'Восстановить часть ячеек после короткого отдыха.' })
  const classKey = playerClassKey(player)
  const catalog = classKey ? generatedClasses.get(classKey) : undefined
  const selectedSubclass = normalizedName(player.subclass)
  const existingNames = new Set(result.map((entry) => normalizedName(entry.name)))
  for (const entry of catalog?.actions ?? []) {
    if (entry.minimumLevel && level < entry.minimumLevel) continue
    if (entry.actionType === 'free') continue
    if (!optionalFeatureSelected(player, entry.id)) continue
    if (entry.subclass && normalizedName(entry.subclass) !== selectedSubclass) continue
    if (existingNames.has(normalizedName(entry.name))) continue
    result.push({
      ...entry,
      mechanicsSupport: entry.effect?.kind === 'special' ? 'ruling-only' : 'heuristic',
      target: entry.target === 'ally' || entry.target === 'enemy' ? entry.target : 'self',
      resource: entry.uses ? `feature_${entry.id}` : entry.resource,
      cost: entry.uses ? 1 : entry.cost,
    })
  }
  return result.map((entry) => ({
    ...entry,
    mechanicsSupport: entry.mechanicsSupport ?? 'partial',
    ...((entry.supportNote || (entry.mechanicsSupport ?? 'partial') === 'partial') ? { supportNote: entry.supportNote ?? defaultPartialActionNote } : {}),
  }))
}

export function fallbackCombatResources(player?: Player): Record<string, { current: number; max: number }> {
  if (!player) return {}
  const role = player.role.toLocaleLowerCase('ru')
  const level = Math.max(1, player.level || 1)
  const resources: Record<string, { current: number; max: number }> = {}
  const add = (id: string, maximum: number) => { resources[id] = { current: maximum, max: maximum } }
  if (/воин|fighter/u.test(role)) {
    add('second_wind', 1)
    if (level >= 2) add('action_surge', 1)
    if (level >= 9) add('indomitable', 1)
    if (level >= 3 && fighter.slice(2).some((entry) => optionalFeatureSelected(player, entry.id))) add('superiority_dice', level >= 7 ? 5 : 4)
  }
  if (/варвар|barbarian/u.test(role)) add('rage', level >= 12 ? 5 : level >= 6 ? 4 : level >= 3 ? 3 : 2)
  if (/бард|bard/u.test(role)) add('bardic_inspiration', Math.max(1, Math.floor(((player.abilities?.cha ?? 10) - 10) / 2)))
  if (/жрец|cleric/u.test(role) && level >= 2) add('channel_divinity', level >= 6 ? 2 : 1)
  if (/друид|druid/u.test(role) && level >= 2) add('wild_shape', 2)
  if (/монах|monk/u.test(role) && level >= 2) add('ki', level)
  if (/паладин|paladin/u.test(role)) add('lay_on_hands', level * 5)
  if (/чарод|sorcer/u.test(role) && level >= 2) add('sorcery_points', level)
  if (/волшеб|wizard/u.test(role)) add('arcane_recovery', 1)
  const proficiency = 2 + Math.floor((level - 1) / 4)
  const classKey = playerClassKey(player)
  const selectedSubclass = normalizedName(player.subclass)
  for (const entry of generatedClasses.get(classKey ?? '')?.actions ?? []) {
    if (!entry.uses || (entry.minimumLevel && level < entry.minimumLevel) || (entry.subclass && normalizedName(entry.subclass) !== selectedSubclass)) continue
    const maximum = entry.uses.maximum === 'proficiency' ? proficiency
      : String(entry.uses.maximum).startsWith('ability:')
        ? Math.max(1, Math.floor(((player.abilities?.[String(entry.uses.maximum).slice(8) as keyof Player['abilities']] ?? 10) - 10) / 2))
        : Math.max(1, Number(entry.uses.maximum) || 1)
    add(`feature_${entry.id}`, maximum)
  }
  return resources
}
