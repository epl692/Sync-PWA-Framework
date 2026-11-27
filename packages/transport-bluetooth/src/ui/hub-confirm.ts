/** <sync-hub-confirm>: ask whether to trust a Hub the first time (name, fingerprint, four words), and warn when a Hub's identity changed. */

import type { HubCandidate } from '../clientLink';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class HubConfirm extends HTMLElement {
  private resolve: ((ok: boolean) => void) | undefined;

  /** Show the question; resolves true only if the user presses the trust button. */
  ask(c: HubCandidate): Promise<boolean> {
    this.resolve?.(false);
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.innerHTML = `<section role="alertdialog" aria-labelledby="hc-t" aria-describedby="hc-d">
        <h2 id="hc-t">Trust this Hub?</h2>
        <p id="hc-d">You are about to sync with <strong class="hc-name">${esc(c.name)}</strong>. Check that these match what the Hub owner shows you.</p>
        <p>Fingerprint: <code class="hc-fp">${esc(c.fingerprint)}</code></p>
        <p>Say it aloud: <strong class="hc-words">${esc(c.words.join(' '))}</strong></p>
        <p>${c.mode === 'approval' ? 'The owner will need to approve this device.' : 'Anyone who belongs to a Space this Hub serves can connect.'}</p>
        <button type="button" data-act="trust">Trust this Hub</button> <button type="button" data-act="cancel">Cancel</button>
      </section>`;
      this.querySelector('[data-act="trust"]')?.addEventListener('click', () => this.done(true));
      this.querySelector('[data-act="cancel"]')?.addEventListener('click', () => this.done(false));
    });
  }

  /** The Hub shown under a name or fingerprint you trusted before has a different identity. There is no "trust anyway" here: forget the Hub first. */
  warnIdentityChanged(i: { fingerprint: string; name: string }): void {
    this.innerHTML = `<section role="alert" aria-labelledby="hi-t">
      <h2 id="hi-t">This Hub has changed</h2>
      <p>The Hub calling itself <strong>${esc(i.name)}</strong> does not have the same identity as the one you trusted before (fingerprint <code>${esc(i.fingerprint)}</code>). It could be a different device pretending to be it. Nothing was shared.</p>
      <p>If you know the owner replaced the Hub, forget the old one in the Bluetooth settings and connect again.</p>
      <button type="button" data-act="ok">OK</button></section>`;
    this.querySelector('[data-act="ok"]')?.addEventListener('click', () => void (this.innerHTML = ''));
  }

  private done(ok: boolean): void {
    this.innerHTML = '';
    this.resolve?.(ok);
    this.resolve = undefined;
  }
}

export function defineHubConfirm(tag = 'sync-hub-confirm'): void {
  if (!customElements.get(tag)) customElements.define(tag, HubConfirm);
}
