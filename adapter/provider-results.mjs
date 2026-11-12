export const settleProviders = (loads, usable, budgetMs = 8_000, graceMs = 500) => new Promise(resolve => {
    const results = loads.map(() => ({ status: 'rejected', reason: Object.assign(new Error('Provider is still loading'), { code: 'provider_timeout' }) }))
    let remaining = loads.length
    let grace
    let finished = false
    const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(deadline)
        clearTimeout(grace)
        resolve(results.slice())
    }
    const deadline = setTimeout(finish, budgetMs)
    if (!remaining) return finish()

    loads.forEach((load, index) => Promise.resolve(load)
        .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
        .then(result => {
            if (finished) return
            results[index] = result
            remaining -= 1
            if (!remaining) finish()
            else if (!grace && result.status === 'fulfilled' && usable(result.value)) grace = setTimeout(finish, graceMs)
        }))
})
