// clipboard writes shared across screens; the async api is best effort and always
// falls back to a hidden textarea execCommand copy so the button works everywhere
export const execCopy = t => {
    const ta = document.createElement('textarea')
    ta.value = t
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
}

export const writeClip = t => {
    try {
        if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(t).catch(() => execCopy(t)); return }
    } catch {}
    execCopy(t)
}
