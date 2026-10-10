#!/usr/bin/env node
/**
 * Drive the archify viewer's own canonical Export menu to download a full-diagram PNG.
 * Usage: node export-via-ui.mjs <input.html> <download-dir>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const input = process.argv[2]
const downloadDir = process.argv[3] || mkdtempSync(resolve(tmpdir(), 'archify-ui-export-'))
if (!input) { console.error('usage: node export-via-ui.mjs <input.html> [download-dir]'); process.exit(2) }

const profileRoot = mkdtempSync(resolve(tmpdir(), 'archify-ui-profile-'))
const child = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--no-first-run',
  '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profileRoot}`,
  '--window-size=1800,1200', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
const writePipe = child.stdio[3]
const readPipe = child.stdio[4]
let buffer = ''
let nextId = 1
const pending = new Map()
const events = []
readPipe.setEncoding('utf8')
readPipe.on('data', (chunk) => {
  buffer += chunk
  let boundary
  while ((boundary = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 1)
    if (!raw) continue
    let message
    try { message = JSON.parse(raw) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    } else if (message.method) events.push(message)
  }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++
  pending.set(id, { resolve: res, reject: rej })
  writePipe.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
})
const waitFor = (method, timeoutMs, sessionId) => new Promise((res, rej) => {
  const match = (e) => e.method === method && (sessionId === undefined || e.sessionId === sessionId)
  const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs)
  const poll = setInterval(() => {
    const i = events.findIndex(match)
    if (i >= 0) { clearInterval(poll); clearTimeout(timer); res(events.splice(i, 1)[0]) }
  }, 20)
})
async function evaluate(pageSend, expression) {
  const result = await pageSend('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed')
  return result.result?.value
}

try {
  const attached = waitFor('Target.attachedToTarget', 30000)
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const { sessionId } = (await attached).params
  const pageSend = (method, params) => send(method, params, sessionId)
  await pageSend('Page.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: resolve(downloadDir), eventsEnabled: true })
    .catch(() => pageSend('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: resolve(downloadDir) }))
  const loaded = waitFor('Page.loadEventFired', 30000, sessionId)
  await pageSend('Page.navigate', { url: `file://${resolve(input)}` })
  await loaded
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const has = await evaluate(pageSend, `document.querySelectorAll('svg').length > 0`)
    if (has) break
  }

  let clickedExport = null
  for (let attempt = 0; attempt < 10 && !clickedExport; attempt++) {
    clickedExport = await evaluate(pageSend, `(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => {
        const aria = b.getAttribute('aria-label') || ''
        const title = b.getAttribute('title') || ''
        const text = b.textContent.trim()
        return aria.includes('导出') || title.includes('导出') || text === '导出'
      })
      if (!btn) return null
      btn.click()
      return btn.textContent.trim()
    })()`)
    if (!clickedExport) await new Promise((r) => setTimeout(r, 500))
  }
  if (!clickedExport) {
    const viaKey = await evaluate(pageSend, `(() => {
      for (const type of ['keydown', 'keyup']) {
        document.dispatchEvent(new KeyboardEvent(type, { key: 'e', code: 'KeyE', bubbles: true }))
        document.body.dispatchEvent(new KeyboardEvent(type, { key: 'e', code: 'KeyE', bubbles: true }))
      }
      return 'keyboard-e'
    })()`)
    await new Promise((r) => setTimeout(r, 700))
    const menuVisible = await evaluate(pageSend, `[...document.querySelectorAll('button,[role="menuitem"]')].some((b) => /PNG/i.test(b.textContent || '') && (b.offsetWidth || b.offsetHeight))`)
    console.log(`fallback keyboard: ${viaKey}, png item visible: ${menuVisible}`)
    if (menuVisible) clickedExport = 'keyboard-e'
  }
  if (!clickedExport) {
    const diag = await evaluate(pageSend, `document.querySelectorAll('button').length`)
    throw new Error(`export button not found (buttons on page: ${diag})`)
  }
  console.log(`clicked export button: ${clickedExport}`)
  await new Promise((r) => setTimeout(r, 500))

  const menu = await evaluate(pageSend, `(() => {
    return [...document.querySelectorAll('button,[role="menuitem"]')].map((b, i) => ({
      i, text: (b.textContent || '').trim().slice(0, 60), aria: b.getAttribute('aria-label'), action: b.getAttribute('data-action'), visible: !!(b.offsetWidth || b.offsetHeight),
    })).filter((b) => b.visible && (b.text || b.aria))
  })()`)
  console.log('menu items:')
  for (const item of menu) console.log(`  [${item.i}] text="${item.text}" aria="${item.aria}" action="${item.action}"`)

  const pick = menu.find((b) => /PNG/i.test(b.text) && /下载|download/i.test(b.text))
    || menu.find((b) => /PNG/i.test(b.text) && !/复制|copy|剪贴板/i.test(b.text))
  if (!pick) throw new Error('no PNG download menu item found')
  console.log(`clicking: [${pick.i}] ${pick.text}`)
  const download = waitFor('Page.downloadWillBegin', 60000, sessionId)
  await evaluate(pageSend, `(() => { const nodes = [...document.querySelectorAll('button,[role="menuitem"]')]; const b = nodes[${pick.i}]; if (!b) return false; b.click(); return true })()`)
  const begin = await download
  console.log(`download began: ${JSON.stringify(begin.params.suggestedFilename)}`)
  await waitFor('Page.downloadProgress', 60000, sessionId).catch(() => null)
  await new Promise((r) => setTimeout(r, 1200))
  console.log(`download dir: ${downloadDir}`)
  console.log(`files: ${readdirSync(downloadDir).join(', ')}`)
} finally {
  child.kill('SIGTERM')
}
