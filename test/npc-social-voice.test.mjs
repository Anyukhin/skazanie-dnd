import assert from 'node:assert/strict'
import test from 'node:test'

import { NPC_SOCIAL_PROMPT_VERSION, NpcSocialController } from '../server/npc-social-controller.mjs'
import { UNTRUSTED_DATA_END, UNTRUSTED_DATA_START } from '../server/security.mjs'

function untrustedPayload(content, section) {
  const open = `${UNTRUSTED_DATA_START}:${section}>>>`
  const close = `${UNTRUSTED_DATA_END}:${section}>>>`
  const start = content.indexOf(open)
  const end = content.indexOf(close)
  assert.ok(start >= 0 && end > start, `блок UNTRUSTED_DATA:${section} обязан присутствовать`)
  return JSON.parse(content.slice(start + open.length, end))
}

function dialogueState() {
  return {
    scene: { title: 'Вечер в «Пустом кубке»', location: 'Трактир «Пустой кубок»', mood: 'настороженно', objective: 'Узнать о караване' },
    players: [
      { id: 'hero', character: 'Ада' },
      { id: 'rogue', character: 'Рен' },
    ],
    social: {
      npcs: [{
        id: 'npc:mira', name: 'Мира', role: 'хозяйка трактира', location: 'Трактир «Пустой кубок»',
        public_summary: 'Держит трактир двадцать лет.', voice: 'Говорит быстро, с прибаутками.',
        speech_profile: {
          pace: 'быстро, короткими фразами',
          lexicon: 'трактирные поговорки и бытовые слова',
          mannerism: 'один раз заканчивает мысль словами «так-то оно вернее»',
        },
        goals: ['Сохранить трактир', 'Узнать, кто пугает поставщиков'],
        visibility: 'party', available: true,
      }, {
        id: 'npc:orin', name: 'Орин', role: 'архивариус', location: 'Трактир «Пустой кубок»',
        public_summary: 'Сверяет дорожные записи.', voice: 'Говорит медленно и точно.',
        speech_profile: {
          pace: 'медленно, с паузой перед выводом',
          lexicon: 'книжные слова и названия документов',
          mannerism: 'перед выводом говорит «согласно записи»',
        },
        visibility: 'party', available: true,
      }],
      relationships: { 'npc:mira': { hero: 10, rogue: 0 }, 'npc:orin': { hero: 0, rogue: 0 } },
      promises: [],
      conversations: [
        { id: 'conv-1', npc_id: 'npc:mira', hero_id: 'rogue', player_message: 'Что слышно у ворот?', npc_reply: 'Стража стала жадной.', stance: 'neutral', visibility: 'party' },
        { id: 'conv-2', npc_id: 'npc:mira', hero_id: 'hero', player_message: 'Налей чего покрепче.', npc_reply: 'Для тебя — из старых запасов.', stance: 'friendly', visibility: 'party' },
      ],
    },
  }
}

test('бриф NPC-диалога несёт сцену, цели NPC и память разговоров со всем отрядом', async () => {
  const requests = []
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => { requests.push(input); return { reply: 'Слушаю.', stance: 'neutral' } } },
  })
  const result = await controller.respond({
    state: dialogueState(), playerId: 'hero', npcId: 'npc:mira', message: 'Расскажи о караване', turnId: 'voice-1',
  })
  assert.ok(result)
  assert.equal(requests.length, 1)

  assert.match(requests[0].messages[0].content, /PROMPT_ID: npc_controller\/social-v4/)
  assert.equal(result.prompt_version, NPC_SOCIAL_PROMPT_VERSION)
  const brief = untrustedPayload(requests[0].messages[1].content, 'npc_social_brief')

  assert.equal(brief.scene.location, 'Трактир «Пустой кубок»')
  assert.equal(brief.scene.mood, 'настороженно')
  assert.equal(Object.hasOwn(brief.scene, 'objective'), false, 'Игровой список задач не становится прямой речью NPC')
  // Цели профиля — приватные мотивы: модель получает только party-видимые
  // поля, потому что всё переданное может дословно уйти в реплику игроку.
  assert.equal(Object.hasOwn(brief.npc, 'goals'), false)
  assert.doesNotMatch(requests[0].messages[1].content, /Сохранить трактир|кто пугает поставщиков/u)
  assert.deepEqual(brief.npc.speech_profile, {
    pace: 'быстро, короткими фразами',
    lexicon: 'трактирные поговорки и бытовые слова',
    mannerism: 'один раз заканчивает мысль словами «так-то оно вернее»',
  })

  // Личная память — только текущий герой, память отряда — остальные с именами.
  assert.deepEqual(brief.recent_conversation.map((entry) => entry.player_message), ['Налей чего покрепче.'])
  assert.deepEqual(brief.recent_party_conversation, [{
    hero: 'Рен', player_message: 'Что слышно у ворот?', npc_reply: 'Стража стала жадной.', stance: 'neutral',
  }])
})

test('память отряда ограничена последними четырьмя разговорами', async () => {
  const state = dialogueState()
  state.social.conversations = Array.from({ length: 9 }, (_, index) => ({
    id: `conv-${index}`, npc_id: 'npc:mira', hero_id: 'rogue',
    player_message: `Реплика ${index}`, npc_reply: `Ответ ${index}`, stance: 'neutral', visibility: 'party',
  }))
  const requests = []
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => { requests.push(input); return { reply: 'Слушаю.', stance: 'neutral' } } },
  })
  await controller.respond({ state, playerId: 'hero', npcId: 'npc:mira', message: 'Ещё раз', turnId: 'voice-2' })
  const brief = untrustedPayload(requests[0].messages[1].content, 'npc_social_brief')
  assert.deepEqual(brief.recent_party_conversation.map((entry) => entry.player_message), ['Реплика 5', 'Реплика 6', 'Реплика 7', 'Реплика 8'])
})

test('бриф NPC не раскрывает specific_player разговор другого героя', async () => {
  const state = dialogueState()
  state.social.conversations.push(
    {
      id: 'conv-private-rogue', npc_id: 'npc:mira', hero_id: 'rogue',
      player_message: 'ЧУЖОЙ СКРЫТЫЙ ВОПРОС', npc_reply: 'ЧУЖОЙ СКРЫТЫЙ ОТВЕТ',
      stance: 'neutral', visibility: 'specific_player',
    },
    {
      id: 'conv-private-hero', npc_id: 'npc:mira', hero_id: 'hero',
      player_message: 'МОЙ СКРЫТЫЙ ВОПРОС', npc_reply: 'МОЙ СКРЫТЫЙ ОТВЕТ',
      stance: 'friendly', visibility: 'specific_player',
    },
  )
  const requests = []
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => { requests.push(input); return { reply: 'Слушаю.', stance: 'neutral' } } },
  })

  await controller.respond({
    state, playerId: 'hero', npcId: 'npc:mira', message: 'Что ты помнишь?', turnId: 'voice-private',
  })

  const brief = untrustedPayload(requests[0].messages[1].content, 'npc_social_brief')
  assert.ok(brief.recent_conversation.some((entry) => entry.player_message === 'МОЙ СКРЫТЫЙ ВОПРОС'))
  assert.ok(brief.recent_party_conversation.some((entry) => entry.player_message === 'Что слышно у ворот?'))
  assert.doesNotMatch(JSON.stringify(brief), /ЧУЖОЙ СКРЫТЫЙ ВОПРОС|ЧУЖОЙ СКРЫТЫЙ ОТВЕТ/u)
})

test('два NPC одной сцены получают разные server-owned речевые профили', async () => {
  const requests = []
  const controller = new NpcSocialController({
    llmClient: { completeJson: async (input) => { requests.push(input); return { reply: 'Слушаю.', stance: 'neutral' } } },
  })
  const state = dialogueState()
  await controller.respond({ state, playerId: 'hero', npcId: 'npc:mira', message: 'Что известно?', turnId: 'voice-mira' })
  await controller.respond({ state, playerId: 'hero', npcId: 'npc:orin', message: 'Что известно?', turnId: 'voice-orin' })

  const [mira, orin] = requests.map((request) => untrustedPayload(request.messages[1].content, 'npc_social_brief').npc)
  assert.notDeepEqual(mira.speech_profile, orin.speech_profile)
  assert.match(mira.speech_profile.mannerism, /так-то оно вернее/u)
  assert.match(orin.speech_profile.mannerism, /согласно записи/u)
})
