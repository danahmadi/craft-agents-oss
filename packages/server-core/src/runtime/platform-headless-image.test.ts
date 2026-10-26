import { describe, expect, it } from 'bun:test'
import { createHeadlessPlatform } from './platform-headless'

const images = createHeadlessPlatform().imageProcessor
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="red"/></svg>')

describe('headless native image processing', () => {
  it('loads the installed native library and decodes SVG', async () => {
    expect(await images.getMetadata(svg)).toEqual({ width: 8, height: 6 })
  })

  it('resizes and round-trips PNG', async () => {
    const png = await images.process(svg, { resize: { width: 4, height: 3 }, format: 'png' })
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(await images.getMetadata(png)).toEqual({ width: 4, height: 3 })
  })

  it('encodes JPEG with the requested dimensions', async () => {
    const jpeg = await images.process(svg, { resize: { width: 4, height: 3 }, format: 'jpeg' })
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
    expect(await images.getMetadata(jpeg)).toEqual({ width: 4, height: 3 })
  })

  it('rejects malformed image data without producing an image', async () => {
    const invalid = Buffer.from('invalid image')
    expect(await images.getMetadata(invalid)).toBeNull()
    await expect(images.process(invalid)).rejects.toThrow()
  })
})
