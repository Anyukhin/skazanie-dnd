import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BadgeCheck, CircleAlert, Coins, HandCoins, LoaderCircle, MapPin,
  PackageOpen, RefreshCw, ScrollText, Search, ShoppingBag, Sparkles, X,
} from 'lucide-react'
import { itemImageFor, type ItemImageInput } from './item-images'
import type { InventoryItem, Merchant, MerchantQuote, MerchantServiceQuote, MerchantView as MerchantViewModel, Player } from './types'

type MerchantScreenProps = {
  merchant: Merchant
  player: Player
  sceneLocation: string
  stateVersion: number
  view: MerchantViewModel | null
  narration: string | null
  busy: boolean
  error: string | null
  onLoad: (merchantId: string, actorId: string) => void
  onBargain: (merchantId: string, actorId: string) => void
  onBuy: (merchantId: string, actorId: string, stockId: string, quantity: number) => void
  onSell: (merchantId: string, actorId: string, itemId: string, quantity: number) => void
  onAppraise: (merchantId: string, actorId: string, itemId: string) => void
  onService: (merchantId: string, actorId: string, serviceId: string) => void
  onClose: () => void
}

type MerchantTab = 'buy' | 'sell' | 'services'
type ItemCategory = 'all' | InventoryItem['type']

const itemCategoryOrder: InventoryItem['type'][] = ['weapon', 'armor', 'consumable', 'tool', 'treasure', 'quest', 'document', 'other']

// Тип предмета приходит английским идентификатором и раньше печатался как есть:
// в русском интерфейсе игрок видел «consumable · potion-healing». Идентификатор
// каталога ему не нужен вовсе, а тип нужен словом.
const itemTypeLabels: Record<string, string> = {
  weapon: 'оружие',
  armor: 'доспех',
  consumable: 'расходник',
  tool: 'инструмент',
  quest: 'сюжетная вещь',
  treasure: 'ценность',
  document: 'бумаги',
  other: 'разное',
}

const itemTypeLabel = (type: string) => itemTypeLabels[type] ?? 'разное'

const serviceKindLabels: Record<MerchantServiceQuote['service']['kind'], string> = {
  appraisal: 'оценка',
  lodging: 'жильё',
  repair: 'ремонт',
  transport: 'перевозка',
  training: 'обучение',
  other: 'услуга',
}

function categoryLabel(category: ItemCategory) {
  if (category === 'all') return 'Все'
  const label = itemTypeLabel(category)
  return `${label.slice(0, 1).toLocaleUpperCase('ru')}${label.slice(1)}`
}

function categoryOptions(items: Array<{ type: InventoryItem['type'] }>) {
  const counts = new Map<InventoryItem['type'], number>()
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  return [
    { id: 'all' as const, label: 'Все', count: items.length },
    ...itemCategoryOrder
      .filter((type) => counts.has(type))
      .map((type) => ({ id: type, label: categoryLabel(type), count: counts.get(type) ?? 0 })),
  ]
}

function normalizeQuery(value: string) {
  return value.trim().toLocaleLowerCase('ru')
}

function humanPricingExplanation(primary?: string, fallback?: string) {
  const technical = /(?:srd_[a-z0-9_]+|skazanie:economy|merchant[-_]policy[-_:]v\d+)/iu
  const candidate = [primary, fallback].find((value) => {
    const text = value?.trim()
    return Boolean(text && !technical.test(text))
  })
  return candidate?.trim() || 'Цена складывается из базовой стоимости товара, условий лавки и результата торга.'
}

function itemMatchesFilter(item: { name: string; type: InventoryItem['type']; description?: string; properties?: string }, query: string, category: ItemCategory) {
  if (category !== 'all' && item.type !== category) return false
  if (!query) return true
  return `${item.name} ${item.description ?? ''} ${item.properties ?? ''} ${itemTypeLabel(item.type)}`
    .toLocaleLowerCase('ru')
    .includes(query)
}

function MerchantFilters({
  items,
  visibleCount,
  query,
  category,
  onQueryChange,
  onCategoryChange,
  ariaLabel,
}: {
  items: Array<{ type: InventoryItem['type'] }>
  visibleCount: number
  query: string
  category: ItemCategory
  onQueryChange: (value: string) => void
  onCategoryChange: (value: ItemCategory) => void
  ariaLabel: string
}) {
  const options = categoryOptions(items)
  return <div className="merchant-filter-bar">
    <label className="merchant-search">
      <Search size={16} aria-hidden="true" />
      <span className="sr-only">{ariaLabel}</span>
      <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Найти предмет" aria-label={ariaLabel} />
      {query && <button type="button" className="merchant-search-clear" onClick={() => onQueryChange('')} aria-label="Очистить поиск" title="Очистить поиск"><X size={14} /></button>}
    </label>
    <div className="merchant-categories" role="group" aria-label="Категория предмета">
      {options.map((option) => <button
        key={option.id}
        type="button"
        className={option.id === category ? 'active' : ''}
        aria-pressed={option.id === category}
        onClick={() => onCategoryChange(option.id)}
      >{option.label}<b>{option.count}</b></button>)}
    </div>
    <span className="merchant-filter-count" aria-live="polite">{visibleCount} из {items.length}</span>
  </div>
}

function MerchantItemArtwork({ item, name }: { item: ItemImageInput; name: string }) {
  const image = itemImageFor(item)
  return <div className={`merchant-item-art${image ? '' : ' neutral'}`} role={image ? undefined : 'img'} aria-label={image ? undefined : `Предмет: ${name}`}>
    {image
      ? <img src={image} alt={name} style={{ objectPosition: item.imagePosition ?? 'center' }} />
      : <PackageOpen size={22} />}
  </div>
}

const coinLabels = [
  ['platinum', 'пм'],
  ['gold', 'зм'],
  ['silver', 'см'],
  ['copper', 'мм'],
] as const

/**
 * Цена монетами, а не дробью. Раньше 55 медяков показывались как «5,5 см» —
 * это читается сантиметрами и вдобавок предлагает половину серебряной монеты,
 * которой не существует. Правильно разложить по номиналам: «5 см 5 мм».
 */
function formatCopper(value?: number) {
  if (!Number.isFinite(value)) return '—'
  const cp = Math.max(0, Math.round(value ?? 0))
  if (cp === 0) return '0 мм'
  const parts: string[] = []
  const gold = Math.floor(cp / 100)
  const silver = Math.floor((cp % 100) / 10)
  const copper = cp % 10
  const number = (amount: number) => new Intl.NumberFormat('ru-RU').format(amount)
  if (gold) parts.push(`${number(gold)} зм`)
  if (silver) parts.push(`${silver} см`)
  if (copper) parts.push(`${copper} мм`)
  return parts.join(' ')
}

function percentage(value?: number) {
  if (!Number.isFinite(value)) return 'без поправки'
  const normalized = Number(value)
  if (normalized === 0) return 'без поправки'
  return `${normalized > 0 ? '+' : ''}${normalized}%`
}

function quoteTotal(quote: MerchantQuote | undefined, quantity: number) {
  if (!quote || !Number.isFinite(quote.unit_price_cp)) return null
  return Math.max(0, Math.round(quote.unit_price_cp)) * Math.max(1, Math.floor(quantity || 1))
}

function QuoteBreakdown({ quote, quantity, direction }: { quote?: MerchantQuote; quantity: number; direction: 'buy' | 'sell' }) {
  if (!quote || quote.unit_price_cp <= 0) return <div className="merchant-no-quote">Торговец пока не назвал цену</div>
  const breakdown = quote.breakdown
  const total = quoteTotal(quote, quantity)
  return (
    <div className="merchant-quote">
      {breakdown && <details className="merchant-price-details">
        <summary>Как рассчитана цена</summary>
        <div className="merchant-price-flow" aria-label="Расшифровка цены">
        <span><small>{quote.price_provenance === 'server_appraisal_policy' ? 'ОЦЕНКА ТОРГОВЦА' : 'ОБЫЧНАЯ ЦЕНА'}</small><b>{formatCopper(breakdown.catalog_base_unit_cp)}</b></span>
        <i>→</i>
        <span><small>ПОЛИТИКА ТОРГОВЦА</small><b>{percentage(breakdown.merchant_adjustment_percent)}</b></span>
        <i>→</i>
        <span><small>РЕЗУЛЬТАТ ТОРГА</small><b>{percentage(breakdown.bargain_adjustment_percent)}</b></span>
        {/* Слава показывается только когда она на что-то влияет: у торговца
            без фракций поправка нулевая, и лишний шаг цепочки её бы удлинял
            без смысла. */}
        {Boolean(breakdown.reputation_adjustment_percent) && <>
          <i>→</i>
          <span title="Поправка за славу отряда у фракций этого торговца"><small>СЛАВА ОТРЯДА</small><b>{percentage(breakdown.reputation_adjustment_percent)}</b></span>
        </>}
        {/* Скидка скупщика. Шаг появляется ровно там, где он есть: у честного
            торговца краденое вообще не доходит до котировки, а у скупщика
            цепочка обязана объяснить, почему вещь стоит меньше обычного, —
            иначе разбор цены не сходится, и скидка читается как ошибка. */}
        {Boolean(breakdown.stolen_adjustment_percent) && <>
          <i>→</i>
          <span className="merchant-stolen-step" title="Скупщик берёт чужую вещь дешевле обычного — и не задаёт вопросов"><small>КРАДЕНОЕ</small><b>{percentage(breakdown.stolen_adjustment_percent)}</b></span>
        </>}
        <i>→</i>
        <span className="merchant-final-price"><small>ЦЕНА ЗА 1</small><b>{formatCopper(breakdown.final_unit_price_cp)}</b></span>
        </div>
      </details>}
      {!breakdown && <p className="merchant-price-note">Сервер не передал подробную раскладку этой котировки.</p>}
      <div className="merchant-quote-summary" aria-live="polite">
        <span><small>ЦЕНА ЗА 1</small><strong>{formatCopper(quote.unit_price_cp)}</strong></span>
        <span><small>{direction === 'buy' ? 'К СПИСАНИЮ' : 'К ПОЛУЧЕНИЮ'} · {Math.max(1, quantity)} шт.</small><strong>{formatCopper(total ?? undefined)}</strong></span>
      </div>
    </div>
  )
}

function QuantityPicker({ value, max, disabled, onChange }: { value: number; max: number; disabled: boolean; onChange: (quantity: number) => void }) {
  return <label className="merchant-quantity">
    <span>КОЛИЧЕСТВО</span>
    <input
      type="number"
      min={1}
      max={Math.max(1, max)}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Math.min(Math.max(1, Math.floor(Number(event.target.value) || 1)), Math.max(1, max)))}
    />
  </label>
}

/** Оболочка лавки: затемнение, закрытие по Escape и по клику мимо окна. */
function MerchantShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null)
  // Обработчик держим в ref: onClose приходит новой стрелкой на каждый рендер
  // родителя, и без этого эффект перезапускался бы постоянно, забирая фокус из
  // поля количества прямо во время набора.
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    let focusFrame = 0
    const focusFirst = () => {
      const root = panel.current
      if (!root) return
      const first = root.querySelector<HTMLElement>(focusSelector)
      const target = first ?? root
      target.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const root = panel.current
      if (!root) return
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(focusSelector)).filter((element) => element.offsetParent !== null)
      if (!focusable.length) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!root.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    // Фокус переносим в окно один раз при открытии: иначе Tab уводит по кнопкам
    // комнаты под затемнением, а с клавиатуры лавка недостижима.
    focusFrame = window.requestAnimationFrame(focusFirst)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  return <div className="merchant-backdrop" onMouseDown={() => close.current()}>
    <section ref={panel} tabIndex={-1} className="merchant-page merchant-modal" role="dialog" aria-modal="true" aria-label="Торговля" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="merchant-close icon-button" onClick={onClose} aria-label="Закрыть лавку" title="Закрыть лавку (Escape)"><X size={18} /></button>
      {children}
    </section>
  </div>
}

export function MerchantScreen({ merchant, player, sceneLocation, stateVersion, view, narration, busy, error, onLoad, onBargain, onBuy, onSell, onAppraise, onService, onClose }: MerchantScreenProps) {
  const [tab, setTab] = useState<MerchantTab>('buy')
  const [buyQuery, setBuyQuery] = useState('')
  const [buyCategory, setBuyCategory] = useState<ItemCategory>('all')
  const [sellQuery, setSellQuery] = useState('')
  const [sellCategory, setSellCategory] = useState<ItemCategory>('all')
  const [buyQuantities, setBuyQuantities] = useState<Record<string, number>>({})
  const [sellQuantities, setSellQuantities] = useState<Record<string, number>>({})
  const lastAutoLoadKey = useRef('')

  useEffect(() => {
    setTab('buy')
    setBuyQuery('')
    setBuyCategory('all')
    setSellQuery('')
    setSellCategory('all')
    setBuyQuantities({})
    setSellQuantities({})
    lastAutoLoadKey.current = ''
  }, [merchant.id])

  const quotedVersion = Number(view?.expected_state_version ?? view?.state_version)
  const viewMatchesContext = view?.merchant.id === merchant.id
    && view.actor_id === player.id
    && Number.isInteger(quotedVersion)
    && quotedVersion >= stateVersion
  const serverView = viewMatchesContext ? view : null
  const shownMerchant = serverView?.merchant ?? merchant

  useEffect(() => {
    const autoLoadKey = `${sceneLocation}\0${stateVersion}\0${merchant.id}\0${player.id}`
    // Ответ сделки уже содержит свежую витрину: повторный GET стёр бы её реплику.
    if (lastAutoLoadKey.current && viewMatchesContext) {
      lastAutoLoadKey.current = autoLoadKey
      return
    }
    // Даже совпадающая с контекстом старая котировка обновляется один раз при
    // открытии: рядом с ней мог сохраниться уже неактуальный merchantError.
    if (!busy && lastAutoLoadKey.current !== autoLoadKey) {
      lastAutoLoadKey.current = autoLoadKey
      onLoad(merchant.id, player.id)
    }
  }, [busy, merchant.id, onLoad, player.id, sceneLocation, stateVersion, viewMatchesContext])

  const currency = serverView?.balance ?? player.currency
  const balanceCp = serverView?.balance_cp ?? currency.copper + currency.silver * 10 + currency.gold * 100 + currency.platinum * 1000
  const merchantPurseCp = serverView?.merchant_purse_cp ?? shownMerchant.purse_cp
  const stock = shownMerchant.stock
  const inventory = player.inventory
  const serviceQuotes = serverView?.service_quotes ?? []
  const buyQuoteById = useMemo(() => new Map((serverView?.buy_quotes ?? []).map((quote) => [quote.stock_id, quote])), [serverView?.buy_quotes])
  const sellQuoteById = useMemo(() => new Map((serverView?.sell_quotes ?? []).map((quote) => [quote.item_id, quote])), [serverView?.sell_quotes])
  const visibleStock = useMemo(() => stock.filter((item) => itemMatchesFilter(item, normalizeQuery(buyQuery), buyCategory)), [buyCategory, buyQuery, stock])
  const visibleInventory = useMemo(() => inventory.filter((item) => itemMatchesFilter(item, normalizeQuery(sellQuery), sellCategory)), [inventory, sellCategory, sellQuery])
  const controlsDisabled = busy || Boolean(error) || shownMerchant.available !== true || !serverView
  const bargainAttempted = Boolean(serverView?.bargain?.attempted)
  const pricingExplanation = humanPricingExplanation(serverView?.pricing_explanation, shownMerchant.pricing.description)
  const serviceCount = serverView ? serviceQuotes.length : shownMerchant.services?.length ?? 0
  const tabOrder: MerchantTab[] = ['buy', 'sell', 'services']
  const moveTab = (current: MerchantTab, direction: 1 | -1) => {
    const index = tabOrder.indexOf(current)
    setTab(tabOrder[(index + direction + tabOrder.length) % tabOrder.length])
  }
  const emptyFiltered = (kind: 'buy' | 'sell') => <div className="merchant-filter-empty">
    <Search size={23} />
    <b>Ничего не найдено</b>
    <span>{kind === 'buy' ? 'Измените запрос или выберите другую категорию.' : 'Измените запрос или категорию инвентаря.'}</span>
    <button type="button" onClick={() => kind === 'buy' ? (setBuyQuery(''), setBuyCategory('all')) : (setSellQuery(''), setSellCategory('all'))}>Сбросить фильтры</button>
  </div>

  const renderService = (quote: MerchantServiceQuote) => {
    const refusal = !quote.available ? (quote.unavailable_reason || 'Услуга сейчас недоступна') : !quote.can_afford ? 'Недостаточно монет' : ''
    return <article className="merchant-item merchant-service-item" key={`service:${quote.service_id}`}>
      <div className="merchant-item-title">
        <div className="merchant-item-art neutral" role="img" aria-label={`Услуга: ${quote.service.name}`}><ScrollText size={21} /></div>
        <span>
          <small>Услуга · {serviceKindLabels[quote.service.kind]}</small>
          <h3>{quote.service.name}</h3>
          <p>{quote.service.description || `Продолжительность: ${quote.service.duration_minutes} мин.`}</p>
        </span>
        <em className={`merchant-item-state ${refusal ? 'warning' : 'available'}`}>{refusal || `${quote.service.duration_minutes} мин.`}</em>
      </div>
      <div className="merchant-quote">
        <div className="merchant-transaction-total" aria-live="polite"><span>К СПИСАНИЮ</span><b><strong>{formatCopper(quote.price_cp)}</strong></b></div>
      </div>
      <div className="merchant-item-actions">
        <span>{refusal && <em className="merchant-refusal">{refusal}</em>}</span>
        {/* Запрет обязан объясняться причиной, а не молчаливо неактивной
            кнопкой: сервер присылает её вместе с котировкой. */}
        <button
          type="button"
          onClick={() => onService(shownMerchant.id, player.id, quote.service_id)}
          disabled={controlsDisabled || !quote.available || !quote.can_afford}
          title={refusal || undefined}
        >
          <ScrollText size={15} />{!quote.available ? 'Отказано' : !quote.can_afford ? 'Недостаточно монет' : `Заказать · ${formatCopper(quote.price_cp)}`}
        </button>
      </div>
    </article>
  }

  return <MerchantShell onClose={onClose}>
    <header className="merchant-page-head">
      <h1>Лавка: {shownMerchant.name}</h1>
      <div className="merchant-location"><MapPin size={15} /><span><small>ТЕКУЩАЯ ЛОКАЦИЯ</small><b>{sceneLocation}</b></span></div>
    </header>

    {!shownMerchant.available && <div className="merchant-mode-warning" role="status"><CircleAlert size={17} /><div><b>Торговец сейчас недоступен</b><p>Покупка, продажа и торг заблокированы до возвращения NPC в текущую сцену.</p></div></div>}
    {error && <div className="merchant-error" role="alert"><CircleAlert size={15} /><span>{error}</span><button type="button" onClick={() => onLoad(shownMerchant.id, player.id)} disabled={busy || !shownMerchant.available}><RefreshCw size={13} />Повторить</button></div>}

    <div className="merchant-layout">
      <aside className="merchant-profile">
        <div className="merchant-avatar">{shownMerchant.portrait ? <img src={shownMerchant.portrait} alt="" /> : <span>{shownMerchant.initials ?? shownMerchant.name.slice(0, 2).toLocaleUpperCase('ru')}</span>}<i className={shownMerchant.available ? 'available' : 'unavailable'} /></div>
        <span className={`merchant-status ${shownMerchant.available ? '' : 'unavailable'}`}><BadgeCheck size={12} />{shownMerchant.available ? 'ДОСТУПЕН В ЭТОЙ СЦЕНЕ' : 'ТОРГОВЕЦ УЖЕ НЕДОСТУПЕН'}</span>
        <h2>{shownMerchant.name}</h2>
        <small>{shownMerchant.title || 'Торговец'}</small>
        <p>{shownMerchant.description || 'NPC готов обсудить товары и услуги в этой сцене.'}</p>
        <blockquote><MessageBubble />{narration || shownMerchant.greeting || 'Торговец молча раскладывает товар на прилавке.'}</blockquote>
        <div className="merchant-policy">
          <ScrollText size={16} /><span><b>Как формируется цена</b><p>{pricingExplanation}</p></span>
        </div>
        <button type="button" className="merchant-bargain" onClick={() => onBargain(shownMerchant.id, player.id)} disabled={controlsDisabled || bargainAttempted}>
          {busy ? <LoaderCircle className="spinning" size={16} /> : <Sparkles size={16} />}{busy ? 'Торговец отвечает…' : bargainAttempted ? 'Условия торга определены' : 'Попробовать поторговаться'}
        </button>
        {serverView?.bargain?.attempted && <div className={`merchant-bargain-result ${serverView.bargain.success ? 'success' : 'failure'}`}>
          <b>{serverView.bargain.success ? 'Торг удался' : 'Торг не удался'}</b>
          <span>{serverView.bargain.message || (serverView.bargain.discount_percent ? `Изменение цены: ${serverView.bargain.discount_percent}%` : 'Торговец оставил прежние условия.')}</span>
        </div>}
      </aside>

      <div className="merchant-market">
        <div className="merchant-wallet">
          <div><Coins size={20} /><span><small>Кошелёк · {player.character}</small><b>{new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(balanceCp / 100)} зм всего</b></span></div>
          <div className="merchant-purse"><HandCoins size={18} /><span><small>Касса торговца</small><b>{formatCopper(merchantPurseCp)}</b></span></div>
          <div className="merchant-coins">{coinLabels.map(([coin, label]) => <span key={coin}><b>{currency[coin]}</b><small>{label}</small></span>)}</div>
          <button type="button" onClick={() => onLoad(shownMerchant.id, player.id)} disabled={busy || !shownMerchant.available}><RefreshCw className={busy ? 'spinning' : ''} size={14} />Обновить котировки</button>
        </div>

        <div className="merchant-tabs" role="tablist" aria-label="Торговые операции">
          <button type="button" id="merchant-buy-tab" role="tab" tabIndex={tab === 'buy' ? 0 : -1} aria-selected={tab === 'buy'} aria-controls="merchant-buy-panel" className={tab === 'buy' ? 'active' : ''} onClick={() => setTab('buy')} onKeyDown={(event) => { if (event.key === 'ArrowRight') moveTab('buy', 1); if (event.key === 'ArrowLeft') moveTab('buy', -1) }}><ShoppingBag size={15} />Покупка <b>{stock.length}</b></button>
          <button type="button" id="merchant-sell-tab" role="tab" tabIndex={tab === 'sell' ? 0 : -1} aria-selected={tab === 'sell'} aria-controls="merchant-sell-panel" className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')} onKeyDown={(event) => { if (event.key === 'ArrowRight') moveTab('sell', 1); if (event.key === 'ArrowLeft') moveTab('sell', -1) }}><HandCoins size={15} />Продажа <b>{inventory.length}</b></button>
          <button type="button" id="merchant-services-tab" role="tab" tabIndex={tab === 'services' ? 0 : -1} aria-selected={tab === 'services'} aria-controls="merchant-services-panel" className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')} onKeyDown={(event) => { if (event.key === 'ArrowRight') moveTab('services', 1); if (event.key === 'ArrowLeft') moveTab('services', -1) }}><ScrollText size={15} />Услуги <b>{serviceCount}</b></button>
        </div>

        {busy && !serverView ? <div className="merchant-loading"><LoaderCircle className="spinning" size={24} /><b>Торговец пересчитывает цены…</b><span>Получаем серверные котировки для {player.character}.</span></div> : tab === 'buy' ? (
          <section id="merchant-buy-panel" className="merchant-tab-panel" role="tabpanel" aria-labelledby="merchant-buy-tab">
            {stock.length > 0 && <MerchantFilters items={stock} visibleCount={visibleStock.length} query={buyQuery} category={buyCategory} onQueryChange={setBuyQuery} onCategoryChange={setBuyCategory} ariaLabel="Поиск товаров для покупки" />}
            {stock.length === 0 ? <div className="merchant-list-empty"><PackageOpen size={28} /><b>Прилавок пуст</b><span>У торговца закончились товары или сервер ещё не открыл склад.</span></div> : visibleStock.length === 0 ? emptyFiltered('buy') : <div className="merchant-items">{visibleStock.map((item) => {
            const quote = buyQuoteById.get(item.stock_id)
            const stockAvailable = Math.max(0, quote?.available_quantity ?? item.quantity)
            const purchaseMax = Math.max(0, Math.min(stockAvailable, quote?.max_quantity ?? stockAvailable))
            const quantity = Math.min(buyQuantities[item.stock_id] ?? 1, Math.max(1, purchaseMax))
            // Отказ лавки объявляет сервер и объявляет причиной: розыск, дурная
            // слава. Без этой ветки герой с полным кошелём читал «Недостаточно
            // монет» — `max_quantity` при отказе равен нулю, и кнопка сваливалась
            // в денежный текст, ни разу не назвав настоящую причину.
            const tradeRefusal = quote?.can_buy === false ? (quote.unavailable_reason || 'Торговец отказывает отряду') : ''
            const stateLabel = tradeRefusal || !quote ? 'Нет котировки' : stockAvailable < 1 ? 'Нет в наличии' : quote.can_afford === false || purchaseMax < 1 ? 'Недостаточно монет' : `${stockAvailable} в наличии`
            return <article className="merchant-item" key={item.stock_id}>
              <div className="merchant-item-title"><MerchantItemArtwork item={item} name={item.name} /><span><small>{categoryLabel(item.type)}{item.rarity ? ` · ${item.rarity}` : ''}</small><h3>{item.name}</h3><p>{item.description || 'Описание предмета не указано.'}</p></span><em className={`merchant-item-state ${tradeRefusal || !quote || stockAvailable < 1 || quote.can_afford === false ? 'warning' : 'available'}`}>{stateLabel}</em></div>
              <QuoteBreakdown quote={quote} quantity={quantity} direction="buy" />
              {tradeRefusal && <p className="merchant-refusal">{tradeRefusal}</p>}
              <div className="merchant-item-actions">
                <QuantityPicker value={quantity} max={purchaseMax} disabled={controlsDisabled || !quote || purchaseMax < 1 || quote.can_buy === false} onChange={(next) => setBuyQuantities((values) => ({ ...values, [item.stock_id]: next }))} />
                <button type="button" onClick={() => onBuy(shownMerchant.id, player.id, item.stock_id, quantity)} disabled={controlsDisabled || !quote || purchaseMax < 1 || quote.can_afford === false || quote.can_buy === false} title={tradeRefusal || undefined}><ShoppingBag size={15} />{!quote ? 'Нет котировки' : tradeRefusal ? 'Отказано' : stockAvailable < 1 ? 'Нет в наличии' : quote.can_afford === false || purchaseMax < 1 ? 'Недостаточно монет' : `Купить · ${formatCopper(quoteTotal(quote, quantity) ?? undefined)}`}</button>
              </div>
            </article>
          })}</div>}
          </section>
        ) : tab === 'sell' ? (
          <section id="merchant-sell-panel" className="merchant-tab-panel" role="tabpanel" aria-labelledby="merchant-sell-tab">
            {inventory.length > 0 && <MerchantFilters items={inventory} visibleCount={visibleInventory.length} query={sellQuery} category={sellCategory} onQueryChange={setSellQuery} onCategoryChange={setSellCategory} ariaLabel="Поиск предметов в инвентаре" />}
            {inventory.length === 0 ? <div className="merchant-list-empty"><PackageOpen size={28} /><b>Нечего продавать</b><span>В инвентаре героя пока нет предметов.</span></div> : visibleInventory.length === 0 ? emptyFiltered('sell') : <div className="merchant-items">{visibleInventory.map((item) => {
            const quote = sellQuoteById.get(item.id)
            const maximumCandidates = [item.quantity, quote?.available_quantity, quote?.max_quantity].filter((value): value is number => Number.isFinite(value))
            const maximum = Math.max(0, maximumCandidates.length ? Math.min(...maximumCandidates) : 0)
            const quantity = Math.max(1, Math.min(sellQuantities[item.id] ?? 1, Math.max(1, maximum)))
            const canSell = quote?.can_sell !== false
            const appraisalRequired = quote?.appraisal_required === true
            const canAppraise = appraisalRequired && quote?.can_appraise === true
            const merchantCanAfford = quote?.can_afford !== false
            // Причин отказа две, и они про разное: `unavailable_reason` — про
            // отряд (розыск, слава), `reason` — про сам предмет (надет, сюжетный,
            // не оценён). Витрина читала только вторую, поэтому отказ по розыску
            // не показывался вовсе.
            const sellRefusal = quote?.unavailable_reason || quote?.reason || ''
            const stateLabel = !quote ? 'Нет котировки' : appraisalRequired ? 'Нужна оценка' : sellRefusal || !canSell ? 'Не принимает' : !merchantCanAfford ? 'У торговца нет монет' : `${maximum} доступно`
            return <article className="merchant-item" key={item.id}>
              <div className="merchant-item-title"><MerchantItemArtwork item={item} name={item.name} /><span><small>{categoryLabel(item.type)} · в инвентаре: {item.quantity}{item.rarity ? ` · ${item.rarity}` : ''}</small><h3>{item.name}</h3><p>{item.description || 'Описание предмета не указано.'}</p></span><em className={`merchant-item-state ${item.equipped || !quote || appraisalRequired || sellRefusal || !canSell || !merchantCanAfford ? 'warning' : 'available'}`}>{item.equipped ? 'Надето' : stateLabel}</em></div>
              {appraisalRequired
                ? <div className="merchant-appraisal-note"><Search size={16} /><span><b>Нужна серверная оценка</b><small>Торговец осмотрит предмет, а цену рассчитает правило кампании.</small></span></div>
                : <QuoteBreakdown quote={quote} quantity={quantity} direction="sell" />}
              {sellRefusal && <p className="merchant-refusal">{sellRefusal}</p>}
              <div className="merchant-item-actions">
                {canAppraise
                  ? <><span className="merchant-appraisal-hint">Цена будет записана в состояние мира</span><button type="button" onClick={() => onAppraise(shownMerchant.id, player.id, item.id)} disabled={controlsDisabled}><Search size={15} />{busy ? 'Оценивает…' : 'Оценить'}</button></>
                  : appraisalRequired
                    ? <span className="merchant-appraisal-hint">{sellRefusal || 'Оценка сейчас недоступна'}</span>
                    : <><QuantityPicker value={quantity} max={maximum} disabled={controlsDisabled || !quote || !canSell || !merchantCanAfford || maximum < 1} onChange={(next) => setSellQuantities((values) => ({ ...values, [item.id]: next }))} />
                      <button type="button" onClick={() => onSell(shownMerchant.id, player.id, item.id, quantity)} disabled={controlsDisabled || !quote || !canSell || !merchantCanAfford || maximum < 1} title={canSell ? undefined : (sellRefusal || undefined)}><HandCoins size={15} />{!quote ? 'Нет котировки' : sellRefusal ? 'Отказано' : !merchantCanAfford ? 'У торговца нет монет' : canSell && maximum > 0 ? `Продать · ${formatCopper(quoteTotal(quote, quantity) ?? undefined)}` : 'Не покупает'}</button></>}
              </div>
            </article>
          })}</div>}
          </section>
        ) : (
          <section id="merchant-services-panel" className="merchant-tab-panel" role="tabpanel" aria-labelledby="merchant-services-tab">
            {serviceQuotes.length > 0 ? <div className="merchant-items">{serviceQuotes.map(renderService)}</div> : <div className="merchant-list-empty"><ScrollText size={28} /><b>Услуг сейчас нет</b><span>В этой сцене торговец не предлагает доступных услуг.</span></div>}
          </section>
        )}
      </div>
    </div>
  </MerchantShell>
}

function MessageBubble() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M7 17.5 3.5 20l1.2-4.3A8 8 0 1 1 7 17.5Z" /></svg>
}
