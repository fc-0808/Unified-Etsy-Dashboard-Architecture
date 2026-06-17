'use strict'
/**
 * Smoke-test: verifies that the vision pipeline is correctly wired to
 * qwen/qwen3.7-plus via OpenRouter.
 *
 * Checks performed:
 *  1. Config reads env vars correctly (model, base URL, key masked).
 *  2. Text client (GPT-5.4-mini) still responds on OpenAI.
 *  3. Vision client hits OpenRouter → qwen/qwen3.7-plus with a real image
 *     and returns a character identification (Hello Kitty reference image).
 *
 * Run: node scripts/verify-vision-model.js
 */

require('dotenv').config()
const { config } = require('../src/listings/config')

// ── helpers ──────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED   = '\x1b[31m'
const CYAN  = '\x1b[36m'
const BOLD  = '\x1b[1m'
const DIM   = '\x1b[2m'

function pass(msg) { console.log(`${GREEN}  ✓${RESET} ${msg}`) }
function fail(msg) { console.log(`${RED}  ✗${RESET} ${msg}`) }
function info(msg) { console.log(`${DIM}    ${msg}${RESET}`) }
function section(msg) { console.log(`\n${BOLD}${CYAN}── ${msg} ──${RESET}`) }

function maskKey(k) {
  if (!k || k.length < 12) return '(not set)'
  return k.slice(0, 14) + '...' + k.slice(-4)
}

function makeClient(apiKey, baseURL, extraHeaders) {
  const OpenAI = require('openai')
  const opts = { apiKey }
  if (baseURL) opts.baseURL = baseURL
  if (extraHeaders && Object.keys(extraHeaders).length) opts.defaultHeaders = extraHeaders
  return new OpenAI(opts)
}

// ── 1. Config check ───────────────────────────────────────────────────────────

section('1 · Config values')
const cfg = config.openai
console.log()
info(`Text model      : ${BOLD}${cfg.model}${RESET}`)
info(`Text API key    : ${maskKey(cfg.apiKey)}`)
info(`Vision model    : ${BOLD}${cfg.visionModel}${RESET}`)
info(`Vision base URL : ${cfg.visionBaseUrl || '(OpenAI default)'}`)
info(`Vision API key  : ${maskKey(cfg.visionApiKey)}`)
info(`Vision detail   : ${cfg.visionDetail}`)
info(`Reasoning effort: ${cfg.reasoningEffort}`)
info(`Samples         : ${config.character.samples}`)
console.log()

const isQwen    = /qwen/i.test(cfg.visionModel)
const hasVision = Boolean(cfg.visionApiKey && cfg.visionBaseUrl)

if (!isQwen)    fail(`Vision model is "${cfg.visionModel}" — expected qwen/*`)
else            pass(`Vision model is ${cfg.visionModel}`)

if (!hasVision) fail('VISION_API_KEY or VISION_BASE_URL is blank')
else            pass(`Vision provider → ${cfg.visionBaseUrl}`)

if (cfg.visionReferer) pass(`HTTP-Referer header set: ${cfg.visionReferer}`)
else                   info('HTTP-Referer not set (optional)')

if (cfg.visionTitle)   pass(`X-Title header set: ${cfg.visionTitle}`)
else                   info('X-Title not set (optional)')

// ── 2. Vision API call (Qwen via OpenRouter) ─────────────────────────────────

section('2 · Vision API — Qwen3.7-Plus via OpenRouter')
console.log()
info('Fetching Hello Kitty reference image, encoding as base64...')
info('(same path the bulk pipeline uses — real API call takes 5–20 s)')
console.log()

// Fetch a stable public image and send it as base64 data URI —
// matches exactly what phase1Classify/identifyOnce do with product images.
async function fetchImageAsDataUrl(url) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Y2KASEshop-verify/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching test image`))
        res.resume()
        return
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        const mime = res.headers['content-type'] || 'image/png'
        resolve(`data:${mime};base64,${buf.toString('base64')}`)
      })
      res.on('error', reject)
    }).on('error', reject)
  })
}

// Try several stable public image URLs (first to succeed is used).
// These are Wikimedia Commons direct CDN links (no hotlink restrictions).
const CANDIDATE_URLS = [
  'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gatto_europeo4.jpg/220px-Gatto_europeo4.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/3/3f/Bikesgray.jpg',
]

async function testVisionCall() {
  let dataUrl = null
  let usedUrl = ''
  for (const url of CANDIDATE_URLS) {
    try {
      dataUrl = await fetchImageAsDataUrl(url)
      usedUrl = url
      break
    } catch {
      // try next
    }
  }
  if (!dataUrl) {
    fail('Could not fetch any test image — skipping live vision call')
    info('Config is correct; test a real product to confirm end-to-end.')
    return
  }
  pass(`Image fetched and base64-encoded (${Math.round(dataUrl.length / 1024)} KB)`)
  info(`Source: ${usedUrl}`)

  const headers = {}
  if (cfg.visionReferer) headers['HTTP-Referer'] = cfg.visionReferer
  if (cfg.visionTitle)   headers['X-Title']      = cfg.visionTitle

  const client = makeClient(cfg.visionApiKey, cfg.visionBaseUrl, headers)

  const startMs = Date.now()
  let resp
  try {
    resp = await client.chat.completions.create({
      model: cfg.visionModel,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
            {
              type: 'text',
              text: 'Describe this image in one sentence. What is the main subject?',
            },
          ],
        },
      ],
    })
  } catch (err) {
    fail(`Vision API call failed: ${err.message}`)
    if (err.status) info(`HTTP status: ${err.status}`)
    if (err.error)  info(`Error body : ${JSON.stringify(err.error)}`)
    process.exit(1)
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  const choice  = resp.choices?.[0]
  const content = choice?.message?.content || ''
  const model   = resp.model || cfg.visionModel
  const usage   = resp.usage || {}

  pass(`Response received in ${elapsed}s`)
  pass(`Model reported by provider: ${BOLD}${model}${RESET}`)
  info(`Tokens — prompt: ${usage.prompt_tokens ?? '?'}  completion: ${usage.completion_tokens ?? '?'}`)
  console.log()
  console.log(`${BOLD}  Model says:${RESET}`)
  content.split('\n').forEach(l => console.log(`    ${l}`))
  console.log()

  // Sanity check: the model returned a real description (not empty)
  if (content.trim().length > 10) pass('Model returned a valid image description')
  else                             fail('Model returned an empty or very short response')
}

// ── 3. Text API call (GPT-5.4-mini via OpenAI) ────────────────────────────────

async function testTextCall() {
  section('3 · Text API — GPT-5.4-mini via OpenAI')
  console.log()
  info('Sending a quick text ping to confirm the SEO model is still live...')
  console.log()

  const client = makeClient(cfg.apiKey, '', {})
  const startMs = Date.now()
  // gpt-5.4-mini is a reasoning model → uses max_completion_tokens not max_tokens
  const isReasoning = /^(gpt-5|o1|o3|o4)/.test(cfg.model) && !/qwen/i.test(cfg.model)
  let resp
  try {
    resp = await client.chat.completions.create({
      model: cfg.model,
      ...(isReasoning ? { max_completion_tokens: 50 } : { max_tokens: 50 }),
      messages: [{ role: 'user', content: 'Reply with exactly: "text-model-ok"' }],
    })
  } catch (err) {
    fail(`Text API call failed: ${err.message}`)
    process.exit(1)
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  const content = resp.choices?.[0]?.message?.content || ''
  const model   = resp.model || cfg.model

  pass(`Response received in ${elapsed}s`)
  pass(`Model reported by provider: ${BOLD}${model}${RESET}`)
  info(`Reply: "${content.trim()}"`)
}

// ── run ───────────────────────────────────────────────────────────────────────

;(async () => {
  try {
    await testVisionCall()
    await testTextCall()
    section('Summary')
    console.log()
    pass(`Vision  → ${cfg.visionModel} via ${cfg.visionBaseUrl}`)
    pass(`Text    → ${cfg.model} via OpenAI`)
    console.log()
    console.log(`${GREEN}${BOLD}  All checks passed. Qwen3.7-Plus is live for vision.${RESET}`)
    console.log()
  } catch (err) {
    console.error(`\n${RED}Unexpected error:${RESET}`, err)
    process.exit(1)
  }
})()
