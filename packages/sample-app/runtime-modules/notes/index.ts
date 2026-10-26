import type { ModuleDefinition, ProjectedObject } from '@sync/modules';

/** Added at runtime: served next to the app and listed in modules/manifest.json, no rebuild of the app needed. */
export default {
  id: 'notes',
  version: '1.0.0',
  provides: {
    types: [
      {
        name: 'note',
        versions: [{ version: 1, fields: { text: { type: 'string', required: true, maxLength: 500 } } }],
      },
    ],
    views: {
      list: (ctx) =>
        class NotesList extends ctx.ui.LiveElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this.bind({ type: 'notes.note' }, (rows) => this.paint(rows));
          }

          private paint(rows: ProjectedObject[]): void {
            const root = this.shadowRoot!;
            const input = document.createElement('input');
            input.placeholder = 'A note';
            const add = document.createElement('button');
            add.textContent = 'Add note';
            add.addEventListener('click', async () => {
              const text = input.value.trim();
              const space = (await ctx.spaces.list('rw'))[0];
              if (!text || !space) return;
              input.value = '';
              await ctx.data.create(space, 'notes.note', { text });
            });
            const list = document.createElement('ul');
            for (const r of rows) {
              const li = document.createElement('li');
              li.textContent = String(r.fields.text ?? '');
              list.append(li);
            }
            root.replaceChildren(input, add, list);
          }
        },
    },
  },
} satisfies ModuleDefinition;
