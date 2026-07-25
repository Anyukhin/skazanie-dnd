import { readFileSync } from 'node:fs'
import { isOptionalFeatureSelected } from './character-progression.mjs'

const catalogPayload = JSON.parse(readFileSync(new URL('../data/dndsu-class-actions-1-12.json', import.meta.url), 'utf8'))
const GENERATED_CLASSES = new Map(catalogPayload.classes.map((entry) => [entry.classKey, Object.freeze(entry)]))

const clone = (value) => structuredClone(value)
const roleText = (actor) => `${actor?.role ?? ''} ${actor?.class ?? ''} ${actor?.characterClass ?? ''}`.toLocaleLowerCase('ru')
const normalizedName = (value) => String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim()

const CLASS_URL = Object.freeze({
  barbarian: 'https://www.dnd.su/class/87-barbarian/', bard: 'https://www.dnd.su/class/88-bard/', cleric: 'https://www.dnd.su/class/89-cleric/',
  druid: 'https://www.dnd.su/class/90-druid/', fighter: 'https://www.dnd.su/class/91-fighter/', monk: 'https://www.dnd.su/class/93-monk/',
  paladin: 'https://www.dnd.su/class/94-paladin/', ranger: 'https://www.dnd.su/class/97-ranger/', rogue: 'https://www.dnd.su/class/99-rogue/',
  sorcerer: 'https://www.dnd.su/class/101-sorcerer/', warlock: 'https://www.dnd.su/class/104-warlock/', wizard: 'https://www.dnd.su/class/105-wizard/',
})

const VERIFIED_ACTION_EFFECTS = new Set(['stand_up', 'break_free', 'steady_nerves', 'extinguish_flames', 'dash', 'check', 'contest', 'heal', 'weapon_attack', 'cleanse', 'restore_action', 'stabilize', 'first_aid'])
const DEFAULT_PARTIAL_ACTION_NOTE = 'Сервер исполняет только формализованную часть способности; остальные свойства пока представлены маркером.'
const action = (id, name, options = {}) => {
  const effectKind = options.effect?.kind
  const mechanicsSupport = options.mechanicsSupport
    ?? (effectKind === 'special' ? 'ruling-only' : VERIFIED_ACTION_EFFECTS.has(effectKind) ? 'verified' : 'partial')
  return Object.freeze({
    id, name, category: 'class', target: 'self', actionType: 'action', range: 0, minimumLevel: 1,
    ...options, mechanicsSupport,
    ...((options.supportNote || mechanicsSupport === 'partial') ? { supportNote: options.supportNote ?? DEFAULT_PARTIAL_ACTION_NOTE } : {}),
  })
}

const COMMON_ACTIONS = Object.freeze([
  action('stand-up', 'Встать', { category: 'common', actionType: 'free', description: 'Потратить половину скорости текущего хода и прекратить состояние «сбит с ног».', effect: { kind: 'stand_up' } }),
  action('break-free', 'Высвободиться', { category: 'common', description: 'Действием совершить проверку Силы против Сл удерживающего эффекта и прекратить опутывание.', effect: { kind: 'break_free' } }),
  action('steady-nerves', 'Совладать со страхом', { category: 'common', description: 'Действием совершить проверку Мудрости против Сл «Гневной кары» и прекратить испуг при успехе.', effect: { kind: 'steady_nerves' } }),
  action('extinguish-self', 'Потушить пламя', { category: 'common', description: 'Действием потушить на себе пламя «Пылающей кары».', effect: { kind: 'extinguish_flames' } }),
  action('extinguish-ally', 'Потушить союзника', { category: 'common', target: 'ally', range: 5, description: 'Действием потушить пламя «Пылающей кары» на существе в пределах 5 футов.', effect: { kind: 'extinguish_flames' } }),
  action('expeditious-retreat-dash', 'Стремительный рывок', { category: 'common', actionType: 'bonus_action', description: 'Пока активно «Поспешное отступление», совершить Рывок бонусным действием.', effect: { kind: 'dash' } }),
  action('dash', 'Рывок', { category: 'common', description: 'Дополнительное перемещение, равное скорости, до конца хода.', effect: { kind: 'dash' } }),
  action('disengage', 'Отход', { category: 'common', description: 'Перемещение не провоцирует атак по возможности до конца хода.', effect: { kind: 'condition', condition: 'disengaged', duration: 'until-next-turn' } }),
  action('dodge', 'Уклонение', { category: 'common', description: 'Атаки по вам совершаются с помехой до начала следующего хода.', effect: { kind: 'condition', condition: 'dodging', duration: 'until-next-turn' } }),
  action('hide', 'Засада', { category: 'common', description: 'Проверка Ловкости (Скрытность), чтобы получить преимущество из укрытия.', effect: { kind: 'check', ability: 'dex', skill: 'stealth' } }),
    action('help', 'Помощь', { category: 'common', target: 'ally', range: 5, description: 'Союзник получает преимущество на следующую атаку.', effect: { kind: 'condition', condition: 'helped', duration: 'until-used' } }),
    action('stabilize', 'Стабилизировать', { category: 'common', target: 'ally', range: 5, description: 'Проверка Мудрости (Медицина) СЛ 10, чтобы стабилизировать союзника с 0 ОЗ.', effect: { kind: 'stabilize', ability: 'wis', skill: 'medicine', difficulty: 10 } }),
    action('first-aid', 'Первая помощь', { category: 'common', target: 'creature', range: 5, description: 'Проверка Мудрости (Медицина) СЛ 10, чтобы привести нокаутированное существо в сознание.', effect: { kind: 'first_aid', ability: 'wis', skill: 'medicine', difficulty: 10 } }),
  action('grapple', 'Захват', { category: 'common', target: 'enemy', range: 5, description: 'Состязание Атлетики против Атлетики или Акробатики; при успехе цель схвачена.', effect: { kind: 'contest', condition: 'grappled' } }),
  action('shove', 'Толчок', { category: 'common', target: 'enemy', range: 5, description: 'Состязание Силы; при успехе цель сбита с ног.', effect: { kind: 'contest', condition: 'prone' } }),
  action('ready', 'Подготовка', { category: 'common', description: 'Подготовить действие и сохранить реакцию для указанного условия.', mechanicsSupport: 'partial', supportNote: 'Сервер фиксирует подготовку до следующего хода; настройка условия и автоматический запуск реакции пока не реализованы.', effect: { kind: 'condition', condition: 'readied', duration: 'until-next-turn' } }),
  action('search', 'Поиск', { category: 'common', description: 'Проверка Мудрости (Восприятие) для обнаружения скрытых целей и деталей.', effect: { kind: 'check', ability: 'wis', skill: 'perception' } }),
  action('use-object', 'Использовать предмет', { category: 'common', description: 'Взаимодействовать с немагическим предметом в бою.', effect: { kind: 'special' } }),
])

const CLASS_ACTIONS = Object.freeze({
  barbarian: Object.freeze([
    action('rage', 'Ярость', { actionType: 'bonus_action', resource: 'rage', description: 'Сопротивление физическому урону и бонус к урону атак Силой.', effect: { kind: 'condition', condition: 'raging', duration: 'rounds:10' } }),
    action('reckless-attack', 'Безрассудная атака', { actionType: 'free', minimumLevel: 2, description: 'Преимущество на атаки Силой, но атаки по вам тоже с преимуществом.', effect: { kind: 'condition', condition: 'reckless', duration: 'until-next-turn' } }),
    action('extra-attack', 'Дополнительная атака', { target: 'enemy', range: 600, minimumLevel: 5, requiresWeapon: true, description: 'Дважды атаковать оружием действием Атака.', effect: { kind: 'weapon_attack', attacks: 2 } }),
    action('instinctive-pounce', 'Инстинктивный бросок', { actionType: 'free', minimumLevel: 7, description: 'При входе в ярость переместиться на половину скорости.', effect: { kind: 'dash', multiplier: .5 } }),
  ]),
  bard: Object.freeze([
    action('bardic-inspiration', 'Вдохновение барда', { target: 'ally', actionType: 'bonus_action', range: 60, resource: 'bardic_inspiration', description: 'Союзник получает кость вдохновения для проверки, атаки или спасброска.', effect: { kind: 'condition', condition: 'bardic-inspiration', duration: 'rounds:100' } }),
    action('countercharm', 'Контрочарование', { minimumLevel: 6, description: 'Вы и союзники получаете преимущество против испуга и очарования.', effect: { kind: 'condition', condition: 'countercharm', duration: 'until-next-turn' } }),
  ]),
  cleric: Object.freeze([
    action('turn-undead', 'Изгнание нежити', { target: 'enemy', range: 30, minimumLevel: 2, resource: 'channel_divinity', description: 'Нежить совершает спасбросок Мудрости или обращается в бегство.', effect: { kind: 'save', saveAbility: 'wis', condition: 'turned', duration: 'rounds:10' } }),
    action('divine-spark', 'Божественная искра', { target: 'ally', range: 30, minimumLevel: 2, resource: 'channel_divinity', description: 'Направить божественную силу и восстановить хиты союзнику.', effect: { kind: 'heal', dice: '1d8', ability: 'wis' } }),
    action('divine-intervention', 'Божественное вмешательство', { minimumLevel: 10, description: 'Просить божество вмешаться; шанс успеха равен уровню жреца в процентах.', effect: { kind: 'percent_check' } }),
  ]),
  druid: Object.freeze([
    action('wild-shape', 'Дикая форма', { minimumLevel: 2, resource: 'wild_shape', description: 'Принять звериный облик, сохраняя личность и ментальные характеристики.', effect: { kind: 'condition', condition: 'wild-shaped', duration: 'rounds:600' } }),
    action('wild-companion', 'Дикий спутник', { minimumLevel: 2, resource: 'wild_shape', description: 'Потратить Дикую форму, чтобы призвать временного духа-спутника.', effect: { kind: 'condition', condition: 'wild-companion', duration: 'rounds:600' } }),
  ]),
  fighter: Object.freeze([
    action('second-wind', 'Второе дыхание', { actionType: 'bonus_action', resource: 'second_wind', description: 'Восстановить 1к10 + уровень хитов.', effect: { kind: 'heal', dice: '1d10', addLevel: true } }),
    action('action-surge', 'Всплеск действий', { actionType: 'free', minimumLevel: 2, resource: 'action_surge', description: 'Немедленно получить ещё одно действие.', effect: { kind: 'restore_action' } }),
    action('extra-attack', 'Дополнительная атака', { target: 'enemy', range: 600, minimumLevel: 5, requiresWeapon: true, description: 'Атаковать оружием дважды; с 11-го уровня — трижды.', effect: { kind: 'weapon_attack', attacksByLevel: { 5: 2, 11: 3 } } }),
  ]),
  monk: Object.freeze([
    action('martial-arts-strike', 'Боевые искусства', { target: 'enemy', actionType: 'bonus_action', range: 5, description: 'Совершить безоружную атаку бонусным действием.', effect: { kind: 'weapon_attack', attacks: 1, unarmed: true } }),
    action('flurry-of-blows', 'Шквал ударов', { target: 'enemy', actionType: 'bonus_action', range: 5, minimumLevel: 2, resource: 'ki', description: 'Потратить 1 ци и совершить две безоружные атаки.', effect: { kind: 'weapon_attack', attacks: 2, unarmed: true } }),
    action('patient-defense', 'Терпеливая оборона', { actionType: 'bonus_action', minimumLevel: 2, resource: 'ki', description: 'Потратить 1 ци и использовать Уклонение.', effect: { kind: 'condition', condition: 'dodging', duration: 'until-next-turn' } }),
    action('step-of-the-wind', 'Шаг ветра', { actionType: 'bonus_action', minimumLevel: 2, resource: 'ki', description: 'Потратить 1 ци: Рывок и Отход, дальность прыжка удваивается.', effect: { kind: 'dash', addCondition: 'disengaged' } }),
    action('quickened-healing', 'Быстрое исцеление', { actionType: 'action', minimumLevel: 4, resource: 'ki', cost: 2, description: 'Потратить 2 ци и восстановить кость боевых искусств + мастерство хитов.', effect: { kind: 'heal', dice: '1d6', addProficiency: true } }),
    action('stunning-strike', 'Ошеломляющий удар', { target: 'enemy', range: 5, minimumLevel: 5, resource: 'ki', requiresWeapon: true, description: 'Атака; при попадании цель спасается Телосложением или оглушается.', effect: { kind: 'weapon_attack', attacks: 1, saveAbility: 'con', condition: 'stunned' } }),
    action('stillness-of-mind', 'Спокойствие разума', { minimumLevel: 7, description: 'Завершить на себе один эффект испуга или очарования.', effect: { kind: 'cleanse', conditions: ['frightened', 'charmed'] } }),
  ]),
  paladin: Object.freeze([
    action('divine-sense', 'Божественное чувство', { resource: 'divine_sense', description: 'Обнаружить небожителей, исчадий и нежить в пределах 60 футов.', effect: { kind: 'condition', condition: 'divine-sense', duration: 'until-next-turn' } }),
    action('lay-on-hands', 'Наложение рук', { target: 'ally', range: 5, resource: 'lay_on_hands', cost: 5, description: 'Передать 5 хитов из запаса целительной силы.', effect: { kind: 'heal', amount: 5 } }),
    action('divine-smite', 'Божественная кара', { target: 'enemy', range: 5, minimumLevel: 2, resource: 'spell_slots_1', requiresWeapon: true, description: 'При попадании потратить ячейку и нанести дополнительно 2к8 излучением.', effect: { kind: 'weapon_attack', attacks: 1, extraDamage: '2d8', damageType: 'radiant' } }),
    action('extra-attack', 'Дополнительная атака', { target: 'enemy', range: 600, minimumLevel: 5, requiresWeapon: true, description: 'Дважды атаковать оружием действием Атака.', effect: { kind: 'weapon_attack', attacks: 2 } }),
  ]),
  ranger: Object.freeze([
    action('favored-foe', 'Избранный враг', { target: 'enemy', actionType: 'free', resource: 'favored_foe', concentration: true, description: 'Пометить цель после попадания и наносить ей дополнительный урон.', effect: { kind: 'condition', condition: 'favored-foe', duration: 'concentration' } }),
    action('hunters-mark', 'Метка охотника', { target: 'enemy', actionType: 'bonus_action', range: 90, resource: 'spell_slots_1', concentration: true, minimumLevel: 2, description: 'Пометить врага: атаки оружием наносят дополнительно 1к6 урона.', effect: { kind: 'condition', condition: 'hunters-mark', duration: 'concentration' } }),
    action('extra-attack', 'Дополнительная атака', { target: 'enemy', range: 600, minimumLevel: 5, requiresWeapon: true, description: 'Дважды атаковать оружием действием Атака.', effect: { kind: 'weapon_attack', attacks: 2 } }),
    action('hide-in-plain-sight', 'Маскировка', { minimumLevel: 10, description: 'Замаскироваться в природном окружении и получить усиленную скрытность.', effect: { kind: 'condition', condition: 'camouflaged', duration: 'rounds:100' } }),
  ]),
  rogue: Object.freeze([
    action('sneak-attack', 'Скрытая атака', { target: 'enemy', range: 600, requiresWeapon: true, description: 'Атака оружием с дополнительным уроном скрытой атаки.', effect: { kind: 'weapon_attack', attacks: 1, extraDamageByLevel: 'sneak' } }),
    action('cunning-dash', 'Хитрое действие: Рывок', { actionType: 'bonus_action', minimumLevel: 2, description: 'Использовать Рывок бонусным действием.', effect: { kind: 'dash' } }),
    action('cunning-disengage', 'Хитрое действие: Отход', { actionType: 'bonus_action', minimumLevel: 2, description: 'Использовать Отход бонусным действием.', effect: { kind: 'condition', condition: 'disengaged', duration: 'until-next-turn' } }),
    action('cunning-hide', 'Хитрое действие: Засада', { actionType: 'bonus_action', minimumLevel: 2, description: 'Использовать Засаду бонусным действием.', effect: { kind: 'check', ability: 'dex', skill: 'stealth' } }),
    action('steady-aim', 'Верный прицел', { actionType: 'bonus_action', minimumLevel: 3, description: 'Не двигаться и получить преимущество на следующую атаку.', effect: { kind: 'condition', condition: 'steady-aim', duration: 'until-used' } }),
    action('uncanny-dodge', 'Невероятное уклонение', { actionType: 'reaction', minimumLevel: 5, description: 'Реакцией уменьшить урон видимой атаки вдвое.', effect: { kind: 'condition', condition: 'uncanny-dodge', duration: 'until-used' } }),
  ]),
  sorcerer: Object.freeze([
    action('font-of-magic', 'Источник магии', { actionType: 'bonus_action', minimumLevel: 2, resource: 'sorcery_points', description: 'Преобразовать чародейские очки в ячейку заклинания.', effect: { kind: 'restore_resource', resource: 'spell_slots_1', amount: 1 } }),
    action('careful-spell', 'Аккуратное заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Союзники в области следующего заклинания автоматически преуспевают в спасброске.', effect: { kind: 'condition', condition: 'metamagic-careful', duration: 'until-used' } }),
    action('distant-spell', 'Далёкое заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Удвоить дальность следующего заклинания.', effect: { kind: 'condition', condition: 'metamagic-distant', duration: 'until-used' } }),
    action('empowered-spell', 'Непреодолимое заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Перебросить часть костей урона следующего заклинания.', effect: { kind: 'condition', condition: 'metamagic-empowered', duration: 'until-used' } }),
    action('extended-spell', 'Продлённое заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Удвоить длительность следующего заклинания.', effect: { kind: 'condition', condition: 'metamagic-extended', duration: 'until-used' } }),
    action('quickened-spell', 'Ускоренное заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', cost: 2, description: 'Следующее заклинание с действием накладывается бонусным действием.', effect: { kind: 'condition', condition: 'metamagic-quickened', duration: 'until-used' } }),
    action('heightened-spell', 'Усиленное заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', cost: 3, description: 'Первая цель следующего заклинания спасается с помехой.', effect: { kind: 'condition', condition: 'metamagic-heightened', duration: 'until-used' } }),
    action('twinned-spell', 'Удвоенное заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Следующее одноцелевое заклинание может выбрать вторую цель.', effect: { kind: 'condition', condition: 'metamagic-twinned', duration: 'until-used' } }),
    action('subtle-spell', 'Неуловимое заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Следующее заклинание не требует вербального и соматического компонентов.', effect: { kind: 'condition', condition: 'metamagic-subtle', duration: 'until-used' } }),
    action('seeking-spell', 'Ищущее заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', cost: 2, description: 'Перебросить промах атакой заклинанием.', effect: { kind: 'condition', condition: 'metamagic-seeking', duration: 'until-used' } }),
    action('transmuted-spell', 'Преобразованное заклинание', { actionType: 'free', minimumLevel: 3, resource: 'sorcery_points', description: 'Изменить стихийный тип урона следующего заклинания.', effect: { kind: 'condition', condition: 'metamagic-transmuted', duration: 'until-used' } }),
  ]),
  warlock: Object.freeze([
    action('pact-blade', 'Оружие договора', { minimumLevel: 3, description: 'Создать или призвать оружие договора.', effect: { kind: 'condition', condition: 'pact-weapon', duration: 'rounds:600' } }),
    action('pact-chain', 'Спутник договора', { minimumLevel: 3, description: 'Призвать особого фамильяра договора Цепи.', effect: { kind: 'condition', condition: 'pact-familiar', duration: 'rounds:600' } }),
    action('pact-tome', 'Книга Теней', { minimumLevel: 3, description: 'Открыть заговоры и ритуалы дара Книги.', effect: { kind: 'condition', condition: 'book-of-shadows', duration: null } }),
    action('pact-talisman', 'Талисман договора', { minimumLevel: 3, description: 'Наделить владельца талисмана поддержкой покровителя.', effect: { kind: 'condition', condition: 'pact-talisman', duration: null } }),
  ]),
  wizard: Object.freeze([
    action('arcane-recovery', 'Магическое восстановление', { resource: 'arcane_recovery', description: 'После короткого отдыха восстановить ячейки суммарным уровнем до половины уровня волшебника.', effect: { kind: 'restore_resource', resource: 'spell_slots_1', amount: 1 } }),
  ]),
})

const MANEUVERS = Object.freeze([
  ['trip-attack', 'Подсекающая атака', 'action', 'enemy', { saveAbility: 'str', condition: 'prone' }],
  ['menacing-attack', 'Устрашающая атака', 'action', 'enemy', { saveAbility: 'wis', condition: 'frightened' }],
  ['disarming-attack', 'Обезоруживающая атака', 'action', 'enemy', { saveAbility: 'str', condition: 'disarmed' }],
  ['distracting-strike', 'Отвлекающий удар', 'action', 'enemy', { condition: 'distracted' }],
  ['goading-attack', 'Провоцирующая атака', 'action', 'enemy', { saveAbility: 'wis', condition: 'goaded' }],
  ['lunging-attack', 'Выпад', 'action', 'enemy', {}],
  ['maneuvering-attack', 'Маневрирующая атака', 'action', 'enemy', { condition: 'maneuvered' }],
  ['pushing-attack', 'Толкающая атака', 'action', 'enemy', { saveAbility: 'str', condition: 'pushed' }],
  ['sweeping-attack', 'Размашистая атака', 'action', 'enemy', {}],
  ['precision-attack', 'Точная атака', 'free', 'self', { condition: 'precision-attack' }],
  ['feinting-attack', 'Финт', 'bonus_action', 'enemy', { condition: 'feinted' }],
  ['rally', 'Воодушевление', 'bonus_action', 'ally', { heal: true }],
  ['parry', 'Парирование', 'reaction', 'self', { condition: 'parrying' }],
  ['riposte', 'Ответный удар', 'reaction', 'enemy', {}],
  ['brace', 'Удержание позиции', 'reaction', 'enemy', {}],
  ['quick-toss', 'Быстрый бросок', 'bonus_action', 'enemy', {}],
  ['grappling-strike', 'Захватывающий удар', 'bonus_action', 'enemy', { condition: 'grappled' }],
  ['bait-and-switch', 'Обман и смена', 'free', 'ally', { condition: 'guarded' }],
  ['evasive-footwork', 'Уклонение ногами', 'free', 'self', { condition: 'evasive-footwork' }],
].map(([id, name, actionType, target, extra]) => action(id, name, { actionType, target, range: target === 'self' ? 0 : target === 'ally' ? 5 : 600, minimumLevel: 3, resource: 'superiority_dice', requiresWeapon: target === 'enemy' && actionType === 'action', description: 'Манёвр мастера боевых искусств; расходует кость превосходства.', effect: extra.heal ? { kind: 'heal', dice: '1d8', ability: 'cha' } : target === 'enemy' ? { kind: 'weapon_attack', attacks: 1, extraDamage: '1d8', ...extra } : { kind: 'condition', condition: extra.condition, duration: 'until-next-turn' } })))

function actorClass(actor) {
  const role = roleText(actor)
  for (const [key, pattern] of [
    ['barbarian', /варвар|barbarian/u], ['bard', /бард|bard/u], ['cleric', /жрец|cleric/u], ['druid', /друид|druid/u],
    ['fighter', /воин|fighter/u], ['monk', /монах|monk/u], ['paladin', /паладин|paladin/u], ['ranger', /следопыт|ranger/u],
    ['rogue', /плут|разбойник|rogue/u], ['sorcerer', /чарод|sorcer/u], ['warlock', /колдун|warlock/u], ['wizard', /волшеб|wizard|маг\b/u],
  ]) if (pattern.test(role)) return key
  return null
}

function actorSubclass(actor, classKey) {
  const selected = normalizedName(actor?.subclass ?? actor?.subClass ?? actor?.archetype)
  const catalog = GENERATED_CLASSES.get(classKey)
  if (!catalog) return null
  if (selected) {
    return catalog.subclasses.find((entry) => normalizedName(entry.id) === selected || normalizedName(entry.name) === selected)?.name ?? null
  }
  const role = normalizedName(roleText(actor))
  return catalog.subclasses.find((entry) => role.includes(normalizedName(entry.name)))?.name ?? null
}

function generatedActionsFor(actor, classKey) {
  const catalog = GENERATED_CLASSES.get(classKey)
  if (!catalog) return []
  const subclass = actorSubclass(actor, classKey)
  return catalog.actions
    .filter((entry) => !entry.subclass || normalizedName(entry.subclass) === normalizedName(subclass))
    .map((entry) => ({
      ...clone(entry),
      mechanicsSupport: entry.effect?.kind === 'special' ? 'ruling-only' : 'heuristic',
      resource: entry.uses ? `feature_${entry.id}` : undefined,
      cost: entry.uses ? 1 : undefined,
    }))
}

export function combatSubclassOptionsFor(actor) {
  const classKey = actorClass(actor)
  const catalog = GENERATED_CLASSES.get(classKey)
  if (!catalog) return []
  return catalog.subclasses.map((entry) => clone(entry))
}

export function normalizedCombatSubclassFor(actor) {
  const classKey = actorClass(actor)
  const catalog = GENERATED_CLASSES.get(classKey)
  if (!catalog || Math.max(1, Math.min(12, Number(actor?.level) || 1)) < Number(catalog.subclassLevel ?? 1)) return null
  return actorSubclass(actor, classKey)
}

export function combatClassCatalogInfo() {
  return {
    rulesProfile: catalogPayload.rulesProfile,
    maximumCharacterLevel: catalogPayload.maximumCharacterLevel,
    classes: catalogPayload.classes.map((entry) => ({
      classKey: entry.classKey,
      label: entry.label,
      sourceUrl: entry.sourceUrl,
      subclasses: entry.subclasses.length,
      actions: entry.actions.length,
      coverage: clone(entry.coverage),
    })),
  }
}

export function combatActionsFor(actor) {
  const level = Math.max(1, Math.min(12, Number(actor?.level) || 1))
  const classKey = actorClass(actor)
  const subclass = actorSubclass(actor, classKey)
  const curated = (classKey ? [...(CLASS_ACTIONS[classKey] ?? []), ...(classKey === 'fighter' && normalizedName(subclass) === normalizedName('Мастер боевых искусств') ? MANEUVERS : [])] : [])
    .filter((entry) => isOptionalFeatureSelected(actor, entry.id))
  const curatedNames = new Set(curated.map((entry) => normalizedName(entry.name)))
  const generated = classKey ? generatedActionsFor(actor, classKey).filter((entry) => entry.actionType !== 'free' && isOptionalFeatureSelected(actor, entry.id) && !curatedNames.has(normalizedName(entry.name))) : []
  const classActions = [...curated, ...generated]
  return [...COMMON_ACTIONS, ...classActions]
    .filter((entry) => level >= entry.minimumLevel)
    .map((entry) => ({ ...clone(entry), sourceUrl: entry.sourceUrl ?? CLASS_URL[classKey] ?? 'https://www.dnd.su/articles/actions-in-combat/' }))
}

export function combatActionFor(actor, actionId) {
  return combatActionsFor(actor).find((entry) => entry.id === String(actionId ?? '')) ?? null
}

export function combatResourceMaximumsFor(actor) {
  const level = Math.max(1, Math.min(12, Number(actor?.level) || 1))
  const classKey = actorClass(actor)
  const subclass = actorSubclass(actor, classKey)
  const proficiency = 2 + Math.floor((level - 1) / 4)
  const resources = {}
  if (classKey === 'barbarian') resources.rage = level >= 12 ? 5 : level >= 6 ? 4 : level >= 3 ? 3 : 2
  if (classKey === 'bard') resources.bardic_inspiration = Math.max(1, Number(actor?.abilities?.cha ? Math.floor((Number(actor.abilities.cha) - 10) / 2) : 1))
  if (classKey === 'cleric' && level >= 2) resources.channel_divinity = level >= 6 ? 2 : 1
  if (classKey === 'druid' && level >= 2) resources.wild_shape = 2
  if (classKey === 'fighter') {
    resources.second_wind = 1
    if (level >= 2) resources.action_surge = 1
    if (level >= 9) resources.indomitable = 1
    if (level >= 3 && normalizedName(subclass) === normalizedName('Мастер боевых искусств') && MANEUVERS.some((entry) => isOptionalFeatureSelected(actor, entry.id))) resources.superiority_dice = level >= 7 ? 5 : 4
  }
  if (classKey === 'monk' && level >= 2) resources.ki = level
  if (classKey === 'paladin') {
    resources.divine_sense = Math.max(1, Number(actor?.abilities?.cha ? Math.floor((Number(actor.abilities.cha) - 10) / 2) + 1 : 1))
    resources.lay_on_hands = level * 5
  }
  if (classKey === 'ranger') resources.favored_foe = proficiency
  if (classKey === 'sorcerer' && level >= 2) resources.sorcery_points = level
  if (classKey === 'wizard') resources.arcane_recovery = 1
  for (const entry of generatedActionsFor(actor, classKey)) {
    if (!entry.uses || level < entry.minimumLevel) continue
    const maximum = entry.uses.maximum === 'proficiency' ? proficiency
      : String(entry.uses.maximum).startsWith('ability:')
        ? Math.max(1, Math.floor((Number(actor?.abilities?.[String(entry.uses.maximum).slice(8)]) - 10) / 2))
        : Math.max(1, Number(entry.uses.maximum) || 1)
    resources[`feature_${entry.id}`] = maximum
  }
  return resources
}

/**
 * Server-owned recovery schedule for class resources.  Resource maxima and
 * recovery timing deliberately live together so a rest cannot restore every
 * pool merely because a client happened to name it.
 */
export function combatResourceRecoveryFor(actor) {
  const level = Math.max(1, Math.min(12, Number(actor?.level) || 1))
  const classKey = actorClass(actor)
  const subclass = actorSubclass(actor, classKey)
  const recovery = {}
  if (classKey === 'barbarian') recovery.rage = 'long'
  if (classKey === 'bard') recovery.bardic_inspiration = level >= 5 ? 'short_or_long' : 'long'
  if (classKey === 'cleric' && level >= 2) recovery.channel_divinity = 'short_or_long'
  if (classKey === 'druid' && level >= 2) recovery.wild_shape = 'short_or_long'
  if (classKey === 'fighter') {
    recovery.second_wind = 'short_or_long'
    if (level >= 2) recovery.action_surge = 'short_or_long'
    if (level >= 9) recovery.indomitable = 'long'
    if (level >= 3 && normalizedName(subclass) === normalizedName('Мастер боевых искусств')) recovery.superiority_dice = 'short_or_long'
  }
  if (classKey === 'monk' && level >= 2) recovery.ki = 'short_or_long'
  if (classKey === 'paladin') {
    recovery.divine_sense = 'long'
    recovery.lay_on_hands = 'long'
  }
  if (classKey === 'ranger') recovery.favored_foe = 'long'
  if (classKey === 'sorcerer' && level >= 2) recovery.sorcery_points = 'long'
  if (classKey === 'wizard') recovery.arcane_recovery = 'long'
  for (const entry of generatedActionsFor(actor, classKey)) {
    if (!entry.uses || level < entry.minimumLevel) continue
    recovery[`feature_${entry.id}`] = entry.uses.recovery === 'short_or_long' ? 'short_or_long' : 'long'
  }
  return recovery
}
