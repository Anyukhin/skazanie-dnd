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

type CombatIconProps = {
  id: string
  kind: CombatIconKind
  hint?: string
  size?: number
  compact?: boolean
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

export function CombatIcon({ id, kind, hint = '', size = 34, compact = false }: CombatIconProps) {
  // Своя картинка, если она есть; иначе прежняя клетка атласа. Набор наполняется
  // постепенно, поэтому запасной вариант обязателен — иначе интерфейс поедет на
  // полпути, когда нарисована половина каталога.
  const own = ownIconUrl(id)
  const index = combatIconIndex(id, kind, hint)
  const column = index % 5
  const row = Math.floor(index / 5)
  const style = {
    ...(own
      ? { '--combat-icon-src': `url('${own}')` }
      : { '--combat-icon-x': `${column * 25}%`, '--combat-icon-y': `${row * 25}%` }),
    width: size,
    height: size,
  } as CSSProperties

  return <span className={`combat-icon combat-icon-${kind}${compact ? ' compact' : ''}`} style={style} aria-hidden="true">
    <i className={own ? 'combat-icon-art own' : 'combat-icon-art'} />
  </span>
}
