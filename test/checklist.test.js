import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistItems } from '../app/js/checklist.js';

test('open checklist items become tasks, checked ones are left out', () => {
  const text = '# Launch\n\n- [ ] Call the **vendor** (due 2026-10-30)\n- [x] Book the room\n* [ ] Send `invites`\n1. [ ]   \nNotes below\n- a bullet that is not a task';
  assert.deepEqual(checklistItems(text, { firstLine: 10 }), [
    { line: 12, title: 'Call the vendor', due: '2026-10-30' },
    { line: 14, title: 'Send invites', due: '' },
  ]);
});

test('without checkboxes, bullets; without bullets, lines', () => {
  assert.deepEqual(checklistItems('Plan:\n- one\n2) two 2026-11-02\n'), [
    { line: 2, title: 'one', due: '' },
    { line: 3, title: 'two', due: '2026-11-02' },
  ]);
  assert.deepEqual(checklistItems('first thing\n\n  second thing  \n'), [
    { line: 1, title: 'first thing', due: '' },
    { line: 3, title: 'second thing', due: '' },
  ]);
  assert.deepEqual(checklistItems('- [x] all done'), []);
  assert.equal(checklistItems(`- [ ] ${'x'.repeat(300)}`)[0].title.length, 140);
});
