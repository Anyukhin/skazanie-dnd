/**
 * Подсказки «что можно сделать» — задача 4.2 плана `docs/experience-upgrade-plan.md`.
 *
 * Состав игроков смешанный и плавающий: за столом регулярно сидит тот, кто
 * видит интерфейс впервые и не догадывается, что сундук можно осмотреть, а с
 * трактирщиком — заговорить. Подсказка отвечает ровно на это.
 *
 * Здесь **нет** ни модели, ни промпта, ни новой команды. Функция читает уже
 * спроецированную игроку комнату — ту самую, что и так уехала в браузер, — и
 * собирает из неё короткие строки. Поэтому раскрыть скрытое она не способна по
 * построению: чего нет в проекции, того нет и на входе. Это же и причина, по
 * которой подсказки строятся после проекции, а не до неё.
 *
 * В бою подсказок нет намеренно: там хотбар перечисляет доступные действия
 * точнее любой строки, и вторая подсказка рядом только мешала бы.
 */

import { currencyToCopper } from './merchant-economy.mjs'
import { sceneInteractionCatalogEntry, sceneInteractionRewardKinds, sceneObjectLabelFor } from './scene-interactions.mjs'
import { MIN_BRIBE_CP } from './underworld.mjs'

export const ACTION_HINTS_POLICY_ID = 'skazanie:action-hints-v1'

/** Больше четырёх строк — это уже не подсказка, а инструкция. */
export const MAX_ACTION_HINTS = 4

/**
 * Сколько строк подсказок отдаётся тому, что не обязано быть на панели:
 * реквизиту и приглашению за стол в таверне.
 *
 * Интеракции открылись всей обстановке (задача 3.2b), и предметов на карте
 * таверны стало три десятка. Без этого потолка подсказки превращались в опись
 * мебели — «скамья, метла, сундук, паутина», — вытесняя единственные строки,
 * ради которых панель и заводилась: с кем говорить, куда идти и зачем.
 */
export const MAX_PROP_HINTS = 2

/**
 * Сколько строк достаётся добыче. Две — потому что после боя на полу лежит
 * столько же тел, сколько было противников, и опись трупов вытеснила бы всё
 * остальное ровно так же, как когда-то опись мебели.
 */
export const MAX_LOOT_HINTS = 2

/** Виды реквизита, за которыми сервер держит находку, тайник или знание. */
const REWARD_BEARING_KINDS = new Set(sceneInteractionRewardKinds())

/**
 * На каком расстоянии подсказка называет чужой карман.
 *
 * Своей мерки у кражи нет: движок требует только присутствия человека в сцене
 * (`PickpocketNpc`, `server/rules-engine.mjs`), и запрещать здесь то, что он
 * разрешает, подсказка не вправе. Но и звать обчистить трактирщика через весь
 * зал незачем — строк в панели четыре, а мирных людей в зале бывает пятеро.
 * Пять футов здесь поэтому **отбор**, а не правило: они решают, о ком сказать,
 * а не что разрешено. Померить нечем — считается, что рядом: сцена без доски
 * (разговор в трактире) кражи не запрещает.
 */
export const THEFT_HINT_REACH_FEET = 5

const text = (value, maximum = 120) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/**
 * Глаголы взаимодействия и то, как они звучат за столом. Список закрыт:
 * подсказка обязана называть то, что сервер действительно исполнит, а не
 * «что-нибудь ещё». Незнакомый глагол молча пропускается.
 */
const VERB_PHRASES = Object.freeze({
  inspect: 'осмотреть',
  open: 'открыть',
  take: 'забрать',
  use: 'использовать',
  topple: 'опрокинуть',
  ignite: 'поджечь',
  // `pray` в таблице нет намеренно: у молитвы своя строка (`blessingHints`), и
  // она называет то, чего шаблон «Можно <глагол>: <предмет>» назвать не умеет, —
  // СЛ проверки и суточный предел. Незнакомый глагол здесь молча пропускается,
  // поэтому алтарь по-прежнему предлагают осмотреть, а не «помолиться: Алтарь».
})

/** Порядок предпочтения глаголов: осмотр безопаснее поджога. */
const VERB_ORDER = Object.freeze(['inspect', 'open', 'take', 'use', 'topple', 'ignite'])

/**
 * Порядок строк в панели. Числа сами по себе ничего не значат — значит только
 * их порядок, и он же решает, кто вытеснит кого при нехватке места.
 *
 * Досуг таверны стоит между приметной находкой и рядовой обстановкой: сундук в
 * углу зала он не вытесняет, метлу и скамью — вытесняет. Раньше он занимал
 * слот безусловно, и в трактире про находку не говорили никогда.
 */
const HINT_PRIORITY = Object.freeze({
  tavernRound: 0,
  poiProp: 1,
  leisure: 2,
  // Пришедший ответ на письмо стоит рядом с досугом, а не в брони: это не
  // начатое действие с деньгами на столе, а новость, которую и так видно
  // карточкой в летописи.
  letter: 2,
  prop: 3,
  // Карман, монета и краденое стоят в одной очереди с рядовым реквизитом:
  // это возможность, а не срочность, — тот же ранг, что у запертой двери.
  // Между равными порядок решает идентификатор, и он детерминирован.
  underworld: 3,
  npc: 4,
  objective: 5,
  exit: 6,
})

/** «сундук» → «Сундук». Подсказка — начало фразы, а не середина. */
function capitalized(value) {
  return value ? value[0].toLocaleUpperCase('ru-RU') + value.slice(1) : ''
}

/**
 * Подсказки по реквизиту сцены — самая узкая часть панели.
 *
 * Три ограничения, и каждое поставлено по живому зонду:
 *
 * 1. Вид предмета решает каталог по `assetId`, а не присланное поле, и в
 *    подсказки пускаются только виды с наградой, тайником или знанием.
 *    Обстановка (`furnishing`) не попадает сюда вовсе: клик по доске её и так
 *    показывает, а строкой «можно осмотреть метлу» панель обесценивается.
 * 2. Подпись берётся из каталога подписей. Латинского идентификатора игрок не
 *    увидит никогда: без русской подписи предмет молча пропускается.
 * 3. Порядок детерминирован — приметное вперёд, дальше по идентификатору.
 */
function propHints(room) {
  const props = Array.isArray(room?.scene?.map?.props) ? room.scene.map.props : []
  const hints = []
  for (const prop of props) {
    if (prop?.interactive !== true) continue
    const catalog = sceneInteractionCatalogEntry(prop?.assetId)
    if (!catalog || !REWARD_BEARING_KINDS.has(catalog.kind)) continue
    const label = text(capitalized(sceneObjectLabelFor(prop?.assetId)), 60)
    if (!label) continue
    const verbs = Array.isArray(prop?.interaction?.verbs) ? prop.interaction.verbs.map(String) : catalog.verbs
    const verb = VERB_ORDER.find((candidate) => verbs.includes(candidate))
    if (!verb) continue
    hints.push({
      id: `prop:${text(prop?.id, 80)}:${verb}`,
      // Приметное — вперёд: точка интереса заметнее рядового ящика.
      priority: prop?.interaction?.pointOfInterest === true ? HINT_PRIORITY.poiProp : HINT_PRIORITY.prop,
      text: `Можно ${VERB_PHRASES[verb]}: ${label}`,
    })
  }
  return hints
}

/**
 * Как зовётся обыск каждого вида контейнера. Глагол нужен свой: «обыскать
 * оружие пленного» — это не по-русски, а «Можно обыскать: Тело: Разбойник» из
 * первой редакции ставило двоеточие дважды подряд, потому что вид уже стоял в
 * имени контейнера.
 */
const LOOT_HINT_PHRASES = Object.freeze({
  corpse: 'обыскать тело',
  captive: 'забрать оружие пленного',
  abandoned: 'разобрать брошенное',
  cache: 'вскрыть схрон',
})

/**
 * Добыча в сцене. Идёт первой строкой не по вкусу: свежее тело — то, из-за чего
 * новичок чаще всего уходит со сцены ни с чем, потому что не догадался, что
 * снять с него что-то вообще можно.
 *
 * Подсказка честна про досягаемость: пока герой не дотянулся, сервер не отдал
 * содержимое, и обещать «можно обыскать» было бы неправдой — строка зовёт
 * подойти. Числа при этом не выдумываются: `item_count` уже в проекции, и
 * закрытым он не является.
 */
function lootHints(room) {
  const containers = Array.isArray(room?.loot_containers?.containers) ? room.loot_containers.containers : []
  return containers
    .filter((container) => container?.status !== 'emptied' && Number(container?.item_count) > 0)
    .slice(0, MAX_LOOT_HINTS)
    .flatMap((container) => {
      const name = text(container?.name, 60)
      if (!name) return []
      const phrase = LOOT_HINT_PHRASES[String(container?.kind ?? '')] ?? 'обыскать добычу'
      // Имя контейнера уже начинается с вида («Тело: Разбойник»), поэтому в
      // строку идёт только то, что после двоеточия, — иначе вид повторится.
      const subject = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : ''
      const target = subject ? `${phrase}: ${subject}` : phrase
      return [{
        id: `loot:${text(container?.id, 80)}`,
        priority: 0,
        text: container?.can_inspect === true
          ? `Можно ${target}`
          : `Можно ${target} — надо подойти вплотную`,
      }]
    })
}

/**
 * Живые мирные люди сцены. Один список на все строки, которые их называют:
 * заговорить, обчистить карман, подкрепить слова монетой. Разойдись эти
 * фильтры — и панель звала бы обчистить того, с кем «не о чем говорить».
 */
function peacefulSceneNpcs(room) {
  return (Array.isArray(room?.scene_npcs) ? room.scene_npcs : [])
    .filter((npc) => npc?.alive !== false && npc?.stance !== 'hostile')
}

/** Клетка героя-читателя. Позиция механики главнее листа: по ней ходит доска. */
function heroCell(room, actorId) {
  const id = String(actorId ?? '')
  if (!id) return null
  const position = room?.mechanics?.positions?.[id]
  const hero = (Array.isArray(room?.players) ? room.players : []).find((player) => String(player?.id ?? '') === id)
  const x = Number(position?.x ?? hero?.x)
  const y = Number(position?.y ?? hero?.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Футы между клетками — та же шахматная мерка, что у доски. `null` — не измерить. */
function feetBetween(from, to) {
  const x = Number(to?.x)
  const y = Number(to?.y)
  if (!from || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return Math.max(Math.abs(from.x - x), Math.abs(from.y - y)) * 5
}

/** Герой-читатель в уже спроецированной комнате. */
function readerHero(room, actorId) {
  const id = String(actorId ?? '')
  if (!id) return null
  return (Array.isArray(room?.players) ? room.players : []).find((player) => String(player?.id ?? '') === id) ?? null
}

/**
 * Чужой карман под рукой.
 *
 * Строка одна и достаётся ближайшему: панель на четыре строки, а мирных людей в
 * зале бывает пятеро. Ни СЛ, ни содержимого кармана в ней нет и быть не может —
 * в проекции их нет вовсе (карман выводится из сида, `server/pickpocket.mjs`), и
 * подсказка обещает попытку, а не добычу. Формулировка та же, что у кнопки
 * досье: обе шлют одну свободную фразу и разбираются одним `resolvePickpocket`.
 *
 * Уже обчищенный карман строка назвать может, и это осознанная цена: маркер
 * «здесь побывала чужая рука» проекция снимает намеренно (`publicConditionsFor`,
 * `server/viewer-projection.mjs`), второго источника у подсказки нет, а
 * промолчать вышло бы только ценой утечки того, чего столу знать не положено.
 */
function theftHints(room, actorId) {
  // Строка личная: спрашивают, дотянулась ли рука **этого** героя. Читателю без
  // героя отвечать нечем — как и `beastHints`, подсказка тогда молчит.
  if (!readerHero(room, actorId)) return []
  const cell = heroCell(room, actorId)
  const nearest = peacefulSceneNpcs(room)
    .map((npc) => ({ npc, feet: feetBetween(cell, npc) }))
    .filter((entry) => entry.feet == null || entry.feet <= THEFT_HINT_REACH_FEET)
    .sort((left, right) => (left.feet ?? Number.POSITIVE_INFINITY) - (right.feet ?? Number.POSITIVE_INFINITY)
      || String(left.npc?.id ?? '').localeCompare(String(right.npc?.id ?? '')))[0]
  const name = text(nearest?.npc?.name, 60)
  if (!name) return []
  return [{
    id: `theft:${text(nearest.npc?.id, 80)}`,
    priority: HINT_PRIORITY.underworld,
    text: `Можно незаметно обчистить карманы: ${name} (Ловкость рук)`,
  }]
}

/**
 * Монета поверх слов.
 *
 * Подкуп живёт внутри самой реплики (`classifyBribeTier`,
 * `server/npc-social-check.mjs`), поэтому строка появляется там, где реплика уже
 * прозвучала: с этим человеком отряд говорил, и он стоит здесь. Разговор берётся
 * из уже спроецированной переписки — чужие и закрытые записи проекция отсеяла до
 * подсказки (`npcSocialForViewer`, `server/npc-social.mjs`).
 *
 * Кошелёк проверяется по той же границе, по которой откажет движок
 * (`INSUFFICIENT_FUNDS` против `MIN_BRIBE_CP`): звать доставать монету того, у
 * кого её нет, — это подсказка наоборот.
 *
 * Чем кончится протянутая рука, строка не знает и знать не вправе: «неподкупный»
 * выводится из сида (`server/underworld.mjs`), в проекции его нет, и назови
 * подсказка хоть намёк — риск подкупа исчез бы вместе с игрой.
 */
function bribeHints(room, actorId) {
  const hero = readerHero(room, actorId)
  if (!hero || currencyToCopper(hero.currency) < MIN_BRIBE_CP) return []
  const present = new Map(peacefulSceneNpcs(room).map((npc) => [String(npc?.id ?? ''), npc]))
  const conversations = Array.isArray(room?.social?.conversations) ? room.social.conversations : []
  const spoken = [...conversations].reverse().find((entry) => present.has(String(entry?.npc_id ?? '')))
  const npc = spoken ? present.get(String(spoken.npc_id)) : null
  const name = text(npc?.name, 60)
  if (!name) return []
  return [{
    id: `bribe:${text(npc?.id, 80)}`,
    priority: HINT_PRIORITY.underworld,
    text: `Можно подкрепить убеждение монетой: ${name}`,
  }]
}

/**
 * Краденое и торговец.
 *
 * Строка нарочно **никого не называет**. Берёт ли этот человек чужие вещи,
 * выводится из сида (`npcIsFence`, `server/underworld.mjs`) и в проекцию не
 * едет по построению; назови подсказка торговца по имени там, где их в зале
 * трое, — и она ответила бы на единственный вопрос, ради которого скупщик
 * заведён. Поэтому здесь ровно предложение попробовать: чем кончится, отряд
 * узнает у прилавка, и честный торговец вправе отказаться, а под розыском —
 * и донести.
 *
 * Само краденое — знание владельца, а не стола: `origin` чужих вещей проекция
 * снимает (`playerItemsWithCapabilities`, `server/viewer-projection.mjs`),
 * поэтому спрашивается только сумка героя-читателя.
 */
function fenceHints(room, actorId) {
  const merchants = Array.isArray(room?.merchants) ? room.merchants : []
  if (!merchants.length) return []
  const hero = readerHero(room, actorId)
  const stolen = (Array.isArray(hero?.inventory) ? hero.inventory : [])
    .some((item) => String(item?.origin ?? '') === 'stolen')
  if (!stolen) return []
  return [{
    id: 'fence:offer',
    priority: HINT_PRIORITY.underworld,
    text: 'Можно попробовать сбыть краденое торговцу',
  }]
}

function npcHints(room) {
  return peacefulSceneNpcs(room)
    .map((npc) => {
      const name = text(npc?.name, 60)
      if (!name) return null
      const role = text(npc?.role, 40)
      return {
        id: `npc:${text(npc?.id, 80)}`,
        priority: HINT_PRIORITY.npc,
        text: role ? `Можно заговорить с кем-то из местных: ${name} (${role})` : `Можно заговорить: ${name}`,
      }
    })
    .filter(Boolean)
}

/**
 * Досуг таверны. Карточку заведения собрал сервер (`server/tavern-life.mjs`),
 * и подсказка только пересказывает её: своей проверки «а таверна ли это»
 * здесь нет и быть не должно — чего нет в проекции, того нет и на входе.
 *
 * Строка **одна**, и это не экономия места, а цена панели: слотов всего
 * четыре, и две строки досуга вытесняли бы разом и находку на карте, и выход
 * из зала. Кости и кружка при этом всё равно стоят кнопками на доске —
 * подсказка нужна тому, кто не знает, что за столом вообще можно чем-то
 * заняться, а не тому, кто выбирает ставку.
 *
 * Открытый раунд забирает эту строку целиком: чужая кость уже на столе, и пока
 * герой не ответил, звать его выпить незачем. Разница между двумя строками не
 * только в тексте: ответ на брошенную кость место занимает безусловно (это уже
 * начатое действие с деньгами на столе), а приглашение за стол — только
 * наравне с реквизитом (`suggestedActionsFor`).
 *
 * @returns {{ urgent: Array<{id: string, priority: number, text: string}>, leisure: Array<{id: string, priority: number, text: string}> }}
 */
function tavernHints(room) {
  const tavern = room?.tavern
  const empty = { urgent: [], leisure: [] }
  if (!tavern) return empty
  // Открытый раунд разбирается **до** запрета входа, а не после, и это не
  // порядок ради порядка: выставленный за дверь остаётся с открытым раундом на
  // руках, отвечать ему запрещено, и единственный его ход — встать из-за стола.
  // Пока запрет обрывал подсказки первой же строкой, этот ход не назывался
  // нигде: панель заведения выставленному тоже рисовала одну заметку.
  if (tavern.round) {
    // Ответить на кость можно всегда — кроме одного положения: героя выставили
    // за дверь, и с ним не садятся вовсе. Тупика в этом нет, выход открыт, но
    // выход этот — сдача, и цену подсказка называет числом.
    //
    // Второго повода «отвечать нечем» здесь не бывает по построению: касса
    // соперника закрепляет выплату за раундом с самого открытия
    // (`tavernFreePurseFor`, `server/tavern-life.mjs`).
    const rival = text(tavern.round.npc_name, 60) || 'соперник'
    const stake = Number(tavern.round.stake_cp) || 0
    return {
      ...empty,
      urgent: [{
        id: 'tavern:answer',
        priority: HINT_PRIORITY.tavernRound,
        text: tavern.ejected === true
          ? `Отсюда героя выставили: раунд остаётся закрыть — встать из-за стола, и ставка в ${stake} мм со стола достанется сопернику`
          : `Можно ответить на бросок: ${rival} выбросил ${Number(tavern.round.npc_total) || 0}`,
      }],
    }
  }
  if (tavern.ejected === true) return empty
  const price = Number(tavern.drink_price_cp) || 0
  const opponent = Array.isArray(tavern.opponents) ? text(tavern.opponents[0]?.name, 60) : ''
  return {
    ...empty,
    leisure: [{
      id: 'tavern:leisure',
      priority: HINT_PRIORITY.leisure,
      text: opponent
        ? `Можно сыграть в кости с местными или заказать выпивку (${price} мм)`
        : `Можно заказать выпивку: ${price} мм за кружку`,
    }],
  }
}

/**
 * Молитвы и благословения. Карточку собрал сервер (`server/blessings.mjs`), и
 * подсказка только пересказывает её: своей арифметики суток здесь нет и быть не
 * должно — чего нет в проекции, того нет и на входе.
 *
 * Строка **одна** и появляется только тогда, когда обращение действительно
 * доступно: сутки не закрыты, благословение не висит на герое прямо сейчас и в
 * сцене есть либо служитель, либо святыня. Иначе панель звала бы молиться там,
 * где движок откажет, — а подсказка, обещающая недоступное, хуже отсутствующей.
 *
 * Уже благословлённый герой отсеивается наравне с суточным откатом: второго
 * благословения поверх первого движок не даёт (`BLESSING_ALREADY_ACTIVE`), и
 * звать к алтарю того, кто ещё не израсходовал первое, значит вести его в отказ.
 *
 * Святыня перевешивает служителя: молитва бесплатна, и предлагать сперва
 * платное было бы советом в пользу храма, а не игрока.
 */
function blessingHints(room) {
  const blessings = room?.blessings
  if (!blessings || blessings.available === false || blessings.blessed === true) return []
  const priest = Array.isArray(blessings.priests) ? text(blessings.priests[0]?.name, 60) : ''
  const shrine = (Array.isArray(room?.scene?.map?.props) ? room.scene.map.props : [])
    .some((prop) => prop?.interactive === true
      && (Array.isArray(prop?.interaction?.verbs) ? prop.interaction.verbs : []).map(String).includes('pray'))
  if (!shrine && !priest) return []
  return [{
    id: 'blessing:offer',
    priority: HINT_PRIORITY.leisure,
    text: shrine
      ? `Можно помолиться у святыни: проверка Религии, СЛ ${Number(blessings.prayer_dc) || 12}, раз в сутки`
      : `Можно попросить благословение: ${priest} (пожертвование ${Number(blessings.donation_cp) || 0} мм)`,
  }]
}

/**
 * Почта отряда. Карточку собрал сервер (`server/courier-letters.mjs`), и
 * подсказка только пересказывает её: своей арифметики дальности здесь нет и
 * быть не должно — чего нет в проекции, того нет и на входе.
 *
 * Строка **одна**, и выбор между двумя её видами жёсткий: пока курьер в пути,
 * предлагать написать ещё одно письмо незачем, а вот назвать, кому и куда уже
 * поехало, стоит. Приглашение написать появляется только тогда, когда почта
 * пуста и адресаты известны, — иначе панель уговаривала бы отряд писать письма
 * каждую сцену.
 */
function letterHints(room) {
  const post = room?.courier_letters
  if (!post) return []
  const letters = Array.isArray(post.letters) ? post.letters : []
  const travelling = letters.find((letter) => letter?.status === 'in_transit')
  if (travelling) {
    const addressee = text(travelling.addressee_name, 60) || 'адресат'
    return [{
      id: 'letter:in-transit',
      priority: HINT_PRIORITY.letter,
      text: `Курьер везёт письмо: ${addressee}${travelling.place_name ? `, ${text(travelling.place_name, 40)}` : ''} — ответа ждать не раньше, чем пройдёт ночь`,
    }]
  }
  const addressees = Array.isArray(post.addressees) ? post.addressees.filter((entry) => entry?.unreachable !== true) : []
  if (!addressees.length) return []
  const nearest = addressees[0]
  return [{
    id: 'letter:write',
    priority: HINT_PRIORITY.letter,
    text: `Можно написать письмо: ${text(nearest.name, 60)} — курьер возьмёт ${Number(nearest.fee_cp) || 0} мм`,
  }]
}

/**
 * Зверь рядом. Карточку собрал сервер (`server/beast-taming.mjs`), и подсказка
 * только пересказывает её: своей проверки «а зверь ли это» здесь нет.
 *
 * Строка одна и появляется только у того, к кому **можно** подойти прямо
 * сейчас: пока волк дерётся, звать к нему с открытой ладонью нельзя, и
 * `blocked_reason` это уже посчитал. Стоящий далеко зверь тоже отсекается, но
 * иначе — своей строкой «сначала подойти»: подсказка обязана называть
 * следующий шаг, а не молчать о звере, до которого просто надо дойти.
 *
 * Досягаемость меряется по герою-читателю, а не по отряду. Партийный вопрос
 * «дотянется ли кто-нибудь» и был второй меркой: панель гасит кнопку по строке
 * своего героя, а подсказка тем же строкам отвечала «сосед стоит вплотную», и
 * на расставленной группе игрок читал разом «до зверя ещё идти: 20 фт» и
 * «можно попробовать успокоить». Комната здесь **персональная** — её собрала
 * `campaignStateForViewer` под конкретного героя, — поэтому спрашивать у неё
 * что-то партийное подсказка права не имеет.
 */
function beastHints(room, actorId) {
  const candidates = Array.isArray(room?.beasts?.candidates) ? room.beasts.candidates : []
  const available = candidates.filter((entry) => entry && !entry.blocked_reason)
  const reachable = available.find((entry) => beastReachRow(entry, actorId).out_of_reach !== true)
  if (!reachable) {
    const distant = available[0]
    if (!distant) return []
    return [{
      id: `beast:${text(distant.id, 80)}`,
      priority: HINT_PRIORITY.leisure,
      text: `Можно подойти вплотную к зверю: ${text(distant.name, 60) || 'зверь'} — с расстояния руку не протянуть`,
    }]
  }
  const name = text(reachable.name, 60) || 'зверь'
  return [{
    id: `beast:${text(reachable.id, 80)}`,
    priority: HINT_PRIORITY.leisure,
    text: reachable.stage === 'calmed'
      ? `Можно покормить: ${name} успокоен и ждёт еды с руки`
      : `Можно попробовать успокоить: ${name} (Уход за животными, СЛ ${Number(reachable.difficulty) || 0})`,
  }]
}

/**
 * Строка досягаемости героя-читателя. Своей геометрии здесь нет: строки собрала
 * та же `beastReachFor`, которой движок проверяет команду.
 *
 * Отсутствующей строке подсказка не верит и умолчание держит в безопасную
 * сторону — «далеко». Строка есть на каждого героя отряда всегда, даже в сцене
 * без карты (`distance_feet: null`, `out_of_reach: false`), поэтому её отсутствие
 * означает ровно одно: спрашивают не за героя отряда. Обещать такому читателю
 * уговор незачем — команду от него сервер всё равно не примет.
 */
function beastReachRow(entry, actorId) {
  const rows = entry?.reach_by_hero
  const row = rows && typeof rows === 'object' ? rows[String(actorId ?? '')] : null
  return row && typeof row === 'object' ? row : { out_of_reach: true }
}

function objectiveHint(room) {
  const objective = text(room?.scene?.objective, 90)
  return objective ? [{ id: 'objective', priority: HINT_PRIORITY.objective, text: `Цель отряда: ${objective}` }] : []
}

/**
 * Запертая дверь под рукой у того, кто умеет с ней справиться.
 *
 * Строка появляется **только при владении инструментом**: звать к замку того,
 * кому движок ответит отказом, — это подсказка наоборот. Признак приезжает
 * готовым (`room.lockpicking.proficient`, `server/lockpicking.mjs`), и своей
 * проверки владения здесь нет: комната собрана, и второй мерки у панели быть
 * не должно.
 *
 * Про сундуки строки нет и быть не может: запертость контейнера выводится из
 * сида и в проекцию не едет — назови её подсказка, и игрок читал бы наличие
 * замка, не притронувшись к крышке. Дверь другое дело: её `locked` игрок и так
 * видит на доске.
 */
function lockpickHints(room) {
  if (room?.lockpicking?.proficient !== true) return []
  const doors = Array.isArray(room?.scene?.map?.doors) ? room.scene.map.doors : []
  if (!doors.some((door) => String(door?.state) === 'locked')) return []
  return [{
    id: 'lockpick:door',
    priority: HINT_PRIORITY.prop,
    text: 'Можно вскрыть замок отмычкой: запертая дверь',
  }]
}

/**
 * Выход из сцены. Дверь на публичной карте уже отфильтрована по раскрытым
 * клеткам, поэтому подсказка не выдаёт проход, которого игрок ещё не видел.
 */
function exitHints(room) {
  const doors = Array.isArray(room?.scene?.map?.doors) ? room.scene.map.doors : []
  if (!doors.length) return []
  return [{ id: 'exit', priority: HINT_PRIORITY.exit, text: 'Можно уйти из этого места через дверь' }]
}

/**
 * Подсказки для одной комнаты. Вход — **уже спроецированная** игроку комната.
 *
 * Порядок детерминирован: сначала объявленный приоритет вида подсказки, затем
 * идентификатор. Иначе одна и та же сцена давала бы разный список от запроса к
 * запросу, а игрок читал бы это как изменение мира.
 *
 * Реквизит забирает только тот остаток строк, который не нужен собеседникам,
 * цели и выходу, и не больше `MAX_PROP_HINTS`. Место в списке предметы всё ещё
 * получают первое — приметное вперёд, — но получают его не за чужой счёт.
 * Запертая дверь стоит в этой же очереди наравне с рядовым реквизитом: замок —
 * возможность, а не срочность.
 *
 * Приглашение за стол в таверне стоит **в этой же очереди**, а не в брони.
 * Безусловный слот у него был, и следствие оказалось хуже причины: в трактире
 * про находку на карте не говорили никогда, потому что собеседник, цель и
 * выход занимали остальные три строки. Теперь приметная находка досуг
 * вытесняет, рядовая обстановка — нет (`HINT_PRIORITY`).
 *
 * Герой-читатель приезжает вторым доводом и нужен там, где строка панели
 * заведена на каждого героя отряда по отдельности: досягаемость зверя, чужой
 * карман под рукой, свой кошелёк и своё краденое. Комната уже персональная,
 * viewer в ней известен, и партийный вопрос вместо личного был бы второй меркой
 * на тот же вопрос кнопки — а у краденого ещё и утечкой: чужое происхождение
 * вещи проекция снимает намеренно.
 *
 * @param {Record<string, any> | null | undefined} room
 * @param {string} [actorId] герой, которому показывается панель
 * @returns {Array<{ id: string, text: string }>}
 */
export function suggestedActionsFor(room, actorId = '') {
  if (!room || typeof room !== 'object') return []
  if (room?.mechanics?.combat?.active === true) return []
  const seen = new Set()
  const ordered = (hints) => hints
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .filter((hint) => {
      if (!hint.text || seen.has(hint.text)) return false
      seen.add(hint.text)
      return true
    })
  const tavern = tavernHints(room)
  // Сначала занимают места те, кого вытеснять нельзя: добыча, начатый раунд
  // костей, собеседники, цель, выход. Добыча стоит первой строкой — см.
  // `lootHints`; с раундом костей она в одной сцене не встречается (кости
  // бросают в мирном зале, тела остаются после боя), а если встретится,
  // порядок решит идентификатор.
  const reserved = ordered([
    ...lootHints(room),
    ...tavern.urgent,
    ...npcHints(room),
    ...objectiveHint(room),
    ...exitHints(room),
  ])
  const budget = Math.min(MAX_PROP_HINTS, Math.max(0, MAX_ACTION_HINTS - reserved.length))
  const props = ordered([
    ...propHints(room),
    ...lockpickHints(room),
    ...tavern.leisure,
    ...blessingHints(room),
    ...beastHints(room, actorId),
    ...letterHints(room),
    // Изнанка. Все три строки личные: карман меряется от героя-читателя,
    // кошелёк и краденое — его собственные, и партийного ответа тут нет.
    ...theftHints(room, actorId),
    ...bribeHints(room, actorId),
    ...fenceHints(room, actorId),
  ]).slice(0, budget)
  return [...props, ...reserved]
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .slice(0, MAX_ACTION_HINTS)
    .map((hint) => ({ id: hint.id, text: hint.text }))
}
