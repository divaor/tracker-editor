// Tab views (tabGroups.js): which group a tab belongs to, the groups, what a view shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLDER_COLORS, folderColor, groupName, groupOf, NOTES, OTHER, PINNED, stepView, suggestedProject, tabGroups, toggleInView, viewKey, viewLabel, viewTabs } from '../app/js/tabGroups.js';

const ctx = {
  folders: ['/code/tracker-editor', '/code/tracking_app', '/code/tracker-editor/vendor', 'C:\\Work\\Scripts', 'remote://db1/'],
  links: { '/code/tracking_app': 'Tracker App' },
  assigned: { 'd:/var/log/app.log': 'f:/code/tracker-editor' },
};

test('a tab’s group: its folder (the deepest), the project a folder is linked to, notes, other files', () => {
  assert.equal(groupOf({ key: 'd:/code/tracker-editor/app/js/app.js', kind: 'disk', path: '/code/tracker-editor/app/js/app.js' }, ctx), 'f:/code/tracker-editor');
  assert.equal(groupOf({ key: 'd:/code/tracker-editor/vendor/x.js', kind: 'disk', path: '/code/tracker-editor/vendor/x.js' }, ctx), 'f:/code/tracker-editor/vendor');
  assert.equal(groupOf({ key: 'd:/code/tracking_app/app/js/model.js', kind: 'disk', path: '/code/tracking_app/app/js/model.js' }, ctx), 'p:tracker app');
  assert.equal(groupOf({ key: 'd:c:\\work\\scripts\\run.ps1', kind: 'disk', path: 'c:\\work\\scripts\\run.ps1' }, ctx), 'f:C:\\Work\\Scripts', 'Windows paths without case');
  assert.equal(groupOf({ key: 'd:remote://db1/etc/app.conf', kind: 'remote', path: 'remote://db1/etc/app.conf' }, ctx), 'f:remote://db1/');
  assert.equal(groupOf({ key: 'd:/tmp/notes.txt', kind: 'disk', path: '/tmp/notes.txt' }, ctx), OTHER);
  assert.equal(groupOf({ key: 'd:/code/tracker-editorial/x', kind: 'disk', path: '/code/tracker-editorial/x' }, ctx), OTHER, 'a name that only starts the same');
  assert.equal(groupOf({ key: 'f:1', kind: 'synced', project: 'Tracker App' }, ctx), 'p:tracker app');
  assert.equal(groupOf({ key: 'f:2', kind: 'synced', project: '' }, ctx), NOTES);
  assert.equal(groupOf({ key: 'r:files/x/plan.md', kind: 'doc', project: '' }, ctx), NOTES);
  // Moved by hand.
  assert.equal(groupOf({ key: 'd:/var/log/app.log', kind: 'disk', path: '/var/log/app.log' }, ctx), 'f:/code/tracker-editor');
});

test('the groups of the open tabs: notes first, then projects and folders as they come, other files last', () => {
  const tabs = [
    { key: 'd:/tmp/a.log', kind: 'disk', path: '/tmp/a.log' },
    { key: 'f:1', kind: 'synced', project: 'tracker app' },
    { key: 'd:/code/tracker-editor/README.md', kind: 'disk', path: '/code/tracker-editor/README.md' },
    { key: 'f:2', kind: 'synced', project: '' },
    { key: 'd:/code/tracking_app/README.md', kind: 'disk', path: '/code/tracking_app/README.md' },
    { key: 'd:remote://db1/etc/x', kind: 'remote', path: 'remote://db1/etc/x' },
  ];
  const groups = tabGroups(tabs, ctx, { projects: [{ key: 'tracker app', name: 'Tracker App', color: '#123456' }], colors: { '/code/tracker-editor': '#abcdef' }, folderName: (p) => (p === 'remote://db1/' ? 'db1 server' : '') });
  assert.deepEqual(
    groups.map((g) => [g.id, g.kind, g.name, g.keys.length]),
    [
      [NOTES, 'notes', 'Notes', 1],
      ['p:tracker app', 'project', 'Tracker App', 2],
      ['f:/code/tracker-editor', 'folder', 'tracker-editor', 1],
      ['f:remote://db1/', 'folder', 'db1 server', 1],
      [OTHER, 'other', 'Other files', 1],
    ],
  );
  assert.equal(groups[1].color, '#123456');
  assert.deepEqual(groups[1].folders, ['/code/tracking_app'], 'the folders linked to it');
  assert.equal(groups[2].color, '#abcdef');
  assert.ok(FOLDER_COLORS.includes(groups[3].color), 'a folder without one gets one of the folder colors');
  assert.equal(groups[0].color, null);
  // Two folders with the same name: their parent tells them apart.
  const same = tabGroups(
    [
      { key: 'd:/a/app/x', kind: 'disk', path: '/a/app/x' },
      { key: 'd:/b/app/y', kind: 'disk', path: '/b/app/y' },
    ],
    { folders: ['/a/app', '/b/app'] },
  );
  assert.deepEqual(same.map((g) => g.name), ['app (a)', 'app (b)']);
});

test('what a view shows: its groups, the pinned tabs, and the open tab from elsewhere as a guest', () => {
  const open = ['f:pin', 'f:1', 'f:2', 'd:/x/a', 'd:/x/b'];
  const group = { 'f:pin': NOTES, 'f:1': 'p:a', 'f:2': NOTES, 'd:/x/a': 'f:/x', 'd:/x/b': 'f:/x' };
  const of = (k) => group[k];
  assert.deepEqual(viewTabs(open, null, of), { keys: open, guests: [] });
  assert.deepEqual(viewTabs(open, ['f:/x'], of, { pinned: ['f:pin'] }).keys, ['f:pin', 'd:/x/a', 'd:/x/b']);
  assert.deepEqual(viewTabs(open, ['f:/x'], of, { pinned: ['f:pin'], pinnedEverywhere: false }).keys, ['d:/x/a', 'd:/x/b']);
  assert.deepEqual(viewTabs(open, [PINNED, 'p:a'], of, { pinned: ['f:pin'], pinnedEverywhere: false }).keys, ['f:pin', 'f:1']);
  assert.deepEqual(viewTabs(open, ['f:/x'], of, { active: 'f:2', side: 'f:1' }).guests, ['f:2', 'f:1']);
  assert.deepEqual(viewTabs(open, ['f:/x'], of, { active: 'd:/x/a' }).guests, []);
});

test('switching views: labels, combinations, stepping through the groups, remembering', () => {
  const groups = [{ id: NOTES, name: 'Notes' }, { id: 'p:a', name: 'Alpha' }, { id: 'f:/x', name: 'x' }];
  assert.equal(viewLabel(null, groups), 'All tabs');
  assert.equal(viewLabel(['p:a'], groups), 'Alpha');
  assert.equal(viewLabel([NOTES, 'p:a'], groups), 'Notes + Alpha');
  assert.equal(viewLabel([NOTES, 'p:a', 'f:/x'], groups), 'Notes + 2');
  assert.equal(viewLabel(['p:gone'], groups, (id) => groupName(id, { projects: [{ key: 'gone', name: 'Gone' }] })), 'Gone', 'a group with no tab open');
  assert.equal(groupName('f:/code/tracker-editor'), 'tracker-editor');
  assert.deepEqual(toggleInView(null, 'p:a'), ['p:a']);
  assert.deepEqual(toggleInView(['p:a'], NOTES), ['p:a', NOTES]);
  assert.equal(toggleInView(['p:a'], 'p:a'), null, 'none left: all tabs');
  assert.deepEqual(stepView(null, groups, 1), [NOTES]);
  assert.deepEqual(stepView([NOTES], groups, 1), ['p:a']);
  assert.equal(stepView(['f:/x'], groups, 1), null, 'after the last group: all tabs');
  assert.deepEqual(stepView(null, groups, -1), ['f:/x']);
  assert.deepEqual(stepView([NOTES, 'p:a'], groups, 1), [NOTES], 'from a combination: the first group');
  assert.equal(viewKey(null), '');
  assert.equal(viewKey(['p:a', NOTES]), viewKey([NOTES, 'p:a']));
});

test('folders get colors of their own: the same each time, not one another group shows', () => {
  assert.equal(folderColor('/code/a'), folderColor('/code/a'));
  const first = folderColor('/code/a');
  assert.notEqual(folderColor('/code/a', new Set([first])), first);
  // Many folders open: as many different colors as there are.
  const tabs = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ key: `d:/w/${n}/x`, kind: 'disk', path: `/w/${n}/x` }));
  const groups = tabGroups(tabs, { folders: ['/w/a', '/w/b', '/w/c', '/w/d', '/w/e'] });
  assert.equal(new Set(groups.map((g) => g.color)).size, 5);
  // None of them is a color of where files live.
  for (const c of FOLDER_COLORS) assert.ok(!['#1c8f55', '#2f6fd6', '#c47a0a', '#b5309a'].includes(c));
});

test('a folder whose name matches a project is offered to link to it', () => {
  const projects = [{ key: 'tracker editor', name: 'Tracker Editor' }, { key: 'api', name: 'API' }];
  assert.equal(suggestedProject('/code/tracker-editor', projects)?.name, 'Tracker Editor');
  assert.equal(suggestedProject('C:\\src\\Tracker_Editor\\', projects)?.name, 'Tracker Editor');
  assert.equal(suggestedProject('/code/other', projects), null);
});
