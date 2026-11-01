// Running tests: which framework a file uses, the tests it declares, the command, and reading
// what came of a run. The reports and outputs in test/fixtures/tests are real ones (Vitest 5,
// Jest 30, Mocha 11, node:test 22, pytest 9, unittest, go 1.24, cargo 1.97, PHPUnit 12; the
// TRX is .NET's format), with the paths shortened to /work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { detectFramework, firstMessageLine, looksLikeTestFile, matchTest, parseOutput, parseReport, placeFailures, reportExt, summaryText, testAt, testCommand, testsInFile, testStates } from '../app/js/testRun.js';
import { commandEnded, endMark } from '../app/js/terminalTabs.js';

const require = createRequire(import.meta.url);
const { projectAround } = require('../electron/testProject.cjs');
const fixture = (name) => readFileSync(new URL(`./fixtures/tests/${name}`, import.meta.url), 'utf8');
const dir = (d, names, texts = {}) => ({ dir: d, names, texts });

test('test files: by their names, else by what they import or mark', () => {
  for (const name of ['math.test.ts', 'a.spec.jsx', 'test_x.py', 'x_test.py', 'x_test.go', 'MathTest.php', 'CartTests.cs']) assert.ok(looksLikeTestFile(name), name);
  assert.ok(looksLikeTestFile('check.mjs', "import { test } from 'node:test';"));
  assert.ok(looksLikeTestFile('lib.rs', '#[cfg(test)]\nmod tests {\n  #[test]\n  fn a() {}\n}'));
  assert.ok(looksLikeTestFile('checks.py', 'def test_one():\n    pass'));
  assert.ok(!looksLikeTestFile('app.js', 'export const x = 1;'));
  assert.ok(!looksLikeTestFile('notes.md', '# test'));
});

test('the framework: from the file’s imports, then the project files above it', () => {
  const pkg = (deps, extra = []) => [dir('/p/test', []), dir('/p', ['package.json', ...extra], { 'package.json': JSON.stringify({ devDependencies: deps }) })];
  assert.deepEqual(detectFramework({ name: 'a.test.js', dirs: pkg({ vitest: '5' }) }), { framework: 'vitest', root: '/p', runner: ['npx'] });
  assert.equal(detectFramework({ name: 'a.test.js', dirs: pkg({ jest: '30' }, ['pnpm-lock.yaml']) }).runner.join(' '), 'pnpm exec');
  assert.equal(detectFramework({ name: 'a.test.js', dirs: pkg({ mocha: '11' }, ['yarn.lock']) }).framework, 'mocha');
  assert.equal(detectFramework({ name: 'a.test.js', dirs: pkg({}, ['jest.config.ts']) }).framework, 'jest');
  // The file's own import wins: node:test in a Vitest project.
  assert.deepEqual(detectFramework({ name: 'a.test.js', text: "import test from 'node:test'", dirs: pkg({ vitest: '5' }) }), { framework: 'node', root: '/p', runner: [] });
  assert.equal(detectFramework({ name: 'a.test.js', dirs: [dir('/p', ['package.json'], { 'package.json': '{"scripts":{"test":"node --test"}}' })] }).framework, 'node');
  // Python: pytest unless only unittest; uv/Poetry/PDM by their lock file.
  const py = [dir('/p/tests', []), dir('/p', ['pyproject.toml', 'uv.lock'], { 'pyproject.toml': '[tool.pytest.ini_options]\n' })];
  assert.deepEqual(detectFramework({ name: 'test_a.py', dirs: py }), { framework: 'pytest', root: '/p', runner: ['uv', 'run'] });
  assert.equal(detectFramework({ name: 'test_u.py', text: fixture('test_unit.py'), dirs: [dir('/p', ['setup.py'])] }).framework, 'unittest');
  assert.equal(detectFramework({ name: 'test_u.py', text: fixture('test_unit.py'), dirs: py }).framework, 'pytest', 'pytest runs unittest tests too');
  assert.equal(detectFramework({ name: 'x_test.go', dirs: [dir('/m/pkg', []), dir('/m', ['go.mod'])] }).root, '/m/pkg');
  assert.equal(detectFramework({ name: 'lib.rs', dirs: [dir('/r/src', []), dir('/r', ['Cargo.toml'])] }).root, '/r');
  assert.equal(detectFramework({ name: 'MathTest.php', text: fixture('MathTest.php'), dirs: [dir('/w/tests', []), dir('/w', ['composer.json'], { 'composer.json': '{"require-dev":{"phpunit/phpunit":"^12"}}' })] }).framework, 'phpunit');
  assert.equal(detectFramework({ name: 'AddTest.php', text: "<?php\nit('adds', function () {});", dirs: [dir('/w', ['composer.json'], { 'composer.json': '{"require-dev":{"pestphp/pest":"^3"}}' })] }).framework, 'pest');
  assert.deepEqual(detectFramework({ name: 'CartTests.cs', dirs: [dir('/s/Shop.Tests', ['Shop.Tests.csproj'])] }), { framework: 'dotnet', root: '/s/Shop.Tests', project: 'Shop.Tests.csproj', runner: [] });
  assert.equal(detectFramework({ name: 'notes.md', dirs: [] }), null);
});

test('the tests a file declares, with their lines and suites', () => {
  const vitest = testsInFile(fixture('vitest.test.js.txt'), 'vitest');
  assert.deepEqual(vitest.map((t) => [t.kind, t.name, t.line, t.end]), [['suite', 'math', 2, 10], ['test', 'math adds', 3, 5], ['test', 'math subtracts', 6, 8], ['test', 'math later', 9, 9]]);
  assert.equal(testAt(vitest, 4).title, 'adds');
  assert.equal(testAt(vitest, 2).title, 'math');
  assert.equal(testAt(vitest, 1), null);
  assert.deepEqual(testsInFile(fixture('test_math.py'), 'pytest').map((t) => [t.kind, t.title, t.cls, t.line]), [['test', 'test_adds', '', 4], ['suite', 'TestMath', 'TestMath', 8], ['test', 'test_subtracts', 'TestMath', 9], ['test', 'test_param', 'TestMath', 13], ['test', 'test_later', 'TestMath', 17]]);
  assert.deepEqual(testsInFile(fixture('math_test.go'), 'go').map((t) => [t.title, t.line, t.end]), [['TestAdd', 5, 9], ['TestSub', 11, 15], ['TestTable', 17, 20]]);
  assert.deepEqual(testsInFile(fixture('lib.rs'), 'cargo').map((t) => [t.title, t.line]), [['adds', 10], ['subtracts', 15], ['later', 21]]);
  assert.deepEqual(testsInFile(fixture('MathTest.php'), 'phpunit').map((t) => [t.kind, t.title, t.line]), [['suite', 'MathTest', 8], ['test', 'testAdds', 10], ['test', 'subtracts', 16], ['test', 'testParam', 27], ['test', 'testLater', 32]]);
  const cs = testsInFile(fixture('CartTests.cs'), 'dotnet');
  assert.deepEqual(cs.map((t) => [t.kind, t.title, t.line]), [['suite', 'CartTests', 5], ['test', 'Adds', 8], ['test', 'Subtracts', 14], ['test', 'Param', 21], ['test', 'Later', 24]]);
  assert.equal(cs[1].ns, 'Shop.Tests');
  // Titles with quotes, each, template literals; not a call inside a string.
  const js = testsInFile("describe(\"it's\", () => {\n  it.each([1, 2])('n %i', (n) => {});\n  test(`tpl`, () => {});\n  const s = 'it(\"no\")';\n});\n", 'jest');
  assert.deepEqual(js.map((t) => t.name), ["it's", "it's n %i", "it's tpl"]);
  assert.deepEqual(testsInFile("it('adds', function () {\n  expect(1)->toBe(1);\n});", 'pest').map((t) => t.title), ['it adds']);
});

test('the command for a test, a suite or the file, with the report it writes', () => {
  const js = testsInFile(fixture('vitest.test.js.txt'), 'vitest');
  const vit = testCommand({ framework: 'vitest', root: '/p', runner: ['npx'] }, { file: '/p/test/math.test.js', target: js[1], report: '/tmp/r.xml' });
  assert.deepEqual([vit.program, ...vit.args], ['npx', 'vitest', 'run', 'test/math.test.js', '-t', '^math( > | )adds$', '--reporter=default', '--reporter=junit', '--outputFile.junit=/tmp/r.xml']);
  assert.equal(vit.cwd, '/p');
  assert.equal(vit.report, 'junit');
  const jest = testCommand({ framework: 'jest', root: '/p', runner: ['yarn'] }, { file: '/p/a (1).test.js', target: { title: 'a.b?', chain: [] }, report: '' });
  assert.deepEqual([jest.program, ...jest.args], ['yarn', 'jest', 'a (1).test.js', '-t', '^a\\.b\\?$']);
  assert.deepEqual(testCommand({ framework: 'mocha', root: '/p', runner: ['npx'] }, { file: '/p/a.test.js', target: js[0] }).args, ['mocha', 'a.test.js', '--grep', '^math'], 'a suite: the names that start with it');
  assert.equal(jest.report, null, 'no report file asked: none');
  const node = testCommand({ framework: 'node', root: '/p', runner: [] }, { file: '/p/x.test.js', target: js[2], report: '/tmp/r.tap' });
  assert.deepEqual(node.args, ['--test', '--test-name-pattern=subtracts', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', '--test-reporter-destination=/tmp/r.tap', 'x.test.js']);
  const py = testsInFile(fixture('test_math.py'), 'pytest');
  assert.deepEqual(testCommand({ framework: 'pytest', root: '/p', runner: ['uv', 'run'] }, { file: '/p/tests/test_math.py', target: py[2], report: '/tmp/r.xml' }).args, ['run', 'pytest', 'tests/test_math.py::TestMath::test_subtracts', '--junitxml=/tmp/r.xml', '-o', 'junit_family=xunit1']);
  assert.deepEqual(testCommand({ framework: 'pytest', root: '/p', runner: [] }, { file: '/p/tests/test_math.py', target: py[1] }).args, ['tests/test_math.py::TestMath']);
  assert.deepEqual(testCommand({ framework: 'unittest', root: '/p', runner: [] }, { file: '/p/tests/test_unit.py', target: { kind: 'test', title: 'test_adds', cls: 'MathTest' }, windows: true }), { program: 'python', args: ['-m', 'unittest', '-v', 'tests.test_unit.MathTest.test_adds'], cwd: '/p', report: null });
  const go = testsInFile(fixture('math_test.go'), 'go');
  const goFile = testCommand({ framework: 'go', root: '/m/pkg', runner: [] }, { file: '/m/pkg/math_test.go', tests: go });
  assert.deepEqual(goFile.args, ['test', '-v', '-run', '^(TestAdd|TestSub|TestTable)$', '.']);
  assert.equal(goFile.cwd, '/m/pkg');
  assert.deepEqual(testCommand({ framework: 'cargo', root: '/r', runner: [] }, { file: '/r/tests/api.rs', target: { title: 'adds' } }).args, ['test', '--test', 'api', 'adds']);
  const php = testsInFile(fixture('MathTest.php'), 'phpunit');
  assert.deepEqual(testCommand({ framework: 'phpunit', root: '/w', runner: [] }, { file: '/w/tests/MathTest.php', target: php[1], report: '/tmp/r.xml' }).args, ['vendor/bin/phpunit', 'tests/MathTest.php', '--filter', '::testAdds\\b', '--log-junit', '/tmp/r.xml']);
  const cs = testsInFile(fixture('CartTests.cs'), 'dotnet');
  assert.deepEqual(testCommand({ framework: 'dotnet', root: '/s', project: 'Shop.Tests.csproj', runner: [] }, { file: '/s/CartTests.cs', target: cs[2], report: '/tmp/r.trx' }).args, ['test', 'Shop.Tests.csproj', '--filter', 'FullyQualifiedName~Shop.Tests.CartTests.Subtracts', '--logger', 'trx;LogFileName=/tmp/r.trx']);
  assert.deepEqual(testCommand({ framework: 'dotnet', root: '/s', runner: [] }, { file: '/s/CartTests.cs', tests: cs }).args, ['test', '--filter', 'FullyQualifiedName~Shop.Tests.CartTests']);
  // Windows paths: relative to the project with "/".
  assert.equal(testCommand({ framework: 'jest', root: 'C:\\p', runner: ['npx'] }, { file: 'c:\\p\\src\\a.test.js' }).args[1], 'src/a.test.js');
  assert.deepEqual(['vitest', 'jest', 'node', 'pytest', 'phpunit', 'dotnet', 'mocha', 'go'].map(reportExt), ['.xml', '.json', '.tap', '.xml', '.xml', '.trx', '', '']);
});

const cases = [
  ['vitest', 'vitest.test.js.txt', () => parseReport('junit', fixture('vitest.xml')), '/work/vitest/test/math.test.js', '/work/vitest', 7, 'AssertionError: expected 2 to be 1 // Object.is equality'],
  ['jest', 'jest.test.js.txt', () => parseReport('jest', fixture('jest.json')), '/work/jest/test/math.test.js', '/work/jest', 6, 'expect(received).toBe(expected) // Object.is equality'],
  ['mocha', 'mocha.test.js.txt', () => parseOutput('mocha', fixture('mocha.out')), '/work/mocha/test/math.test.js', '/work/mocha', 7, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:'],
  ['node', 'node.test.js.txt', () => parseReport('tap', fixture('node.tap')), '/work/nodet/math.test.js', '/work/nodet', 8, 'Expected values to be strictly equal:'],
  ['pytest', 'test_math.py', () => parseReport('junit', fixture('pytest.xml')), '/work/py/tests/test_math.py', '/work/py', 10, 'assert (3 - 1) == 1'],
  ['unittest', 'test_unit.py', () => parseOutput('unittest', fixture('unittest.out')), '/work/py/tests/test_unit.py', '/work/py', 9, 'AssertionError: 2 != 1'],
  ['go', 'math_test.go', () => parseOutput('go', fixture('go.out')), '/work/go/math_test.go', '/work/go', 13, '3-1 = 2, want 1'],
  ['cargo', 'lib.rs', () => parseOutput('cargo', fixture('cargo.out')), '/work/rust/src/lib.rs', '/work/rust', 16, 'assertion `left == right` failed: three minus one'],
  ['phpunit', 'MathTest.php', () => parseReport('junit', fixture('phpunit.xml')), '/work/php/tests/MathTest.php', '/work/php', 18, 'three minus one'],
  ['dotnet', 'CartTests.cs', () => parseReport('trx', fixture('dotnet.trx')), '/work/cs/CartTests.cs', '/work/cs', 15, 'Assert.Equal() Failure: Values differ'],
];

for (const [framework, source, parse, file, root, line, message] of cases) {
  test(`what came of a ${framework} run: each test’s state, the failure at its line`, () => {
    const tests = testsInFile(fixture(source), framework);
    const results = placeFailures(parse(), { file, root, tests });
    assert.equal(results.failed, 1);
    assert.ok(results.passed >= 1);
    const failure = results.tests.find((t) => t.status === 'failed');
    assert.equal(failure.at.line, line, 'the assertion’s line, from the report or the stack');
    assert.equal(firstMessageLine(failure.message), message);
    const states = testStates(tests, results);
    const failing = tests.find((t) => t.kind === 'test' && /^(math )?subtracts$|^test_subtracts$|^TestSub$|^Subtracts$/.test(t.name.replace(/^(TestMath|MathTest|CartTests) /, '')));
    assert.equal(states.get(failing.line), 'failed');
    assert.ok([...states.values()].includes('passed'));
    // The suite around a failed test failed too.
    const suite = tests.find((t) => t.kind === 'suite');
    if (suite) assert.equal(states.get(suite.line), 'failed');
  });
}

test('results matched to declared tests: by line, by name and suite, parameters left out', () => {
  const tests = testsInFile("describe('a', () => {\n  it('same', () => {});\n});\ndescribe('b', () => {\n  it('same', () => {});\n});\n", 'jest');
  assert.equal(matchTest(tests, { name: 'same', chain: ['b'] }).line, 5);
  assert.equal(matchTest(tests, { name: 'b > same' }).line, 5, "Vitest's JUnit names: 'suite > test'");
  assert.equal(matchTest(tests, { name: 'same', testLine: 2 }).line, 2);
  const py = testsInFile(fixture('test_math.py'), 'pytest');
  assert.equal(matchTest(py, { name: 'test_param[2]', cls: 'tests.test_math.TestMath' }).line, 13);
  assert.equal(summaryText({ tests: [{}], failed: 2, passed: 10, skipped: 1 }), '2 failed, 10 passed, 1 skipped');
  assert.equal(summaryText({ tests: [], failed: 0, passed: 0, skipped: 0 }), 'No tests ran');
});

test('a command’s end: what shells with our integration say, and the mark others get', () => {
  assert.deepEqual(commandEnded('D;0'), { code: 0 });
  assert.deepEqual(commandEnded('D;127'), { code: 127 });
  assert.deepEqual(commandEnded('D'), { code: null });
  assert.equal(commandEnded('P;Cwd=/x'), null);
  assert.equal(commandEnded('D;x'), null);
  assert.equal(endMark('posix'), `; printf '\\033]633;D;%s\\007' "$?"`);
  assert.equal(endMark('wsl'), endMark('posix'));
  assert.equal(endMark('powershell'), '');
});

test('the project around a test file: its folder and those above, up to a repository’s top', async () => {
  const tree = {
    '/r': ['.git', 'package.json', 'pnpm-lock.yaml', 'README.md'],
    '/r/pkg': ['package.json', 'vitest.config.ts', 'src'],
    '/r/pkg/src': ['a.test.ts', 'b.ts'],
  };
  const texts = { '/r/pkg/package.json': '{"devDependencies":{"vitest":"5"}}', '/r/package.json': '{}' };
  const io = { list: async (d) => tree[d] ?? [], read: async (p) => (texts[p] ? Buffer.from(texts[p]) : null), join: (a, b) => `${a}/${b}`, dirname: (p) => p.slice(0, p.lastIndexOf('/')) || '/' };
  const dirs = await projectAround('/r/pkg/src', io);
  assert.deepEqual(dirs.map((d) => [d.dir, d.names]), [['/r/pkg/src', []], ['/r/pkg', ['package.json', 'vitest.config.ts']], ['/r', ['.git', 'package.json', 'pnpm-lock.yaml']]]);
  assert.equal(dirs[1].texts['package.json'], texts['/r/pkg/package.json']);
  assert.equal((await projectAround('/r/pkg/src', { ...io, stop: '/r/pkg' })).length, 2, 'not above the folder picked');
  const setup = detectFramework({ name: 'a.test.ts', dirs });
  assert.deepEqual(setup, { framework: 'vitest', root: '/r/pkg', runner: ['pnpm', 'exec'] }, 'a workspace: its lock file is in the top folder, not next to the package’s package.json');
});
