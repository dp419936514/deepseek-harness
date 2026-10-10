#!/usr/bin/env node
/**
 * Detect export tiling/clipping in a PNG without vision:
 * - edge ink: non-background pixels touching the left/right image border
 * - column periodicity: a near-zero column-diff at some horizontal lag means tiled content
 * Usage: node check-tile.mjs <image.png>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const input = process.argv[2]
const profileRoot = mkdtempSync(resolve(tmpdir(), 'archify-check-profile-'))
const child = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--no-first-run',
  '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${profileRoot}`,
  '--window-size=4400,2400', 'about:blank',
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

const CHECK_EXPR = `(() => {
  const img = document.querySelector('img')
  if (!img) return { error: 'no img element' }
  const w = img.naturalWidth, h = img.naturalHeight
  if (!w || !h) return { error: 'image not decoded' }
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h).data
  const isBg = (i) => { const r = data[i], g = data[i + 1], b = data[i + 2]; return r > 244 && g > 244 && b > 244 }
  const isDark = (i) => { const r = data[i], g = data[i + 1], b = data[i + 2]; return r < 170 && g < 170 && b < 170 }
  const edgeInk = (band) => {
    let ink = 0, total = 0
    for (let y = 0; y < h; y += 4) for (let x = 0; x < band; x++) {
      total++
      if (isDark((y * w + x) * 4)) ink++
      if (isDark((y * w + (w - 1 - x)) * 4)) ink++
    }
    return Math.round((ink / (total * 2)) * 1000) / 10
  }
  const column = (x) => { let s = 0; for (let y = 0; y < h; y += 3) { const i = (y * w + x) * 4; s += data[i] + data[i + 1] + data[i + 2] } return s }
  const cols = []
  for (let x = 0; x < w; x += 2) cols.push(column(x))
  let bestLag = 0, bestRatio = 1
  for (let lag = 4; lag < cols.length / 2; lag++) {
    let diff = 0, base = 0
    for (let i = 0; i + lag < cols.length; i++) { diff += Math.abs(cols[i] - cols[i + lag]); base += cols[i] }
    const ratio = base === 0 ? 0 : diff / base
    if (ratio < bestRatio) { bestRatio = ratio; bestLag = lag * 2 }
  }
  let inkPixels = 0, sampled = 0
  for (let i = 0; i < data.length; i += 40) { sampled++; if (!isBg(i)) inkPixels++ }
  return { width: w, height: h, inkPct: Math.round((inkPixels / sampled) * 1000) / 10, edgeInkPct: edgeInk(4), tileLagPx: bestLag, tileDiffRatio: Math.round(bestRatio * 10000) / 10000 }
})()`
try {
  const attached = waitFor('Target.attachedToTarget', 30000)
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const { sessionId } = (await attached).params
  const pageSend = (method, params) => send(method, params, sessionId)
  await pageSend('Page.enable')
  const loaded = waitFor('Page.loadEventFired', 30000)
  await pageSend('Page.navigate', { url: `file://${resolve(input)}` })
  await loaded
  const result = await new Promise((resolveEvaluate, rejectEvaluate) => {
    let attempts = 0
    const run = async () => {
      try {
        const r = await pageSend('Runtime.evaluate', {
          expression: CHECK_EXPR,
          returnByValue: true,
        })
        if (r.result?.value && !r.result.value.error) resolveEvaluate(r)
        else if (++attempts < 20) { setTimeout(run, 300) } else resolveEvaluate(r)
      } catch (e) { rejectEvaluate(e) }
    }
    run()
  })
  const v = result.result?.value
  console.log(JSON.stringify(v))
  let failed = !v || v.error ? 'no result: ' + (v?.error || 'empty') : null
  if (!failed) {
    const tiled = v.tileDiffRatio < 0.02 && v.tileLagPx > 200
    const clipped = v.edgeInkPct > 0.5
    if (tiled || clipped || v.inkPct < 3) {
      failed = `tiled=${tiled} (lag ${v.tileLagPx}px, ratio ${v.tileDiffRatio}) clipped=${clipped} (edge ink ${v.edgeInkPct}%) ink ${v.inkPct}%`
    } else {
      console.log(`CHECK PASS: no tiling (best lag ${v.tileLagPx}px ratio ${v.tileDiffRatio}), edges clean (${v.edgeInkPct}%), ink ${v.inkPct}%`)
    }
  }
  if (failed) { console.error('CHECK FAIL: ' + failed); process.exitCode = 1 }
} finally {
  child.kill('SIGTERM')
}
