// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { HubConfirm, defineHubConfirm } from '../../src/ui/hub-confirm';
import { HubCode, LINK_CODE_WARNING, defineHubCode } from '../../src/ui/hub-code';

beforeAll(() => {
  defineHubConfirm();
  defineHubCode();
});

const candidate = { name: 'Camp <b>hub</b>', fingerprint: '72as-yext-vngo-nlc5-w2nm-guxz-a3fr-wepp', words: ['vortex', 'mosaic', 'clover', 'blanket'], mode: 'open' as const, slots: 3 };

describe('<sync-hub-confirm>', () => {
  it('shows the name (escaped), fingerprint and four words, and resolves true only on "Trust this Hub"', async () => {
    const el = document.createElement('sync-hub-confirm') as HubConfirm;
    document.body.appendChild(el);
    const answer = el.ask(candidate);
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('.hc-name')!.textContent).toBe('Camp <b>hub</b>');
    expect(el.querySelector('.hc-fp')!.textContent).toBe(candidate.fingerprint);
    expect(el.querySelector('.hc-words')!.textContent).toBe('vortex mosaic clover blanket');
    expect(el.querySelector('[role="alertdialog"]')).not.toBeNull();
    (el.querySelector('[data-act="trust"]') as HTMLElement).click();
    expect(await answer).toBe(true);
    expect(el.innerHTML).toBe('');
  });
  it('Cancel resolves false, and asking again while one is open cancels the first', async () => {
    const el = document.createElement('sync-hub-confirm') as HubConfirm;
    document.body.appendChild(el);
    const first = el.ask(candidate);
    const second = el.ask(candidate);
    expect(await first).toBe(false);
    (el.querySelector('[data-act="cancel"]') as HTMLElement).click();
    expect(await second).toBe(false);
  });
  it('an identity change is a warning with no way to trust anyway', () => {
    const el = document.createElement('sync-hub-confirm') as HubConfirm;
    document.body.appendChild(el);
    el.warnIdentityChanged({ fingerprint: 'aaaa', name: 'Camp' });
    expect(el.querySelector('[role="alert"]')!.textContent).toMatch(/different device pretending/);
    expect(el.querySelector('[data-act="trust"]')).toBeNull();
  });
});

describe('<sync-hub-code>', () => {
  it('shows a serve code, and a link code only with the warning', async () => {
    const calls: boolean[] = [];
    const el = document.createElement('sync-hub-code') as HubCode;
    document.body.appendChild(el);
    el.export = async ({ link }) => (calls.push(link), link ? 'syncserve:1:LINK' : 'syncserve:1:SERVE');
    expect(el.querySelector('.hcd-warning')).toBeNull();
    await el.show();
    expect((el.querySelector('.hcd-code') as HTMLTextAreaElement).value).toBe('syncserve:1:SERVE');
    await el.show(true);
    expect(el.querySelector('.hcd-warning')!.textContent).toBe(LINK_CODE_WARNING);
    expect((el.querySelector('.hcd-code') as HTMLTextAreaElement).value).toBe('syncserve:1:LINK');
    expect(calls).toEqual([false, true]);
  });
  it('shows an error instead of a code when the export fails', async () => {
    const el = document.createElement('sync-hub-code') as HubCode;
    document.body.appendChild(el);
    el.export = async () => {
      throw new Error('this device holds no key for that Space');
    };
    await el.show();
    expect(el.querySelector('[role="alert"]')!.textContent).toMatch(/no key/);
    expect(el.querySelector('.hcd-code')).toBeNull();
  });
});
