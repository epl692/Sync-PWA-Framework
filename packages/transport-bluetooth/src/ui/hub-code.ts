/** <sync-hub-code>: show a "serve this Space" code for the owner of a Hub, and a separate, clearly warned "link code" for Hub-to-Hub use. */

export const LINK_CODE_WARNING = 'This code lets a Hub join other Hubs for this Space. It cannot read your data. Only give it to Hubs you own.';

export type CodeExporter = (opts: { link: boolean }) => Promise<string>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class HubCode extends HTMLElement {
  private exporter: CodeExporter | undefined;
  private code = '';
  private link = false;
  private error = '';

  set export(e: CodeExporter | undefined) {
    this.exporter = e;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  async show(link = this.link): Promise<void> {
    if (!this.exporter) return;
    this.link = link;
    try {
      this.error = '';
      this.code = await this.exporter({ link });
    } catch (e) {
      this.code = '';
      this.error = e instanceof Error ? e.message : 'The code could not be made.';
    }
    this.render();
  }

  private render(): void {
    if (!this.exporter) return void (this.innerHTML = '');
    this.innerHTML = `<section aria-labelledby="hcd-h">
      <h2 id="hcd-h">Let a Hub serve this Space</h2>
      <p>Give this code to the person running the Hub. It lets the Hub store and pass on this Space's encrypted data. It cannot read it.</p>
      <label><input type="checkbox" name="link" ${this.link ? 'checked' : ''}> This Hub should also join my other Hubs</label>
      ${this.link ? `<p class="hcd-warning" role="note"><strong>${esc(LINK_CODE_WARNING)}</strong></p>` : ''}
      <button type="button" data-act="make">Show code</button>
      ${this.error ? `<p role="alert">${esc(this.error)}</p>` : ''}
      ${this.code ? `<label>Code <textarea readonly rows="4" class="hcd-code">${esc(this.code)}</textarea></label> <button type="button" data-act="copy">Copy</button>` : ''}
    </section>`;
    this.querySelector('input[name="link"]')?.addEventListener('change', (e) => void this.show((e.target as HTMLInputElement).checked));
    this.querySelector('[data-act="make"]')?.addEventListener('click', () => void this.show());
    this.querySelector('[data-act="copy"]')?.addEventListener('click', () => void (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator?.clipboard?.writeText(this.code));
  }
}

export function defineHubCode(tag = 'sync-hub-code'): void {
  if (!customElements.get(tag)) customElements.define(tag, HubCode);
}
