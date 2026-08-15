/**
 * Icon generator: produces icon.png (Marketplace/webview) and icon.svg (activity bar)
 * from media/origin.png.
 *
 * Run:  npm run gen-icon
 */
import sharp from 'sharp'
import potrace from 'potrace'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ORIGIN = join(__dirname, '..', 'media', 'origin.png')
const OUT_PNG = join(__dirname, '..', 'media', 'icon.png')
const OUT_SVG = join(__dirname, '..', 'media', 'icon.svg')

async function main(): Promise<void> {
  // 1. PNG: scale to 128×128 marketplace icon.
  //    Contain inside a 128×128 box (preserve aspect, center transparent margin).
  const pngBuffer = await sharp(ORIGIN)
    .resize({ width: 128, height: 128, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  writeFileSync(OUT_PNG, pngBuffer)
  console.log(`✓ wrote ${OUT_PNG} (${pngBuffer.length} bytes, 128×128)`)

  // 2. SVG: monochrome vector trace for the activity bar (uses currentColor).
  //    Flatten all non-transparent pixels to black so both the whale (black)
  //    and the blue geometric elements are captured by potrace.
  const bwPng = await sharp(ORIGIN)
    .resize({ width: 128, height: 128, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .threshold(250)
    .png()
    .toBuffer()

  const svg: string = await new Promise((resolve, reject) => {
    potrace.trace(bwPng, (err, svgString) => {
      if (err) reject(err); else resolve(svgString)
    })
  })

  const inner = svg
    .replace(/<\?xml[^>]*\?>\s*/, '')
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>/, '')
    .replace(/\s*stroke="none"/g, '')
    .replace(/\s*fill="black"/g, '')
    .replace(/\s*fill="#000000"/g, '')
    .replace(/\s*fill-rule="[^"]*"/g, '')
    .replace(/\s*\n\s*/g, '\n    ')

  const wrapped = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 128 128" fill="none">
  <g fill="currentColor" stroke="currentColor" stroke-width="0">
    ${inner}
  </g>
</svg>`
  writeFileSync(OUT_SVG, wrapped)
  console.log(`✓ wrote ${OUT_SVG} (${wrapped.length} bytes)`)
}

main().catch((e) => { console.error('gen-icon failed:', e); process.exit(1) })
