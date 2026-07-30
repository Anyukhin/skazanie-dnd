import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { wait, withBrowser } from './browser.mjs'

const root = resolve(import.meta.dirname, '..')
const campaignId = 'TABLE-FIVE'
const setupToken = 'table-five-smoke-setup'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolveListen)
  })
  const address = probe.address()
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()))
  return address.port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await Promise.race([
    new Promise((resolveExit) => {
      child.once('exit', resolveExit)
      child.kill()
    }),
    wait(4_000),
  ])
  if (child.exitCode == null) child.kill('SIGKILL')
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited early\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* server is starting */ }
    await wait(50)
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion includes text */ }
  return { response, status: response.status, body: parsed, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0] ?? ''

async function pageRequest(page, path, { method = 'GET', body } = {}) {
  return page.evaluate(async (requestPath, requestMethod, requestBody) => {
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: requestBody === undefined ? {} : { 'Content-Type': 'application/json' },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { /* caller gets text */ }
    return { status: response.status, body: parsed, text }
  }, path, method, body)
}

async function setSession(page, baseUrl, sessionCookie) {
  const [name, value] = sessionCookie.split('=')
  await page.command('Network.enable')
  const result = await page.command('Network.setCookie', { name, value, url: baseUrl, httpOnly: true })
  assert.notEqual(result.success, false)
}

function characterDocument(index) {
  const baseScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character: `Герой ${index}`,
      name: `Герой ${index}`,
      role: 'Варвар · ур. 1',
      characterClass: 'barbarian',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience: 0,
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
}

async function importHero(baseUrl, sessionCookie, index) {
  const actorId = `hero-slot-${index}`
  const result = await request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST',
    cookie: sessionCookie,
    body: {
      idempotency_key: `smoke-import-${index}`,
      message: `Создание героя ${index}`,
      command: { command_type: 'ImportCharacter', actor_id: actorId, document: characterDocument(index) },
    },
  })
  assert.equal(result.status, 200, result.text)
}

async function room(baseUrl, sessionCookie) {
  const result = await request(baseUrl, `/api/rooms/${campaignId}`, { cookie: sessionCookie })
  assert.equal(result.status, 200, result.text)
  return result.body
}

async function waitForRoom(baseUrl, sessionCookie, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await room(baseUrl, sessionCookie)
    if (predicate(latest)) return latest
    await wait(100)
  }
  throw new Error(`Room timeout: ${label}\n${JSON.stringify(latest?.state?.presence ?? null)}`)
}

async function screenshotSet(browser, outputDir, stage, indices = [0, 1, 2, 3, 4]) {
  const files = []
  for (const index of [...new Set(indices)]) {
    const path = join(outputDir, `${stage}-player-${index + 1}.png`)
    const saved = await browser.page(index).screenshot(path, { fullPage: false })
    files.push(relative(root, saved).replaceAll('\\', '/'))
  }
  return files
}

async function command(baseUrl, sessionCookie, idempotencyKey, commandBody) {
  return request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST',
    cookie: sessionCookie,
    body: { idempotency_key: idempotencyKey, message: `Smoke: ${commandBody.command_type}`, command: commandBody },
  })
}

async function main() {
  await access(join(root, 'dist', 'index.html'))
  const outputArg = process.argv.indexOf('--output')
  const outputDir = resolve(outputArg >= 0 ? process.argv[outputArg + 1] : join(root, 'docs', 'evidence', 'table-of-five'))
  await mkdir(outputDir, { recursive: true })
  const storage = await mkdtemp(join(tmpdir(), 'skazanie-five-browser-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let logs = ''
  let server = startServer(port, storage, (chunk) => { logs += chunk })
  const protocol = []

  try {
    await waitForHealth(baseUrl, server, () => logs)
    const admin = await request(baseUrl, '/api/auth/setup-admin', {
      method: 'POST',
      body: { name: 'Smoke Admin', email: 'admin@five.smoke', password: 'secure-admin-password', setupToken },
    })
    assert.equal(admin.status, 201, admin.text)
    const adminCookie = cookie(admin)

    const accountCookies = []
    for (let index = 1; index <= 6; index += 1) {
      const registered = await request(baseUrl, '/api/auth/register', {
        method: 'POST',
        body: { name: `Игрок ${index}`, email: `player-${index}@five.smoke`, password: `secure-player-${index}-password` },
      })
      assert.equal(registered.status, 201, registered.text)
      accountCookies.push(cookie(registered))
    }

    const created = await request(baseUrl, '/api/campaigns', {
      method: 'POST',
      cookie: accountCookies[0],
      body: {
        code: campaignId,
        name: 'Пять фонарей',
        bootstrap: {
          partyName: 'Пять фонарей',
          slotCount: 5,
          world: {
            preset: 'Классическое фэнтези',
            openingSituation: 'Пять путников встречаются у заставы перед исчезнувшей дорогой.',
          },
        },
      },
    })
    assert.equal(created.status, 201, created.text)
    assert.equal(created.body.state.players.length, 5)
    await importHero(baseUrl, accountCookies[0], 1)

    await withBrowser({ pageCount: 5, windowSize: { width: 1280, height: 800 } }, async (browser) => {
      await Promise.all(browser.pages.map((page, index) => setSession(page, baseUrl, accountCookies[index])))
      await browser.page(0).navigate(`${baseUrl}/?room=${campaignId}`)
      await browser.page(0).waitForSelector('.game-area', { timeoutMs: 30_000 })

      for (let index = 1; index < 4; index += 1) {
        const invite = await request(baseUrl, `/api/campaigns/${campaignId}/invites`, {
          method: 'POST', cookie: accountCookies[0], body: {},
        })
        assert.equal(invite.status, 201, invite.text)
        await browser.page(index).navigate(`${baseUrl}/?room=${campaignId}#invite=${encodeURIComponent(invite.body.token)}`)
        await browser.page(index).waitFor(() => location.hash === '' && location.search.includes('room=TABLE-FIVE'), {
          timeoutMs: 30_000,
          label: `player ${index + 1} joined`,
        })
        await importHero(baseUrl, accountCookies[index], index + 1)
        await browser.page(index).navigate(`${baseUrl}/?room=${campaignId}`)
        await browser.page(index).waitForSelector('.game-area', { timeoutMs: 30_000 })
      }
      protocol.push({ stage: 'intro-four', screenshots: await screenshotSet(browser, outputDir, '01-intro', [0, 1, 2, 3]) })

      const introAction = await pageRequest(browser.page(0), '/api/narrate', {
        method: 'POST',
        body: {
          campaign_id: campaignId,
          actor_id: 'hero-slot-1',
          action: 'Осматриваю заставу и рассказываю спутникам, что здесь изменилось.',
          idempotency_key: 'smoke-intro-action',
        },
      })
      assert.equal(introAction.status, 200, introAction.text)

      const lateInvite = await request(baseUrl, `/api/campaigns/${campaignId}/invites`, {
        method: 'POST', cookie: accountCookies[0], body: {},
      })
      assert.equal(lateInvite.status, 201, lateInvite.text)
      await browser.page(4).navigate(`${baseUrl}/?room=${campaignId}#invite=${encodeURIComponent(lateInvite.body.token)}`)
      await browser.page(4).waitFor(() => location.hash === '' && location.search.includes('room=TABLE-FIVE'), {
        timeoutMs: 30_000,
        label: 'late player joined',
      })
      await importHero(baseUrl, accountCookies[4], 5)
      await browser.page(4).navigate(`${baseUrl}/?room=${campaignId}`)
      await browser.page(4).waitForSelector('.game-area', { timeoutMs: 30_000 })
      await waitForRoom(baseUrl, accountCookies[0], (snapshot) => snapshot.state.presence.connected_heroes === 5, 'five online')
      protocol.push({ stage: 'late-join-five', screenshots: await screenshotSet(browser, outputDir, '02-late-join') })

      const noSeat = await request(baseUrl, `/api/campaigns/${campaignId}/invites`, {
        method: 'POST', cookie: accountCookies[0], body: {},
      })
      assert.equal(noSeat.status, 409, noSeat.text)
      protocol.push({ stage: 'all-seats-taken', result: noSeat.body.error })

      const freeInput = 'input[aria-label="Действие своими словами"]'
      await browser.page(1).type(freeInput, 'Формулирую общий план')
      await browser.page(0).waitFor(() => document.body.innerText.includes('Герой 2 формулирует намерение'), {
        timeoutMs: 10_000,
        label: 'typing visible to party',
      })
      protocol.push({ stage: 'typing', screenshots: await screenshotSet(browser, outputDir, '03-typing', [0, 1]) })
      await browser.page(1).type(freeInput, '')

      const concurrent = await Promise.all([
        pageRequest(browser.page(0), '/api/narrate', {
          method: 'POST',
          body: { campaign_id: campaignId, actor_id: 'hero-slot-1', action: 'Проверяю следы у ворот.', idempotency_key: 'smoke-race-a' },
        }),
        pageRequest(browser.page(1), '/api/narrate', {
          method: 'POST',
          body: { campaign_id: campaignId, actor_id: 'hero-slot-2', action: 'Осматриваю стены заставы.', idempotency_key: 'smoke-race-b' },
        }),
      ])
      assert.ok(concurrent.some((result) => result.status === 200), JSON.stringify(concurrent))
      assert.ok(concurrent.every((result) => [200, 409].includes(result.status)), JSON.stringify(concurrent))
      protocol.push({ stage: 'concurrent-intentions', statuses: concurrent.map((result) => result.status) })

      const voteOpened = await pageRequest(browser.page(0), '/api/narrate', {
        method: 'POST',
        body: {
          campaign_id: campaignId,
          actor_id: 'hero-slot-1',
          action: 'Предлагаю покинуть подземелье',
          idempotency_key: 'smoke-open-vote',
        },
      })
      assert.equal(voteOpened.status, 200, voteOpened.text)
      const openRoom = await waitForRoom(baseUrl, accountCookies[0], (snapshot) => snapshot.state.agentInteraction?.status === 'open', 'vote open')
      const interaction = openRoom.state.agentInteraction
      const optionId = interaction.options[0].id
      await Promise.all(browser.pages.map((page, index) => page.waitFor(
        () => Boolean(document.querySelector('.agent-interaction')),
        { timeoutMs: 10_000, label: `vote visible in browser ${index + 1}` },
      )))
      const voteLayouts = await Promise.all(browser.pages.map((page) => page.evaluate(() => {
        const panel = document.querySelector('.chat-panel')
        const slot = document.querySelector('.chat-interaction-slot')
        const card = document.querySelector('.agent-interaction')
        const messages = document.querySelector('.messages')
        const rect = (element) => element ? {
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
          height: element.getBoundingClientRect().height,
        } : null
        return {
          rows: panel ? getComputedStyle(panel).gridTemplateRows : null,
          slotDisplay: slot ? getComputedStyle(slot).display : null,
          panel: rect(panel),
          slot: rect(slot),
          card: rect(card),
          messages: rect(messages),
        }
      })))
      assert.ok(voteLayouts.every((layout) => (
        layout.card?.height > 0
        && layout.slot?.height > 0
        && layout.card.top >= layout.panel.top
        && layout.card.top < layout.panel.bottom
      )), JSON.stringify(voteLayouts))
      protocol.push({ stage: 'vote-open', screenshots: await screenshotSet(browser, outputDir, '04-vote', [0, 1, 2, 3, 4]) })
      await browser.page(0).evaluate(() => {
        const slot = document.querySelector('.chat-interaction-slot')
        if (slot) slot.scrollTop = slot.scrollHeight
      })
      await wait(150)
      protocol.push({ stage: 'vote-voters', screenshots: await screenshotSet(browser, outputDir, '04-voters', [0]) })

      const playerFourVote = await pageRequest(browser.page(3), `/api/campaigns/${campaignId}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
        method: 'POST',
        body: { actor_id: 'hero-slot-4', option_id: optionId, idempotency_key: 'smoke-vote-4' },
      })
      assert.equal(playerFourVote.status, 200, playerFourVote.text)
      await browser.page(3).close()
      const afterVoteDisconnect = await waitForRoom(
        baseUrl,
        accountCookies[0],
        (snapshot) => snapshot.state.players.find((player) => player.id === 'hero-slot-4')?.online === false
          && snapshot.state.agentInteraction?.abstainedVoterIds?.length > 0,
        'vote disconnect becomes explicit abstention',
      )
      protocol.push({
        stage: 'vote-disconnect',
        requiredVotes: afterVoteDisconnect.state.agentInteraction.requiredVotes,
        abstainedVoterIds: afterVoteDisconnect.state.agentInteraction.abstainedVoterIds,
      })
      await browser.reopenPage(3, `${baseUrl}/?room=${campaignId}`)
      await browser.page(3).waitForSelector('.game-area', { timeoutMs: 30_000 })

      for (let index = 0; index < 3; index += 1) {
        const voted = await pageRequest(browser.page(index), `/api/campaigns/${campaignId}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
          method: 'POST',
          body: { actor_id: `hero-slot-${index + 1}`, option_id: optionId, idempotency_key: `smoke-vote-${index + 1}` },
        })
        assert.equal(voted.status, 200, voted.text)
      }
      const resolvedVoteRoom = await waitForRoom(baseUrl, accountCookies[0], (snapshot) => snapshot.state.agentInteraction?.status === 'resolved', 'vote resolved')

      const encounter = await request(baseUrl, `/api/campaigns/${campaignId}/encounters/assemble`, {
        method: 'POST',
        cookie: adminCookie,
        body: {
          expected_state_version: resolvedVoteRoom.state.state_version,
          difficulty: 'easy',
          theme: 'raiders',
          seed: 'table-five-smoke',
          idempotency_key: 'smoke-create-encounter',
        },
      })
      assert.equal(encounter.status, 200, encounter.text)
      const beforeCombat = await room(baseUrl, adminCookie)
      if (!beforeCombat.state.mechanics?.combat?.active) {
        const start = await command(baseUrl, adminCookie, 'smoke-start-combat', {
          command_type: 'StartCombat',
          actor_id: beforeCombat.state.activePlayerId,
        })
        assert.equal(start.status, 200, start.text)
      }
      let combatRoom = await waitForRoom(baseUrl, accountCookies[0], (snapshot) => snapshot.state.mechanics?.combat?.active === true, 'combat active')
      protocol.push({ stage: 'combat', screenshots: await screenshotSet(browser, outputDir, '05-combat', [0, 1, 2, 3, 4]) })

      let activeCombatActor = combatRoom.state.mechanics.combat.initiative[combatRoom.state.mechanics.combat.active_index]?.actor_id
      for (let attempt = 0; attempt < 10 && !String(activeCombatActor).startsWith('hero-slot-'); attempt += 1) {
        await request(baseUrl, `/api/campaigns/${campaignId}/system-tick`, { method: 'POST', cookie: accountCookies[0], body: {} })
        combatRoom = await room(baseUrl, accountCookies[0])
        activeCombatActor = combatRoom.state.mechanics.combat.initiative[combatRoom.state.mechanics.combat.active_index]?.actor_id
      }
      assert.match(String(activeCombatActor), /^hero-slot-[1-5]$/u)
      const activePageIndex = Number(String(activeCombatActor).split('-').at(-1)) - 1
      const beforeDisconnectIndex = combatRoom.state.mechanics.combat.active_index
      await browser.page(activePageIndex).close()
      await waitForRoom(baseUrl, accountCookies[0], (snapshot) => snapshot.state.players.find((player) => player.id === activeCombatActor)?.online === false, 'active combat player offline')
      const heldCombat = await room(baseUrl, accountCookies[0])
      assert.equal(heldCombat.state.mechanics.combat.active_index, beforeDisconnectIndex)
      await browser.reopenPage(activePageIndex, `${baseUrl}/?room=${campaignId}`)
      await browser.page(activePageIndex).waitForSelector('.game-area', { timeoutMs: 30_000 })

      const durableBeforeRestart = await room(baseUrl, accountCookies[0])
      await stopServer(server)
      server = startServer(port, storage, (chunk) => { logs += chunk })
      await waitForHealth(baseUrl, server, () => logs)
      const durableAfterRestart = await room(baseUrl, accountCookies[0])
      assert.equal(durableAfterRestart.state.state_version, durableBeforeRestart.state.state_version)
      assert.equal(durableAfterRestart.state.mechanics.combat.active_index, durableBeforeRestart.state.mechanics.combat.active_index)
      assert.deepEqual(durableAfterRestart.state.mechanics.combat.initiative, durableBeforeRestart.state.mechanics.combat.initiative)
      await Promise.all(browser.pages.map((page) => page.waitFor(async (id) => {
        const response = await fetch(`/api/rooms/${id}`)
        return response.ok
      }, { args: [campaignId], timeoutMs: 30_000, label: 'browser reconnect after restart' })))
      protocol.push({ stage: 'restart-in-combat', screenshots: await screenshotSet(browser, outputDir, '06-restart', [0, activePageIndex]) })

      const activeAfterRestart = durableAfterRestart.state.mechanics.combat.initiative[durableAfterRestart.state.mechanics.combat.active_index]?.actor_id
      const ended = await command(baseUrl, adminCookie, 'smoke-end-combat', {
        command_type: 'EndCombat',
        actor_id: activeAfterRestart,
        reason: 'приёмочный прогон',
      })
      assert.equal(ended.status, 200, ended.text)

      const beforeShop = await room(baseUrl, adminCookie)
      const shop = await request(baseUrl, `/api/campaigns/${campaignId}/merchants/assemble`, {
        method: 'POST',
        cookie: adminCookie,
        body: {
          expected_state_version: beforeShop.state.state_version,
          settlement_type: 'traveling',
          theme: 'general',
          seed: 'table-five-shop',
          budget_cp: 5_000,
          idempotency_key: 'smoke-create-shop',
        },
      })
      assert.equal(shop.status, 200, shop.text)
      const shopRoom = await room(baseUrl, accountCookies[0])
      const merchantId = shopRoom.state.merchants.find((merchant) => merchant.available)?.id
      assert.ok(merchantId)
      const merchantView = await pageRequest(browser.page(0), `/api/campaigns/${campaignId}/merchants/${encodeURIComponent(merchantId)}?actor_id=hero-slot-1`)
      assert.equal(merchantView.status, 200, merchantView.text)
      const bargained = await pageRequest(browser.page(0), `/api/campaigns/${campaignId}/merchants/${encodeURIComponent(merchantId)}/commands`, {
        method: 'POST',
        body: {
          idempotency_key: 'smoke-bargain',
          command: {
            command_type: 'BargainWithMerchant',
            actor_id: 'hero-slot-1',
            merchant_id: merchantId,
            expected_state_version: merchantView.body.merchant_view.expected_state_version,
          },
        },
      })
      assert.equal(bargained.status, 200, bargained.text)
      await browser.page(0).navigate(`${baseUrl}/?room=${campaignId}`)
      await browser.page(0).waitForSelector('.scene-merchant', { timeoutMs: 30_000 })
      await browser.page(0).click('.scene-merchant')
      await browser.page(0).waitForSelector('.merchant-backdrop', { timeoutMs: 30_000 })
      await browser.page(0).waitFor(
        () => Boolean(document.querySelector('.merchant-item')) && !document.querySelector('.merchant-loading'),
        { timeoutMs: 30_000, label: 'merchant quotes visible' },
      )
      protocol.push({ stage: 'trade', screenshots: await screenshotSet(browser, outputDir, '07-trade', [0]) })
      await browser.page(0).navigate(`${baseUrl}/?room=${campaignId}`)

      const resolvedInteraction = (await room(baseUrl, accountCookies[0])).state.agentInteraction
      const winner = resolvedInteraction.options.find((option) => option.id === resolvedInteraction.resolvedOptionId)
      const sceneBeforeTransition = (await room(baseUrl, accountCookies[0])).state.scene
      const previousLocation = sceneBeforeTransition.location_id ?? sceneBeforeTransition.location
      const transitioned = await pageRequest(browser.page(0), '/api/narrate', {
        method: 'POST',
        body: {
          campaign_id: campaignId,
          actor_id: 'hero-slot-1',
          action: `[РЕШЕНИЕ ГРУППЫ] ${resolvedInteraction.title}: ${winner.label}. ${resolvedInteraction.resolutionPrompt}`,
          idempotency_key: 'smoke-scene-transition',
        },
      })
      assert.equal(transitioned.status, 200, transitioned.text)
      await waitForRoom(baseUrl, accountCookies[0], (snapshot) => (snapshot.state.scene.location_id ?? snapshot.state.scene.location) !== previousLocation, 'scene transitioned', 30_000)
      await Promise.all(browser.pages.map((page) => page.navigate(`${baseUrl}/?room=${campaignId}`)))
      await Promise.all(browser.pages.map((page) => page.waitForSelector('.game-area', { timeoutMs: 30_000 })))
      protocol.push({ stage: 'scene-transition', screenshots: await screenshotSet(browser, outputDir, '08-transition') })
    })

    const report = {
      ok: true,
      campaign: campaignId,
      browsers: 5,
      storage: 'temporary',
      serverRestarted: true,
      protocol,
      knownDeferred: [
        'Обрыв во время открытого голосования по закреплённой policy считается воздержанием; повторно проголосовать в том же решении нельзя.',
        'Отключившийся активный герой удерживает боевой ход до возвращения; автоматический пропуск требует отдельной продуктовой policy.',
        'Приглашения одноразовые и закрепляют одно место: владелец создаёт отдельную ссылку для каждого гостя.',
      ],
    }
    await writeFile(join(outputDir, 'protocol.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await stopServer(server)
    await rm(storage, { recursive: true, force: true })
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})
