import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { CircleAlert, X } from 'lucide-react'
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

/**
 * Лицо героя: всё, из чего собирается аватар. Тип нарочно шире `Player` —
 * тем же приёмом рисуется черновик листа в редакторе и павший герой, а у них
 * своя форма записи.
 */
export type HeroFace = {
  portrait?: string
  portraitPosition?: string
  character?: string
  name?: string
  initials?: string
  color?: string
}

/** Портрет есть только тогда, когда в поле лежит непустая ссылка. */
export function hasHeroPortrait(hero: HeroFace | null | undefined): boolean {
  return Boolean(String(hero?.portrait ?? '').trim())
}

/**
 * Инициалы героя. Приоритет у явного поля листа (`initials`), дальше — первые
 * буквы имени персонажа, и лишь в самом крайнем случае вопросительный знак:
 * герой без имени бывает ровно один миг — в свежесозданном пустом слоте.
 */
export function heroInitials(hero: HeroFace | null | undefined): string {
  const explicit = String(hero?.initials ?? '').trim()
  if (explicit) return explicit.slice(0, 2).toLocaleUpperCase('ru')
  const source = String(hero?.character || hero?.name || '').trim()
  const letters = source.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part.slice(0, 1)).join('')
  return (letters || '?').toLocaleUpperCase('ru')
}

/**
 * Стиль аватара героя. Портрет есть — рисуем его по своей позиции в спрайте
 * отряда; портрета нет — не выставляем `backgroundImage` **вовсе** и отдаём
 * цвет героя переменной `--face-color`.
 *
 * Инлайновый `backgroundImage: url()` от пустой строки и был причиной пустых
 * кружков: браузер честно запрашивал сам адрес страницы, ничего не рисовал, а
 * перебить инлайновый стиль из листа стилей нельзя. Поэтому фолбэк не
 * «поверх» портрета, а вместо него.
 */
export function heroFaceStyle(hero: HeroFace | null | undefined, extra: CSSProperties = {}): CSSProperties {
  if (hasHeroPortrait(hero)) {
    return { ...extra, backgroundImage: `url(${hero?.portrait})`, backgroundPosition: hero?.portraitPosition }
  }
  return { ...extra, ['--face-color' as string]: hero?.color || '#6d5b45' }
}

/** Значение `data-face` для оправы аватара: метка «здесь инициалы, а не фото». */
export function heroFaceMode(hero: HeroFace | null | undefined): 'initials' | undefined {
  return hasHeroPortrait(hero) ? undefined : 'initials'
}

/**
 * Инициалы поверх цвета героя — единственная замена портрету во всём
 * интерфейсе: на фишке доски, в списке отряда, в ленте инициативы и в
 * ресурсном кластере панели. `aria-hidden` намеренно: имя героя рядом уже
 * названо подписью или `aria-label` оправы, и скринридер не обязан слышать
 * «Л В» вторым голосом.
 */
export function HeroFaceInitials({ hero }: { hero: HeroFace | null | undefined }) {
  return <b className="hero-face-initials" aria-hidden="true">{heroInitials(hero)}</b>
}

/** Сколько отказов видно разом и сколько живёт каждый. */
const ERROR_TOAST_LIMIT = 3
const ERROR_TOAST_LIFETIME_MS = 9000

/** Источник отказа: готовый текст и, если он у источника есть, способ снять его. */
export type ErrorToastSource = { text: string | null | undefined; onDismiss?: () => void }

/**
 * Общая лента отказов. Источников несколько — команда доски, жизненный цикл
 * кампании, вход в комнату, — и каждый рисовал свою строку в своём углу: вторая
 * ошибка затирала первую раньше, чем её успевали прочитать. Здесь они встают в
 * очередь, видно до трёх подряд, каждая уходит сама. Тексты приходят готовыми и
 * не переписываются: причину формулирует тот, кто отказал.
 */
export function ErrorToasts({ sources }: { sources: ErrorToastSource[] }) {
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; onDismiss?: () => void }>>([])
  const shownRef = useRef<string[]>([])
  const nextIdRef = useRef(0)
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  // Ключ вместо массива в зависимостях: массив собирается заново на каждом
  // рендере родителя, и эффект перезапускался бы вхолостую.
  const sourcesKey = JSON.stringify(sources.map((source) => source.text ?? ''))
  useEffect(() => {
    const incoming = sourcesRef.current
    const previous = shownRef.current
    shownRef.current = incoming.map((source) => source.text ?? '')
    // Новое — только то, что изменилось у своего источника: пока текст висит
    // прежним, тост не дублируется.
    const fresh = incoming.filter((source, index) => source.text && source.text !== previous[index])
    if (!fresh.length) return
    setToasts((current) => [
      ...current,
      ...fresh.map((source) => ({ id: ++nextIdRef.current, text: String(source.text), onDismiss: source.onDismiss })),
    ].slice(-ERROR_TOAST_LIMIT))
  }, [sourcesKey])
  // Гасим по одному с головы очереди: следующий отсчёт начинается, когда
  // предыдущий тост ушёл, и три отказа подряд не исчезают одним махом.
  useEffect(() => {
    const oldest = toasts[0]
    if (!oldest) return
    const timer = window.setTimeout(() => {
      oldest.onDismiss?.()
      setToasts((current) => current.filter((entry) => entry.id !== oldest.id))
    }, ERROR_TOAST_LIFETIME_MS)
    return () => window.clearTimeout(timer)
  }, [toasts])
  if (!toasts.length) return null
  return <div className="toast-stack">
    {toasts.map((toast) => <div key={toast.id} className="toast toast-error" role="alert">
      <CircleAlert size={15} aria-hidden="true" />
      <span>{toast.text}</span>
      <button
        type="button"
        aria-label="Закрыть сообщение"
        onClick={() => { toast.onDismiss?.(); setToasts((current) => current.filter((entry) => entry.id !== toast.id)) }}
      ><X size={13} /></button>
    </div>)}
  </div>
}

/**
 * Escape закрывает окно и возвращает фокус тому элементу, который его открыл:
 * без этого после закрытия обход по Tab начинался заново с верха страницы.
 */
export function useDialogEscape(onClose: () => void, open = true) {
  // Обработчик держим в ref: `onClose` приходит новой стрелкой на каждый рендер
  // родителя, и эффект иначе переподписывался бы на каждое обновление.
  const close = useRef(onClose)
  close.current = onClose
  // `open` — именно «окно на экране», а не «действие разрешено»: по этому же
  // признаку запоминается и возвращается фокус. Окна, которые монтируются
  // условно, признак не передают вовсе — им хватает жизни компонента.
  useEffect(() => {
    if (!open) return
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (invoker?.isConnected) invoker.focus()
    }
  }, [open])
}

/**
 * «1 предмет», «2 предмета», «11 предметов». Правило русского счёта, а не
 * `count < 5`: одиннадцать по короткому правилу превращалось в «11 предмета».
 */
export function itemCountLabel(count: number) {
  const value = Math.max(0, Math.trunc(Number(count) || 0))
  const hundreds = value % 100
  const tens = value % 10
  if (hundreds >= 11 && hundreds <= 14) return `${value} предметов`
  if (tens === 1) return `${value} предмет`
  if (tens >= 2 && tens <= 4) return `${value} предмета`
  return `${value} предметов`
}

/**
 * Виды урона по-русски, в именительном падеже. Один словарь на всех
 * потребителей: строку хроники, историю урона у наведённой фишки и список
 * вариантов заклинания на панели (`SPELL_OPTION_LABELS`, `DungeonMap.tsx`) —
 * раньше он жил там же и обслуживал заодно урон, отчего «колющий» существовал
 * в интерфейсе ровно в одном месте и хронике не доставался.
 */
export const DAMAGE_TYPE_LABELS: Record<string, string> = {
  acid: 'Кислота', bludgeoning: 'Дробящий', cold: 'Холод', fire: 'Огонь', force: 'Сила',
  lightning: 'Молния', necrotic: 'Некротический', piercing: 'Колющий', poison: 'Яд',
  psychic: 'Психический', radiant: 'Излучение', slashing: 'Рубящий', thunder: 'Звук',
}

/**
 * Тот же список в родительном падеже: «8 колющего», «6 огненного». Второй
 * словарь нужен именно потому, что первый не склоняется правилом — половина
 * видов урона это прилагательные («колющий»), половина существительные
 * («огонь», «яд»), и вывести одно из другого нечем.
 */
const DAMAGE_TYPE_AMOUNT_LABELS: Record<string, string> = {
  acid: 'кислотного', bludgeoning: 'дробящего', cold: 'холодного', fire: 'огненного',
  force: 'силового', lightning: 'электрического', necrotic: 'некротического',
  piercing: 'колющего', poison: 'ядовитого', psychic: 'психического',
  radiant: 'сияющего', slashing: 'рубящего', thunder: 'звукового',
}

/** Название вида урона для подписи. Пустая строка — вида нет или он незнаком. */
export function damageTypeLabel(damageType: string | null | undefined): string {
  return DAMAGE_TYPE_LABELS[String(damageType ?? '').toLowerCase()] ?? ''
}

/**
 * «8 колющего» — величина вместе с видом. Незнакомый или отсутствующий вид даёт
 * прежнее «8 урона»: выдумывать слово вместо неизвестного вида хуже, чем
 * промолчать о нём.
 */
export function damageAmountText(amount: number | null | undefined, damageType?: string | null): string {
  const value = Number(amount) || 0
  return `${value} ${DAMAGE_TYPE_AMOUNT_LABELS[String(damageType ?? '').toLowerCase()] ?? 'урона'}`
}

/**
 * Глагол по виду атаки. Вид приходит с сервера полем `attackKind` и отвечает за
 * обе стороны стола: у героя он берётся из выбранного режима оружия, у
 * существа — из его действия стат-блока. Без этого поля (бой, сыгранный до
 * появления признака) глагол остаётся прежним нейтральным «атакует».
 */
const ATTACK_VERB_LABELS: Record<'melee' | 'ranged' | 'thrown', string> = {
  melee: 'бьёт', ranged: 'стреляет в', thrown: 'мечет в',
}

/**
 * Причина помехи от стрельбы за пределы обычной дальности. Формулировку задаёт
 * сервер (`attackSwingShape`, `server/rules-engine.mjs`), здесь она названа
 * именем, чтобы хроника не напечатала её дважды: «дальний выстрел с помехой» в
 * голове строки и та же причина ещё раз после исхода.
 */
const LONG_RANGE_ROLL_REASON = 'дальний диапазон'

/**
 * Характеристика спасброска по-русски. Раньше в строку уезжал сырой ключ
 * («спасбросок DEX от «Огненного шара»») — единственное английское слово во
 * всей хронике. Сокращение, а не полное имя, выбрано ради падежа: «спасбросок
 * Ловкость» неграмотно, «спасбросок Ловкости» потребовало бы третьего словаря
 * на шесть строк, а сокращения не склоняются вовсе. Незнакомый ключ остаётся
 * собой, а не превращается в выдумку.
 */
function abilitySaveLabel(ability: string | null | undefined): string {
  const key = String(ability ?? '').toLowerCase()
  return ABILITY_SHORT_LABELS[key] ?? (key ? key.toLocaleUpperCase('ru') : '')
}

/**
 * Чем и с какого расстояния бьют — короткая скобка после цели.
 *
 * Название не зависит от вида атаки: удар легендарного действия и луч
 * заклинания вида не несут вовсе, но названы оба, и молчать о них значило бы
 * терять «чем» ради «как». Расстояние — наоборот: без вида атаки неизвестно,
 * дальний это удар или обычные пять футов, и число тогда не печатается.
 */
function attackAimText(event: BattleLogEvent, kind?: 'melee' | 'ranged' | 'thrown'): string {
  const parts: string[] = []
  // Имя оружия героя, имя действия существа и имя заклинания публичны все три:
  // своё снаряжение отряд видит в листе, а поступок противника — своими
  // глазами. Ни ключа вещи, ни идентификатора действия здесь нет и быть не
  // может — сервер их до стола не довозит.
  const weapon = String(event.itemName || event.actionName || event.spellName || '').trim()
  if (weapon) parts.push(`«${weapon}»`)
  if (kind && kind !== 'melee' && event.distanceFeet != null) parts.push(`${event.distanceFeet} фт`)
  if (event.longRange) parts.push('дальний выстрел с помехой')
  return parts.length ? ` (${parts.join(', ')})` : ''
}

/**
 * Почему бросок был с преимуществом или помехой. Причины приходят готовыми
 * русскими строками с сервера — тем же списком, что объясняет прогноз удара, —
 * и здесь только выбираются и обрезаются: в строку хроники входят две, дальше
 * она перестаёт читаться с одного взгляда.
 */
function rollModeText(event: BattleLogEvent): string {
  if (event.rollMode !== 'advantage' && event.rollMode !== 'disadvantage') return ''
  const advantage = event.rollMode === 'advantage'
  const reasons = [...new Set(((advantage ? event.advantageReasons : event.disadvantageReasons) ?? []).map(String))]
    .map((reason) => reason.trim())
    .filter((reason) => reason && !(event.longRange && reason === LONG_RANGE_ROLL_REASON))
    .slice(0, 2)
  if (!reasons.length) {
    // Дальний выстрел уже назван в голове строки вместе со своей помехой:
    // второе «с помехой» после исхода пересказывало бы тот же факт.
    if (!advantage && event.longRange) return ''
    return advantage ? ' (с преимуществом)' : ' (с помехой)'
  }
  return ` (${advantage ? 'преимущество' : 'помеха'}: ${reasons.join(', ')})`
}

/**
 * Разбор броска атаки: «к20 14+4=18». Кость и модификатор есть только у своих —
 * у удара противника проекция оставляет один итог (`publicBattleEventFor`,
 * `server/viewer-projection.mjs`), потому что модификатор атаки существа —
 * число его стат-блока, закрытое наравне с КД. Тогда печатается сам итог, как
 * и печатался.
 */
function attackRollText(roll: BattleLogEvent['roll']): string {
  const die = Number(roll?.die)
  const modifier = Number(roll?.modifier)
  const total = roll?.total ?? '?'
  if (!Number.isFinite(die) || die <= 0) return `${total}`
  if (!Number.isFinite(modifier) || modifier === 0) return `к20 ${die}`
  return `к20 ${die}${modifier > 0 ? '+' : '−'}${Math.abs(modifier)}=${total}`
}

type BattleLogEvent = NonNullable<GameState['battleLog']>[number]

export function battleEventText(state: GameState, event: BattleLogEvent) {
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
  if (event.type === 'captive-taken') return `${actorName(event.actorId)} взят в плен${event.reason === 'knocked_out' ? ' без сознания' : ''}.`
  // Журнал называет, что добыча появилась и сколько её, но не что внутри:
  // содержимое отряд узнаёт, подойдя к телу.
  if (event.type === 'loot-container') {
    return `${event.containerName || 'Добыча'} — можно обыскать (${itemCountLabel(event.itemCount ?? 0)}).`
  }
  if (event.type === 'loot-taken') {
    const to = event.recipientId && event.recipientId !== event.actorId ? ` и передаёт ${actorName(event.recipientId)}` : ''
    return `${actorName(event.actorId)} обыскивает «${event.containerName || 'добычу'}»${to}: ${itemCountLabel(event.itemCount ?? 0)}.`
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
    const damage = event.damage != null ? ` · ${damageAmountText(event.damage, event.damageType)}` : ''
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    const automatic = event.automaticSuccess ? ' · автоматический успех' : event.immunity ? ` · иммунитет: ${event.immunity}` : ''
    const itemBonus = event.itemSavingThrowBonus ? ` · предмет +${event.itemSavingThrowBonus}` : ''
    return hideTargetFacts
      ? `${actorName(event.targetId)} делает спасбросок от «${event.spellName ?? event.spellId ?? 'заклинания'}» — ${outcome}${automatic}${itemBonus}${damage}.`
      : `${actorName(event.targetId)}: спасбросок ${abilitySaveLabel(event.ability)} от «${event.spellName ?? event.spellId ?? 'заклинания'}» ${formula} против СЛ ${event.roll?.difficulty ?? '?'} — ${outcome}${automatic}${itemBonus}${damage}${hp}.`
  }
  if (event.type === 'spell-damage') return `${actorName(event.actorId)} применяет «${event.spellName ?? event.spellId ?? 'заклинание'}» к ${actorName(event.targetId)}: ${damageAmountText(event.damage ?? 0, event.damageType)}${hideTargetFacts ? '' : ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter ?? '?'}`}.`
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
  // Область называет и то, от чего спасаются, и то, чем бьёт: раньше строка
  // обрывалась на радиусе, а СЛ с видом урона оставались только в карточке
  // вещи. Исход по каждой цели приходит своими записями.
  if (event.type === 'area-attack') {
    const save = event.savingThrowDifficulty != null
      ? ` · спасбросок ${abilitySaveLabel(event.ability)} против СЛ ${event.savingThrowDifficulty}`
      : ''
    const kind = damageTypeLabel(event.damageType)
    return `${actorName(event.actorId)} применяет «${event.itemName ?? 'областную атаку'}» в области радиусом ${event.area?.radiusFeet ?? '?'} фт${save}${kind ? ` · урон ${kind.toLocaleLowerCase('ru')}` : ''}.`
  }
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
    // «Кто, чем, как, исход» одной строкой. Глагол берётся из серверного вида
    // атаки, а не угадывается по дальности: в живой партии багбир метнул копьё
    // с 25 футов, а хроника печатала «атакует», и стол принял бросок за удар
    // вплотную. Вида нет — значит, бой сыгран до появления признака, и строка
    // остаётся ровно прежней.
    const kind = event.attackKind
    const verb = kind ? ATTACK_VERB_LABELS[kind] : 'атакует'
    const head = `${actorName(event.actorId)} ${verb} ${actorName(event.targetId)}${attackAimText(event, kind)}`
    const damage = event.roll?.hit && event.damage != null ? `, ${damageAmountText(event.damage, event.damageType)}` : ''
    const outcome = `${event.roll?.hit ? 'попадание' : 'промах'}${rollModeText(event)}${damage}`
    const hp = !hideTargetFacts && event.hpAfter != null ? ` · ОЗ ${event.hpBefore ?? '?'} → ${event.hpAfter}` : ''
    return hideActorFacts
      ? `${head} — ${outcome}${hp}.`
      : `${head}: ${attackRollText(event.roll)}${hideTargetFacts ? '' : ` против КД ${event.roll?.difficulty ?? '?'}`} — ${outcome}${hp}.`
  }
  // Реакция называлась в хронике одним своим ключом — строкой «reaction».
  // Имя приёма приходит с сервера тем же полем, что и у боевого действия.
  if (event.type === 'reaction') {
    if (event.countered) return `${actorName(event.actorId)} обрывает «${event.spellName ?? event.spellId ?? 'заклинание'}»: заклинание ${actorName(event.targetId)} не срабатывает.`
    // Только имя, без ключа: `actionId` — служебная строка латиницей
    // («uncanny-dodge»), и в русской хронике она была бы хуже молчания. У
    // записи, сделанной до появления имени, остаётся честное «отвечает
    // реакцией» и величина срезанного урона.
    const name = String(event.actionName ?? '').trim()
    const prevented = event.preventedDamage ? `, урон снижен на ${event.preventedDamage}` : ''
    return `${actorName(event.actorId)} отвечает реакцией${name ? ` «${name}»` : ''}${prevented}.`
  }
  if (event.type === 'encounter-created') {
    const participants = (event.participantIds ?? []).map(actorName).join(', ')
    return participants ? `Новое столкновение: ${participants}.` : 'Новое столкновение готово.'
  }
  if (event.type === 'encounter-ended') return `Столкновение завершено${event.reason ? ` · ${event.reason}` : ''}.`
  if (event.type === 'beast-tamed') return `${actorName(event.actorId)} успокоен и больше не нападает.`
  if (event.type === 'max-hp-increase') return `${actorName(event.targetId)}: максимум ОЗ ${event.maximumHpBefore ?? '?'} → ${event.maximumHpAfter ?? '?'}.`
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
/** Те же характеристики сокращённо: лист героя, хроника боя, узкие подписи. */
export const ABILITY_SHORT_LABELS: Record<string, string> = {
  str: 'СИЛ', dex: 'ЛОВ', con: 'ТЕЛ', int: 'ИНТ', wis: 'МДР', cha: 'ХАР',
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

