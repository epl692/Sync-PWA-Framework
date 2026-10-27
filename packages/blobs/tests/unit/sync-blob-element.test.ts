// @vitest-environment jsdom
// T037: the <sync-blob> element shows a placeholder, progress, content or a failure for one attachment reference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobRef, BlobStatus, Blobs } from '../../src';
import { defineSyncBlob, formatBytes, type SyncBlobElement } from '../../src/ui/sync-blob';

let n = 0;
const ref = (over: Partial<BlobRef> = {}): BlobRef => ({ $blob: 1, id: 'A'.repeat(43), size: 1_234_567, type: 'application/pdf', space: 'S', scope: 'S', keyId: '0123456789abcdef', name: 'report.pdf', ...over });
const status = (over: Partial<BlobStatus> = {}): BlobStatus => ({ state: 'missing', reason: 'not-requested', size: 1_234_567, progress: 0, bytesDone: 0, pinned: false, replicas: 0, ...over });

/** Just enough engine for the element: an observable status the test drives, and recorded calls. */
function fakeEngine(initial: BlobStatus) {
  let cur = initial;
  const listeners = new Set<(s: BlobStatus) => void>();
  const calls: string[] = [];
  const subs = { open: 0, closed: 0 };
  const engine = {
    observe: () => ({
      get: () => cur,
      subscribe: (l: (s: BlobStatus) => void) => {
        subs.open++;
        listeners.add(l);
        return () => {
          subs.closed++;
          listeners.delete(l);
        };
      },
    }),
    request: vi.fn(async () => void calls.push('request')),
    toBlob: vi.fn(async () => (calls.push('toBlob'), new Blob(['x'], { type: 'image/png' }))),
    pin: vi.fn(async () => void calls.push('pin')),
    unpin: vi.fn(async () => void calls.push('unpin')),
  } as unknown as Blobs;
  return { engine, calls, subs, set: (s: BlobStatus) => ((cur = s), listeners.forEach((l) => l(s))) };
}

const mount = (e: Blobs, r: BlobRef) => {
  const tag = `sync-blob-t${++n}`;
  defineSyncBlob(e, tag);
  const el = document.createElement(tag) as SyncBlobElement;
  el.ref = r;
  document.body.appendChild(el);
  return el;
};
const root = (el: Element) => el.shadowRoot!;
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});
afterEach(() => void (document.body.innerHTML = ''));

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [1_234_567, '1.2 MB'],
    [5 * 1024 ** 3, '5.0 GB'],
  ])('%i -> %s', (b, s) => expect(formatBytes(b)).toBe(s));
});

describe('<sync-blob>', () => {
  it('shows type, a human-readable size and a Download button for a blob that is not here', async () => {
    const f = fakeEngine(status());
    const el = mount(f.engine, ref());
    const text = root(el).textContent!;
    expect(text).toContain('application/pdf');
    expect(text).toContain('1.2 MB');
    expect(text).toContain('report.pdf');
    const btn = root(el).querySelector('button')!;
    expect(btn.textContent).toMatch(/download/i);
    btn.click();
    await tick();
    expect(f.calls).toEqual(['request']);
  });

  it('shows progress with an accessible progressbar while downloading', () => {
    const f = fakeEngine(status({ state: 'downloading', reason: undefined, progress: 0.42, bytesDone: 518_518 }));
    const el = mount(f.engine, ref());
    const bar = root(el).querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-label')).toMatch(/download/i);
    f.set(status({ state: 'downloading', reason: undefined, progress: 0.9, bytesDone: 1 }));
    expect(root(el).querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('90');
  });

  it('renders an image from an object URL when available, and revokes it when removed', async () => {
    const f = fakeEngine(status({ state: 'available', reason: undefined, progress: 1 }));
    const el = mount(f.engine, ref({ type: 'image/png', name: 'cat.png' }));
    await tick();
    const img = root(el).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:fake');
    expect(img.getAttribute('alt')).toBe('cat.png');
    el.remove();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
    expect(f.subs.closed).toBe(f.subs.open); // no subscription leaks
  });

  it('renders a link with the file name for a type it cannot display', async () => {
    const f = fakeEngine(status({ state: 'available', reason: undefined, progress: 1 }));
    const el = mount(f.engine, ref());
    await tick();
    const a = root(el).querySelector('a')!;
    expect(a.textContent).toContain('report.pdf');
    expect(a.getAttribute('download')).toBe('report.pdf');
    expect(a.getAttribute('href')).toBe('blob:fake');
  });

  it('offers "Keep on this device" for a blob that is here: it reflects the pin and toggles it', async () => {
    const f = fakeEngine(status({ state: 'available', reason: undefined, progress: 1, pinned: false }));
    const el = mount(f.engine, ref());
    await tick();
    const box = root(el).querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(root(el).textContent).toContain('Keep on this device');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await tick();
    expect(f.calls).toContain('pin');
    f.set(status({ state: 'available', reason: undefined, progress: 1, pinned: true }));
    expect((root(el).querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    (root(el).querySelector('input[type="checkbox"]') as HTMLInputElement).checked = false;
    root(el).querySelector('input[type="checkbox"]')!.dispatchEvent(new Event('change'));
    await tick();
    expect(f.calls).toContain('unpin');
  });

  it('shows the reason and a Retry button when it failed', async () => {
    const f = fakeEngine(status({ state: 'failed', reason: 'quota' }));
    const el = mount(f.engine, ref());
    expect(root(el).textContent).toMatch(/storage/i);
    root(el).querySelector('button')!.click();
    await tick();
    expect(f.calls).toEqual(['request']);
  });

  it('says "Unsupported attachment" for a reference version it does not know, and never fetches', async () => {
    const f = fakeEngine(status());
    const el = mount(f.engine, { ...ref(), $blob: 2 } as unknown as BlobRef);
    expect(root(el).textContent).toContain('Unsupported attachment');
    expect(root(el).querySelector('button')).toBeNull();
    expect(f.subs.open).toBe(0);
  });

  it('re-renders when the reference changes and drops the old subscription', () => {
    const f = fakeEngine(status());
    const el = mount(f.engine, ref({ name: 'one.pdf' }));
    el.ref = ref({ name: 'two.pdf', id: 'B'.repeat(43) });
    expect(root(el).textContent).toContain('two.pdf');
    expect(f.subs.closed).toBe(1);
  });

  it('can be driven by a JSON `ref` attribute in markup', () => {
    const f = fakeEngine(status());
    const tag = `sync-blob-t${++n}`;
    defineSyncBlob(f.engine, tag);
    document.body.innerHTML = `<${tag} ref='${JSON.stringify(ref({ name: 'markup.pdf' }))}'></${tag}>`;
    expect(document.querySelector(tag)!.shadowRoot!.textContent).toContain('markup.pdf');
  });
});
