/** ~20 lines of app code (not framework): show the view for the current hash. Views are plain custom elements. */
const views: Record<string, string> = { '#todo': 'todo-list', '#stats': 'stats-summary' };

export function mountShell(root: ParentNode = document): void {
  const target = root.querySelector('#view');
  if (!target) return;
  const show = () => {
    const tag = views[location.hash] ?? views['#todo']!;
    target.replaceChildren(document.createElement(tag));
  };
  addEventListener('hashchange', show);
  show();
}
