import { NARRATOR_PRIORITY, narrationTextOr, registerDeterministicNarrator } from './deterministic-narration.mjs'

/**
 * Текст интеракций с обстановкой — задача 3.2 плана. Рассказывает только то,
 * что движок уже подтвердил событиями: повалено, загорелось, кого задело.
 * Ни одного числа механики: урон и спасброски игрок видит в карточке броска.
 */

const HAZARD_INTENTS = new Set(['topple', 'ignite'])

export function hasSceneHazardEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => (
    String(event?.event_type ?? '') === 'SceneObjectStateChanged'
    && HAZARD_INTENTS.has(String(event?.payload?.intent ?? ''))
  ))
}

export function sceneHazardNarration(events, state) {
  const batch = Array.isArray(events) ? events : []
  const changed = batch.find((event) => (
    event?.event_type === 'SceneObjectStateChanged' && HAZARD_INTENTS.has(String(event?.payload?.intent ?? ''))
  ))
  if (!changed) return null
  const propId = String(changed.payload?.prop_id ?? '')
  const prop = (state?.scene?.map?.props ?? []).find((candidate) => String(candidate?.id) === propId)
  const what = narrationTextOr(prop?.assetId ? propLabel(prop.assetId) : '', 'предмет обстановки', 80)
  const form = formsFor(what)

  if (changed.payload?.intent === 'topple') {
    if (changed.payload?.success === false) {
      return `${capitalize(what)} ${form.swayed}, но ${form.held}: опрокинуть ${form.accusative} не вышло.`
    }
    const hurt = batch.filter((event) => event?.event_type === 'DamageApplied' && event?.payload?.reason === 'scene-object-topple')
    const prone = batch.some((event) => event?.event_type === 'ConditionAdded' && event?.payload?.condition === 'prone')
    if (!hurt.length) return `${capitalize(what)} с грохотом ${form.falls} на пол, но задеть никого не ${form.misses}.`
    return `${capitalize(what)} ${form.collapses} вниз и ${form.covers} тех, кто стоял ${form.under}${prone ? ', сбивая с ног' : ''}.`
  }

  const fromProp = String(changed.payload?.fire_source ?? '') === 'prop'
  return `${capitalize(what)} ${form.catches} огнём${fromProp ? ' от стоящего рядом пламени' : ''}. Пламя перекидывается на соседние клетки, и стоять в нём больше нельзя.`
}

const RU_LABELS = Object.freeze({
  bookshelf: 'стеллаж', bar_shelf: 'полка за стойкой', shelf_wall: 'стеллаж',
  wardrobe: 'платяной шкаф', cupboard: 'буфет', crate_stack: 'штабель ящиков',
  barrel_stack: 'штабель бочек', table_long: 'длинный стол', table_round: 'круглый стол',
  table_small: 'столик', bar_counter: 'барная стойка', barrel: 'бочка', keg: 'бочонок',
  crate: 'ящик', cart: 'телега', market_stall: 'торговый лоток', statue: 'статуя',
  pillar: 'колонна', haystack: 'стог сена', woodpile: 'поленница',
  firewood_stack: 'дрова', basket: 'корзина', broom: 'метла', cobweb: 'паутина',
  banner: 'полотнище', temple_banner: 'храмовое полотнище', rug: 'ковёр',
  bed: 'постель', bunk_bed: 'койка', prayer_bench: 'скамья', bench: 'скамья',
})

/**
 * Род известных подписей. Русский глагол в прошедшем времени согласуется с
 * подлежащим, а подписи в справочнике разного рода — без этой карты выходило
 * «Колонна качнулся». `p` — множественное число: «дрова» ведут себя так же,
 * как род, только формы у них свои.
 */
const LABEL_GENDER = Object.freeze({
  'полка за стойкой': 'f', 'барная стойка': 'f', 'бочка': 'f', 'телега': 'f', 'статуя': 'f',
  'колонна': 'f', 'поленница': 'f', 'корзина': 'f', 'метла': 'f', 'паутина': 'f',
  'постель': 'f', 'койка': 'f', 'скамья': 'f',
  'полотнище': 'n', 'храмовое полотнище': 'n',
  'дрова': 'p',
})

/**
 * Формы для каждого рода. Отдельной таблицей, а не правилом по окончанию:
 * подписей три десятка, они заданы вручную, и угадывание здесь врало бы чаще,
 * чем помогало.
 */
const GENDER_FORMS = Object.freeze({
  m: Object.freeze({
    swayed: 'качнулся', held: 'устоял', accusative: 'его', under: 'под ним',
    falls: 'валится', misses: 'успевает', collapses: 'обрушивается', covers: 'накрывает', catches: 'занимается',
  }),
  f: Object.freeze({
    swayed: 'качнулась', held: 'устояла', accusative: 'её', under: 'под ней',
    falls: 'валится', misses: 'успевает', collapses: 'обрушивается', covers: 'накрывает', catches: 'занимается',
  }),
  n: Object.freeze({
    swayed: 'качнулось', held: 'устояло', accusative: 'его', under: 'под ним',
    falls: 'валится', misses: 'успевает', collapses: 'обрушивается', covers: 'накрывает', catches: 'занимается',
  }),
  p: Object.freeze({
    swayed: 'качнулись', held: 'устояли', accusative: 'их', under: 'под ними',
    falls: 'валятся', misses: 'успевают', collapses: 'обрушиваются', covers: 'накрывают', catches: 'занимаются',
  }),
})

/** Подпись без рода в карте считается мужской: так же, как было до правки. */
function formsFor(label) {
  return GENDER_FORMS[LABEL_GENDER[String(label ?? '').toLocaleLowerCase('ru')] ?? 'm']
}

function propLabel(assetId) {
  const key = String(assetId ?? '').toLowerCase().split(/[\\/]/u).at(-1)?.replace(/\.[a-z0-9]+$/u, '') ?? ''
  return RU_LABELS[key] ?? ''
}

function capitalize(value) {
  const text = String(value ?? '')
  return text ? text[0].toLocaleUpperCase('ru') + text.slice(1) : text
}

export const sceneHazardNarrator = registerDeterministicNarrator({
  id: 'scene-hazard',
  // Раньше сцены: обрушенный стеллаж — событие крупнее, чем открытая дверь.
  priority: NARRATOR_PRIORITY.scene - 1,
  promptVersion: 'scene-hazard-narrator/v1',
  provider: 'deterministic-scene-hazard',
  matches: hasSceneHazardEvent,
  narrate: (events, state) => sceneHazardNarration(events, state),
})
