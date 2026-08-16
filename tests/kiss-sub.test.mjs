import test from 'node:test'
import assert from 'node:assert/strict'
import { kissSubToVtt } from '../src/lib/kiss-sub.js'

// fixture: real cue lines from kiss:8705 ep 173841 (English .srt.txt1 track)
const BODY = [
    '1', '00:01:40,039 --> 00:01:43,070', 'HNiyEmkqtBWbIF4DbMxZ8TXkPcEb3U/WQ2o1d5Jav1o=', '',
    '2', '00:01:43,539 --> 00:01:45,700', '2TpoCde06ubvabrmerY/yQ==', '',
    '3', '00:01:46,770 --> 00:01:50,360', 'H/3OM+tIksbnfiDT10sNQuCBI31ILEihB0QwI26VUPygX0vZTHP+dM6G0VGosWxLCrJZZdfRitLSKRhXeooLwg0IqzoTmbVHNnTyg4wGrbs=', '',
    '4', '00:01:52,490 --> 00:01:53,030', '+euezn+XSRLmIg', '',
].join('\n')
const URL_TXT1 = 'https://sub.cdnvideo11.shop/English-EP1-The-White-Olive-Tree.2025.srt.txt1'

test('decrypts KissKH .txt1 subtitle cues into WebVTT', async () => {
    const vtt = await kissSubToVtt(BODY, URL_TXT1)
    assert.ok(vtt.startsWith('WEBVTT'))
    assert.ok(vtt.includes('00:01:40.039 --> 00:01:43.070\n[The White Olive Tree]'))
    assert.ok(vtt.includes('00:01:43.539 --> 00:01:45.700\n[Episode 1]'))
    assert.ok(vtt.includes('[This is a work of fiction. Any resemblance to reality is purely coincidental.]'))
    assert.ok(!vtt.includes('00:01:52.490'), 'undecryptable cue is dropped')
})

test('rejects garbage without throwing', async () => {
    assert.equal(await kissSubToVtt('not a subtitle file', URL_TXT1), 'WEBVTT\n')
})
