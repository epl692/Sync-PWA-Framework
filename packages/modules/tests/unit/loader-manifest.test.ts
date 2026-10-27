// T072: manifest parsing and refusal rules (contracts/runtime-manifest.md).
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/loader/manifest';

const ORIGIN = 'https://app.test';
const URL_ = `${ORIGIN}/apps/x/modules/manifest.json`;
const parse = (json: unknown, bundled: string[] = []) => parseManifest(json, URL_, ORIGIN, new Set(bundled));
const good = { id: 'notes', version: '1.2.0', url: 'notes.1.2.0.js', integrity: 'sha256-AAAA' };

describe('parseManifest', () => {
  it('resolves urls against the manifest and keeps the integrity and boot flags', () => {
    const r = parse({ v: 1, modules: [good, { id: 'prov', version: '1.0.0', url: '/elsewhere/prov.js', boot: true }] });
    expect(r.refused).toEqual([]);
    expect(r.entries).toEqual([
      { id: 'notes', version: '1.2.0', url: 'notes.1.2.0.js', integrity: 'sha256-AAAA', resolved: `${ORIGIN}/apps/x/modules/notes.1.2.0.js` },
      { id: 'prov', version: '1.0.0', url: '/elsewhere/prov.js', boot: true, resolved: `${ORIGIN}/elsewhere/prov.js` },
    ]);
  });

  it('ignores unknown extra fields', () => {
    const r = parse({ v: 1, future: true, modules: [{ ...good, comment: 'x' }] });
    expect(r.entries).toHaveLength(1);
    expect(r.refused).toEqual([]);
  });

  it('refuses another origin, with the reason', () => {
    const r = parse({ v: 1, modules: [{ ...good, url: 'https://evil.test/notes.js' }, good] });
    expect(r.entries.map((e) => e.id)).toEqual(['notes']);
    expect(r.refused).toEqual([{ id: 'notes', url: 'https://evil.test/notes.js', reason: 'cross-origin', detail: expect.stringContaining('evil.test') }]);
  });

  it('refuses a different port or scheme of the same host as another origin', () => {
    const r = parse({ v: 1, modules: [{ ...good, url: 'https://app.test:8443/n.js' }, { ...good, id: 'two', url: 'http://app.test/n.js' }] });
    expect(r.refused.map((x) => x.reason)).toEqual(['cross-origin', 'cross-origin']);
  });

  it.each(['data:text/javascript,export default 1', 'javascript:alert(1)', 'blob:https://app.test/abc', 'file:///etc/passwd'])('refuses the scheme of %s', (url) => {
    const r = parse({ v: 1, modules: [{ ...good, url }] });
    expect(r.entries).toEqual([]);
    expect(r.refused[0]!.reason).toBe('bad-scheme');
  });

  it('refuses an id that is bundled: a manifest cannot replace shipped code', () => {
    const r = parse({ v: 1, modules: [good] }, ['notes']);
    expect(r.entries).toEqual([]);
    expect(r.refused[0]).toMatchObject({ id: 'notes', reason: 'id-clash' });
  });

  it('refuses the second entry for an id', () => {
    const r = parse({ v: 1, modules: [good, { ...good, version: '1.3.0' }] });
    expect(r.entries).toHaveLength(1);
    expect(r.refused[0]).toMatchObject({ reason: 'id-clash', detail: expect.stringContaining('twice') });
  });

  it('skips malformed entries and still loads the others', () => {
    const r = parse({
      v: 1,
      modules: [
        { ...good, id: 'Bad Id' },
        { ...good, id: 'two', version: '1.0' },
        { id: 'three', version: '1.0.0' },
        { ...good, id: 'four', integrity: 'md5-xyz' },
        { ...good, id: 'five', boot: 'yes' },
        null,
        'x',
        good,
      ],
    });
    expect(r.entries.map((e) => e.id)).toEqual(['notes']);
    expect(r.refused).toHaveLength(7);
    expect(r.refused.every((x) => x.reason === 'malformed')).toBe(true);
  });

  it('a manifest version above 1 is unsupported: nothing new is loaded', () => {
    const r = parse({ v: 2, modules: [good] });
    expect(r.unsupported).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it.each([null, 'x', [], { v: 1 }, { v: 'one', modules: [] }, { modules: [] }])('rejects the manifest %j as malformed', (json) => {
    const r = parse(json);
    expect(r.entries).toEqual([]);
    expect(r.refused.length).toBeGreaterThan(0);
  });
});
