// T046: the sample modules satisfy the module contract.
import { moduleContract } from '@sync/testkit';
import stats from '../modules/stats/index';
import todo from '../modules/todo/index';

moduleContract({
  name: 'todo',
  definition: todo,
  fixtures: { 'todo.item': [{ title: 'Milk' }, { title: 'Eggs', done: true }] },
});

moduleContract({ name: 'stats', definition: stats, dependencies: [todo] });
