// T046: the sample modules satisfy the module contract.
import { moduleContract } from '@sync/testkit';
import stats from '../modules/stats/index';
import todo from '../modules/todo/index';

moduleContract({
  name: 'todo',
  definition: todo,
  fixtures: {
    'todo.item': [
      { title: 'Milk' },
      { title: 'Eggs', done: true },
      // an attachment is just a reference in a field (spec 004)
      { title: 'With photo', photo: { $blob: 1, id: 'A'.repeat(43), size: 1234, type: 'image/png', space: 'S', scope: 'S', keyId: '0123456789abcdef', name: 'milk.png' } },
    ],
  },
});

moduleContract({ name: 'stats', definition: stats, dependencies: [todo] });
