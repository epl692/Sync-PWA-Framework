import type { ModuleContext, ModuleDefinition, ProjectedObject } from '@sync/modules';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { text?: string } = {}): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  const { text, ...rest } = props;
  Object.assign(node, rest);
  if (text !== undefined) node.textContent = text;
  return node;
};

async function targetSpace(ctx: ModuleContext, host: HTMLElement): Promise<string | undefined> {
  return host.getAttribute('space') ?? (await ctx.spaces.list('rw'))[0];
}

/** Todo items with a list view and an editor view. */
export default {
  id: 'todo',
  version: '1.0.0',
  provides: {
    types: [
      {
        name: 'item',
        versions: [
          {
            version: 1,
            fields: {
              title: { type: 'string', required: true, maxLength: 200 },
              done: { type: 'boolean', default: false },
              // an optional photo; stored as a reference, the bytes sync separately and on demand
              photo: { type: 'blob', accept: ['image/*'], maxBytes: 20 * 1024 * 1024 },
            },
          },
        ],
      },
    ],
    views: {
      list: (ctx) =>
        class TodoList extends ctx.ui.LiveElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this.bind({ type: 'todo.item', space: this.getAttribute('space') ?? undefined }, (rows) => this.paint(rows));
          }

          private paint(rows: ProjectedObject[]): void {
            const root = this.shadowRoot!;
            const input = el('input', { placeholder: 'What needs doing?', maxLength: 200 });
            const add = el('button', { text: 'Add' });
            add.addEventListener('click', async () => {
              const title = input.value.trim();
              const space = await targetSpace(ctx, this);
              if (!title || !space) return;
              input.value = '';
              await ctx.data.create(space, 'todo.item', { title });
            });
            const list = el('ul');
            for (const r of rows) {
              const li = el('li');
              const box = el('input', { type: 'checkbox', checked: r.fields.done === true });
              box.addEventListener('change', () => void ctx.data.update(r.id, { done: box.checked }));
              const del = el('button', { text: 'Remove' });
              del.addEventListener('click', () => void ctx.data.remove(r.id));
              li.append(box, el('span', { text: String(r.fields.title ?? '') }), del);
              if (r.fields.photo) {
                const photo = document.createElement('sync-blob') as HTMLElement & { ref?: unknown };
                photo.ref = r.fields.photo;
                li.append(photo);
              }
              if (ctx.blobs) {
                const pick = el('input', { type: 'file', accept: 'image/*' });
                pick.addEventListener('change', async () => {
                  const file = pick.files?.[0];
                  if (!file) return;
                  const ref = await ctx.blobs!.attach(file, { space: r.space, obj: r.id });
                  await ctx.data.update(r.id, { photo: ref as never });
                });
                li.append(pick);
              }
              list.append(li);
            }
            root.replaceChildren(el('div', {}), list);
            root.firstElementChild!.append(input, add);
          }
        },

      editor: (ctx) =>
        class TodoEditor extends ctx.ui.LiveElement {
          #bound = false;
          constructor() {
            super();
            this.attachShadow({ mode: 'open' });
          }

          override connectedCallback(): void {
            const id = this.getAttribute('item-id');
            if (id && !this.#bound) {
              this.#bound = true;
              this.bind({ id }, (rows) => this.paint(rows[0]));
            }
            super.connectedCallback();
          }

          private paint(row: ProjectedObject | undefined): void {
            const root = this.shadowRoot!;
            if (!row) return root.replaceChildren(el('em', { text: 'Not found' }));
            const input = el('input', { value: String(row.fields.title ?? ''), maxLength: 200 });
            input.addEventListener('change', () => void ctx.data.update(row.id, { title: input.value }));
            root.replaceChildren(input);
          }
        },
    },
  },
} satisfies ModuleDefinition;
