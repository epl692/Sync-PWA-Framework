/**
 * <sync-bluetooth-panel>: find and join a Hub (native Web Component, no framework). It shows what the transport reports in plain
 * language, never blocks the app, and tells the user what to do when Bluetooth or a Hub is missing (spec FR-004, FR-029).
 */

import { describeStatus, errorMessage, type BluetoothTransportStatus } from '../status';
import type { HubConnectionInfo, HubConnectionState } from '../clientLink';

export interface PanelTransport {
  status(): BluetoothTransportStatus;
  connections(): HubConnectionInfo[];
  chooseHub(): Promise<unknown>;
  disconnectHub(fingerprint: string): Promise<void>;
  onStatus(h: (s: BluetoothTransportStatus) => void): () => void;
  onConnections(h: (c: HubConnectionInfo[]) => void): () => void;
}

export const STATE_LABELS: Record<HubConnectionState, string> = {
  searching: 'Searching',
  connecting: 'Connecting',
  securing: 'Securing the link',
  authenticating: 'Checking your Spaces',
  pending: 'Waiting for the Hub owner to approve this device',
  syncing: 'Syncing',
  idle: 'Up to date',
  disconnected: 'Disconnected',
  full: 'The Hub is full',
  error: 'Problem',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class BluetoothPanel extends HTMLElement {
  private t: PanelTransport | undefined;
  private offs: Array<() => void> = [];
  private message = '';
  private busy = false;

  /** Give the panel the transport to show. */
  set transport(t: PanelTransport | undefined) {
    this.unsubscribe();
    this.t = t;
    if (t) this.offs = [t.onStatus(() => this.render()), t.onConnections(() => this.render())];
    this.render();
  }
  get transport(): PanelTransport | undefined {
    return this.t;
  }

  connectedCallback(): void {
    this.render();
  }
  disconnectedCallback(): void {
    this.unsubscribe();
  }
  private unsubscribe(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** The user pressed "Find a Hub". Exposed for tests and for apps that wire their own button. */
  async find(): Promise<void> {
    if (!this.t || this.busy) return;
    this.busy = true;
    this.message = '';
    this.render();
    try {
      await this.t.chooseHub();
    } catch (e) {
      this.message = errorMessage(e);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    const t = this.t;
    if (!t) {
      this.innerHTML = '';
      return;
    }
    const status = t.status();
    const conns = t.connections();
    const unsupported = status.kind === 'unsupported';
    const items = conns
      .map(
        (c) => `<li data-fp="${esc(c.fingerprint)}"><span class="name">${esc(c.name)}</span> <span class="state" data-state="${c.state}">${esc(STATE_LABELS[c.state] ?? c.state)}</span>${c.state === 'pending' && c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ''}<button type="button" data-act="leave" data-fp="${esc(c.fingerprint)}" aria-label="Disconnect from ${esc(c.name)}">Disconnect</button></li>`,
      )
      .join('');
    this.innerHTML = `
      <section class="bt-panel" aria-labelledby="bt-h">
        <h2 id="bt-h">Bluetooth</h2>
        <p class="bt-status" role="status" aria-live="polite">${esc(describeStatus(status))}</p>
        ${this.message ? `<p class="bt-error" role="alert">${esc(this.message)}</p>` : ''}
        ${conns.length ? `<ul class="bt-hubs" aria-label="Connected Hubs">${items}</ul>` : ''}
        ${
          unsupported
            ? '<p class="bt-help">You can still use the app on other connections. To sync over Bluetooth, open this page in Chrome or Edge.</p>'
            : conns.length
              ? ''
              : '<p class="bt-help">Someone nearby needs to be running a Hub (an Android or desktop app). Ask them to start it, then press the button.</p>'
        }
        <button type="button" data-act="find" ${unsupported || this.busy ? 'disabled' : ''}>${this.busy ? 'Looking for Hubs…' : conns.length ? 'Connect to another Hub' : 'Find a Hub'}</button>
      </section>`;
    this.querySelector('[data-act="find"]')?.addEventListener('click', () => void this.find());
    for (const b of this.querySelectorAll('[data-act="leave"]')) {
      b.addEventListener('click', () => void t.disconnectHub((b as HTMLElement).dataset.fp!));
    }
  }
}

export function defineBluetoothPanel(tag = 'sync-bluetooth-panel'): void {
  if (!customElements.get(tag)) customElements.define(tag, BluetoothPanel);
}
