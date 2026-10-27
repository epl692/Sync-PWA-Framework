// T086: device-local Space bindings (data-model.md "Device-local state").
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { Bindings, indexedDbBindingDb, memoryBindingDb } from '../../src/access/bindings';

describe('Bindings', () => {
  it('stores a mode per module and Space; rw covers r', async () => {
    const b = await Bindings.open(memoryBindingDb());
    await b.set('todo', 's1', 'rw');
    await b.set('todo', 's2', 'r');
    await b.set('stats', 's1', 'r');
    expect(b.mode('todo', 's1')).toBe('rw');
    expect(b.mode('todo', 's2')).toBe('r');
    expect(b.mode('todo', 's3')).toBeUndefined();
    expect(b.allows('todo', 's1', 'r')).toBe(true);
    expect(b.allows('todo', 's2', 'rw')).toBe(false);
    expect(b.allows('stats', 's1', 'rw')).toBe(false);
    expect(b.spacesOf('todo', 'r').sort()).toEqual(['s1', 's2']);
    expect(b.spacesOf('todo', 'rw')).toEqual(['s1']);
    expect(b.spacesOf('nobody', 'r')).toEqual([]);
  });

  it('setting again changes the mode; remove forgets it', async () => {
    const b = await Bindings.open(memoryBindingDb());
    await b.set('todo', 's1', 'rw');
    await b.set('todo', 's1', 'r');
    expect(b.mode('todo', 's1')).toBe('r');
    await b.remove('todo', 's1');
    expect(b.mode('todo', 's1')).toBeUndefined();
    await b.remove('todo', 's1'); // removing nothing is fine
  });

  it('rejects a mode that is not r or rw', async () => {
    const b = await Bindings.open(memoryBindingDb());
    await expect(b.set('todo', 's1', 'w' as never)).rejects.toThrow(/mode/);
  });

  it('tells listeners only about real changes', async () => {
    const b = await Bindings.open(memoryBindingDb());
    let n = 0;
    const off = b.onChange(() => void n++);
    await b.set('todo', 's1', 'rw');
    await b.set('todo', 's1', 'rw'); // same: no change
    await b.remove('todo', 's9'); // nothing there
    await b.remove('todo', 's1');
    expect(n).toBe(2);
    off();
    await b.set('todo', 's1', 'r');
    expect(n).toBe(2);
  });

  it('persists in IndexedDB across restarts, per module and Space', async () => {
    const factory = new IDBFactory();
    const open = () => Bindings.open(indexedDbBindingDb({ factory, name: 'sync-modules' }));
    const first = await open();
    await first.set('todo', 's1', 'rw');
    await first.set('stats', 's1', 'r');
    await first.set('todo', 's2', 'r');
    await first.remove('todo', 's2');
    const second = await open();
    expect(second.mode('todo', 's1')).toBe('rw');
    expect(second.mode('stats', 's1')).toBe('r');
    expect(second.mode('todo', 's2')).toBeUndefined();
  });

  it('uses its own database (not the object store or the key database)', async () => {
    const factory = new IDBFactory();
    await Bindings.open(indexedDbBindingDb({ factory }));
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).toEqual(['sync-modules']);
  });
});
