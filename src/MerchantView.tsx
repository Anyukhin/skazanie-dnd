import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BadgeCheck, CircleAlert, Coins, HandCoins, LoaderCircle, MapPin,
  PackageOpen, RefreshCw, ScrollText, Search, ShieldCheck, ShoppingBag, Sparkles, X,
} from 'lucide-react'
import { itemImageFor, type ItemImageInput } from './item-images'
import type { Merchant, MerchantQuote, MerchantView as MerchantViewModel, Player } from './types'

type MerchantScreenProps = {
  merchants: Merchant[]
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
      {breakdown ? <div className="merchant-price-flow" aria-label="Расшифровка цены">
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
        <i>→</i>
        <span className="merchant-final-price"><small>ЦЕНА ЗА 1</small><b>{formatCopper(breakdown.final_unit_price_cp)}</b></span>
      </div> : <div className="merchant-price-flow compact">
        <span className="merchant-final-price"><small>ЦЕНА ЗА 1</small><b>{formatCopper(quote.unit_price_cp)}</b></span>
        <p>Сервер не передал подробную раскладку этой котировки.</p>
      </div>}
      <div className="merchant-transaction-total" aria-live="polite">
        <span>{direction === 'buy' ? 'К СПИСАНИЮ' : 'К ПОЛУЧЕНИЮ'}</span>
        <b><small>{formatCopper(quote.unit_price_cp)}</small><i>×</i><small>{Math.max(1, quantity)}</small><i>=</i><strong>{formatCopper(total ?? undefined)}</strong></b>
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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    // Фокус переносим в окно один раз при открытии: иначе Tab уводит по кнопкам
    // комнаты под затемнением, а с клавиатуры лавка недостижима.
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <div className="merchant-backdrop" onMouseDown={() => close.current()}>
    <section ref={panel} tabIndex={-1} className="merchant-page merchant-modal" role="dialog" aria-modal="true" aria-label="Торговля" onMouseDown={(event) => event.stopPropagation()}>
      <button className="merchant-close icon-button" onClick={onClose} aria-label="Закрыть лавку" title="Закрыть лавку (Escape)"><X size={18} /></button>
      {children}
    </section>
  </div>
}

export function MerchantScreen({ merchants, player, sceneLocation, stateVersion, view, narration, busy, error, onLoad, onBargain, onBuy, onSell, onAppraise, onService, onClose }: MerchantScreenProps) {
  const [tab, setTab] = useState<'buy' | 'sell'>('buy')
  const [selectedMerchantId, setSelectedMerchantId] = useState(merchants[0]?.id ?? '')
  const [buyQuantities, setBuyQuantities] = useState<Record<string, number>>({})
  const [sellQuantities, setSellQuantities] = useState<Record<string, number>>({})
  const lastAutoLoadKey = useRef('')

  useEffect(() => {
    if (!merchants.some((merchant) => merchant.id === selectedMerchantId)) setSelectedMerchantId(merchants[0]?.id ?? '')
  }, [merchants, selectedMerchantId])

  const selectedMerchant = merchants.find((merchant) => merchant.id === selectedMerchantId) ?? merchants[0]
  const quotedVersion = Number(view?.expected_state_version ?? view?.state_version)
  const viewMatchesContext = view?.merchant.id === selectedMerchant?.id
    && view.actor_id === player.id
    && Number.isInteger(quotedVersion)
    && quotedVersion >= stateVersion
  const serverView = viewMatchesContext ? view : null
  const shownMerchant = serverView?.merchant ?? selectedMerchant

  useEffect(() => {
    const autoLoadKey = `${sceneLocation}\0${stateVersion}\0${selectedMerchant?.id ?? ''}\0${player.id}`
    if (viewMatchesContext) lastAutoLoadKey.current = autoLoadKey
    if (selectedMerchant?.id && !busy && !viewMatchesContext && lastAutoLoadKey.current !== autoLoadKey) {
      lastAutoLoadKey.current = autoLoadKey
      onLoad(selectedMerchant.id, player.id)
    }
  }, [busy, onLoad, player.id, sceneLocation, selectedMerchant?.id, stateVersion, viewMatchesContext])

  const currency = serverView?.balance ?? player.currency
  const balanceCp = serverView?.balance_cp ?? currency.copper + currency.silver * 10 + currency.gold * 100 + currency.platinum * 1000
  const merchantPurseCp = serverView?.merchant_purse_cp ?? shownMerchant?.purse_cp
  const stock = shownMerchant?.stock ?? []
  const buyQuoteById = useMemo(() => new Map((serverView?.buy_quotes ?? []).map((quote) => [quote.stock_id, quote])), [serverView?.buy_quotes])
  const sellQuoteById = useMemo(() => new Map((serverView?.sell_quotes ?? []).map((quote) => [quote.item_id, quote])), [serverView?.sell_quotes])
  const controlsDisabled = busy || Boolean(error) || shownMerchant?.available !== true || !serverView
  const bargainAttempted = Boolean(serverView?.bargain?.attempted)

  if (!shownMerchant) return <MerchantShell onClose={onClose}>
    <div className="merchant-empty-state"><ShoppingBag size={38} /><span>ТОРГОВАЯ ПЛОЩАДКА</span><h1>Здесь сейчас нет торговцев</h1><p>Торговое меню появляется только рядом с доступным NPC. Текущая локация: «{sceneLocation}».</p></div>
  </MerchantShell>

  return <MerchantShell onClose={onClose}>
    <header className="merchant-page-head">
      <div><span>ТОРГОВЛЯ И ПЕРЕГОВОРЫ</span><h1>Лавка в пути</h1><p>Товар разложен, цена названа. Поторгуйтесь — или идите дальше.</p></div>
      <div className="merchant-location"><MapPin size={15} /><span><small>ТЕКУЩАЯ ЛОКАЦИЯ</small><b>{sceneLocation}</b></span></div>
    </header>

    {!shownMerchant.available && <div className="merchant-mode-warning" role="status"><CircleAlert size={17} /><div><b>Торговец сейчас недоступен</b><p>Покупка, продажа и торг заблокированы до возвращения NPC в текущую сцену.</p></div></div>}
    {error && <div className="merchant-error" role="alert"><CircleAlert size={15} /><span>{error}</span><button onClick={() => onLoad(shownMerchant.id, player.id)} disabled={busy || !shownMerchant.available}><RefreshCw size={13} />Повторить</button></div>}

    {merchants.length > 1 && <div className="merchant-selector" aria-label="Доступные торговцы">
      {merchants.map((merchant) => <button key={merchant.id} className={merchant.id === shownMerchant.id ? 'active' : ''} disabled={busy} onClick={() => setSelectedMerchantId(merchant.id)}>{merchant.name}</button>)}
    </div>}

    <div className="merchant-layout">
      <aside className="merchant-profile">
        <div className="merchant-avatar">{shownMerchant.portrait ? <img src={shownMerchant.portrait} alt="" /> : <span>{shownMerchant.initials ?? shownMerchant.name.slice(0, 2).toLocaleUpperCase('ru')}</span>}<i className="available" /></div>
        <span className={`merchant-status ${shownMerchant.available ? '' : 'unavailable'}`}><BadgeCheck size={12} />{shownMerchant.available ? 'ДОСТУПЕН В ЭТОЙ СЦЕНЕ' : 'ТОРГОВЕЦ УЖЕ НЕДОСТУПЕН'}</span>
        <h2>{shownMerchant.name}</h2>
        <small>{shownMerchant.title}</small>
        <p>{shownMerchant.description}</p>
        <blockquote><MessageBubble />{narration || shownMerchant.greeting || 'Торговец молча раскладывает товар на прилавке.'}</blockquote>
        <div className="merchant-policy">
          <ScrollText size={16} /><span><b>Как формируется цена</b><p>{serverView?.pricing_explanation || shownMerchant.pricing.description || 'Обычная цена товара, надбавка лавки и то, о чём удалось договориться.'}</p></span>
        </div>
        <button className="merchant-bargain" onClick={() => onBargain(shownMerchant.id, player.id)} disabled={controlsDisabled || bargainAttempted}>
          {busy ? <LoaderCircle className="spinning" size={16} /> : <Sparkles size={16} />}{busy ? 'Торговец отвечает…' : bargainAttempted ? 'Условия торга определены' : 'Попробовать поторговаться'}
        </button>
        {serverView?.bargain?.attempted && <div className={`merchant-bargain-result ${serverView.bargain.success ? 'success' : 'failure'}`}>
          <b>{serverView.bargain.success ? 'Торг удался' : 'Торг не удался'}</b>
          <span>{serverView.bargain.message || (serverView.bargain.discount_percent ? `Изменение цены: ${serverView.bargain.discount_percent}%` : 'Торговец оставил прежние условия.')}</span>
        </div>}
      </aside>

      <div className="merchant-market">
        <div className="merchant-wallet">
          <div><Coins size={20} /><span><small>КОШЕЛЁК · {player.character}</small><b>{new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(balanceCp / 100)} зм всего</b></span></div>
          <div className="merchant-purse"><HandCoins size={18} /><span><small>КАССА ТОРГОВЦА</small><b>{formatCopper(merchantPurseCp)}</b></span></div>
          <div className="merchant-coins">{coinLabels.map(([coin, label]) => <span key={coin}><b>{currency[coin]}</b><small>{label}</small></span>)}</div>
          <button onClick={() => onLoad(shownMerchant.id, player.id)} disabled={busy || !shownMerchant.available}><RefreshCw className={busy ? 'spinning' : ''} size={14} />Обновить котировки</button>
        </div>

        <div className="merchant-tabs" role="tablist" aria-label="Торговые операции">
          <button role="tab" aria-selected={tab === 'buy'} className={tab === 'buy' ? 'active' : ''} onClick={() => setTab('buy')}><ShoppingBag size={15} />Купить <b>{stock.length}</b></button>
          <button role="tab" aria-selected={tab === 'sell'} className={tab === 'sell' ? 'active' : ''} onClick={() => setTab('sell')}><HandCoins size={15} />Продать <b>{player.inventory.length}</b></button>
        </div>

        {tab === 'buy' && (serverView?.service_quotes?.length ?? 0) > 0 && <div className="merchant-items">
          {serverView?.service_quotes?.map((quote) => <article className="merchant-item" key={`service:${quote.service_id}`}>
            <div className="merchant-item-title">
              <ScrollText size={20} />
              <span>
                <small>УСЛУГА · {quote.service.kind}</small>
                <h3>{quote.service.name}</h3>
                <p>{quote.service.description || `Продолжительность: ${quote.service.duration_minutes} мин.`}</p>
              </span>
              <em>{quote.service.duration_minutes} мин.</em>
            </div>
            <div className="merchant-quote">
                      <div className="merchant-transaction-total"><span>К СПИСАНИЮ</span><b><strong>{formatCopper(quote.price_cp)}</strong></b></div>
            </div>
            <div className="merchant-item-actions">
              <span>{!quote.available && quote.unavailable_reason ? <em className="merchant-refusal">{quote.unavailable_reason}</em> : null}</span>
              {/* Запрет обязан объясняться причиной, а не молчаливо неактивной
                  кнопкой: сервер присылает её вместе с котировкой. */}
              <button
                onClick={() => onService(shownMerchant.id, player.id, quote.service_id)}
                disabled={controlsDisabled || !quote.available || !quote.can_afford}
                title={!quote.available ? (quote.unavailable_reason || 'Услуга сейчас недоступна') : undefined}
              >
                <ScrollText size={15} />{!quote.available ? (quote.unavailable_reason ? 'Отказано' : 'Недоступно') : !quote.can_afford ? 'Недостаточно монет' : `Заказать · ${formatCopper(quote.price_cp)}`}
              </button>
            </div>
          </article>)}
        </div>}

        {busy && !serverView ? <div className="merchant-loading"><LoaderCircle className="spinning" size={24} /><b>Торговец пересчитывает цены…</b><span>Получаем серверные котировки для {player.character}.</span></div> : tab === 'buy' ? (
          stock.length ? <div className="merchant-items">{stock.map((item) => {
            const quote = buyQuoteById.get(item.stock_id)
            const stockAvailable = Math.max(0, quote?.available_quantity ?? item.quantity)
            const purchaseMax = Math.max(0, Math.min(stockAvailable, quote?.max_quantity ?? stockAvailable))
            const quantity = Math.min(buyQuantities[item.stock_id] ?? 1, Math.max(1, purchaseMax))
            // Отказ лавки объявляет сервер и объявляет причиной: розыск, дурная
            // слава. Без этой ветки герой с полным кошелём читал «Недостаточно
            // монет» — `max_quantity` при отказе равен нулю, и кнопка сваливалась
            // в денежный текст, ни разу не назвав настоящую причину.
            const tradeRefusal = quote?.can_buy === false ? (quote.unavailable_reason || 'Торговец отказывает отряду') : ''
            return <article className="merchant-item" key={item.stock_id}>
              <div className="merchant-item-title"><MerchantItemArtwork item={item} name={item.name} /><span><small>{itemTypeLabel(item.type)}</small><h3>{item.name}</h3><p>{item.description}</p></span><em>{stockAvailable} в наличии</em></div>
              <QuoteBreakdown quote={quote} quantity={quantity} direction="buy" />
              {tradeRefusal && <p className="merchant-refusal">{tradeRefusal}</p>}
              <div className="merchant-item-actions">
                <QuantityPicker value={quantity} max={purchaseMax} disabled={controlsDisabled || !quote || purchaseMax < 1} onChange={(next) => setBuyQuantities((values) => ({ ...values, [item.stock_id]: next }))} />
                <button onClick={() => onBuy(shownMerchant.id, player.id, item.stock_id, quantity)} disabled={controlsDisabled || !quote || purchaseMax < 1 || quote.can_afford === false} title={tradeRefusal || undefined}><ShoppingBag size={15} />{!quote ? 'Нет котировки' : tradeRefusal ? 'Отказано' : stockAvailable < 1 ? 'Нет в наличии' : quote.can_afford === false || purchaseMax < 1 ? 'Недостаточно монет' : `Купить ×${quantity} · ${formatCopper(quoteTotal(quote, quantity) ?? undefined)}`}</button>
              </div>
            </article>
          })}</div> : <div className="merchant-list-empty"><PackageOpen size={28} /><b>Прилавок пуст</b><span>У торговца закончились товары или сервер ещё не открыл склад.</span></div>
        ) : (
          player.inventory.length ? <div className="merchant-items">{player.inventory.map((item) => {
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
            return <article className="merchant-item" key={item.id}>
              <div className="merchant-item-title"><MerchantItemArtwork item={item} name={item.name} /><span><small>{itemTypeLabel(item.type)} · в инвентаре: {item.quantity}</small><h3>{item.name}</h3><p>{item.description}</p></span>{item.equipped && <em>НАДЕТО</em>}</div>
              {appraisalRequired
                ? <div className="merchant-appraisal-note"><Search size={16} /><span><b>Нужна серверная оценка</b><small>Торговец осмотрит предмет, а цену рассчитает правило кампании.</small></span></div>
                : <QuoteBreakdown quote={quote} quantity={quantity} direction="sell" />}
              {!canSell && sellRefusal && <p className="merchant-refusal">{sellRefusal}</p>}
              <div className="merchant-item-actions">
                {canAppraise
                  ? <><span className="merchant-appraisal-hint">Цена будет записана в состояние мира</span><button onClick={() => onAppraise(shownMerchant.id, player.id, item.id)} disabled={controlsDisabled}><Search size={15} />{busy ? 'Оценивает…' : 'Оценить'}</button></>
                  : <><QuantityPicker value={quantity} max={maximum} disabled={controlsDisabled || !quote || !canSell || maximum < 1} onChange={(next) => setSellQuantities((values) => ({ ...values, [item.id]: next }))} />
                    <button onClick={() => onSell(shownMerchant.id, player.id, item.id, quantity)} disabled={controlsDisabled || !quote || !canSell || maximum < 1} title={canSell ? undefined : (sellRefusal || undefined)}><HandCoins size={15} />{!quote ? 'Нет котировки' : quote.unavailable_reason ? 'Отказано' : !merchantCanAfford ? 'У торговца нет монет' : canSell && maximum > 0 ? `Продать ×${quantity} · ${formatCopper(quoteTotal(quote, quantity) ?? undefined)}` : 'Не покупает'}</button></>}
              </div>
            </article>
          })}</div> : <div className="merchant-list-empty"><PackageOpen size={28} /><b>Нечего продавать</b><span>В инвентаре героя пока нет предметов.</span></div>
        )}
      </div>
    </div>
  </MerchantShell>
}

function MessageBubble() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M7 17.5 3.5 20l1.2-4.3A8 8 0 1 1 7 17.5Z" /></svg>
}
