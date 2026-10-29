export function bindMangaImageZoom(pages, { isPaged, onSwipe, onZoom }) {
    let figure = null
    let frame = null
    let scale = 1
    let x = 0
    let y = 0
    let renderedX = 0
    let renderedY = 0
    let gesture = null
    let blockClickUntil = 0

    const prevent = event => { if (event.cancelable) event.preventDefault() }
    const point = touch => ({ x: touch.clientX, y: touch.clientY })
    const midpoint = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 })
    const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const origin = () => {
        const rect = frame.getBoundingClientRect()
        return { x: rect.left - renderedX, y: rect.top - renderedY }
    }

    function paint() {
        if (!frame) return
        if (scale <= 1.01) {
            scale = 1
            x = y = 0
        } else {
            const base = origin()
            const rect = figure.getBoundingClientRect()
            const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
            const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
            const width = frame.offsetWidth * scale, height = frame.offsetHeight * scale
            x = width <= right - left ? (left + right - width) / 2 - base.x : Math.max(right - base.x - width, Math.min(left - base.x, x))
            y = height <= bottom - top ? (top + bottom - height) / 2 - base.y : Math.max(bottom - base.y - height, Math.min(top - base.y, y))
        }
        frame.style.transform = scale === 1 ? '' : `translate3d(${x}px, ${y}px, 0) scale(${scale})`
        renderedX = x
        renderedY = y
        figure.classList.toggle('zoomed', scale > 1)
        pages.classList.toggle('is-zoomed', scale > 1)
        onZoom(scale > 1)
    }

    function reset() {
        if (frame) frame.style.transform = ''
        figure?.classList.remove('zoomed')
        pages.classList.remove('is-zoomed')
        figure = frame = gesture = null
        scale = 1
        x = y = renderedX = renderedY = 0
        onZoom(false)
    }

    function select(target) {
        const next = target.closest('.manga-page') || (isPaged() ? pages.querySelector('.manga-page:not([hidden])') : null)
        if (!next?.querySelector('img')?.naturalWidth) return false
        if (next !== figure) {
            reset()
            figure = next
            frame = next.querySelector('.manga-page-image')
        }
        return true
    }

    function startPinch(touches) {
        const center = midpoint(touches)
        const base = origin()
        gesture = {
            kind: 'pinch', distance: Math.max(1, distance(touches)), scale,
            base, anchorX: (center.x - base.x - x) / scale, anchorY: (center.y - base.y - y) / scale,
        }
        blockClickUntil = performance.now() + 500
    }

    function startPan(touch) {
        gesture = { kind: 'pan', start: point(touch), x, y }
    }

    function zoomAt(nextScale, center, base, anchorX, anchorY) {
        scale = Math.max(1, Math.min(5, nextScale))
        x = center.x - base.x - anchorX * scale
        y = center.y - base.y - anchorY * scale
        paint()
    }

    pages.addEventListener('touchstart', event => {
        if (event.target.closest('button, a')) return
        if (event.touches.length >= 2) {
            prevent(event)
            if (select(event.touches[0].target)) startPinch(event.touches)
            else gesture = null
        } else if (scale > 1) {
            prevent(event)
            startPan(event.touches[0])
        } else {
            gesture = { kind: 'swipe', start: point(event.touches[0]), id: event.touches[0].identifier }
        }
    }, { passive: false })

    pages.addEventListener('touchmove', event => {
        if (event.touches.length >= 2) {
            prevent(event)
            if (gesture?.kind !== 'pinch') return
            zoomAt(gesture.scale * distance(event.touches) / gesture.distance, midpoint(event.touches), gesture.base, gesture.anchorX, gesture.anchorY)
        } else if (gesture?.kind === 'pan') {
            prevent(event)
            x = gesture.x + event.touches[0].clientX - gesture.start.x
            y = gesture.y + event.touches[0].clientY - gesture.start.y
            paint()
        }
    }, { passive: false })

    pages.addEventListener('touchend', event => {
        const previous = gesture
        gesture = null
        if (!previous) return
        if (previous.kind !== 'swipe') {
            prevent(event)
            blockClickUntil = performance.now() + 500
            if (event.touches.length >= 2) startPinch(event.touches)
            else if (event.touches.length === 1) startPan(event.touches[0])
            return
        }
        if (!isPaged() || event.touches.length) return
        const end = [...event.changedTouches].find(touch => touch.identifier === previous.id)
        if (!end) return
        const dx = end.clientX - previous.start.x, dy = end.clientY - previous.start.y
        if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
        prevent(event)
        blockClickUntil = performance.now() + 500
        onSwipe(dx < 0 ? 1 : -1)
    }, { passive: false })

    pages.addEventListener('touchcancel', () => {
        gesture = null
        blockClickUntil = performance.now() + 500
    }, { passive: true })

    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) pages.addEventListener(type, prevent, { passive: false })
    pages.addEventListener('click', event => {
        if (event.target.closest('button, a')) return
        if (scale <= 1 && performance.now() >= blockClickUntil) return
        event.preventDefault()
        event.stopImmediatePropagation()
    }, true)

    pages.addEventListener('wheel', event => {
        if (!event.ctrlKey || !select(event.target)) return
        prevent(event)
        const center = point(event)
        const base = origin()
        zoomAt(scale * Math.exp(-event.deltaY * .01), center, base, (center.x - base.x - x) / scale, (center.y - base.y - y) / scale)
    }, { passive: false })

    pages.addEventListener('pointerdown', event => {
        if (event.pointerType !== 'mouse' || event.button !== 0 || scale <= 1) return
        prevent(event)
        startPan(event)
        pages.setPointerCapture(event.pointerId)
    })
    pages.addEventListener('pointermove', event => {
        if (event.pointerType !== 'mouse' || gesture?.kind !== 'pan') return
        x = gesture.x + event.clientX - gesture.start.x
        y = gesture.y + event.clientY - gesture.start.y
        paint()
    })
    const endMousePan = event => {
        if (event.pointerType !== 'mouse' || gesture?.kind !== 'pan') return
        gesture = null
        blockClickUntil = performance.now() + 500
        if (pages.hasPointerCapture(event.pointerId)) pages.releasePointerCapture(event.pointerId)
    }
    pages.addEventListener('pointerup', endMousePan)
    pages.addEventListener('pointercancel', endMousePan)

    return { reset, refresh: paint, get active() { return scale > 1 || gesture?.kind === 'pinch' || gesture?.kind === 'pan' } }
}
