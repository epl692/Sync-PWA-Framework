# Building a module

This walks through a new module from nothing: one object type, a list view, wired into an app, built and tried in a
browser, with a contract test. It takes the sample app in `packages/sample-app` as the app. Plan for about 20 minutes.

You need Node 20+ and a checkout of this repository with `npm install` run once.

## 1. What a module is

A module is a plain object: an ID, a version, and what it registers. It does not import the framework at run time;
everything it needs arrives through a `ctx` object. That is what lets the same file run bundled into the app or be
loaded later from a manifest.

```ts
import type { ModuleDefinition } from '@sync/modules'; // types only: erased when built

export default {
  id: 'recipes', //             lowercase letters and digits, 2 to 24 characters
  version: '1.0.0',
  provides: { types: [/* ... */], views: {/* ... */} },
} satisfies ModuleDefinition;
```

Names are namespaced by the module ID: the type below is `recipes.recipe`, the element is `<recipes-list>`.

## 2. Write the module

Create `packages/sample-app/modules/recipes/index.ts`:

```ts
import type { ModuleDefinition, ProjectedObject } from '@sync/modules';

export default {
  id: 'recipes',
  version: '1.0.0',
  provides: {
    // An object type is declared data: fields, rules, and a version. Invalid writes are refused here and by every peer.
    types: [
      {
        name: 'recipe',
        versions: [
          {
            version: 1,
            fields: {
              title: { type: 'string', required: true, maxLength: 100 },
              minutes: { type: 'integer', min: 1, max: 600 },
            },
          },
        ],
      },
    ],
    // A view is a custom element. Views are written as a function of ctx and return the element class.
    views: {
      list: (ctx) =>
        // LiveElement binds the element to a live query: it re-renders when the data changes.
        class RecipeList extends ctx.ui.LiveElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' });
            this.bind({ type: 'recipes.recipe' }, (rows) => this.paint(rows));
          }

          private paint(rows: ProjectedObject[]): void {
            const input = document.createElement('input');
            input.placeholder = 'New recipe';
            const add = document.createElement('button');
            add.textContent = 'Add';
            add.addEventListener('click', async () => {
              const space = (await ctx.spaces.list('rw'))[0];
              if (!input.value.trim() || !space) return;
              await ctx.data.create(space, 'recipes.recipe', { title: input.value.trim() });
              input.value = '';
            });
            const list = document.createElement('ul');
            for (const r of rows) {
              const li = document.createElement('li');
              li.textContent = String(r.fields.title ?? ''); // textContent, never innerHTML, for data that came from elsewhere
              list.append(li);
            }
            this.shadowRoot!.replaceChildren(input, add, list);
          }
        },
    },
  },
} satisfies ModuleDefinition;
```

What to notice:

- `ctx.data` is the only way to read and write objects. It checks every call against what the module declared.
- `ctx.spaces.list('rw')` gives the Spaces this module may write to. The app decides which (step 3).
- Values are validated before any packet exists: `create(..., { title: '' })` or a `minutes` of 9999 throws a
  `SchemaValidationError` naming the field.

## 3. Add it to the app

In `packages/sample-app/app.config.ts` import the module, add it to `modules`, and bind the Space it may use. Modules
use `bound` Space access by default, so the app says which Space each may use on this device:

```ts
import recipes from './modules/recipes/index';
// ...
modules: [identity, todo, stats, recipes],
// ...
async onReady(host, spaces) {
  // ...existing lines...
  await host.bindSpace('recipes', personal.id, 'rw');
  mountShell();
},
```

Show the view: add `'#recipes': 'recipes-list'` to `views` in `packages/sample-app/shell.ts`, and
`| <a href="#recipes">Recipes</a>` to the nav in `index.template.html`.

## 4. Check, build, try it

```bash
npm run check -w @sync/sample-app        # resolves modules and lints schemas, no browser needed
npm run build -w @sync/sample-app        # writes packages/sample-app/dist
npm run serve -w @sync/sample-app        # any static host works; this is a 20 line Node script
```

Open http://localhost:4180/#recipes, add a recipe, then turn the network off in the browser's dev tools and reload:
the app and the recipe are still there.

`check` catches the mistakes that otherwise show up at start: a bad ID, a schema that does not lint, a duplicate module,
a missing dependency. A module that fails at run time never takes the others down; `__syncHost.report()` (development
builds) shows its status and the reason.

## 5. Test it against the contract

Create `packages/sample-app/tests/recipes.contract.test.ts`:

```ts
import { moduleContract } from '@sync/testkit';
import recipes from '../modules/recipes/index';

moduleContract({
  name: 'recipes',
  definition: recipes,
  fixtures: { 'recipes.recipe': [{ title: 'Pancakes' }, { title: 'Soup', minutes: 45 }] },
});
```

`npx vitest run packages/sample-app` runs it. The suite checks the definition and schemas, clean activation and
shutdown, that your fixtures are accepted and read back, that the module cannot touch types it did not declare, and
that a crashing sibling does not affect it.

## 6. Changing the schema later

Add a second entry to `versions`, with an `up` migration from the old fields to the new ones. Old objects are
migrated when read; peers still on version 1 keep syncing and lose nothing.

```ts
import { migrate } from '@sync/modules/migrate'; // helpers only: about 1 KB, safe in runtime modules too
versions: [
  { version: 1, fields: { title: { type: 'string' } } },
  {
    version: 2,
    fields: { name: { type: 'string' }, minutes: { type: 'integer' } },
    up: migrate.rename('title', 'name'),       // read old data as the new shape
    down: migrate.mirrorRename('name', 'title') // keep version 1 peers seeing changes
  },
],
```

Rules the lint enforces: a field name keeps one type forever (a different shape needs a new name), version 2 and later
need `up`, and need `down` or `breaking: true` (when a change cannot be shown to older peers).

## 7. Shipping it without rebuilding the app

Put the module under `packages/sample-app/runtime-modules/recipes/index.ts` instead (same file, no value imports from
`@sync/*`). `npm run build` writes it to `dist/modules/recipes.1.0.0.js` and lists it, with a SHA-256 integrity hash, in
`dist/modules/manifest.json`. Copy a new file and manifest to the host and users get it on their next launch; it is
cached for offline use. See [app-config.md](./app-config.md).
