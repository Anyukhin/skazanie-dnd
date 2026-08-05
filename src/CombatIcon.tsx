import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { ACTION_ICON_IDS } from './action-icons'

export type CombatIconKind =
  | 'spell'
  | 'weapon'
  | 'action'
  | 'item'
  | 'movement'
  | 'spellbook'
  | 'roll'
  | 'swap'
  | 'end-turn'
  | 'start-combat'
  | 'reaction'
  | 'deck'

export type AbilityIconTheme = 'martial' | 'arcane' | 'divine' | 'nature' | 'shadow' | 'utility'

type CombatIconProps = {
  id: string
  kind: CombatIconKind
  hint?: string
  size?: number
  compact?: boolean
  priority?: boolean
}

const semanticIcons: Array<[RegExp, number]> = [
  [/fire|flame|burn|scorch|hell|огн|плам|жар/u, 5],
  [/cold|frost|ice|winter|chill|лед|мороз|холод/u, 6],
  [/lightning|thunder|storm|shock|electric|молн|гром|бур/u, 7],
  [/acid|poison|venom|toxic|кисл|яд/u, 8],
  [/heal|cure|life|vital|restor|леч|исцел|жизн/u, 9],
  [/death|dead|necrot|grave|skull|смер|мертв|некро/u, 10],
  [/sun|radiant|holy|divine|sacred|солн|свет|свят|боже/u, 11],
  [/mind|psychic|thought|dream|fear|charm|illusion|разум|псих|сон|страх|очаров|иллюз/u, 12],
  [/arcane|magic|spell|cantrip|маг|заклин|заговор/u, 13],
  [/summon|conjur|familiar|beast|animal|wild|призыв|звер|дик/u, 14],
  [/book|tome|scroll|spellbook|книг|свит/u, 15],
  [/potion|elixir|flask|зель|эликсир|флакон/u, 16],
  [/bomb|blast|burst|explos|взрыв|бомб/u, 17],
  [/key|unlock|ключ|замок/u, 18],
  [/gem|crystal|jewel|камень|кристалл|самоцвет/u, 19],
  [/reaction|counter|ready|реакц|контр/u, 20],
  [/dice|roll|check|брос|куб/u, 21],
  [/swap|change weapon|сменить оруж|заменить оруж/u, 22],
  [/end.turn|finish.turn|завершить ход|конец хода/u, 23],
  [/start.combat|initiative|начать бой|инициатив/u, 24],
  [/shield|ward|armor|protect|guard|защит|брон|страж/u, 2],
  [/dash|haste|speed|retreat|move|foot|рыв|скор|отступ|перемещ/u, 3],
  [/hand|touch|grasp|interact|рук|касание|захват|взаимодейств/u, 4],
  [/arrow|bow|ray|bolt|shot|mark|ranged|стрел|лук|луч|метк|дальн/u, 1],
  [/sword|blade|weapon|slash|strike|attack|меч|клин|оруж|удар|атак/u, 0],
]

const fixedIcons: Partial<Record<CombatIconKind, number>> = {
  movement: 3,
  spellbook: 15,
  roll: 21,
  swap: 22,
  'end-turn': 23,
  'start-combat': 24,
  reaction: 20,
}

const fallbackIcons: Record<CombatIconKind, number[]> = {
  spell: [5, 6, 7, 8, 10, 11, 12, 13, 14],
  weapon: [0, 1],
  action: [2, 3, 4, 9, 12, 20],
  item: [15, 16, 17, 18, 19],
  movement: [3],
  spellbook: [15],
  roll: [21],
  swap: [22],
  'end-turn': [23],
  'start-combat': [24],
  reaction: [20],
  deck: [0, 2, 13, 15, 16],
}

const abilityIconThemePatterns: Array<[RegExp, AbilityIconTheme]> = [
  [/\bmending\b|\bresistance\b|\blight\b|alarm|identify|message|detect|locate|comprehend|tongues/u, 'utility'],
  [/heal|cure|restor|holy|divine|sacred|radiant|bless|aid|prayer|paladin|cleric|smite|life|vital|sanctuary|guidance|spare.the.dying|thaumaturgy|protection|ceremony/u, 'divine'],
  [/nature|wild|beast|animal|plant|thorn|vine|druid|ranger|poison|acid|earth|water|wind|insect|spider/u, 'nature'],
  [/death|dead|necrot|curse|hex|shadow|fear|charm|mind|psychic|illusion|dream|eldritch|warlock|rogue|hide|sneak|invisib/u, 'shadow'],
  [/attack|strike|blade|sword|weapon|rage|reckless|martial|flurry|stunning|fighter|barbarian|monk|arrow|bow|shove|grapple/u, 'martial'],
  [/magic|arcane|spell|sorcerer|wizard|bard|fire|flame|cold|frost|ice|lightning|thunder|storm|teleport|counter/u, 'arcane'],
]

const defaultAbilityIconThemes: Record<CombatIconKind, AbilityIconTheme> = {
  spell: 'arcane',
  weapon: 'martial',
  action: 'utility',
  item: 'utility',
  movement: 'utility',
  spellbook: 'arcane',
  roll: 'utility',
  swap: 'utility',
  'end-turn': 'utility',
  'start-combat': 'martial',
  reaction: 'utility',
  deck: 'utility',
}

export function abilityIconTheme(id: string, kind: CombatIconKind, hint = ''): AbilityIconTheme {
  const signature = `${id} ${hint}`.toLocaleLowerCase('ru')
  return abilityIconThemePatterns.find(([pattern]) => pattern.test(signature))?.[1] ?? defaultAbilityIconThemes[kind]
}

export function abilityIconBackgroundUrl(theme: AbilityIconTheme) {
  return `/assets/ui/action-backgrounds/${theme}.webp`
}

function hashId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function combatIconIndex(id: string, kind: CombatIconKind, hint = '') {
  const signature = `${id} ${hint}`.toLocaleLowerCase('ru')
  if (fixedIcons[kind] !== undefined) return fixedIcons[kind]
  const semantic = semanticIcons.find(([pattern]) => pattern.test(signature))
  if (semantic) return semantic[1]
  const family = fallbackIcons[kind]
  return family[hashId(`${kind}:${id}`) % family.length]
}

/** Путь к собственному рисунку действия, если он нарисован. */
export function ownIconUrl(id: string) {
  return ACTION_ICON_IDS.has(id) ? `/assets/ui/action-icons/${id}.png` : null
}

// Фоновая картинка грузится, как только элемент попал в дерево отрисовки, —
// видно его или нет, браузеру всё равно. В книге заклинаний это сотни запросов
// за одно раскрытие панели, хотя на экран помещается пара десятков клеток.
// Поэтому адрес подставляется только тем иконкам, до которых доскроллили.
//
// Наблюдатель один на все иконки: пятьсот отдельных стоят заметно дороже
// одного общего, а полоса в 200 px даёт картинке подгрузиться до того, как
// клетка въедет в экран, — иначе пролистывание идёт по пустым тайлам.
const REVEAL_MARGIN = 200
const revealHandlers = new WeakMap<Element, () => void>()
let iconObserver: IntersectionObserver | null = null

/** Клетка уже на экране прямо сейчас — по геометрии, без ожидания колбэка. */
function alreadyOnScreen(node: Element) {
  const box = node.getBoundingClientRect()
  return box.bottom > -REVEAL_MARGIN && box.top < window.innerHeight + REVEAL_MARGIN
}

function iconRevealObserver() {
  if (iconObserver) return iconObserver
  iconObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      revealHandlers.get(entry.target)?.()
      revealHandlers.delete(entry.target)
      observer.unobserve(entry.target)
    }
  }, { rootMargin: `${REVEAL_MARGIN}px` })
  return iconObserver
}

/** Показывать ли собственный рисунок: до попадания в область просмотра — нет. */
function useRevealedIcon(enabled: boolean, priority: boolean) {
  const holder = useRef<HTMLSpanElement>(null)
  const [revealed, setRevealed] = useState(enabled && priority)

  useEffect(() => {
    if (!enabled || revealed) return
    const node = holder.current
    if (!node) return
    // Видимое показываем сразу и наблюдателя не заводим. Это не оптимизация, а
    // страховка: колбэк IntersectionObserver приходит только при отрисовке кадра,
    // и во вкладке, которая ничего не рисует, он не придёт никогда. Отложенная
    // иконка не должна зависеть от этого — на экране она обязана быть.
    // Без самого IntersectionObserver (старый webview) показываем всё:
    // потерять иконку хуже, чем загрузить её раньше времени.
    if (typeof IntersectionObserver === 'undefined' || alreadyOnScreen(node)) {
      setRevealed(true)
      return
    }
    const observer = iconRevealObserver()
    revealHandlers.set(node, () => setRevealed(true))
    observer.observe(node)
    return () => {
      revealHandlers.delete(node)
      observer.unobserve(node)
    }
  }, [enabled, revealed])

  return { holder, revealed }
}

export function CombatIcon({ id, kind, hint = '', size, compact = false, priority = false }: CombatIconProps) {
  // Своя картинка, если она есть; иначе прежняя клетка атласа. Набор наполняется
  // постепенно, поэтому запасной вариант обязателен — иначе интерфейс поедет на
  // полпути, когда нарисована половина каталога.
  const own = ownIconUrl(id)
  const theme = abilityIconTheme(id, kind, hint)
  const index = combatIconIndex(id, kind, hint)
  const column = index % 5
  const row = Math.floor(index / 5)
  const { holder, revealed } = useRevealedIcon(own !== null, priority)
  // Без size размер задаёт место, куда иконку поставили: слоту боевой панели нужно,
  // чтобы рисунок занимал его целиком, а слот меняет ширину вместе с экраном.
  // Запасное значение стоит в CSS, поэтому иконка нигде не схлопнется в ноль.
  const style = {
    ...(own
      ? {
          '--combat-icon-bg': `url('${abilityIconBackgroundUrl(theme)}')`,
          ...(revealed ? { '--combat-icon-src': `url('${own}')` } : {}),
        }
      : { '--combat-icon-x': `${column * 25}%`, '--combat-icon-y': `${row * 25}%` }),
    ...(size === undefined ? {} : { width: size, height: size }),
  } as CSSProperties

  return <span ref={holder} className={`combat-icon combat-icon-${kind} combat-icon-theme-${theme}${compact ? ' compact' : ''}`} style={style} aria-hidden="true">
    <i className={own ? 'combat-icon-art own' : 'combat-icon-art'}>
      {own && <b className="combat-icon-symbol" />}
    </i>
  </span>
}
