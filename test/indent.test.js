// Each file's indentation: detected from its text, converted, or given by .editorconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertIndent, detectIndent, editorConfigIndent, indentLabel } from '../app/js/indent.js';

test('detecting tabs or spaces, and how many', () => {
  assert.deepEqual(detectIndent('a\n\tb\n\t\tc\n\td\n'), { tabs: true, size: null });
  assert.deepEqual(detectIndent('a:\n  b: 1\n  c:\n    d: 2\n'), { tabs: false, size: 2 });
  assert.deepEqual(detectIndent('def f():\n    if x:\n        return 1\n    return 2\n'), { tabs: false, size: 4 });
  assert.deepEqual(detectIndent('<a>\n   <b/>\n   <c>\n      <d/>\n   </c>\n</a>\n'), { tabs: false, size: 3 });
  // A step of two levels at once (8 going back out) does not outvote the single steps.
  assert.deepEqual(detectIndent('a {\n    b {\n        c\n        d\n    }\n}\ne {\n    f\n}\n'), { tabs: false, size: 4 });
  // JSDoc's " * " lines are not indentation.
  assert.deepEqual(detectIndent('/**\n * a\n * b\n */\nfunction f() {\n  return 1;\n}\nif (x) {\n  y();\n}\n'), { tabs: false, size: 2 });
  // Not enough to tell.
  assert.equal(detectIndent('one line'), null);
  assert.equal(detectIndent('a\nb\nc'), null);
  assert.equal(indentLabel({ tabs: true, size: 4 }), 'Tab size: 4');
  assert.equal(indentLabel({ tabs: false, size: 2 }), 'Spaces: 2');
});

test('converting the indentation, line starts only', () => {
  assert.equal(convertIndent('a\n    b\n        c "    "\n', { toTabs: true, size: 4 }), 'a\n\tb\n\t\tc "    "\n');
  assert.equal(convertIndent('\tb\n\t\tc\n', { toTabs: false, size: 2 }), '  b\n    c\n');
  // A remainder smaller than a level stays as spaces; tabs after spaces go to the next stop.
  assert.equal(convertIndent('      x\n', { toTabs: true, size: 4 }), '\t  x\n');
  assert.equal(convertIndent('  \tx\n', { toTabs: false, size: 4 }), '    x\n');
});

test('.editorconfig: the nearest wins, root stops, globs by file', () => {
  const root = { dir: '/w', text: 'root = true\n\n[*]\nindent_style = space\nindent_size = 4\n\n[*.{yml,yaml}]\nindent_size = 2\n\n[Makefile]\nindent_style = tab\n' };
  assert.deepEqual(editorConfigIndent([root], '/w/src/a.js'), { tabs: false, size: 4 });
  assert.deepEqual(editorConfigIndent([root], '/w/ci/deploy.yaml'), { tabs: false, size: 2 });
  assert.deepEqual(editorConfigIndent([root], '/w/Makefile'), { tabs: true, size: 4 });
  const near = { dir: '/w/go', text: '[*.go]\nindent_style = tab\ntab_width = 8\n' };
  assert.deepEqual(editorConfigIndent([near, root], '/w/go/main.go'), { tabs: true, size: 8 });
  // Above a root = true: not read.
  const above = { dir: '/', text: '[*]\nindent_size = 8\n' };
  assert.deepEqual(editorConfigIndent([root, above], '/w/a.js'), { tabs: false, size: 4 });
  assert.deepEqual(editorConfigIndent([above], '/w/a.js'), { tabs: null, size: 8 });
  // Paths in a glob are from the file's folder.
  const nested = { dir: '/w', text: '[lib/**.js]\nindent_size = 3\n' };
  assert.deepEqual(editorConfigIndent([nested], '/w/lib/x/y.js'), { tabs: null, size: 3 });
  assert.equal(editorConfigIndent([nested], '/w/src/y.js'), null);
  assert.equal(editorConfigIndent([{ dir: '/w', text: '[*.md]\ntrim_trailing_whitespace = false\n' }], '/w/a.md'), null);
});
