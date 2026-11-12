export function settleProviders<T>(loads: Promise<T>[], usable: (value: T) => boolean, budgetMs?: number, graceMs?: number): Promise<PromiseSettledResult<T>[]>
