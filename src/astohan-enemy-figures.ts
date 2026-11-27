import * as THREE from 'three'
import type { ActorModelInput, ActorModelManifestEntry } from './actor-models'
import { buildAstohanChimeraFamily } from './astohan-chimera-family'
import { buildAstohanBeast } from './astohan-beasts'
import { buildAstohanUndead } from './astohan-undead'
import { buildAstohanGiant } from './astohan-giants'
import { buildAstohanRaider, decorateRaider } from './astohan-raider-figures'
import { buildBarbedDevil } from './astohan-barbed-devil'

// Открытые имена бестиария. Служебный ID врага содержит скрытую информацию
// при маскировке, поэтому выбор работает только по подписи и публичному типу.
const species: Readonly<Record<string, readonly [string, string]>> = {
  'air-elemental': ['Воздушный элементаль', 'elemental'],
  'awakened-shrub': ['Пробуждённый куст', 'plant'],
  'bandit': ['Разбойник', 'humanoid'],
  'bandit-captain': ['Капитан разбойников', 'humanoid'],
  'banshee': ['Баньши', 'undead'],
  'barbed-devil': ['Шипастый дьявол', 'fiend'],
  'basilisk': ['Василиск', 'monstrosity'],
  'berserker': ['Берсерк', 'humanoid'],
  'brown-bear': ['Бурый медведь', 'beast'],
  'bugbear': ['Багбир', 'humanoid'],
  'chimera': ['Химера', 'monstrosity'],
  'couatl': ['Коатль', 'celestial'],
  'crawling-claw': ['Ползающая рука', 'undead'],
  'cyclops': ['Циклоп', 'giant'],
  'dire-wolf': ['Лютый волк', 'beast'],
  'displacer-beast': ['Ускользающий зверь', 'monstrosity'],
  'ettin': ['Эттин', 'giant'],
  'flameskull': ['Пылающий череп', 'undead'],
  'ghast': ['Вурдалак', 'undead'],
  'ghost': ['Привидение', 'undead'],
  'ghoul': ['Упырь', 'undead'],
  'giant-boar': ['Гигантский кабан', 'beast'],
  'giant-rat': ['Гигантская крыса', 'beast'],
  'giant-spider': ['Гигантский паук', 'beast'],
  'gnoll': ['Гнолл', 'humanoid'],
  'goblin': ['Гоблин', 'humanoid'],
  'gorgon': ['Горгона', 'monstrosity'],
  'harpy': ['Гарпия', 'monstrosity'],
  'hell-hound': ['Адская гончая', 'fiend'],
  'hill-giant': ['Холмовой великан', 'giant'],
  'hobgoblin': ['Хобгоблин', 'humanoid'],
  'hyena': ['Гиена', 'beast'],
  'jackal': ['Шакал', 'beast'],
  'lion': ['Лев', 'beast'],
  'manticore': ['Мантикора', 'monstrosity'],
  'minotaur-skeleton': ['Скелет минотавра', 'undead'],
  'mummy': ['Мумия', 'undead'],
  'ogre': ['Огр', 'giant'],
  'orc': ['Орк', 'humanoid'],
  'owlbear': ['Совомед', 'monstrosity'],
  'red-dragon-wyrmling': ['Вирмлинг красного дракона', 'dragon'],
  'skeleton': ['Скелет', 'undead'],
  'specter': ['Спектр', 'undead'],
  'spider': ['Паук', 'beast'],
  'troll': ['Тролль', 'giant'],
  'vampire-spawn': ['Порождение вампира', 'undead'],
  'veteran': ['Ветеран', 'humanoid'],
  'water-elemental': ['Водяной элементаль', 'elemental'],
  'wight': ['Умертвие', 'undead'],
  'wolf': ['Волк', 'beast'],
  'wyvern': ['Виверна', 'dragon'],
  'young-red-dragon': ['Молодой красный дракон', 'dragon'],
  'zombie': ['Зомби', 'undead'],
}

const existing: Readonly<Record<string,string>> = {
  wolf:'wolf', spider:'spider', 'giant-spider':'spider', 'giant-rat':'rat',
  goblin:'goblin-quaternius', skeleton:'skeleton-quaternius',
  'young-red-dragon':'dragon', 'red-dragon-wyrmling':'dragon',
  bandit:'hero-male', 'bandit-captain':'hero-male', veteran:'hero-male', berserker:'hero-male', orc:'hero-male', hobgoblin:'hero-male',
}

const nameKey = (v: string) => v.toLowerCase().trim().replace(/ё/gu,'е').replace(/[-_]/gu,' ').replace(/\s+\d+$/u,'')
const byPublicName = new Map(Object.entries(species).flatMap(([slug,[name]]) =>
  [[nameKey(name),slug], [nameKey(slug),slug]] as [string,string][]))
export function campaignEnemySlug(input: Pick<ActorModelInput,'kind'|'archetype'|'label'>): string | null {
  if (input.kind !== 'enemy' && input.kind !== 'summon') return null
  const slug = byPublicName.get(nameKey(input.label))
  if (!slug || (input.archetype && nameKey(input.archetype) !== species[slug][1] && nameKey(input.archetype) !== nameKey(slug))) return null
  return slug
}

const prefix = 'astohan-figure-'
export function authoredEnemyEntry(input: ActorModelInput, models: readonly ActorModelManifestEntry[]): ActorModelManifestEntry | null {
  const slug = input.modelKey?.startsWith(prefix) ? input.modelKey.slice(prefix.length) : campaignEnemySlug(input)
  if (!slug || !Object.hasOwn(species,slug)) return null
  const baseKey = existing[slug]
  if (baseKey) {
    const entry = models.find(m=>m.key===baseKey)
    if (!entry) return null
    return slug === 'red-dragon-wyrmling' ? {...entry, height:1.5} : entry
  }
  const type = species[slug][1]
  const profile = type === 'undead' ? 'skeleton' : type === 'giant' || type === 'humanoid' ? 'warrior' : 'beast'
  const low: Record<string,number> = { 'crawling-claw':.30, flameskull:.78, 'awakened-shrub':.72, basilisk:.80, 'giant-boar':.87, jackal:.6, hyena:.73 }
  return {key:prefix+slug, name_ru:species[slug][0], profile, height:low[slug]??1.25, url:null, outfit:'builtin', rights:{source:'Сказание',license:'original'}}
}

export function buildCampaignEnemy(key: string): THREE.Group | null {
  if (!key.startsWith(prefix)) return null
  const slug = key.slice(prefix.length)
  return buildAstohanBeast(slug) ?? buildAstohanChimeraFamily(slug) ?? buildAstohanUndead(slug) ?? buildAstohanGiant(slug)
    ?? buildAstohanRaider(slug) ?? (slug === 'barbed-devil' ? buildBarbedDevil() : null)
}

export function dressCampaignEnemy(root: THREE.Group, input: ActorModelInput) {
  if (input.modelKey) return
  const slug = campaignEnemySlug(input)
  if (slug && existing[slug] === 'hero-male') decorateRaider(root,slug)
}
