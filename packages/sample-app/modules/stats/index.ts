import type { ModuleDefinition, ProjectedObject } from '@sync/modules';

const count = (rows: ProjectedObject[]) => ({ open: rows.filter((r) => r.fields.done !== true).length, done: rows.filter((r) => r.fields.done === true).length });

/** Reads todo items: a summary view, and a feature that mirrors the open count onto the page without any view. */
export default {
  id: 'stats',
  version: '1.0.0',
  dependencies: { todo: '^1.0.0' },
  access: { types: { read: ['todo.item'] } },
  provides: {
    views: {
      summary: (ctx) =>
        class StatsSummary extends ctx.ui.LiveElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this.bind({ type: 'todo.item' }, (rows) => {
              const c = count(rows);
              this.shadowRoot!.textContent = `${c.open} open, ${c.done} done`;
            });
          }
        },
    },
    features: [
      {
        id: 'badge',
        singleton: false,
        start: (ctx) => {
          ctx.data.query({ type: 'todo.item' }).subscribe((rows) => {
            if (typeof document !== 'undefined') document.documentElement.dataset.openCount = String(count(rows).open);
          });
        },
      },
    ],
  },
} satisfies ModuleDefinition;
