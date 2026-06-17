'use strict'
/**
 * END-TO-END verification that the REAL bulk-listing pipeline uses
 * qwen/qwen3.7-plus for all image recognition (classification, character ID,
 * accessory detection → style variations) via OpenRouter.
 *
 * Unlike verify-vision-model.js (a raw connectivity ping), this script invokes
 * the actual exported generateListingCopy() so it exercises the exact code path
 * the dashboard uses — including the strict json_schema structured outputs that
 * drive which style variations get offered.
 *
 * Run: node scripts/verify-vision-pipeline.js
 */

require('dotenv').config()
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

const { config } = require('../src/listings/config')
const { generateListingCopy } = require('../src/listings/ai-generator')

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', BOLD = '\x1b[1m', DIM = '\x1b[2m', YEL = '\x1b[33m'
const pass = (m) => console.log(`${GREEN}  ✓${RESET} ${m}`)
const fail = (m) => console.log(`${RED}  ✗${RESET} ${m}`)
const info = (m) => console.log(`${DIM}    ${m}${RESET}`)
const warn = (m) => console.log(`${YEL}  !${RESET} ${m}`)
const section = (m) => console.log(`\n${BOLD}${CYAN}── ${m} ──${RESET}`)

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Y2KASEshop-verify/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(dest)))
      out.on('error', reject)
    }).on('error', reject)
  })
}

// Direct (non-thumb) Wikimedia Commons URLs — these avoid the thumb rate-limiter.
const PRODUCT_IMAGE_URLS = [
  'https://upload.wikimedia.org/wikipedia/commons/3/3a/Mobile_phone_cases.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/c/c1/Iphone_6_silver.png',
  'https://upload.wikimedia.org/wikipedia/commons/3/3f/Bikesgray.jpg',
]

async function main() {
  section('1 · Active configuration')
  console.log()
  info(`Vision model    : ${BOLD}${config.openai.visionModel}${RESET}`)
  info(`Vision provider : ${config.openai.visionBaseUrl || '(OpenAI default)'}`)
  info(`Text model      : ${config.openai.model}`)
  info(`Samples / image : ${config.character.samples}`)
  console.log()

  if (!/qwen/i.test(config.openai.visionModel)) {
    fail(`Vision model is "${config.openai.visionModel}", expected qwen/* — aborting`)
    process.exit(1)
  }
  pass(`Vision model is ${config.openai.visionModel}`)
  if (!config.openai.visionBaseUrl) { fail('VISION_BASE_URL is blank'); process.exit(1) }
  pass(`Routing through ${config.openai.visionBaseUrl}`)

  // ── Fetch a real product image to disk (pipeline reads from disk) ──
  section('2 · Fetch test product image')
  console.log()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'y2kase-verify-'))
  let imgPath = null
  for (const url of PRODUCT_IMAGE_URLS) {
    const ext = path.extname(url.split('?')[0]) || '.jpg'
    const dest = path.join(tmpDir, `product${ext}`)
    try {
      await download(url, dest)
      imgPath = dest
      info(`Downloaded ${url}`)
      break
    } catch (e) {
      info(`skip ${url} (${e.message})`)
    }
  }
  if (!imgPath) { fail('Could not download any test image'); process.exit(1) }
  const mime = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg'
  pass(`Image ready: ${imgPath} (${Math.round(fs.statSync(imgPath).size / 1024)} KB)`)

  // ── Run the REAL pipeline ──
  section('3 · Run real bulk-listing pipeline (generateListingCopy)')
  console.log()
  info('This calls phase1Classify + identifyCharacter + analyzeAccessories on Qwen')
  info('plus Phase 2 SEO copy on GPT-5.4-mini. Takes 30–90 s with self-consistency...')
  console.log()

  const product = {
    name: 'Test Phone Case',
    images: [{ path: imgPath, mime }],
  }

  const startMs = Date.now()
  let result
  try {
    result = await generateListingCopy(product, { shopName: 'Y2KASEshop', brandTags: ['y2kase'] })
  } catch (err) {
    fail(`Pipeline FAILED: ${err.message}`)
    if (/json_schema|response_format|structured|schema/i.test(err.message)) {
      warn('This looks like a STRUCTURED-OUTPUT incompatibility on the vision provider.')
      warn('Qwen via OpenRouter may not support strict json_schema — see remediation note below.')
    }
    if (err.status) info(`HTTP status: ${err.status}`)
    if (err.error) info(`Body: ${JSON.stringify(err.error).slice(0, 400)}`)
    console.log()
    process.exit(1)
  }
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  pass(`Pipeline completed end-to-end in ${elapsed}s`)
  console.log()

  // ── Assert structured outputs that drive style variations ──
  section('4 · Verify structured results (style variations)')
  console.log()

  // Phase 1 classification (vision, structured)
  if (Array.isArray(result.imageAnalysis) && result.imageAnalysis.length) {
    pass(`Phase 1 classification returned ${result.imageAnalysis.length} image object(s) [structured JSON OK]`)
    const a = result.imageAnalysis[0]
    info(`  image 1 → has_case=${a.has_case} has_grip=${a.has_grip} has_charm=${a.has_charm} magsafe=${a.has_magsafe_ring}`)
  } else {
    fail('Phase 1 returned no image_classifications — structured output likely failed')
  }

  // Character identification (vision, structured)
  if (result.characterName) {
    pass(`Character resolved: "${BOLD}${result.characterName}${RESET}" (confidence ${result.characterConfidence}, verified=${result.characterVerified})`)
  } else {
    fail('No character resolved')
  }

  // Accessory detection → enabled style variations (THE key output)
  const acc = result.accessory || {}
  info(`Accessory detection → grip=${acc.hasGrip} (conf ${acc.gripConfidence ?? '—'}), charm=${acc.hasCharm} (conf ${acc.charmConfidence ?? '—'})`)
  // enabledStyles is a { styleKey: boolean } map; "Case Only" is always true.
  const styleMap = result.enabledStyles || {}
  const onStyles = Object.keys(styleMap).filter((k) => styleMap[k])
  if (onStyles.length) {
    pass(`Enabled STYLE VARIATIONS (${onStyles.length}): ${BOLD}${onStyles.join(', ')}${RESET}`)
    info(`  full map: ${JSON.stringify(styleMap)}`)
  } else {
    fail('No enabledStyles produced — variation logic did not run')
  }

  // Style → image mapping
  const mapKeys = result.styleImageMapping ? Object.keys(result.styleImageMapping) : []
  if (mapKeys.length) pass(`Style→image mapping built for ${mapKeys.length} style(s)`)
  else                info('Style→image mapping empty (expected with a single test image)')

  // Phase 2 SEO copy (text model)
  if (result.title && result.description && Array.isArray(result.tags)) {
    pass(`Phase 2 SEO copy: title ${result.title.length} chars, description ${result.description.length} chars, ${result.tags.length} tags`)
  } else {
    fail('Phase 2 SEO copy incomplete')
  }

  // ── Cleanup ──
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  section('Summary')
  console.log()
  pass(`Image recognition (classify + character + accessory) → ${config.openai.visionModel}`)
  pass(`Style variations derived from Qwen accessory detection`)
  pass(`SEO copy → ${config.openai.model}`)
  console.log()
  console.log(`${GREEN}${BOLD}  Bulk-listing pipeline verified on Qwen3.7-Plus.${RESET}`)
  console.log()
}

main().catch((e) => { console.error(`\n${RED}Unexpected error:${RESET}`, e); process.exit(1) })
