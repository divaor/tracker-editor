#!/usr/bin/env node
// A small language server for the tests, over stdio like the real ones. It knows the
// words of the open files and of the files next to them:
// - problems: `ERROR` on a line is an error ("Fake error"), `TODO` a warning; pushed, or
//   answered to textDocument/diagnostic when FAKE_LSP_PULL=1 (as TypeScript 7 does);
// - hover, completion (after "." it offers fakeMember), signature help after "name(";
// - definition: the line declaring the word (function/def/const/let/class), in any file;
//   references and rename: every whole-word use, in any file;
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
  if (method === undefined) return; // an answer to one of ours
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
          renameProvider: true,
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
    case 'shutdown':
      return reply(null);
    case 'exit':
      return process.exit(0);
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `fake-lsp does not do ${method}` } });
  }
}
