import {
  Activity, Axe, Ban, Bird, Bolt, Bomb, BookOpen, Brain, CircleDot,
  Cloud, Crown, Dices, DoorOpen, Droplets, Eclipse, Eye, EyeOff,
  Feather, Flame, FlaskConical, Footprints, Gem, Hand, Heart,
  HeartPulse, KeyRound, Leaf, Moon, Orbit, PawPrint, PersonStanding,
  Rabbit, RefreshCw, Route, Search, Shield, ShieldCheck, Skull,
  Snowflake, Sparkles, Star, Sun, Swords, Target, TentTree,
  Triangle, WandSparkles, Waves, Wind, Zap,
  type LucideIcon,
} from 'lucide-react'
import type { CSSProperties } from 'react'

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

const spellGlyphs: LucideIcon[] = [WandSparkles, Sparkles, Star, Orbit, Eclipse, Moon, Sun, CircleDot, Triangle, Bolt, Feather, Brain]
const weaponGlyphs: LucideIcon[] = [Swords, Axe, Target, Bolt, Activity, Zap]
const actionGlyphs: LucideIcon[] = [Shield, Footprints, Hand, PersonStanding, Rabbit, Eye, Search, Crown, Activity, Heart]
const itemGlyphs: LucideIcon[] = [FlaskConical, Bomb, Gem, KeyRound, BookOpen, Droplets]
const reactionGlyphs: LucideIcon[] = [RefreshCw, ShieldCheck, Swords, Bolt, Eye, Activity]
const accentGlyphs: LucideIcon[] = [Sparkles, Star, CircleDot, Triangle, Bolt, Feather, Crown, Eye, Leaf, Moon, Sun, Zap, Flame, Snowflake, Droplets, Shield, PawPrint, KeyRound]

const semanticGlyphs: Array<[RegExp, LucideIcon]> = [
  [/fire|flame|burn|scorch|hell|огн|плам|жар/u, Flame],
  [/cold|frost|ice|winter|chill|лед|мороз|холод/u, Snowflake],
  [/lightning|thunder|storm|shock|electric|молн|гром|бур/u, Zap],
  [/acid|poison|venom|toxic|кисл|яд/u, Droplets],
  [/heal|cure|life|vital|restor|леч|исцел|жизн/u, HeartPulse],
  [/death|dead|necrot|grave|skull|смер|мертв|некро/u, Skull],
  [/shield|ward|armor|protect|guard|защит|брон|страж/u, ShieldCheck],
  [/summon|conjur|familiar|beast|animal|wild|призыв|звер|дик/u, PawPrint],
  [/teleport|misty|dimension|portal|gate|door|телеп|врат/u, DoorOpen],
  [/wind|gust|air|ветер|возду/u, Wind],
  [/water|wave|tidal|вод|волн/u, Waves],
  [/earth|stone|rock|thorn|tree|plant|зем|кам|шип|дерев|раст/u, TentTree],
  [/sun|radiant|holy|divine|sacred|солн|свет|свят|боже/u, Sun],
  [/dark|shadow|night|void|тьм|тен|ноч/u, Moon],
  [/mind|psychic|thought|dream|fear|charm|разум|псих|сон|страх|очаров/u, Brain],
  [/illusion|invis|blur|disguise|иллюз|невид|маскир/u, EyeOff],
  [/see|vision|detect|true-sight|глаз|зрение|обнаруж|поиск/u, Eye],
  [/hand|touch|grasp|fist|рук|касание|захват|кулак/u, Hand],
  [/bird|fly|feather|wing|птиц|полёт|перо|крыл/u, Bird],
  [/leaf|druid|nature|bloom|лист|друид|природ|цвет/u, Leaf],
  [/arrow|bow|ray|bolt|shot|mark|стрел|лук|луч|метк/u, Target],
  [/sword|blade|weapon|slash|strike|меч|клин|оруж|удар/u, Swords],
  [/dash|haste|speed|retreat|move|рыв|скор|отступ|перемещ/u, Footprints],
  [/hide|sneak|stealth|скры|спрят|крад/u, Rabbit],
  [/book|tome|scroll|spellbook|книг|свит/u, BookOpen],
  [/bomb|blast|burst|explos|взрыв|бомб/u, Bomb],
  [/ban|counter|silence|dispel|запрет|контр|тишин|рассе/u, Ban],
]

const fixedGlyphs: Partial<Record<CombatIconKind, LucideIcon>> = {
  movement: Footprints,
  spellbook: BookOpen,
  roll: Dices,
  swap: RefreshCw,
  'end-turn': ShieldCheck,
  'start-combat': Swords,
}

const damageHues: Array<[RegExp, number]> = [
  [/fire|огн/u, 24], [/cold|ice|frost|холод|лед/u, 190], [/lightning|thunder|молн|гром/u, 212],
  [/acid|кисл/u, 88], [/poison|яд/u, 126], [/necrot|некро/u, 286], [/radiant|свет|свят/u, 47],
  [/psychic|псих/u, 322], [/force|силов/u, 267], [/heal|cure|леч|исцел/u, 158],
]

function hashId(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function chooseGlyph(id: string, kind: CombatIconKind, hint: string, hash: number) {
  const semanticText = `${id} ${hint}`.toLocaleLowerCase('ru')
  const semantic = semanticGlyphs.find(([pattern]) => pattern.test(semanticText))?.[1]
  if (semantic) return semantic
  if (fixedGlyphs[kind]) return fixedGlyphs[kind]!
  const family = kind === 'spell' ? spellGlyphs
    : kind === 'weapon' ? weaponGlyphs
      : kind === 'item' ? itemGlyphs
        : kind === 'reaction' ? reactionGlyphs
          : actionGlyphs
  return family[hash % family.length]
}

function iconHue(id: string, hint: string, hash: number) {
  const semanticText = `${id} ${hint}`.toLocaleLowerCase('ru')
  const semanticHue = damageHues.find(([pattern]) => pattern.test(semanticText))?.[1]
  if (semanticHue !== undefined) return (semanticHue + ((hash >>> 8) % 19) - 9 + 360) % 360
  return hash % 360
}

function runePath(hash: number) {
  const x1 = 7 + (hash & 7)
  const y1 = 9 + ((hash >>> 3) & 7)
  const x2 = 32 + ((hash >>> 6) & 7)
  const y2 = 8 + ((hash >>> 9) & 7)
  const x3 = 31 + ((hash >>> 12) & 8)
  const y3 = 32 + ((hash >>> 15) & 7)
  const x4 = 8 + ((hash >>> 18) & 8)
  const y4 = 31 + ((hash >>> 21) & 7)
  return `M${x1} ${y1} L${x2} ${y2} L${x3} ${y3} L${x4} ${y4} Z`
}

export function CombatIcon({ id, kind, hint = '', size = 34, compact = false }: CombatIconProps) {
  const hash = hashId(`${kind}:${id}`)
  const Glyph = chooseGlyph(id, kind, hint, hash)
  let AccentGlyph = accentGlyphs[(hash >>> 14) % accentGlyphs.length]
  if (AccentGlyph === Glyph) AccentGlyph = accentGlyphs[((hash >>> 14) + 1) % accentGlyphs.length]
  const hue = iconHue(id, hint, hash)
  const secondaryHue = (hue + 35 + ((hash >>> 13) % 86)) % 360
  const rotation = ((hash >>> 5) % 15) - 7
  const nodeA = 8 + ((hash >>> 11) % 32)
  const nodeB = 8 + ((hash >>> 17) % 32)
  const style = {
    '--combat-icon-hue': hue,
    '--combat-icon-hue-2': secondaryHue,
    '--combat-icon-rotation': `${rotation}deg`,
    '--combat-icon-bg-x': `${hash % 100}%`,
    '--combat-icon-bg-y': `${(hash >>> 9) % 100}%`,
    width: size,
    height: size,
  } as CSSProperties

  return <span className={`combat-icon combat-icon-${kind}${compact ? ' compact' : ''}`} style={style} aria-hidden="true">
    <svg className="combat-icon-rune" viewBox="0 0 48 48" focusable="false">
      <path d={runePath(hash)} />
      <circle cx={nodeA} cy={nodeB} r="1.25" />
      <circle cx={48 - nodeB} cy={48 - nodeA} r=".8" />
    </svg>
    <Glyph className="combat-icon-glyph" strokeWidth={compact ? 2.15 : 2.4} />
    <AccentGlyph className="combat-icon-accent" strokeWidth={2.6} />
  </span>
}
