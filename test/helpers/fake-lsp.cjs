#!/usr/bin/env node
// A small language server for the tests, over stdio like the real ones. It knows the
// words of the open files and of the files next to them:
// - problems: `ERROR` on a line is an error ("Fake error"), `TODO` a warning; pushed, or
//   answered to textDocument/diagnostic when FAKE_LSP_PULL=1 (as TypeScript 7 does);
// - hover, completion (after "." it offers fakeMember), signature help after "name(";
// - definition: the line declaring the word (function/def/const/let/class), in any file;
//   references and rename: every whole-word use, in any file (prepareRename refuses "print");
// - code actions: on an ERROR line, "Replace ERROR with OK" (an edit, preferred); everywhere
//   "Uppercase this line" (its edit filled in by codeAction/resolve), "Add a comment above"
//   (a command: the edit comes back as workspace/applyEdit) and "Move this line to a new file"
//   (creates moved.py); source.organizeImports sorts the import lines at the top;
// - formatting: trailing spaces go, " = " around assignments (the selection only, for a range);
// - workspace symbols: the declarations whose name contains the query;
// - files changed on disk (didChangeWatchedFiles) and settings received are written to stderr;
// - "Indexing" progress after start; CRASH_NOW in a file ends the process (code 3).
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const docs = new Map(); // uri → text
let root = null;
let progress = false;
const pull = process.env.FAKE_LSP_PULL === '1';
// Started like the real ones (--stdio); `node --test` also runs this file, and then it ends.
if (!process.argv.includes('--stdio')) process.exit(0);

process.stderr.write(`fake-lsp started (${pull ? 'pull' : 'push'} diagnostics)\n`);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});

const offsetAt = (text, { line, character }) => {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + character;
};
const positionAt = (text, offset) => {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length - 1, character: before.at(-1).length };
};
const wordAt = (text, pos) => {
  const offset = offsetAt(text, pos);
  let from = offset;
  let to = offset;
  while (from > 0 && /\w/.test(text[from - 1])) from--;
  while (to < text.length && /\w/.test(text[to])) to++;
  return from < to ? text.slice(from, to) : '';
};

// The open files, then the code files next to them (not open).
function allFiles() {
  const files = new Map(docs);
  if (root) {
    for (const name of fs.readdirSync(root)) {
      if (!/\.(ts|js|py)$/.test(name)) continue;
      const uri = pathToFileURL(path.join(root, name)).href;
      if (!files.has(uri)) files.set(uri, fs.readFileSync(path.join(root, name), 'utf8'));
    }
  }
  return files;
}
function occurrences(word) {
  const found = [];
  const re = new RegExp(`\\b${word}\\b`, 'g');
  for (const [uri, text] of allFiles()) {
    for (const m of text.matchAll(re)) found.push({ uri, range: { start: positionAt(text, m.index), end: positionAt(text, m.index + word.length) } });
  }
  return found;
}

function problems(text) {
  const list = [];
  text.split('\n').forEach((line, n) => {
    for (const [word, severity, message] of [['ERROR', 1, 'Fake error: something is wrong here'], ['TODO', 2, 'Fake warning: a TODO is left']]) {
      const at = line.indexOf(word);
      if (at >= 0) list.push({ range: { start: { line: n, character: at }, end: { line: n, character: at + word.length } }, severity, source: 'fake', message });
    }
  });
  return list;
}
const publish = (uri) => {
  if (!pull) send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: problems(docs.get(uri) ?? '') } });
};
const checkCrash = (text) => {
  if (text.includes('CRASH_NOW')) process.exit(3);
};

function handle(msg) {
  const { id, method, params } = msg;
  if (method === undefined) {
    // An answer to one of ours (workspace/applyEdit): noted for the tests.
    if (id === 'apply1') process.stderr.write(`fake-lsp: applyEdit answered ${JSON.stringify(msg.result ?? msg.error)}\n`);
    return;
  }
  const reply = (result) => send({ id, result });
  switch (method) {
    case 'initialize':
      root = params.rootUri ? fileURLToPath(params.rootUri) : null;
      progress = Boolean(params.capabilities?.window?.workDoneProgress);
      return reply({
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          hoverProvider: true,
          completionProvider: { triggerCharacters: ['.'] },
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: { prepareProvider: true },
          codeActionProvider: { codeActionKinds: ['quickfix', 'refactor', 'source.organizeImports'], resolveProvider: true },
          executeCommandProvider: { commands: ['fake.addComment'] },
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          workspaceSymbolProvider: true,
          ...(pull ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
        },
        serverInfo: { name: 'fake-lsp', version: '1.0' },
      });
    case 'initialized':
      if (progress) {
        send({ id: 'p1', method: 'window/workDoneProgress/create', params: { token: 'index' } });
        send({ method: '$/progress', params: { token: 'index', value: { kind: 'begin', title: 'Indexing', percentage: 0 } } });
        setTimeout(() => send({ method: '$/progress', params: { token: 'index', value: { kind: 'report', percentage: 50 } } }), 100);
        setTimeout(() => send({ method: '$/progress', params: { token: 'index', value: { kind: 'end' } } }), 300);
      }
      return;
    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, params.textDocument.text);
      checkCrash(params.textDocument.text);
      return publish(params.textDocument.uri);
    case 'textDocument/didChange': {
      let text = docs.get(params.textDocument.uri) ?? '';
      for (const change of params.contentChanges) {
        if (!change.range) text = change.text;
        else text = text.slice(0, offsetAt(text, change.range.start)) + change.text + text.slice(offsetAt(text, change.range.end));
      }
      docs.set(params.textDocument.uri, text);
      checkCrash(text);
      return publish(params.textDocument.uri);
    }
    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri);
      return;
    case 'textDocument/diagnostic':
      return reply({ kind: 'full', items: problems(docs.get(params.textDocument.uri) ?? '') });
    case 'textDocument/hover': {
      const word = wordAt(docs.get(params.textDocument.uri) ?? '', params.position);
      return reply(word ? { contents: { kind: 'markdown', value: `\`\`\`ts\n${word}: fake\n\`\`\`\n**${word}**, as the fake server sees it.` } } : null);
    }
    case 'textDocument/completion': {
      const text = docs.get(params.textDocument.uri) ?? '';
      const before = text.slice(0, offsetAt(text, params.position));
      if (before.endsWith('.')) return reply([{ label: 'fakeMember', kind: 2, detail: '(): void', documentation: { kind: 'markdown', value: 'Docs for **fakeMember**' } }]);
      const words = new Set([...allFiles().values()].flatMap((t) => t.match(/\b[a-zA-Z_]\w{2,}\b/g) ?? []));
      return reply({ isIncomplete: false, items: [...words].map((label) => ({ label, kind: 6 })) });
    }
    case 'textDocument/signatureHelp': {
      const text = docs.get(params.textDocument.uri) ?? '';
      const before = text.slice(0, offsetAt(text, params.position));
      const m = /(\w+)\(([^()]*)$/.exec(before);
      if (!m) return reply(null);
      return reply({ signatures: [{ label: `${m[1]}(a: number, b: number): number`, parameters: [{ label: 'a: number' }, { label: 'b: number' }] }], activeSignature: 0, activeParameter: m[2].split(',').length - 1 });
    }
    case 'textDocument/definition': {
      const word = wordAt(docs.get(params.textDocument.uri) ?? '', params.position);
      const decl = new RegExp(`\\b(function|def|const|let|class)\\s+${word}\\b`);
      for (const [uri, text] of allFiles()) {
        const m = decl.exec(text);
        if (m) {
          const at = m.index + m[0].length - word.length;
          return reply({ uri, range: { start: positionAt(text, at), end: positionAt(text, at + word.length) } });
        }
      }
      return reply(null);
    }
    case 'textDocument/references': {
      const word = wordAt(docs.get(params.textDocument.uri) ?? '', params.position);
      return reply(word ? occurrences(word) : []);
    }
    case 'textDocument/rename': {
      const word = wordAt(docs.get(params.textDocument.uri) ?? '', params.position);
      const changes = {};
      for (const { uri, range } of word ? occurrences(word) : []) (changes[uri] ??= []).push({ range, newText: params.newName });
      return reply({ changes });
    }
    case 'textDocument/prepareRename': {
      const text = docs.get(params.textDocument.uri) ?? '';
      const word = wordAt(text, params.position);
      if (!word || word === 'print') return reply(null);
      const at = offsetAt(text, params.position);
      let from = at;
      while (from > 0 && /\w/.test(text[from - 1])) from--;
      return reply({ range: { start: positionAt(text, from), end: positionAt(text, from + word.length) }, placeholder: word });
    }
    case 'textDocument/codeAction': {
      const { uri } = params.textDocument;
      const text = docs.get(uri) ?? '';
      const n = params.range.start.line;
      const line = text.split('\n')[n] ?? '';
      const lineRange = { start: { line: n, character: 0 }, end: { line: n, character: line.length } };
      const only = params.context?.only;
      if (only?.some((k) => k.startsWith('source.organizeImports'))) {
        const lines = text.split('\n');
        let end = 0;
        while (end < lines.length && /^(import|from) /.test(lines[end])) end++;
        const sorted = lines.slice(0, end).sort();
        const edit = { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: end, character: 0 } }, newText: sorted.map((l) => `${l}\n`).join('') }] } };
        return reply(end ? [{ title: 'Organize imports', kind: 'source.organizeImports', edit }] : []);
      }
      const actions = [];
      const at = line.indexOf('ERROR');
      if (at >= 0) {
        const diagnostics = (params.context?.diagnostics ?? []).filter((d) => d.range.start.line === n);
        actions.push({ title: 'Replace ERROR with OK', kind: 'quickfix', isPreferred: true, diagnostics, edit: { changes: { [uri]: [{ range: { start: { line: n, character: at }, end: { line: n, character: at + 5 } }, newText: 'OK' }] } } });
      }
      if (line.trim()) {
        actions.push({ title: 'Uppercase this line', kind: 'refactor.rewrite', data: { uri, line: n } });
        actions.push({ title: 'Add a comment above', kind: 'refactor', command: { title: 'Add a comment above', command: 'fake.addComment', arguments: [uri, n] } });
        const moved = new URL('moved.py', uri).href;
        actions.push({
          title: 'Move this line to a new file',
          kind: 'refactor.move',
          edit: {
            documentChanges: [
              { kind: 'create', uri: moved, options: { ignoreIfExists: false } },
              { textDocument: { uri: moved, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `${line}\n` }] },
              { textDocument: { uri, version: null }, edits: [{ range: { start: { line: n, character: 0 }, end: { line: n + 1, character: 0 } }, newText: '' }] },
            ],
          },
        });
      }
      return reply(actions);
    }
    case 'codeAction/resolve': {
      if (!params.data) return reply(params);
      const { uri, line: n } = params.data;
      const line = (docs.get(uri) ?? '').split('\n')[n] ?? '';
      return reply({ ...params, edit: { changes: { [uri]: [{ range: { start: { line: n, character: 0 }, end: { line: n, character: line.length } }, newText: line.toUpperCase() }] } } });
    }
    case 'workspace/executeCommand': {
      if (params.command !== 'fake.addComment') return send({ id, error: { code: -32601, message: 'Unknown command' } });
      const [uri, n] = params.arguments;
      reply(null);
      // The edit comes back as a request; the answer is noted for the tests.
      return send({ id: 'apply1', method: 'workspace/applyEdit', params: { label: 'Add a comment', edit: { changes: { [uri]: [{ range: { start: { line: n, character: 0 }, end: { line: n, character: 0 } }, newText: '# added by the fake server\n' }] } } } });
    }
    case 'textDocument/formatting':
    case 'textDocument/rangeFormatting': {
      const text = docs.get(params.textDocument.uri) ?? '';
      const lines = text.split('\n');
      const from = params.range?.start.line ?? 0;
      const to = params.range?.end.line ?? lines.length - 1;
      const edits = [];
      for (let n = from; n <= to && n < lines.length; n++) {
        const tidy = lines[n].replace(/\s+$/, '').replace(/^(\s*\w+)\s*=\s*/, '$1 = ');
        if (tidy !== lines[n]) edits.push({ range: { start: { line: n, character: 0 }, end: { line: n, character: lines[n].length } }, newText: tidy });
      }
      return reply(edits);
    }
    case 'workspace/symbol': {
      const found = [];
      const decl = /\b(function|def|const|let|class)\s+(\w+)/g;
      for (const [uri, text] of allFiles()) {
        for (const m of text.matchAll(decl)) {
          if (!m[2].toLowerCase().includes(String(params.query).toLowerCase())) continue;
          const at = m.index + m[0].length - m[2].length;
          found.push({ name: m[2], kind: m[1] === 'class' ? 5 : m[1] === 'def' || m[1] === 'function' ? 12 : 13, containerName: 'fake', location: { uri, range: { start: positionAt(text, at), end: positionAt(text, at + m[2].length) } } });
        }
      }
      return reply(found);
    }
    case 'workspace/didChangeWatchedFiles':
      for (const c of params.changes) process.stderr.write(`fake-lsp: ${c.type === 1 ? 'created' : 'changed'} ${path.basename(fileURLToPath(c.uri))}\n`);
      return;
    case 'workspace/didChangeConfiguration':
      process.stderr.write(`fake-lsp: settings ${JSON.stringify(params.settings)}\n`);
      return;
    case 'shutdown':
      return reply(null);
    case 'exit':
      return process.exit(0);
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `fake-lsp does not do ${method}` } });
  }
}
