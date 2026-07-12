import { randomInt, randomUUID } from 'node:crypto'

const VISIBILITIES = new Set(['public', 'party', 'specific_player', 'gm_only', 'npc_private'])

export class DiceExpressionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DiceExpressionError'
  }
}

export class CryptoDiceRng {
  randint(minimum, maximum) {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new RangeError('Некорректный диапазон генератора случайных чисел')
    }
    return randomInt(minimum, maximum + 1)
  }
}

export class SequenceDiceRng {
  constructor(values) {
    this.values = [...values]
    this.index = 0
  }

  randint(minimum, maximum) {
    if (this.index >= this.values.length) throw new RangeError('Тестовая последовательность бросков закончилась')
    const value = Number(this.values[this.index++])
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`Тестовое значение ${value} не входит в диапазон ${minimum}..${maximum}`)
    }
    return value
  }
}

export function parseDiceExpression(expression) {
  const compact = String(expression ?? '').toLowerCase().replace(/\s+/g, '')
  const match = /^(\d{0,3})d(\d{1,4})([+-]\d{1,5})?$/.exec(compact)
  if (!match) throw new DiceExpressionError('Поддерживается формат NdS, например 1d20+5')

  const count = match[1] ? Number(match[1]) : 1
  const sides = Number(match[2])
  const modifier = match[3] ? Number(match[3]) : 0
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new DiceExpressionError('Количество костей должно быть от 1 до 100')
  }
  if (!Number.isSafeInteger(sides) || sides < 2 || sides > 1000) {
    throw new DiceExpressionError('Количество граней должно быть от 2 до 1000')
  }
  if (!Number.isSafeInteger(modifier) || Math.abs(modifier) > 10_000) {
    throw new DiceExpressionError('Модификатор слишком велик')
  }

  const canonical = `${count}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`
  return { count, sides, modifier, canonical }
}

export class DiceService {
  constructor({ rng = new CryptoDiceRng(), idFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
    if (!rng || typeof rng.randint !== 'function') throw new TypeError('DiceRng должен реализовывать randint(minimum, maximum)')
    this.rng = rng
    this.idFactory = idFactory
    this.now = now
  }

  roll(expression, purpose = 'unspecified', actorId = null, visibility = 'public') {
    const parsed = parseDiceExpression(expression)
    const dice = Array.from({ length: parsed.count }, () => this.rng.randint(1, parsed.sides))
    return {
      roll_id: this.idFactory(),
      expression: parsed.canonical,
      dice,
      modifier: parsed.modifier,
      total: dice.reduce((sum, value) => sum + value, parsed.modifier),
      purpose: String(purpose || 'unspecified').slice(0, 80),
      actor_id: actorId == null ? null : String(actorId).slice(0, 120),
      visibility: VISIBILITIES.has(visibility) ? visibility : 'public',
      created_at: this.now(),
    }
  }

  rollD20({ modifier = 0, purpose = 'check', actorId = null, visibility = 'public', advantage = false, disadvantage = false } = {}) {
    const safeModifier = Number(modifier)
    if (!Number.isSafeInteger(safeModifier) || Math.abs(safeModifier) > 100) throw new DiceExpressionError('Некорректный модификатор d20')

    const mode = advantage && !disadvantage ? 'advantage' : disadvantage && !advantage ? 'disadvantage' : 'normal'
    const dice = mode === 'normal'
      ? [this.rng.randint(1, 20)]
      : [this.rng.randint(1, 20), this.rng.randint(1, 20)]
    const kept = mode === 'advantage' ? Math.max(...dice) : mode === 'disadvantage' ? Math.min(...dice) : dice[0]

    return {
      roll_id: this.idFactory(),
      expression: `${mode === 'normal' ? '1' : '2'}d20${safeModifier > 0 ? `+${safeModifier}` : safeModifier < 0 ? safeModifier : ''}`,
      dice,
      kept,
      mode,
      modifier: safeModifier,
      total: kept + safeModifier,
      purpose: String(purpose || 'check').slice(0, 80),
      actor_id: actorId == null ? null : String(actorId).slice(0, 120),
      visibility: VISIBILITIES.has(visibility) ? visibility : 'public',
      created_at: this.now(),
    }
  }

  rollCheck({ modifier = 0, difficulty = 10, ...options } = {}) {
    const dc = Number(difficulty)
    if (!Number.isSafeInteger(dc) || dc < 0 || dc > 100) throw new DiceExpressionError('Некорректная сложность проверки')
    const result = this.rollD20({ modifier, ...options })
    return { ...result, difficulty: dc, success: result.total >= dc }
  }
}

