// "file:line" in program output and logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFileRefs, resolveRef } from '../app/js/fileRefs.js';

const refs = (text) => findFileRefs(text).map((r) => `${r.path}@${r.line}:${r.column}`);

test('references as programs print them', () => {
  assert.deepEqual(refs('src/app.js:12:5: error: x is not defined'), ['src/app.js@12:5']);
  assert.deepEqual(refs('    at load (/home/me/w/store.js:40:11)'), ['/home/me/w/store.js@40:11']);
  assert.deepEqual(refs('  File "/srv/app/main.py", line 7, in <module>'), ['/srv/app/main.py@7:1']);
  assert.deepEqual(refs('  File "/home/me/my app/run.py", line 2, in <module>'), ['/home/me/my app/run.py@2:1']);
  assert.deepEqual(refs('  File "<stdin>", line 1, in <module>'), []);
  assert.deepEqual(refs('   at Foo.Bar() in C:\\code\\Foo.cs:line 42'), ['C:\\code\\Foo.cs@42:1']);
  assert.deepEqual(refs('src/a.ts(12,5): error TS2304: Cannot find name'), ['src/a.ts@12:5']);
  assert.deepEqual(refs('./main.go:9:2: undefined: x'), ['./main.go@9:2']);
  assert.deepEqual(refs('see file:///tmp/x.log:3'), ['/tmp/x.log@3:1']);
  assert.deepEqual(refs('a.py:1 and b.py:2'), ['a.py@1:1', 'b.py@2:1']);
  // Not files: times, versions, plain words.
  assert.deepEqual(refs('at 10:30 version 1.2:3 hello: 5'), []);
  const [r] = findFileRefs('x  src/app.js:12');
  assert.deepEqual([r.from, r.to], [3, 16]);
});

test('relative references from the folder they were printed in', () => {
  assert.equal(resolveRef('src/a.js', '/w'), '/w/src/a.js');
  assert.equal(resolveRef('../lib/b.js', '/w/src'), '/w/lib/b.js');
  assert.equal(resolveRef('./c.py', '/w/'), '/w/c.py');
  assert.equal(resolveRef('/abs/d.js', '/w'), '/abs/d.js');
  assert.equal(resolveRef('C:\\x\\e.cs', 'D:\\y'), 'C:\\x\\e.cs');
  assert.equal(resolveRef('f.cs', 'D:\\y'), 'D:\\y\\f.cs');
  assert.equal(resolveRef('~/g.txt', '/w'), null);
  assert.equal(resolveRef('h.txt', ''), null);
});
