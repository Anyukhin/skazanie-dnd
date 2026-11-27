/**
 * Публичное сопоставление фигурок форм и призывов.
 *
 * Источник — только имя и id формы из viewer-safe проекции. Скрытая сущность
 * боя сюда не попадает. Если для формы нет отдельной локальной модели,
 * выбирается отдельная проектная фигура, если для формы она зарегистрирована.
 */
const FORM_MODEL_KEYS: Readonly<Record<string, string>> = {
  wolf: 'wolf',
  'dire-wolf': 'astohan-figure-dire-wolf',
  'brown-bear': 'astohan-figure-brown-bear',
  lion: 'astohan-figure-lion',
  'giant-boar': 'astohan-figure-giant-boar',
  'giant-spider': 'spider',
  spider: 'spider',
  rat: 'rat',
  frog: 'frog',
  toad: 'frog',
  snake: 'snake',
  wasp: 'wasp',
}

const SUMMON_MODEL_KEYS: Readonly<Record<string, string>> = {
  'spiritual-weapon': 'astohan-summon-spiritual-weapon',
  'summon-beast': 'astohan-summon-beast',
  'conjure-animals': 'astohan-summon-animal',
  'summon-fey': 'astohan-summon-fey',
  'summon-lesser-demons': 'astohan-summon-lesser-demon',
  'summon-shadowspawn': 'astohan-summon-shadowspawn',
  'summon-undead': 'astohan-summon-undead',
  'conjure-woodland-beings': 'astohan-summon-woodland',
  'mordenkainen-s-faithful-hound': 'astohan-summon-faithful-hound',
  'summon-aberration': 'astohan-summon-aberration',
  'summon-construct': 'astohan-summon-construct',
  'summon-elemental': 'astohan-summon-elemental',
  'summon-greater-demon': 'astohan-summon-greater-demon',
}

function slug(value: unknown): string {
  return String(value ?? '').toLocaleLowerCase('ru-RU')
    .replace(/ё/gu, 'е')
    .replace(/[^a-zа-я0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
}

export type PublicShapeFigure = { id?: string; name?: string; wild_shape?: boolean }

/** Возвращает ключ уже существующей локальной модели для видимой формы. */
export function publicShapeModelKey(form: PublicShapeFigure | null | undefined): string | undefined {
  if (!form) return undefined
  const id = slug(form.id)
  const name = slug(form.name)
  for (const key of [id, name]) {
    if (FORM_MODEL_KEYS[key]) return FORM_MODEL_KEYS[key]
  }
  if (/(гигант.*паук|паук|spider)/u.test(id + '-' + name)) return 'spider'
  if (/(лютый.*волк|dire.*wolf)/u.test(id + '-' + name)) return 'astohan-figure-dire-wolf'
  if (/(медвед|bear)/u.test(id + '-' + name)) return 'astohan-figure-brown-bear'
  if (/(кабан|boar)/u.test(id + '-' + name)) return 'astohan-figure-giant-boar'
  if (/(лев|lion)/u.test(id + '-' + name)) return 'astohan-figure-lion'
  if (/(волк|wolf)/u.test(id + '-' + name)) return 'wolf'
  if (/(крыса|rat)/u.test(id + '-' + name)) return 'rat'
  if (/(лягуш|жаб|frog|toad)/u.test(id + '-' + name)) return 'frog'
  if (/(зме|snake|viper)/u.test(id + '-' + name)) return 'snake'
  if (/(оса|wasp)/u.test(id + '-' + name)) return 'wasp'
  return undefined
}

/** Для призыва форма определяется открытым именем/типом существа. */
export function summonModelKey(input: { name?: string; creature_type?: string; archetype?: string; sourceSpellId?: string }): string | undefined {
  const sourceKey = String(input.sourceSpellId ?? '').toLocaleLowerCase('en-US')
  if (SUMMON_MODEL_KEYS[sourceKey]) return SUMMON_MODEL_KEYS[sourceKey]
  const publicName = `${input.name ?? ''} ${input.archetype ?? ''}`.toLocaleLowerCase('ru-RU')
  for (const [id, key] of Object.entries(SUMMON_MODEL_KEYS)) {
    const words = id.split('-').filter(word => word.length > 3)
    if (words.some(word => publicName.includes(word))) return key
  }
  return publicShapeModelKey({ id: input.archetype, name: input.name })
}

export const campaignSummonModelPrefix = 'astohan-summon-'
