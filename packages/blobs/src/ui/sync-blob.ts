/**
 * `<sync-blob>`: a native custom element for one attachment (research R-11). It shows what the engine knows about the
 * blob (placeholder with type and size, progress, the content, or a failure) and nothing more; apps that want something
 * else observe the blob themselves. No framework. Set `el.ref = ref` or give a JSON `ref` attribute.
 */

import type { BlobRef } from '../format/ref';
import type { BlobStatus, Blobs } from '../types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

const FAILURES: Record<string, string> = {
  quota: 'Not enough storage space on this device',
  'too-large': 'This attachment is larger than allowed',
  verification: 'The attachment arrived damaged',
  'no-key': 'This device cannot decrypt the attachment yet',
  cancelled: 'Download cancelled',
  unavailable: 'No device has this attachment right now',
};

export interface SyncBlobElement extends HTMLElement {
  ref: BlobRef | undefined;
}

const STYLE = `:host{display:inline-block;font:inherit}.box{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
img,video{max-width:100%;height:auto}.type,.size{opacity:.75}[role=progressbar]{width:10rem;height:.5rem;border-radius:.25rem;background:rgba(127,127,127,.3);overflow:hidden}
[role=progressbar]>span{display:block;height:100%;background:currentColor}`;

/** Define the element (once per tag name) bound to an engine, and return its class. */
export function defineSyncBlob(blobs: Blobs, name = 'sync-blob'): CustomElementConstructor {
  const existing = customElements.get(name);
  if (existing) return existing;

  class Element extends HTMLElement implements SyncBlobElement {
    private _ref: BlobRef | undefined;
    private unsub: (() => void) | undefined;
    private url: string | undefined;
    private fetching: Promise<void> | undefined;
    private generation = 0;

    static get observedAttributes() {
      return ['ref'];
    }

    get ref(): BlobRef | undefined {
      return this._ref;
    }
    set ref(v: BlobRef | undefined) {
      this._ref = v;
      if (this.isConnected) this.bind();
    }

    attributeChangedCallback(_n: string, _o: string | null, value: string | null): void {
      try {
        this.ref = value ? (JSON.parse(value) as BlobRef) : undefined;
      } catch {
        this.ref = undefined;
      }
    }

    connectedCallback(): void {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      if (!this._ref && this.hasAttribute('ref')) this.attributeChangedCallback('ref', null, this.getAttribute('ref'));
      this.bind();
    }

    disconnectedCallback(): void {
      this.generation++;
      this.unsub?.();
      this.unsub = undefined;
      this.releaseUrl();
    }

    private releaseUrl(): void {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = undefined;
      this.fetching = undefined;
    }

    private bind(): void {
      this.generation++;
      this.unsub?.();
      this.unsub = undefined;
      this.releaseUrl();
      const r = this._ref;
      if (!r) return this.paint(undefined);
      if (r.$blob !== 1) return this.paint(undefined, 'Unsupported attachment');
      const obs = blobs.observe(r);
      this.unsub = obs.subscribe((s) => this.paint(r, undefined, s));
      this.paint(r, undefined, obs.get());
    }

    private async show(r: BlobRef, gen: number): Promise<void> {
      if (this.fetching) return;
      this.fetching = (async () => {
        try {
          const b = await blobs.toBlob(r, { fetch: false });
          if (gen !== this.generation || !this.isConnected) return;
          this.url = URL.createObjectURL(b);
          this.paint(r, undefined, blobs.observe(r).get());
        } catch {
          // the status observable reports the failure
        }
      })();
    }

    private paint(r: BlobRef | undefined, message?: string, s?: BlobStatus): void {
      const root = this.shadowRoot;
      if (!root) return;
      root.replaceChildren();
      const style = document.createElement('style');
      style.textContent = STYLE;
      const box = document.createElement('div');
      box.className = 'box';
      root.append(style, box);
      const text = (cls: string, t: string) => {
        const e = document.createElement('span');
        e.className = cls;
        e.textContent = t;
        return e;
      };
      const button = (label: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      };
      if (!r) {
        if (message) box.append(text('note', message));
        return;
      }
      const gen = this.generation;
      const label = r.name ?? r.type;
      switch (s?.state ?? 'missing') {
        case 'available': {
          if (!this.url) {
            void this.show(r, gen);
            box.append(text('note', 'Opening…'));
            break;
          }
          if (r.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = this.url;
            img.alt = r.name ?? '';
            box.append(img);
          } else if (r.type.startsWith('video/') || r.type.startsWith('audio/')) {
            const m = document.createElement(r.type.startsWith('video/') ? 'video' : 'audio');
            m.setAttribute('controls', '');
            m.setAttribute('src', this.url);
            box.append(m);
          } else {
            const a = document.createElement('a');
            a.href = this.url;
            a.setAttribute('download', r.name ?? 'attachment');
            a.textContent = `${r.name ?? 'attachment'} (${formatBytes(r.size)})`;
            box.append(a);
          }
          // keep it offline: a device-local pin, never synced
          const keep = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = s!.pinned;
          cb.addEventListener('change', () => void (cb.checked ? blobs.pin(r) : blobs.unpin(r)).catch(() => undefined));
          keep.append(cb, document.createTextNode(' Keep on this device'));
          box.append(keep);
          break;
        }
        case 'downloading': {
          const pct = Math.round((s!.progress ?? 0) * 100);
          const bar = document.createElement('div');
          bar.setAttribute('role', 'progressbar');
          bar.setAttribute('aria-valuemin', '0');
          bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-valuenow', String(pct));
          bar.setAttribute('aria-label', `Downloading ${label}`);
          const fill = document.createElement('span');
          fill.style.width = `${pct}%`;
          bar.append(fill);
          box.append(text('name', label), bar, text('size', `${pct}% of ${formatBytes(r.size)}`));
          break;
        }
        case 'failed':
          box.append(text('name', label), text('note', FAILURES[s!.reason ?? ''] ?? 'Download failed'), button('Retry', () => void blobs.request(r).catch(() => undefined)));
          break;
        default:
          box.append(text('name', label), text('type', r.type), text('size', formatBytes(r.size)), button('Download', () => void blobs.request(r).catch(() => undefined)));
      }
    }
  }

  customElements.define(name, Element);
  return Element;
}
