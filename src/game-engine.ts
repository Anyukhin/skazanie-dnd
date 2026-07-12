import type { GameState, MapCell, Message, PendingCheck, RollResult } from './types'

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
const time = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date())

const choose = <T,>(items: T[], seed: number) => items[seed % items.length]

function revealEasternRoom(cells: MapCell[]) {
  return cells.map((cell) => cell.x >= 7 && cell.x <= 11 && cell.y >= 1 && cell.y <= 6
    ? { ...cell, revealed: true, type: cell.x === 7 && cell.y === 2 ? 'door' : cell.type }
    : cell)
}

export function createLocalCheck(state: GameState, action: string): Omit<PendingCheck, 'action' | 'playerId' | 'status'> | null {
  const normalized = action.toLowerCase()
  const player = state.players.find((item) => item.id === state.activePlayerId) ?? state.players[0]
  if (/\?|говор|отвеч|спраш|крич|шеп|обсуж|предлаг|план|инвентар|показыв|вспомин/.test(normalized)) return null
  if (/атак|стрел|удар|меч|заклин/.test(normalized)) return { label: 'Атака', modifier: 4, difficulty: 14, sides: 20 }
  if (/вода|ныр|плы|луж|смотр|слуш/.test(normalized)) return { label: 'Внимательность', modifier: 3, difficulty: 13, sides: 20 }
  if (/знак|рун|маг|изуч|прочит/.test(normalized)) return { label: 'Магия', modifier: 3, difficulty: 13, sides: 20 }
  if (/двер|замок|механ|ловуш/.test(normalized)) return { label: 'Расследование', modifier: 2, difficulty: 13, sides: 20 }
  if (/пыта|ищ|осматр|исслед|иду|бег|прыга|лез|откры|беру|использ|делаю/.test(normalized)) {
    return { label: 'Проверка навыка', modifier: player.proficiency, difficulty: 12, sides: 20 }
  }
  return null
}

export function resolveAction(state: GameState, action: string, result?: RollResult): { message: Message; cells: MapCell[]; objective?: string; turnConsumed: boolean } {
  const normalized = action.toLowerCase()
  const check = createLocalCheck(state, action)
  if (!check) {
    const isQuestion = /\?|спраш|что |кто |где |почему /.test(normalized)
    return {
      cells: state.scene.cells,
      turnConsumed: false,
      message: {
        id: id(), speaker: 'narrator', author: 'Рассказчик', timestamp: time(),
        text: isQuestion
          ? 'Вопрос звучит в тишине сцены. Те, кто могут ответить, реагируют на него, но само уточнение не требует проверки и не завершает ход героя.'
          : 'Герой делает это без помех и риска. Обстановка существенно не меняется, поэтому можно продолжить свой ход.',
      },
    }
  }
  const roll = result?.value ?? Math.floor(Math.random() * 20) + 1
  const modifier = result?.modifier ?? check.modifier
  const total = result?.total ?? roll + modifier
  const success = result?.success ?? total >= check.difficulty
  let label = 'Проверка навыка'
  let text = ''
  let cells = state.scene.cells
  let objective: string | undefined

  if (/вода|ныр|плы|луж/.test(normalized)) {
    label = 'Внимательность'
    text = success
      ? 'Ты замечаешь, что круги на воде расходятся не от существа, а от тонкой цепи. Она уходит под разрушенный стеллаж и натягивается при каждом вашем шаге. Это часть старой сигнальной ловушки — теперь её можно обойти.'
      : 'Ты наклоняешься ближе. Вода неподвижна, но на миг твоё отражение улыбается раньше тебя. Когда ты моргаешь, всё снова выглядит обычно.'
  } else if (/знак|рун|маг|изуч|прочит/.test(normalized)) {
    label = 'Магия'
    cells = revealEasternRoom(cells)
    text = success
      ? 'Руна отзывается на твой взгляд и складывается в слово «память». По стене пробегает зелёный свет, проявляя скрытый проход в восточную часть архива. На карте открывается новая комната.'
      : 'Знак вспыхивает и на мгновение показывает очертания комнаты за восточной стеной. Проход существует, но печать пока не желает открываться.'
    objective = 'Добраться до печати в восточном хранилище'
  } else if (/двер|замок|механ|ловуш/.test(normalized)) {
    label = 'Расследование'
    text = success
      ? 'Между плитами скрыт пружинный стопор. Ты фиксируешь его обломком клинка — теперь дверь не захлопнется, а путь к отступлению останется свободным.'
      : 'Механизм старый и покрыт ржавчиной. Кажется, дверь безопасна, но из глубины стены доносится один сухой щелчок.'
  } else if (/атак|стрел|удар|меч|заклин/.test(normalized)) {
    label = 'Атака'
    text = success
      ? 'Удар достигает цели. Тень у дальнего стеллажа дёргается, рассыпается чёрными клочьями и отступает в неисследованную часть архива. Вы выиграли несколько драгоценных секунд.'
      : 'Атака рассекает влажный воздух. Тень оказывается лишь отражением — а настоящий противник теперь знает, где вы стоите.'
  } else {
    label = 'Импровизация'
    text = choose(success ? [
      'Твой замысел срабатывает. Подземелье отвечает едва слышным гулом, и в окружающей сцене появляется новая возможность: за поваленным шкафом виден узкий проход.',
      'Ты действуешь уверенно. Остальные успевают подхватить идею, и группа получает преимущество в следующем рискованном действии.',
    ] : [
      'Ты приводишь план в действие, но место словно сопротивляется. Получается лишь отчасти — и где-то за стеной просыпается тяжёлый механизм.',
      'Замысел почти удаётся. В последний миг что-то меняется, и теперь придётся выбирать: продолжить с риском или отступить.',
    ], state.scene.turn)
  }

  return {
    cells,
    objective,
    turnConsumed: true,
    message: {
      id: id(),
      speaker: 'narrator',
      author: 'Рассказчик',
      timestamp: time(),
      text,
      roll: { value: roll, modifier, total, label: result?.label ?? label, success },
    },
  }
}

export function playerMessage(author: string, text: string): Message {
  return { id: id(), speaker: 'player', author, text, timestamp: time() }
}
