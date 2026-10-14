// Эталон `server/parley.mjs` для sk-society: `node gen-parley.mjs`.
//
// Мораль, предводитель, откуп и перемирие — на случайных сторонах противника
// с мусором; распознавание фразы — на сотнях фраз, собранных из обрывков
// окрика, встречных признаков и нейтральных слов; патч боя — на всех
// событиях парлея.
import { JUNK, collector, rng, server, write } from './lib.mjs'

const parley = await import(server('parley'))
const random = rng(4242)
const c = collector()

const constants = {
  PARLEY_SCHEMA_VERSION: parley.PARLEY_SCHEMA_VERSION,
  PARLEY_POLICY_ID: parley.PARLEY_POLICY_ID,
  PARLEY_SKILLS: parley.PARLEY_SKILLS,
  PARLEY_ABILITY: parley.PARLEY_ABILITY,
  PARLEY_COMMAND_TYPES: [...parley.PARLEY_COMMAND_TYPES],
  TRUCE_BREAKING_COMMAND_TYPES: [...parley.TRUCE_BREAKING_COMMAND_TYPES],
  NEGOTIABLE_CREATURE_TYPES: [...parley.NEGOTIABLE_CREATURE_TYPES],
  ZEALOT_TRAIT_IDS: [...parley.ZEALOT_TRAIT_IDS],
  PARLEY_REFUSAL_LINES: parley.PARLEY_REFUSAL_LINES,
  PARLEY_REFUSAL_REASONS: parley.PARLEY_REFUSAL_REASONS,
  PARLEY_OUTCOMES: parley.PARLEY_OUTCOMES,
  PARLEY_TERMS: parley.PARLEY_TERMS,
  PARLEY_BASE_DC: parley.PARLEY_BASE_DC,
  PARLEY_HEALTH_WEIGHT: parley.PARLEY_HEALTH_WEIGHT,
  PARLEY_LOSS_WEIGHT: parley.PARLEY_LOSS_WEIGHT,
  PARLEY_OUTCOME_THRESHOLDS: parley.PARLEY_OUTCOME_THRESHOLDS,
  PARLEY_COUNTER_REASONS: parley.PARLEY_COUNTER_REASONS,
}

const IDS = ['enemy-a', 'enemy-b', 'enemy-c', 'enemy-leader', 'Enemy-B', 'Вожак', 'ё-1', 'e-1', '', null, 7, 'enemy-a']
const TYPES = ['humanoid', 'Humanoid', ' humanoid ', 'HUMANOID', 'giant', 'fiend', 'celestial', 'dragon', 'beast', 'undead', 'ooze', '', null, 5]
const TRAITS = [[], [{ id: 'bloodied-frenzy' }], ['relentless-pursuit'], [{ id: 'pack-tactics' }], [null], [{}], 'bloodied-frenzy', [{ id: ' bloodied-frenzy ' }]]
const HP = [undefined, null, 0, 1, 3, 5, 11, 20, 30, -4, '7', 1.5, 'abc', 2 ** 53]
const CONDITIONS = [[], [{ id: 'fled' }], ['surrendered'], [{ id: 'unconscious' }], [{ id: 'prone' }], [null], 'fled', [{ id: null }]]

function enemy() {
  if (random.chance(0.05)) return random.pick([null, 'x', 3])
  const typeKey = random.pick(['creature_type', 'creatureType', 'monster_type', 'kind'])
  const entry = {
    id: random.pick(IDS),
    name: random.chance(0.7) ? random.pick(['Разбойник', '  Вожак   банды ', 'Ｏｒｃ', '', null]) : undefined,
    character: random.chance(0.3) ? 'Персонаж' : undefined,
    hp: random.pick(HP),
    alive: random.pick([undefined, true, false, 'false', 0]),
    traits: random.chance(0.6) ? random.pick(TRAITS) : undefined,
    provenance: random.chance(0.8) ? { xp: random.pick([25, 50, 100, 200, 450, 1800, 0, -5, '100', null, 2 ** 40]) } : random.pick([undefined, null, 'x']),
    [typeKey]: random.pick(TYPES),
  }
  if (random.chance(0.4)) entry.creature_type = random.chance(0.5) ? null : random.pick(TYPES)
  const maxKey = random.pick(['maxHp', 'max_hp', 'both', 'none'])
  if (maxKey === 'maxHp' || maxKey === 'both') entry.maxHp = random.pick([...HP, 11, 22])
  if (maxKey === 'max_hp' || maxKey === 'both') entry.max_hp = random.pick([...HP, 11, 22])
  return entry
}

function truce() {
  if (random.chance(0.1)) return random.pick(JUNK)
  return {
    leader_id: random.pick(['enemy-leader', ' enemy-a ', '', null, 9]),
    leader_name: random.chance(0.8) ? random.pick(['Вожак', '  Вожак   банды ', null]) : undefined,
    hero_id: random.chance(0.8) ? 'hero' : undefined,
    hero_name: random.chance(0.8) ? 'Ада' : undefined,
    skill: random.pick(['persuasion', 'intimidation', 'deception', undefined, null, ' persuasion ']),
    difficulty: random.pick([undefined, null, 20, 4, 31, '12', 1.5]),
    total: random.pick([undefined, 17, -3, '15', 1.5]),
    round: random.pick([undefined, 2, -1, '3']),
    established_at_minutes: random.pick([undefined, 0, 600, -5, '30']),
    outcomes: random.pick([['resume'], ['withdraw', 'resume'], ['surrender', 'tribute', 'withdraw', 'resume'], [' withdraw ', 'withdraw', 'bogus'], [], undefined, 'resume', [null, 3]]),
    tribute_cp: random.pick([undefined, 0, 50, -1, '20']),
  }
}

function state() {
  const enemies = Array.from({ length: random.int(0, 6) }, enemy)
  const conditions = {}
  for (const id of random.some(['enemy-a', 'enemy-b', 'enemy-c', 'enemy-leader', 'null', '7'], 4)) conditions[id] = random.pick(CONDITIONS)
  return {
    sessionCode: random.pick(['PARLEY', 'p-2', '', null, undefined, 11]),
    enemies: random.chance(0.95) ? enemies : random.pick(JUNK),
    mechanics: random.chance(0.95) ? {
      conditions: random.chance(0.9) ? conditions : random.pick(JUNK),
      combat: random.chance(0.85) ? {
        active: random.pick([true, true, false, 'yes', 0, undefined]),
        truce: random.chance(0.5) ? truce() : undefined,
        parley_attempts: random.pick([undefined, 0, 1, 2, -1, '3', 1.5]),
      } : random.pick(JUNK),
    } : random.pick(JUNK),
  }
}

for (let index = 0; index < 400; index += 1) {
  const s = state()
  c.call('standingEnemies', parley.standingEnemies, [s])
  c.call('parleyLeaderFor', parley.parleyLeaderFor, [s])
  c.call('parleyMoraleFor', parley.parleyMoraleFor, [s])
  c.call('parleyTributeCp', parley.parleyTributeCp, [s])
  c.call('truceFor', parley.truceFor, [s])
  c.call('truceHolds', parley.truceHolds, [s])
  c.call('parleyAttempts', parley.parleyAttempts, [s])
  c.call('parleyTaunt', parley.parleyTaunt, [s, { leaderId: random.pick(IDS), round: random.pick([undefined, 0, 2, '3', null, 1.5]), attempt: random.pick([undefined, 1, 2, null, 'x']) }])
}

for (let index = 0; index < 150; index += 1) {
  const t = truce()
  c.call('normalizeTruce', parley.normalizeTruce, [t])
  c.call('parleyTermsFor', parley.parleyTermsFor, [random.chance(0.8) ? { outcomes: random.pick([['resume', 'withdraw'], ['tribute', 'bogus', 'surrender'], ['constructor', 'resume'], ['toString'], [null, 7], 'resume', undefined]) } : random.pick(JUNK)])
  for (const type of ['ParleyProposed', 'TruceEstablished', 'TruceBroken', 'ParleySettled', 'MakeAttack', '', undefined]) {
    c.call('parleyCombatPatch', parley.parleyCombatPatch, [random.chance(0.8) ? { parley_attempts: random.pick([undefined, 0, 2, '4', -1, 1.5, null]) } : random.pick(JUNK), { event_type: type, payload: random.chance(0.8) ? { truce: t } : random.pick([undefined, null]) }])
  }
}
c.call('parleyCombatPatch', parley.parleyCombatPatch, [])
for (const reason of ['no_leader', 'mindless', 'zealots', 'roll_failed', '', null, undefined, 7]) c.call('parleyRefusalLine', parley.parleyRefusalLine, [reason])

// Фразы: обрывки окрика, встречные признаки, нажим и нейтральные слова.
const PARLEY_BITS = ['поговорим', 'Поговорим', 'ПЕРЕГОВОРЫ', 'переговоры', 'парлей', 'парлий', 'перемирие', 'давайте поговорим', 'давай  поговорим', 'поговорим миром', 'поговорите по-хорошему',
  'сложите оружие', 'опустите оружие', 'бросай оружие', 'бросьте оружие', 'прекратите бой', 'прекрати драку', 'хватит драться', 'хватит биться', 'не хотим драться', 'предлагаю мир', 'предлагаем сдаться', 'сдавайтесь', 'Сдавайтесь', 'суперпереговоры', 'непоговорим']
const COUNTER_BITS = ['бью', 'бьём', 'бьем', 'атакую', 'нападаем', 'рублю', 'режу', 'колю', 'стреляю', 'мечу', 'кидаю', 'швыряем', 'добиваю', 'наношу удар', 'замахиваюсь',
  'никаких переговоров', 'никакого перемирия', 'не пахнет', 'не будем говорить', 'какие уж тут переговоры', 'не о чем говорить', 'сдаюсь', 'сдаёмся', 'после боя', 'после драки', 'позже', 'потом', 'не сейчас', 'когда всё закончится', 'когда закончим',
  'помню', 'вспомнил', 'припоминаю', 'говорили про', 'говорил о', 'рассказывал', 'слышал про', 'слышали о', 'бьюсь', 'потомок', 'мечущийся']
const PRESS_BITS = ['или я', 'или мы', 'иначе', 'убью', 'убьём', 'прикончу', 'зарублю', 'перебьём', 'пожалеешь', 'пожалеете', 'последнее предупреждение', 'илия', 'иначеский']
const NEUTRAL = ['кричу им:', 'остановитесь!', 'гоблин,', 'эй,', 'мы не тронем вас', 'тихо', 'смотрю по сторонам', 'и', '—', '...', 'Ｈｅｙ', 'ё', 'Ёлки']

const phrases = new Set([
  'кричу им: остановитесь, поговорим!', 'Предлагаю переговоры', 'Сдавайтесь, и мы вас не тронем', 'Предлагаю переговоры: хватит драться!', 'бью топором по щиту',
  'Кричу товарищу: поговорим после боя! А сейчас бью гоблина топором', 'Помню, староста говорил про переговоры с гильдией — но сейчас атакую',
  'Перемирием тут и не пахнет, режу его', 'Хватит драться, я сдаюсь', 'Никаких переговоров с этой швалью', 'Предлагаю переговоры, но не сейчас',
  'Помню, в трактире говорили про переговоры с бандой', 'Прекрати бой, гоблин, или я тебя убью', '', '   ',
])
while (phrases.size < 700) {
  const parts = []
  for (let index = 0; index < random.int(1, 5); index += 1) {
    parts.push(random.pick(random.pick([PARLEY_BITS, PARLEY_BITS, COUNTER_BITS, PRESS_BITS, NEUTRAL])))
  }
  phrases.add(parts.join(random.pick([' ', ', ', '  ', ' ', ' — '])))
}
for (const phrase of phrases) {
  c.call('mentionsParley', parley.mentionsParley, [phrase])
  c.call('parleyCounterReasonFor', parley.parleyCounterReasonFor, [phrase])
  c.call('parleySkillFor', parley.parleySkillFor, [phrase])
}
for (const junk of JUNK) {
  c.call('mentionsParley', parley.mentionsParley, [junk])
  c.call('parleySkillFor', parley.parleySkillFor, [junk])
}

write('parley.json', { generator: 'gen-parley.mjs', constants, values: c.values, cases: c.cases, skipped: c.skipped })
