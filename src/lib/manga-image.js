const boundsCache = new WeakMap()
const fullPage = { x: 0, y: 0, width: 1, height: 1 }

export function mangaImageBounds(image) {
    if (boundsCache.has(image)) return boundsCache.get(image)
    if (!image.complete || !image.naturalWidth) return fullPage
    let bounds = fullPage
    try {
        const scale = Math.min(1, 384 / Math.max(image.naturalWidth, image.naturalHeight))
        const canvas = document.createElement('canvas')
        const width = canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0, width, height)
        const { data } = context.getImageData(0, 0, width, height)
        const light = index => data[index + 3] < 16 || Math.min(data[index], data[index + 1], data[index + 2]) > 235
        const dark = index => data[index + 3] < 16 || Math.max(data[index], data[index + 1], data[index + 2]) < 20
        const border = (vertical, reverse) => {
            const length = vertical ? width : height
            const cross = vertical ? height : width
            const offset = (line, position) => (vertical ? position * width + line : line * width + position) * 4
            const edge = reverse ? length - 1 : 0
            let white = 0, black = 0
            for (let p = 0; p < cross; p++) {
                if (light(offset(edge, p))) white++
                if (dark(offset(edge, p))) black++
            }
            const blank = white / cross > .99 ? light : black / cross > .99 ? dark : null
            if (!blank) return 0
            for (let distance = 0; distance < length / 4; distance++) {
                const line = reverse ? length - distance - 1 : distance
                let filled = 0
                for (let p = 0; p < cross; p++) {
                    if (!blank(offset(line, p))) filled++
                }
                if (filled > Math.max(1, cross * .005)) return Math.max(0, distance - 2)
            }
            return 0
        }
        const left = border(true, false), right = width - border(true, true)
        const top = border(false, false), bottom = height - border(false, true)
        bounds = { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height }
        canvas.width = canvas.height = 0
    } catch {}
    boundsCache.set(image, bounds)
    return bounds
}
