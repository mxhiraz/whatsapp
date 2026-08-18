import assert from 'node:assert/strict'
import { NO_DRAFTS, readDrafts, sanitizeDrafts } from '../lib/store.ts'

/*
  The draft store's read path, on its own.

  It lives here rather than in an `import.meta` block inside lib/store.ts because
  that module is imported by client components: `node:assert`, `process` and
  `import.meta.filename` would all follow it into the browser bundle.
*/
if (import.meta.filename === process.argv[1]) {
  // Nothing stored at all. This is also what "no draft" means everywhere else.
  assert.deepEqual(sanitizeDrafts(undefined), NO_DRAFTS)
  assert.deepEqual(sanitizeDrafts(null), NO_DRAFTS)

  // Corrupt or foreign values fall back to the defaults instead of throwing.
  assert.deepEqual(sanitizeDrafts('not an object'), NO_DRAFTS, 'a string is not a set of drafts')
  assert.deepEqual(sanitizeDrafts([1, 2, 3]), NO_DRAFTS, 'nor is an array')
  assert.deepEqual(sanitizeDrafts({ campaign: 'oops' }), NO_DRAFTS)
  assert.deepEqual(sanitizeDrafts({ campaign: { steps: 'nope' } }), NO_DRAFTS)
  assert.deepEqual(sanitizeDrafts({ number: { caps: null } }), NO_DRAFTS)
  assert.deepEqual(sanitizeDrafts({ import: { roles: [1, 2] } }), NO_DRAFTS, 'a mapping must be strings')
  assert.deepEqual(sanitizeDrafts({ campaign: { cfg: { start_hour: Number.NaN } } }), NO_DRAFTS, 'NaN is not an hour')

  // The dialogs index steps[0] and bodies[0] directly, so neither can be empty.
  assert.equal(sanitizeDrafts({ campaign: { steps: [] } }).campaign.steps.length, 1)
  assert.deepEqual(sanitizeDrafts({ campaign: { steps: [{ bodies: [] }] } }).campaign.steps[0].bodies, [''])

  // Each field falls back on its own: good typing survives a broken field beside it.
  const mixed = sanitizeDrafts({
    campaign: { name: 'Q3 founders', list: 7, cfg: { start_hour: 7, end_hour: 'noon' } },
    number: { caps: { max_per_day: 30, proxy_url: false } },
    import: { cc: '44', roles: ['phone', 'skip'] },
  })
  assert.equal(mixed.campaign.name, 'Q3 founders', 'what typed correctly is kept')
  assert.equal(mixed.campaign.list, '', 'a number where a list name belongs is dropped')
  assert.equal(mixed.campaign.cfg.start_hour, 7)
  assert.equal(mixed.campaign.cfg.end_hour, NO_DRAFTS.campaign.cfg.end_hour, 'the bad half falls back alone')
  assert.equal(mixed.number.caps.max_per_day, 30)
  assert.equal(mixed.number.caps.proxy_url, '')
  assert.deepEqual(mixed.import, { list: '', cc: '44', roles: ['phone', 'skip'] })

  // A version this build does not know is thrown away rather than half-converted.
  assert.deepEqual(readDrafts({ campaign: { name: 'from an older build' } }, 0), NO_DRAFTS)
  assert.deepEqual(readDrafts({ campaign: { name: 'from a newer build' } }, 99), NO_DRAFTS)
  assert.equal(readDrafts({ campaign: { name: 'this build' } }).campaign.name, 'this build')

  // Reading twice cannot hand out the same mutable arrays.
  assert.notEqual(sanitizeDrafts(undefined).campaign.steps, sanitizeDrafts(undefined).campaign.steps)

  console.log('store.ts ok')
}
