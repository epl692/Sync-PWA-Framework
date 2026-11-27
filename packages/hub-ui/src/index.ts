/** Hub owner screens as native Web Components (spec 005). Each takes a `HubControl` from @sync/hub-core and renders what the owner needs. */

import type { ClientInfo, HubControl, HubEvent, ServedSpaceInfo } from '@sync/hub-core';
import { fingerprintWords } from '@sync/transport-bluetooth/link';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

abstract class HubElement extends HTMLElement {
  protected hub: HubControl | undefined;
  private off: (() => void) | undefined;

  set control(h: HubControl | undefined) {
    this.off?.();
    this.hub = h;
    this.off = h?.on((e) => this.onEvent(e));
    this.render();
  }
  get control(): HubControl | undefined {
    return this.hub;
  }
  connectedCallback(): void {
    this.render();
  }
  disconnectedCallback(): void {
    this.off?.();
    this.off = undefined;
  }
  protected onEvent(_e: HubEvent): void {
    this.render();
  }
  protected abstract render(): void;
}

export const BRIDGE_MESSAGES: Record<string, string> = {
  ready: 'Bluetooth is on and the Hub is visible to nearby devices.',
  'bluetooth-off': 'Bluetooth is turned off. Turn it on to let devices find this Hub.',
  'permission-denied': 'This app is not allowed to use Bluetooth. Allow it in the system settings.',
  'advertising-failed': 'The Hub could not start advertising. Try turning Bluetooth off and on.',
  unsupported: "This computer's Bluetooth adapter cannot act as a Hub. Use a phone or another computer.",
};

/** `<hub-status>`: the Hub's name, how to recognise it, and whether it is visible. */
export class HubStatus extends HubElement {
  private bridge: string = 'ready';
  private detail = '';
  protected override onEvent(e: HubEvent): void {
    if (e.type === 'bridge-state') {
      this.bridge = e.state;
      this.detail = e.detail ?? '';
    }
    this.render();
  }
  protected render(): void {
    const h = this.hub;
    if (!h) return void (this.innerHTML = '');
    const s = h.settings();
    const fpBytes = h.fingerprint.replace(/-/g, '');
    const words = (() => {
      try {
        return fingerprintWords(base32To(fpBytes)).join(' ');
      } catch {
        return '';
      }
    })();
    this.innerHTML = `<section aria-labelledby="hs-h">
      <h2 id="hs-h">${esc(s.displayName)}</h2>
      <p class="hub-mode">Access: <strong>${s.accessMode === 'open' ? 'open to members of served Spaces' : 'approval required'}</strong></p>
      <p class="hub-fp">Fingerprint: <code>${esc(h.fingerprint)}</code></p>
      ${words ? `<p class="hub-words">Say it aloud: <strong>${esc(words)}</strong></p>` : ''}
      <p class="hub-bridge" role="status" aria-live="polite" data-state="${esc(this.bridge)}">${esc(BRIDGE_MESSAGES[this.bridge] ?? this.bridge)}${this.detail ? ` (${esc(this.detail)})` : ''}</p>
    </section>`;
  }
}

function base32To(s: string): Uint8Array {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s.toLowerCase()) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error('bad fingerprint');
    acc = (acc << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/** `<hub-spaces>`: the Spaces this Hub serves, with a box to paste a serve code and a way to remove one. */
export class HubSpaces extends HubElement {
  private error = '';
  async add(code: string): Promise<void> {
    if (!this.hub) return;
    try {
      this.error = '';
      await this.hub.addServeCode(code.trim());
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'That code could not be used.';
    }
    this.render();
  }
  async removeSpace(space: string, deleteStored: boolean): Promise<void> {
    await this.hub?.removeSpace(space, { deleteStored });
    this.render();
  }
  private row(s: ServedSpaceInfo): string {
    return `<li data-space="${esc(s.space)}"><span class="sp-name">${esc(s.name ?? s.space)}</span> <span class="sp-meta">${s.source === 'auto' ? 'added automatically' : 'added with a code'}${s.link ? ', can link to other Hubs' : ''}, ${s.bytesStored} bytes stored</span>
      <button type="button" data-act="remove-keep" data-space="${esc(s.space)}">Stop serving</button>
      <button type="button" data-act="remove-delete" data-space="${esc(s.space)}">Stop serving and delete stored data</button></li>`;
  }
  protected render(): void {
    const h = this.hub;
    if (!h) return void (this.innerHTML = '');
    const list = h.spaces();
    this.innerHTML = `<section aria-labelledby="hsp-h">
      <h2 id="hsp-h">Spaces this Hub serves</h2>
      ${list.length ? `<ul>${list.map((s) => this.row(s)).join('')}</ul>` : '<p class="sp-empty">No Spaces yet. In the app, export a "serve this Space" code and paste it here.</p>'}
      <form data-act="add"><label>Serve code <input name="code" autocomplete="off" spellcheck="false"></label> <button type="submit">Add</button></form>
      ${this.error ? `<p class="sp-error" role="alert">${esc(this.error)}</p>` : ''}
    </section>`;
    this.querySelector('form')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.add((this.querySelector('input[name="code"]') as HTMLInputElement).value);
    });
    for (const b of this.querySelectorAll('button[data-act^="remove"]')) {
      const el = b as HTMLElement;
      el.addEventListener('click', () => {
        const del = el.dataset.act === 'remove-delete';
        if (del && typeof confirm === 'function' && !confirm('Delete everything stored for this Space? Devices that already have it keep their copy.')) return;
        void this.removeSpace(el.dataset.space!, del);
      });
    }
  }
}

/** `<hub-clients>`: every known device with what the owner can do about it (approve, deny, block, unblock, disconnect). */
export class HubClients extends HubElement {
  private row(c: ClientInfo): string {
    const acts: string[] = [];
    if (c.state === 'pending') acts.push(`<button type="button" data-act="approve" data-device="${esc(c.device)}">Approve</button>`, `<button type="button" data-act="deny" data-device="${esc(c.device)}">Deny</button>`);
    if (c.state === 'trusted') acts.push(`<button type="button" data-act="block" data-device="${esc(c.device)}">Block</button>`);
    if (c.state === 'blocked') acts.push(`<button type="button" data-act="unblock" data-device="${esc(c.device)}">Unblock</button>`);
    if (c.connected) acts.push(`<button type="button" data-act="disconnect" data-device="${esc(c.device)}">Disconnect</button>`);
    const label = c.state === 'pending' ? 'waiting for approval' : c.state;
    return `<li data-device="${esc(c.device)}"><span class="cl-name">${esc(c.name)}</span> <span class="cl-state" data-state="${c.state}">${c.connected ? 'connected' : 'not connected'}, ${label}</span> ${acts.join(' ')}</li>`;
  }
  protected render(): void {
    const h = this.hub;
    if (!h) return void (this.innerHTML = '');
    const list = h.clients();
    const pending = list.filter((c) => c.state === 'pending').length;
    this.innerHTML = `<section aria-labelledby="hc-h"><h2 id="hc-h">Devices</h2>
      ${pending ? `<p class="cl-pending" role="status" aria-live="polite">${pending} ${pending === 1 ? 'device is' : 'devices are'} waiting for your approval.</p>` : ''}
      ${list.length ? `<ul>${list.map((c) => this.row(c)).join('')}</ul>` : '<p class="cl-empty">No devices are connected right now.</p>'}</section>`;
    const acts: Record<string, (d: string) => Promise<void>> = {
      approve: (d) => h.approve(d),
      deny: (d) => h.deny(d),
      block: (d) => h.block(d),
      unblock: (d) => h.unblock(d),
      disconnect: (d) => h.disconnect(d),
    };
    for (const b of this.querySelectorAll('button[data-act]')) {
      const el = b as HTMLElement;
      el.addEventListener('click', () => void acts[el.dataset.act!]!(el.dataset.device!).then(() => this.render()));
    }
  }
}

/** `<hub-access>`: who may connect (open or approval) and whether Spaces are added automatically. */
export class HubAccess extends HubElement {
  protected render(): void {
    const h = this.hub;
    if (!h) return void (this.innerHTML = '');
    const s = h.settings();
    this.innerHTML = `<section aria-labelledby="ha-h"><h2 id="ha-h">Who can connect</h2>
      <fieldset><legend>Access</legend>
        <label><input type="radio" name="mode" value="open" ${s.accessMode === 'open' ? 'checked' : ''}> Anyone who belongs to a Space this Hub serves</label>
        <label><input type="radio" name="mode" value="approval" ${s.accessMode === 'approval' ? 'checked' : ''}> Only devices I approve</label>
      </fieldset>
      <label><input type="checkbox" name="auto" ${s.autoSpaces ? 'checked' : ''}> Serve any Space a connecting device brings (for events; can fill the Hub's storage)</label>
      </section>`;
    for (const r of this.querySelectorAll('input[name="mode"]')) {
      r.addEventListener('change', () => void h.updateSettings({ accessMode: (r as HTMLInputElement).value as 'open' | 'approval' }));
    }
    this.querySelector('input[name="auto"]')?.addEventListener('change', (e) => void h.updateSettings({ autoSpaces: (e.target as HTMLInputElement).checked }));
  }
}

const fmtBytes = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** `<hub-storage>`: what the Hub has stored, how long it keeps it, and warnings when space runs short. */
export class HubStorage extends HubElement {
  private usage: { usedBytes: number; limitBytes: number; perSpace: Record<string, number>; oldestPacketAt?: number } | undefined;
  private warning = '';
  private error = '';

  protected override onEvent(e: HubEvent): void {
    if (e.type === 'storage-warning') {
      this.warning = e.level === 'evicting-undelivered' ? 'Storage is full: the Hub is deleting changes that no other device has received yet. Free up space or raise the limit.' : 'Storage is nearly full.';
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.hub) return;
    this.usage = await this.hub.storage();
    this.render();
  }

  override connectedCallback(): void {
    void this.refresh();
  }

  async save(patch: { retentionDays?: number; storageLimitBytes?: number }): Promise<void> {
    try {
      this.error = '';
      await this.hub?.updateSettings(patch);
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'That value is not allowed.';
    }
    await this.refresh();
  }

  protected render(): void {
    const h = this.hub;
    if (!h) return void (this.innerHTML = '');
    const s = h.settings();
    const u = this.usage;
    const names = new Map(h.spaces().map((x) => [x.space, x.name ?? x.space]));
    const rows = u ? Object.entries(u.perSpace).map(([sp, n]) => `<li data-space="${esc(sp)}">${esc(names.get(sp) ?? sp)}: ${fmtBytes(n)}</li>`).join('') : '';
    this.innerHTML = `<section aria-labelledby="hst-h"><h2 id="hst-h">Storage</h2>
      ${this.warning ? `<p class="st-warning" role="alert">${esc(this.warning)}</p>` : ''}
      <p class="st-used">${u ? `${fmtBytes(u.usedBytes)} of ${fmtBytes(u.limitBytes)} used` : 'Counting…'}${u?.oldestPacketAt ? `. Oldest change: ${new Date(u.oldestPacketAt).toISOString().slice(0, 10)}` : ''}</p>
      ${rows ? `<ul class="st-spaces">${rows}</ul>` : ''}
      <label>Keep changes for <input type="number" name="days" min="1" max="365" value="${s.retentionDays}"> days</label>
      <label>Storage limit (MB) <input type="number" name="limit" min="1" value="${Math.round(s.storageLimitBytes / 1024 ** 2)}"></label>
      ${this.error ? `<p class="st-error" role="alert">${esc(this.error)}</p>` : ''}
    </section>`;
    this.querySelector('input[name="days"]')?.addEventListener('change', (e) => void this.save({ retentionDays: Number((e.target as HTMLInputElement).value) }));
    this.querySelector('input[name="limit"]')?.addEventListener('change', (e) => void this.save({ storageLimitBytes: Math.round(Number((e.target as HTMLInputElement).value) * 1024 ** 2) }));
  }
}

export function defineHubUi(): void {
  for (const [tag, ctor] of [
    ['hub-status', HubStatus],
    ['hub-spaces', HubSpaces],
    ['hub-clients', HubClients],
    ['hub-access', HubAccess],
    ['hub-storage', HubStorage],
  ] as const) {
    if (!customElements.get(tag)) customElements.define(tag, ctor as unknown as CustomElementConstructor);
  }
}
