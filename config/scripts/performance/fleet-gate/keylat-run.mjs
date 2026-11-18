#!/usr/bin/env node
// Fleet-scale perf gate: OLD vs NEW on a ~1,900-workspace synthetic profile. Usage: docs/readme/fleet-perf-gate.md.
import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { hotPathChanges } from './fleet-gate-hot-paths.mjs'
import { installMainProbeIn, resetMainProbe, snapshotMainProbe } from './fleet-gate-main-probe.mjs'
import { installRendererProbe } from './fleet-gate-renderer-probe.mjs'
import { burstRows, compareRuns, formatTable, windowMetrics } from './fleet-gate-report.mjs'
import {
  BURST_CHATS,
  continueAfterRestart,
  countLaunches,
  countOwnershipRefusals,
  createChatBurst,
  startCpuLoad,
  pointClaudeAtStub,
  waitForLaunches,
  writeClaudeStub
} from './fleet-gate-launch-burst.mjs'
import { SCENARIOS, seedAgentStatuses, hookEndpointMtime, readHookEndpoint } from './fleet-gate-scenarios.mjs'
import {
  buildSyntheticFleetSeed,
  readFleetCensus,
  readSeedReceipt
} from './fleet-gate-synthetic-seed.mjs'

const CACHE_ROOT =
  process.env.ORCA_FLEET_GATE_CACHE ?? path.join(os.homedir(), '.cache', 'item130-keylat')
const KEEP_BUILDS = 4
const KEEP_SEEDS = 2
// Idle agents spread over this many workspaces; the #42104 report had ~500 keyed statuses on ~1,900 workspaces.
const AGENT_PANES = 200

function parseArgs(argv) {
  const options = {
    old: null,
    new: 'HEAD',
    seed: process.env.ORCA_FLEET_SEED_DIR ?? null,
    runs: 2,
    settleMs: 120_000,
    windowMs: 30_000,
    idleWindowMs: 60_000,
    scenarios: [...Object.keys(SCENARIOS), 'burst'],
    force: false,
    pathsOnly: false,
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      index += 1
      if (argv[index] === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      return argv[index]
    }
    const setters = {
      '--old': () => (options.old = value()),
      '--new': () => (options.new = value()),
      '--seed': () => (options.seed = path.resolve(value())),
      '--runs': () => (options.runs = Number(value())),
      '--settle-ms': () => (options.settleMs = Number(value())),
      '--window-ms': () => (options.windowMs = Number(value())),
      '--idle-window-ms': () => (options.idleWindowMs = Number(value())),
      '--scenarios': () => (options.scenarios = value().split(',').filter(Boolean)),
      '--out': () => (options.out = path.resolve(value())),
      '--force': () => (options.force = true),
      '--paths-only': () => (options.pathsOnly = true),
      '--': () => {}
    }
    if (!setters[arg]) {
      throw new Error(`unknown argument ${arg}`)
    }
    setters[arg]()
  }
  for (const name of options.scenarios) {
    if (!SCENARIOS[name] && name !== 'burst') {
      throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
    }
  }
  return options
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const gitOptional = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function run(command, args, cwd, logFile) {
  const fd = fs.openSync(logFile, 'a')
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: process.env })
  fs.closeSync(fd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (log ${logFile})`)
  }
}

/** One e2e-mode build per commit, cached; a --shared clone, so nothing registers as a worktree of the checkout. */
function ensureBuild(repoRoot, sha) {
  const buildsDir = path.join(CACHE_ROOT, 'builds')
  const dir = path.join(buildsDir, sha)
  const marker = path.join(dir, '.fleet-gate-built')
  if (fs.existsSync(marker)) {
    fs.utimesSync(marker, new Date(), new Date())
    return dir
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(buildsDir, { recursive: true })
  const log = path.join(buildsDir, `${sha}.log`)
  fs.writeFileSync(log, '')
  console.log(`[fleet-gate] building ${sha.slice(0, 12)} (log ${log})`)
  // A PR head or scratch commit may not be local yet; fetch it by id so --old/--new take any pushed commit.
  if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot }).status !== 0) {
    run('git', ['fetch', '--quiet', 'origin', sha], repoRoot, log)
  }
  run('git', ['clone', '--quiet', '--shared', '--no-checkout', repoRoot, dir], buildsDir, log)
  // A blobless source repo leaves new blobs unfetched; let the clone fetch them from the same origin on checkout.
  const filter = gitOptional(repoRoot, ['config', '--get', 'remote.origin.partialclonefilter'])
  if (filter) {
    run(
      'git',
      ['config', 'remote.origin.url', git(repoRoot, ['remote', 'get-url', 'origin'])],
      dir,
      log
    )
    run('git', ['config', 'remote.origin.promisor', 'true'], dir, log)
    run('git', ['config', 'remote.origin.partialclonefilter', filter], dir, log)
  }
  run('git', ['checkout', '--quiet', '--detach', sha], dir, log)
  if (git(dir, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error(`checkout of ${sha.slice(0, 12)} is incomplete in ${dir} (log ${log})`)
  }
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir, log)
  run('pnpm', ['run', 'build:packages'], dir, log)
  run(
    process.execPath,
    ['config/scripts/desktop-build/execution/run-electron-vite-build.mjs', '--mode', 'e2e'],
    dir,
    log
  )
  run('pnpm', ['run', 'ensure:electron-runtime'], dir, log)
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  pruneCache(buildsDir, '.fleet-gate-built', KEEP_BUILDS, new Set([dir]))
  return dir
}

function pruneCache(parentDir, markerName, keepCount, keep) {
  const entries = fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name))
    .map((dir) => ({
      dir,
      mtime: fs.statSync(path.join(dir, markerName), { throwIfNoEntry: false })?.mtimeMs ?? 0
    }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { dir } of entries.slice(keepCount)) {
    if (!keep.has(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

// Hidden windows never paint, so clicks and screenshots stall; on Linux the copy gets its own Xvfb, never a real desktop.
let virtualDisplay = null

function findOnPath(binary) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary)
    if (dir && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

async function startVirtualDisplay() {
  const xvfb = process.platform === 'linux' ? findOnPath('Xvfb') : null
  if (!xvfb) {
    return null
  }
  let number = 140 + Math.floor(Math.random() * 400)
  while (fs.existsSync(`/tmp/.X11-unix/X${number}`) || fs.existsSync(`/tmp/.X${number}-lock`)) {
    number += 1
  }
  const child = spawn(xvfb, [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], {
    stdio: 'ignore'
  })
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(`/tmp/.X11-unix/X${number}`)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL')
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { display: `:${number}`, stop: () => child.kill('SIGTERM') }
}

function launchArgs(buildDir) {
  const keychain = ['--password-store=basic', '--use-mock-keychain']
  if (process.platform !== 'linux') {
    return [...keychain, buildDir]
  }
  // Pin X11 on Xvfb: Electron otherwise follows the session's Wayland hints and fails without a compositor.
  const display = virtualDisplay ? ['--ozone-platform=x11'] : ['--ozone-platform=headless']
  return [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    ...display,
    ...keychain,
    buildDir
  ]
}

function isolatedEnv(runDir, userDataDir) {
  const home = path.join(runDir, 'home')
  for (const dir of [
    '',
    '.config',
    '.cache',
    '.local/share',
    '.local/state',
    '.claude',
    '.codex'
  ]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  }
  // Drop the launching Orca's own values so the copy never attaches to it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('ORCA_') &&
        ![
          'ELECTRON_RUN_AS_NODE',
          'NODE_OPTIONS',
          'WAYLAND_DISPLAY',
          'DISPLAY',
          'XDG_SESSION_TYPE',
          'ELECTRON_OZONE_PLATFORM_HINT'
        ].includes(key)
    )
  )
  return {
    ...env,
    ...(virtualDisplay
      ? { DISPLAY: virtualDisplay.display, ORCA_E2E_HEADFUL: '1' }
      : { ORCA_E2E_HEADLESS: '1' }),
    NODE_ENV: 'development',
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_E2E_USER_DATA_DIR: userDataDir,
    ORCA_E2E_HOME_DIR: home,
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex')
  }
}

const READY_TIMEOUT_MS = 300_000

function readWindowState() {
  return {
    url: location.href,
    hasApi: Boolean(window.api),
    hasStore: Boolean(window.__store),
    ready: window.__store?.getState().workspaceSessionReady ?? null,
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)
  }
}

/** The session-ready app window; on timeout, writes what every window showed so one run explains the failure. */
async function waitForAppWindow(app, { label, userDataDir, outDir, stderrTail }) {
  const consoleErrors = []
  const watch = (page) =>
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text().slice(0, 300))
        consoleErrors.splice(0, Math.max(0, consoleErrors.length - 20))
      }
    })
  await app.firstWindow({ timeout: 180_000 })
  app.windows().forEach(watch)
  app.on('window', watch)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const ready = await page
        .evaluate(() => window.__store?.getState().workspaceSessionReady === true)
        .catch(() => false)
      if (ready) {
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  const windows = []
  for (const page of app.windows()) {
    windows.push(await page.evaluate(readWindowState).catch((error) => ({ error: String(error) })))
  }
  fs.mkdirSync(outDir, { recursive: true })
  const stem = path.join(outDir, `not-ready-${label}-${Date.now()}`)
  await app
    .windows()[0]
    ?.screenshot({ path: `${stem}.png` })
    .catch(() => {})
  const userDataFiles = fs.readdirSync(userDataDir).slice(0, 40)
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({ windows, consoleErrors, stderrTail, userDataFiles }, null, 2)}\n`
  )
  console.log(`[fleet-gate] ${label} never became ready: ${JSON.stringify(windows).slice(0, 600)}`)
  console.log(
    `[fleet-gate] console errors: ${JSON.stringify(consoleErrors.slice(-5)).slice(0, 600)}`
  )
  console.log(`[fleet-gate] stderr tail: ${JSON.stringify(stderrTail.slice(-8)).slice(0, 800)}`)
  throw new Error(`${label} not session-ready after ${READY_TIMEOUT_MS / 1000}s (${stem}.json)`)
}

/** Launches one hidden copy on userDataDir; close() quits it (gracefully first) and is safe to call twice. */
async function launchCopy({ buildDir, runDir, userDataDir, label, outDir, extraEnv = {} }) {
  const executablePath = createRequire(path.join(buildDir, 'package.json'))('electron')
  const app = await electron.launch({
    executablePath,
    args: launchArgs(buildDir),
    env: { ...isolatedEnv(runDir, userDataDir), ...extraEnv },
    timeout: 180_000
  })
  // Captured now: app.process() throws once the app object is closed.
  const child = app.process()
  const stderrTail = []
  let ownershipText = ''
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    if (/provider process ownership/i.test(text)) {
      ownershipText += text
    }
    stderrTail.push(...text.split('\n').filter(Boolean))
    stderrTail.splice(0, Math.max(0, stderrTail.length - 40))
  })
  let closed = false
  const close = async () => {
    if (closed) {
      return
    }
    closed = true
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 30_000))
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  try {
    const page = await waitForAppWindow(app, { label, userDataDir, outDir, stderrTail })
    return { app, page, close, ownershipText: () => ownershipText }
  } catch (error) {
    await close()
    throw error
  }
}

/** A seed made by the OLD build, so NEW only ever opens it forward, as an upgrade would. */
async function ensureSeed({ oldSha, oldBuild, outDir }) {
  const seedsDir = path.join(CACHE_ROOT, 'seeds')
  const seedDir = path.join(seedsDir, oldSha)
  const existing = readSeedReceipt(seedDir)
  if (existing) {
    fs.utimesSync(path.join(seedDir, '.fleet-seed.json'), new Date(), new Date())
    return { seedDir, receipt: existing }
  }
  console.log(`[fleet-gate] seeding a synthetic fleet with ${oldSha.slice(0, 12)}`)
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fleet-seed-'))
  try {
    const receipt = await buildSyntheticFleetSeed({
      seedDir,
      corpusDir: path.join(CACHE_ROOT, 'corpus'),
      builtBy: oldSha,
      launch: (userDataDir) =>
        launchCopy({ buildDir: oldBuild, runDir, userDataDir, label: 'seed', outDir })
    })
    console.log(`[fleet-gate] seed ${JSON.stringify(receipt)}`)
    pruneCache(seedsDir, '.fleet-seed.json', KEEP_SEEDS, new Set([seedDir]))
    return { seedDir, receipt }
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true })
  }
}

// ---- item130 key-latency probe (scratch) ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pct(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10
}

function summarize(values) {
  return { n: values.filter(Number.isFinite).length, p50: pct(values, 50), p95: pct(values, 95), max: pct(values, 100) }
}

async function focusDiagnostics(page, outDir, label) {
  await page.screenshot({ path: path.join(outDir, `${label}-nofocus.png`) }).catch(() => {})
  return page.evaluate(() => {
    const state = window.__store.getState()
    const withTabs = Object.entries(state.tabsByWorktree ?? {}).filter(
      ([, tabs]) => Array.isArray(tabs) && tabs.length > 0
    )
    return {
      activeWorktreeId: state.activeWorktreeId,
      activeView: state.activeView ?? null,
      activeTabId: state.activeTabId ?? null,
      worktreesWithTabs: withTabs.length,
      firstWithTabs: withTabs[0]?.[0] ?? null,
      activateFns: Object.keys(state).filter((key) => /activ|setActive/i.test(key) && typeof state[key] === 'function').slice(0, 30),
      xterms: document.querySelectorAll('.xterm').length,
      helpers: document.querySelectorAll('.xterm-helper-textarea').length,
      visibleXterms: [...document.querySelectorAll('.xterm')].filter((el) => el.getClientRects().length).length,
      size: [innerWidth, innerHeight],
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeElement: document.activeElement?.tagName + '.' + String(document.activeElement?.className ?? '').slice(0, 60),
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400)
    }
  })
}

async function focusTerminal(page) {
  await page.evaluate(() => {
    const state = window.__store.getState()
    const withTerminal = Object.entries(state.tabsByWorktree ?? {}).find(
      ([, tabs]) => Array.isArray(tabs) && tabs.some((tab) => tab.type === undefined || tab.type === 'terminal' || tab.kind === 'terminal')
    ) ?? Object.entries(state.tabsByWorktree ?? {}).find(([, tabs]) => Array.isArray(tabs) && tabs.length > 0)
    if (withTerminal && state.activeWorktreeId !== withTerminal[0]) {
      state.setActiveWorktree(withTerminal[0])
    }
    const tabs = state.tabsByWorktree?.[withTerminal?.[0]] ?? []
    if (tabs[0]?.id && typeof state.setActiveTab === 'function') {
      state.setActiveTab(tabs[0].id)
    }
    if (typeof state.setActiveView === 'function' && state.activeView && state.activeView !== 'terminal') {
      state.setActiveView('terminal')
    }
  })
  await sleep(4_000)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape')
    await sleep(300)
  }
  const ok = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('.xterm-helper-textarea')].find(
      (element) => element.closest('.xterm')?.getClientRects().length
    )
    if (!visible) {
      return false
    }
    document.querySelectorAll('[data-keylat-input]').forEach((el) => el.removeAttribute('data-keylat-input'))
    visible.setAttribute('data-keylat-input', '1')
    return true
  })
  if (!ok) {
    return false
  }
  await page.locator('[data-keylat-input="1"]').first().focus()
  return page.evaluate(() => document.activeElement?.getAttribute('data-keylat-input') === '1')
}

function installMarkers() {
  const samples = []
  const pending = new Map()
  let textarea = document.querySelector('[data-keylat-input="1"]')
  const onDocCapture = (event) => {
    if (event.target !== textarea || !event.isTrusted) {
      return
    }
    pending.set(event, { ts: event.timeStamp, docCapture: performance.now() })
  }
  const onTarget = (event) => {
    const row = pending.get(event)
    if (!row) {
      return
    }
    row.dispatched = performance.now()
    samples.push(row)
    // First frame after the key.
    requestAnimationFrame(() => {
      row.raf = performance.now()
    })
  }
  document.addEventListener('keydown', onDocCapture, true)
  textarea.addEventListener('keydown', onTarget)
  const events = []
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'keydown' || entry.name === 'keypress' || entry.name === 'keyup') {
        events.push({
          name: entry.name,
          startTime: entry.startTime,
          processingStart: entry.processingStart,
          processingEnd: entry.processingEnd,
          duration: entry.duration
        })
      }
    }
  })
  observer.observe({ type: 'event', durationThreshold: 16, buffered: false })
  const loafs = []
  const loafObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      loafs.push({
        startTime: entry.startTime,
        duration: entry.duration,
        blockingDuration: entry.blockingDuration,
        renderStart: entry.renderStart,
        styleAndLayoutStart: entry.styleAndLayoutStart,
        scripts: (entry.scripts ?? []).slice(0, 6).map((script) => ({
          invoker: script.invoker,
          duration: Math.round(script.duration),
          forced: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
          source: `${script.sourceFunctionName ?? ''} ${String(script.sourceURL ?? '').split('/').pop()}:${script.sourceCharPosition ?? ''}`
        }))
      })
    }
  })
  try {
    loafObserver.observe({ type: 'long-animation-frame', buffered: false })
  } catch {}
  globalThis.__keylatMarkers = {
    retarget() {
      const next = document.querySelector('[data-keylat-input="1"]')
      if (next && next !== textarea) {
        textarea?.removeEventListener('keydown', onTarget)
        textarea = next
        textarea.addEventListener('keydown', onTarget)
      }
    },
    collect() {
      observer.disconnect()
      loafObserver.disconnect()
      document.removeEventListener('keydown', onDocCapture, true)
      textarea.removeEventListener('keydown', onTarget)
      return { samples, events, loafs }
    }
  }
}

async function startLiveAgents(page, userDataDir) {
  const result = await page.evaluate(async () => {
    const state = window.__store.getState()
    const active = state.activeWorktreeId
    const list = await window.api.runtime.call({ method: 'worktree.list', params: { limit: 5000 } })
    const worktrees = (list.result?.worktrees ?? []).filter((worktree) => worktree.id !== active && /wt-\d{4}$/.test(worktree.path)).slice(-5)
    let started = 0
    const errors = []
    for (const worktree of worktrees) {
      const created = await window.api.runtime.call({
        method: 'terminal.create',
        params: {
          worktree: `id:${worktree.id}`,
          clientMutationId: crypto.randomUUID(),
          command: "while :; do printf 'agent %s working on step %s of the plan\\n' $$ $RANDOM; sleep 0.03; done"
        }
      })
      if (created.ok) {
        started += 1
      } else {
        errors.push(`create ${JSON.stringify(created.error ?? created).slice(0, 200)}`)
      }
    }
    return { worktrees: worktrees.length, started, errors: errors.slice(0, 3), stillActive: window.__store.getState().activeWorktreeId === active }
  })
  let stop = false
  const endpoint = readHookEndpoint(userDataDir)
  const panes = await page.evaluate(() => {
    const state = window.__store.getState()
    const out = []
    for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        const leafId = state.terminalLayoutsByTabId?.[tab.id]?.activeLeafId
        if (leafId && out.length < 10) out.push({ worktreeId, paneKey: `${tab.id}:${leafId}` })
      }
    }
    return out
  })
  const TURN = [
    { hook_event_name: 'UserPromptSubmit', prompt: 'keylat turn' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'Stop', last_assistant_message: 'done' }
  ]
  let posted = 0
  const loop = (async () => {
    if (!endpoint?.ORCA_AGENT_HOOK_PORT || panes.length === 0) return
    while (!stop) {
      const pane = panes[posted % panes.length]
      const payload = TURN[Math.floor(posted / panes.length) % TURN.length]
      await fetch(`http://127.0.0.1:${endpoint.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': endpoint.ORCA_AGENT_HOOK_TOKEN },
        body: JSON.stringify({
          paneKey: pane.paneKey,
          tabId: pane.paneKey.split(':')[0],
          worktreeId: pane.worktreeId,
          env: endpoint.ORCA_AGENT_HOOK_ENV,
          version: endpoint.ORCA_AGENT_HOOK_VERSION,
          payload: { session_id: `keylat-${pane.paneKey}`, ...payload }
        })
      }).catch(() => {})
      posted += 1
      await sleep(50)
    }
  })()
  return {
    info: { ...result, hookPanes: panes.length, hookEndpoint: Boolean(endpoint?.ORCA_AGENT_HOOK_PORT) },
    async stop() {
      stop = true
      await loop
      return posted
    }
  }
}

async function measureKeys({ label, buildDir, seedDir, options, runDir, outDir }) {
  const userDataDir = path.join(runDir, 'user-data')
  fs.cpSync(seedDir, userDataDir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
  const launchedAt = Date.now()
  const { app, page, close } = await launchCopy({ buildDir, runDir, userDataDir, label, outDir })
  const result = { label, notes: [] }
  try {
    for (let waited = 0; waited < 60 && hookEndpointMtime(userDataDir) < launchedAt; waited += 1) {
      await sleep(1_000)
    }
    result.hookEndpointFresh = hookEndpointMtime(userDataDir) >= launchedAt
    result.terminalsAdded = await page.evaluate(async () => {
      const state = window.__store.getState()
      const existing = Object.values(state.tabsByWorktree ?? {}).filter((tabs) => Array.isArray(tabs) && tabs.length > 0).length
      if (existing >= 20) {
        return { existing, created: 0 }
      }
      const list = await window.api.runtime.call({ method: 'worktree.list', params: { limit: 5000 } })
      const worktrees = (list.result?.worktrees ?? [])
        .filter((worktree) => /wt-\d{4}\/?$/.test(worktree.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .slice(0, 40)
      let created = 0
      let firstError = null
      for (const worktree of worktrees) {
        const response = await window.api.runtime.call({
          method: 'terminal.create',
          params: { worktree: `id:${worktree.id}`, clientMutationId: crypto.randomUUID() }
        })
        if (response.ok) {
          created += 1
        } else if (!firstError) {
          firstError = JSON.stringify(response.error ?? response).slice(0, 300)
        }
      }
      return { existing, listed: worktrees.length, created, firstError, samplePath: list.result?.worktrees?.[0]?.path ?? null }
    })
    console.log(`[keylat] ${label} terminals ${JSON.stringify(result.terminalsAdded)}`)
    await sleep(5_000)
    const agents = await seedAgentStatuses({ page, userDataDir, count: AGENT_PANES })
    result.agentStatuses = agents
    console.log(`[keylat] ${label} up; settling ${options.settleMs / 1000}s`)
    await sleep(options.settleMs)
    result.census = await readFleetCensus(page)
    if (!(await focusTerminal(page))) {
      result.notes.push('could not focus a terminal textarea')
      result.focusDiagnostics = await focusDiagnostics(page, outDir, label).catch((error) => String(error))
      console.log(`[keylat] focus diagnostics ${JSON.stringify(result.focusDiagnostics)}`)
      return result
    }
    const live = options.live ? await startLiveAgents(page, userDataDir) : null
    result.live = live?.info ?? null
    await sleep(3_000)
    await page.locator('[data-keylat-input="1"]').first().focus()
    await page.evaluate(installMarkers)
    await page.evaluate(() => {
      window.__orcaTypingDiagnostic?.start()
      globalThis.__keylat?.start()
    })
    const cdp = await page.context().newCDPSession(page)
    if (options.profile) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }
    const segments = []
    const menuCalls = async () =>
      page.evaluate(() =>
        (globalThis.__keylat?.snapshot() ?? [])
          .filter((row) => row.site.startsWith('[document capture keydown] handleKeyDown'))
          .reduce((sum, row) => sum + row.n, 0)
      )
    const typeSegment = async (name, count) => {
      const before = await menuCalls()
      for (let index = 0; index < count; index += 1) {
        await page.keyboard.press(index % 25 === 24 ? 'Backspace' : 'a')
        await sleep(options.keyIntervalMs)
        if (options.focusSwitches && index % 30 === 15) {
          switches.push(await (switches.length % 2 === 0 ? appSwitch() : browserSwitch()))
        }
      }
      segments.push({ name, keys: count, menuListenerCallsPerKey: Math.round(((await menuCalls()) - before) / count) })
    }
    const switches = []
    const worktreeId = await page.evaluate(() => window.__store.getState().activeWorktreeId)
    const terminalTabId = await page.evaluate(() => window.__store.getState().getActiveTab?.()?.id ?? null)
    const refocusTerminal = async () => {
      await page.evaluate(() => {
        document.querySelectorAll('[data-keylat-input]').forEach((el) => el.removeAttribute('data-keylat-input'))
        const visible = [...document.querySelectorAll('.xterm-helper-textarea')].find(
          (element) => element.closest('.xterm')?.getClientRects().length
        )
        visible?.setAttribute('data-keylat-input', '1')
      })
      await page.locator('[data-keylat-input="1"]').first().focus({ timeout: 3_000 }).catch(() => {})
      await page.evaluate(() => globalThis.__keylatMarkers?.retarget?.())
    }
    // App switch away and back: the window's own blur/focus handlers, without OS activation.
    const appSwitch = async () => {
      const started = Date.now()
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        win?.emit('blur')
      })
      await page.evaluate(() => {
        document.activeElement?.blur?.()
        window.dispatchEvent(new FocusEvent('blur'))
      })
      await sleep(400)
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        win?.emit('focus')
      })
      await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
      await refocusTerminal()
      const backOnTerminal = await page.evaluate(() => document.activeElement?.getAttribute('data-keylat-input') === '1')
      return { kind: 'app', ms: Date.now() - started, backOnTerminal }
    }
    let browserReady = null
    const browserSwitch = async () => {
      const started = Date.now()
      if (browserReady === null) {
        browserReady = await page.evaluate((id) => {
          try {
            window.__store.getState().createBrowserTab(id, 'about:blank')
            return true
          } catch (error) {
            return String(error?.message ?? error).slice(0, 200)
          }
        }, worktreeId)
      } else {
        await page.evaluate((id) => window.__store.getState().setActiveTabType('browser', id), worktreeId)
      }
      await sleep(600)
      const webviewFocused = await page
        .locator('webview')
        .first()
        .focus({ timeout: 1_000 })
        .then(() => true)
        .catch(() => false)
      await sleep(300)
      await page.evaluate(
        ({ id, tab }) => {
          const state = window.__store.getState()
          if (tab && typeof state.activateTab === 'function') {
            state.activateTab(tab)
          } else {
            state.setActiveTabType('terminal', id)
          }
        },
        { id: worktreeId, tab: terminalTabId }
      )
      await sleep(500)
      await refocusTerminal()
      const backOnTerminal = await page.evaluate(() => document.activeElement?.getAttribute('data-keylat-input') === '1')
      return { kind: 'browser', ms: Date.now() - started, browserReady, webviewFocused, backOnTerminal }
    }
    await typeSegment('steady', Math.round(options.keys / 2))
    await typeSegment('with-switches', options.keys - Math.round(options.keys / 2))
    if (options.focusSwitches) {
      // Use the app: switch workspaces a few times, then come back and type again.
      await page.evaluate(async (home) => {
        const state = window.__store.getState()
        const ids = Object.keys(state.tabsByWorktree ?? {}).filter((id) => id !== home).slice(0, 6)
        for (const id of ids) {
          window.__store.getState().setActiveWorktree(id)
          await new Promise((resolve) => setTimeout(resolve, 700))
        }
        window.__store.getState().setActiveWorktree(home)
      }, worktreeId)
      await sleep(2_000)
      await refocusTerminal()
      await typeSegment('after-workspace-switches', 40)
    }
    result.segments = segments
    result.switches = switches
    await sleep(1_000)
    if (options.profile) {
      const { profile } = await cdp.send('Profiler.stop')
      fs.writeFileSync(path.join(outDir, `${label}.cpuprofile`), JSON.stringify(profile))
    }
    // Clear the typed line so the shell stays tidy.
    await page.keyboard.press('Control+U').catch(() => {})
    result.livePosted = live ? await live.stop() : 0
    const collected = await page.evaluate(() => globalThis.__keylatMarkers.collect())
    const report = await page.evaluate(() => {
      const value = window.__orcaTypingDiagnostic?.report()
      window.__orcaTypingDiagnostic?.stop()
      return JSON.parse(JSON.stringify(value ?? null))
    })
    result.listeners = await page.evaluate(() => {
      globalThis.__keylat?.stop()
      return globalThis.__keylat?.snapshot() ?? null
    })
    const samples = collected.samples
    result.markers = {
      keys: samples.length,
      eventToDocCapture: summarize(samples.map((s) => s.docCapture - s.ts)),
      docCaptureToDispatch: summarize(samples.map((s) => s.dispatched - s.docCapture)),
      eventToDispatch: summarize(samples.map((s) => s.dispatched - s.ts)),
      eventToFirstFrame: summarize(samples.map((s) => (s.raf ?? Number.NaN) - s.ts))
    }
    result.diagnosticShape = report ? Object.keys(report).slice(0, 40) : null
    result.diagnosticHead = report ? JSON.stringify(report).slice(0, 1500) : null
    const exact = report?.exactSamples ?? report?.samples?.exact ?? []
    result.diagnostic = {
      exactInputs: report?.exactInputs ?? null,
      eventToHandler: summarize(exact.map((s) => s.eventToHandlerMs ?? Number.NaN)),
      inputToDispatch: summarize(exact.map((s) => s.inputToDispatchMs)),
      keyToDispatch: summarize(exact.map((s) => (s.eventToHandlerMs ?? Number.NaN) + s.inputToDispatchMs)),
      eventToPaint: summarize(exact.map((s) => s.eventToPaintMs ?? Number.NaN))
    }
    const keydowns = collected.events.filter((e) => e.name === 'keydown')
    result.eventTiming = {
      over16: keydowns.length,
      queue: summarize(keydowns.map((e) => e.processingStart - e.startTime)),
      handler: summarize(keydowns.map((e) => e.processingEnd - e.processingStart)),
      afterHandler: summarize(keydowns.map((e) => e.startTime + e.duration - e.processingEnd)),
      duration: summarize(keydowns.map((e) => e.duration))
    }
    result.loafs = collected.loafs.sort((a, b) => b.duration - a.duration).slice(0, 8)
    result.rawSamples = samples.slice(0, 400)
    result.rawEvents = collected.events.slice(0, 400)
  } finally {
    await close()
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  return result
}

async function keylatMain() {
  const args = process.argv.slice(2)
  const get = (name, fallback) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const builds = get('--builds', '').split(',').filter(Boolean).map((spec) => {
    const [label, ref] = spec.split('=')
    return { label, sha: git(repoRoot, ['rev-parse', `${ref}^{commit}`]) }
  })
  const options = {
    settleMs: Number(get('--settle-ms', '60000')),
    keys: Number(get('--keys', '150')),
    keyIntervalMs: Number(get('--key-interval-ms', '120')),
    runs: Number(get('--runs', '2')),
    live: get('--live', '1') === '1',
    profile: get('--profile', '1') === '1',
    focusSwitches: get('--focus-switches', '0') === '1'
  }
  const outDir = get('--out', path.join(CACHE_ROOT, 'keylat-reports'))
  fs.mkdirSync(outDir, { recursive: true })
  virtualDisplay = await startVirtualDisplay()
  console.log(`[keylat] virtual display ${virtualDisplay?.display ?? 'none (headless)'}`)
  const dirs = {}
  for (const build of builds) {
    dirs[build.label] = ensureBuild(repoRoot, build.sha)
  }
  let seedDir = get('--seed', null)
  if (!seedDir) {
    // Reuse the fleet gate's synthetic seed when one exists (copied per run, never written).
    const shared = path.join(os.homedir(), '.cache', 'orca-fleet-gate', 'seeds')
    const candidates = fs.existsSync(shared)
      ? fs
          .readdirSync(shared)
          .map((name) => path.join(shared, name))
          .filter((dir) => readSeedReceipt(dir))
          .sort((a, b) => fs.statSync(path.join(b, '.fleet-seed.json')).mtimeMs - fs.statSync(path.join(a, '.fleet-seed.json')).mtimeMs)
      : []
    seedDir = candidates[0] ?? null
    console.log(`[keylat] seed ${seedDir ?? 'none shared; building own'} ${seedDir ? JSON.stringify(readSeedReceipt(seedDir)?.census) : ''}`)
  }
  if (!seedDir) {
    const seeded = await ensureSeed({ oldSha: builds[0].sha, oldBuild: dirs[builds[0].label], outDir })
    seedDir = seeded.seedDir
  }
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-keylat-'))
  const all = []
  try {
    for (let run = 0; run < options.runs; run += 1) {
      const order = run % 2 === 0 ? builds : [...builds].reverse()
      for (const build of order) {
        const label = `${build.label}-${build.sha.slice(0, 11)}-r${run}`
        const result = await measureKeys({
          label,
          buildDir: dirs[build.label],
          seedDir,
          options: { ...options, profile: options.profile && run === 0 },
          runDir: path.join(runsRoot, label),
          outDir
        })
        all.push({ build: build.label, sha: build.sha, ...result })
        fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(result, null, 2))
        const { rawSamples, rawEvents, listeners, ...brief } = result
        console.log(`[keylat] RESULT ${JSON.stringify(brief)}`)
        if (listeners) {
          console.log(`[keylat] LISTENERS ${label}`)
          for (const row of listeners.slice(0, 25)) console.log(`  ${JSON.stringify(row)}`)
        }
      }
    }
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true })
  }
  fs.writeFileSync(path.join(outDir, `keylat-all-${Date.now()}.json`), JSON.stringify(all, null, 2))
}

keylatMain()
  .catch((error) => {
    console.error(`[keylat] ${error.stack ?? error}`)
    process.exitCode = 2
  })
  .finally(() => {
    virtualDisplay?.stop()
    process.exit()
  })
