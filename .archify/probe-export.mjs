#!/usr/bin/env node
/** One-off CDP probe: list SVGs and export-related UI in an archify artifact. */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const input = process.argv[2]
const profileRoot = mkdtempSync(resolve(tmpdir(), 'archify-probe-profile-'))
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
const waitFor = (method, timeoutMs) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), timeoutMs)
  const poll = setInterval(() => {
    const i = events.findIndex((e) => e.method === method)
    if (i >= 0) { clearInterval(poll); clearTimeout(timer); res(events.splice(i, 1)[0]) }
  }, 20)
})
try {
  const attached = waitFor('Target.attachedToTarget', 30000)
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const { sessionId } = (await attached).params
  const pageSend = (method, params) => send(method, params, sessionId)
  await pageSend('Page.enable')
  const loaded = waitFor('Page.loadEventFired', 30000)
  await pageSend('Page.navigate', { url: `file://${resolve(input)}` })
  await loaded
  const probeExpr = `(() => {
    const svgs = [...document.querySelectorAll('svg')].map((s, i) => {
      const r = s.getBoundingClientRect()
      const t = s.querySelector('g')?.getAttribute('transform')
      return { i, id: s.id || null, cls: s.getAttribute('class'), viewBox: s.getAttribute('viewBox'), w: s.getAttribute('width'), h: s.getAttribute('height'), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, children: s.childElementCount, firstTransform: t, parentCls: s.parentElement?.getAttribute('class') || null, parentId: s.parentElement?.id || null }
    })
    const controls = [...document.querySelectorAll('button,[role="menuitem"],[role="button"],a[download]')].map((b) => ({ tag: b.tagName, text: (b.textContent || '').trim().slice(0, 30), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), dataAction: b.getAttribute('data-action') })).filter((b) => b.text || b.aria || b.title || b.dataAction)
    const globals = Object.keys(window).filter((k) => /archify|viewer|export|diagram/i.test(k))
    return { svgCount: svgs.length, svgs, controlCount: controls.length, controls: controls.slice(0, 60), globals }
  })()`
  let value = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((r) => setTimeout(r, 300))
    const result = await pageSend('Runtime.evaluate', { expression: probeExpr, returnByValue: true })
    value = result.result?.value
    if (value && value.svgCount > 0) break
  }
  console.log(JSON.stringify(value, null, 1).slice(0, 12000))
} finally {
  child.kill('SIGTERM')
}
