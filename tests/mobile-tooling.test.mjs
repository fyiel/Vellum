import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { extractTemplate } = require('@capacitor/cli/dist/util/template.js')
const { rimraf } = require('rimraf')
const assets = join(dirname(require.resolve('@capacitor/cli/package.json')), 'assets')

for (const [template, expected] of [
    ['android', 'app/src/main/AndroidManifest.xml'],
    ['ios-pods', 'App/App/AppDelegate.swift'],
    ['ios-spm', 'App/App/AppDelegate.swift'],
]) {
    test(`Capacitor extracts its ${template} template with the patched archive dependency`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'vellum-mobile-template-'))
        try {
            await extractTemplate(join(assets, `${template}-template.tar.gz`), directory)
            assert.ok((await readFile(join(directory, expected))).length > 0)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
}

test('Capacitor migration cleanup keeps unmatched files with the patched glob dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vellum-mobile-cleanup-'))
    try {
        await writeFile(join(directory, 'old.txt'), 'old')
        await writeFile(join(directory, 'keep.json'), 'keep')
        await rimraf(join(directory, '*.txt'), { glob: true })
        await assert.rejects(readFile(join(directory, 'old.txt')), { code: 'ENOENT' })
        assert.equal(await readFile(join(directory, 'keep.json'), 'utf8'), 'keep')
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
