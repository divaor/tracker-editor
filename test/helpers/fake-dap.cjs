#!/usr/bin/env node
// A small debug adapter for the tests, speaking the Debug Adapter Protocol like the real ones:
// - `--stdio` as debugpy does: launch is answered only after configurationDone (initialized
//   comes after launch);
// - `--server <port> <host>` as js-debug's standalone server does: each connection is a
//   session; the first one's launch asks for a child session (startDebugging, attach with
//   __pendingTargetId) and the child runs the program; the parent ends after it.
// The "program" is the file's lines, run one after the other (no jumps): `x = 5` / `let x = 5;`
// assigns (numbers, 'strings', [lists]); `print(…)` / `console.log(…)` writes to stdout;
// `raise …` / `throw …` raises (it stops there when an exception filter is on; then the program
// ends with code 1); `sleep(ms)` waits. Breakpoints stop on their line (condition `x > 3`, hit
// count `2` or `>= 2`, log message `x is {x}`); next and step in run one line, step out and
// continue run on. Evaluate knows the variables, numbers and `a + b`. The launch (or attach)
// arguments received are written to the console first, for the tests to check.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const mode = process.argv.includes('--stdio') ? 'stdio' : process.argv.includes('--server') ? 'server' : null;
// `node --test` runs this file too: then it ends.
if (!mode) process.exit(0);

function framer(write) {
  let seq = 1;
  return {
    send(msg) {
      const body = Buffer.from(JSON.stringify({ seq: seq++, ...msg }), 'utf8');
      write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    },
  };
}
function reader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      buffer = buffer.subarray(end + 4 + length);
      onMessage(message);
    }
  };
}

const CAPS = {
  supportsConfigurationDoneRequest: true,
  supportsConditionalBreakpoints: true,
  supportsHitConditionalBreakpoints: true,
  supportsLogPoints: true,
  supportsEvaluateForHovers: true,
  supportsTerminateRequest: true,
  exceptionBreakpointFilters: [
    { filter: 'raised', label: 'Raised exceptions', default: false },
    { filter: 'uncaught', label: 'Uncaught exceptions', default: true },
  ],
};

const literal = (text, vars) => {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: t, num: Number(t) };
  if (/^(['"]).*\1$/.test(t)) return { value: `'${t.slice(1, -1)}'`, str: t.slice(1, -1) };
  if (/^\[.*\]$/.test(t)) {
    const items = t.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map((s) => literal(s, vars));
    return { value: `[${items.map((i) => i.value).join(', ')}]`, items };
  }
  const m = /^([A-Za-z_]\w*)\s*\+\s*([A-Za-z_]\w*|-?\d+)$/.exec(t);
  if (m) {
    const a = literal(m[1], vars);
    const b = literal(m[2], vars);
    if (a.num !== undefined && b.num !== undefined) return { value: String(a.num + b.num), num: a.num + b.num };
  }
  if (/^[A-Za-z_]\w*$/.test(t)) {
    if (vars.has(t)) return vars.get(t);
    throw new Error(`name '${t}' is not defined`);
  }
  throw new Error(`cannot evaluate ${t}`);
};
const shown = (v) => (v.str !== undefined ? v.str : v.value);

// One program run: lines, breakpoints, variables, a thread.
function makeRunner(send, config, shared) {
  const file = config.program;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const vars = new Map();
  const hits = new Map();
  let current = 0; // the line it stopped before (1-based), 0 before the start
  let running = false;
  let pauseAsked = false;
  let ended = false;
  const event = (name, body) => send({ type: 'event', event: name, body });
  const output = (text, category = 'stdout') => event('output', { category, output: text });

  function stopsAt(n) {
    const bp = shared.breakpoints.get(file)?.find((b) => b.line === n);
    if (!bp) return false;
    if (bp.condition) {
      const m = /^([A-Za-z_]\w*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)$/.exec(bp.condition.trim());
      if (!m || !vars.has(m[1])) return false;
      const a = vars.get(m[1]).num;
      const b = Number(m[3]);
      if (!{ '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b, '==': a === b, '!=': a !== b }[m[2]]) return false;
    }
    const count = (hits.get(n) ?? 0) + 1;
    hits.set(n, count);
    if (bp.hitCondition) {
      const m = /^(>=|>)?\s*(\d+)$/.exec(bp.hitCondition.trim());
      if (!m) return false;
      const want = Number(m[2]);
      if (!(m[1] === '>=' ? count >= want : m[1] === '>' ? count > want : count === want)) return false;
    }
    if (bp.logMessage) {
      output(`${bp.logMessage.replace(/\{(\w+)\}/g, (_m, name) => (vars.has(name) ? shown(vars.get(name)) : `{${name}}`))}\n`, 'console');
      return false;
    }
    return true;
  }
  const stop = (reason, extra = {}) => {
    running = false;
    event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...extra });
  };
  function finish(code) {
    if (ended) return;
    ended = true;
    running = false;
    event('exited', { exitCode: code });
    event('terminated', {});
    shared.onEnd?.();
  }
  // Runs line `n` (1-based): what it does.
  async function exec(n) {
    const text = (lines[n - 1] ?? '').trim();
    let m = /^(?:let |const |var )?([A-Za-z_]\w*)\s*=\s*(.+?);?$/.exec(text);
    if (m && !/^(print|console\.log)\(/.test(text)) {
      vars.set(m[1], literal(m[2], vars));
      return null;
    }
    m = /^(?:print|console\.log)\((.*)\);?$/.exec(text);
    if (m) {
      const parts = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => shown(literal(s, vars)));
      output(`${parts.join(' ')}\n`);
      return null;
    }
    m = /^sleep\((\d+)\);?$/.exec(text);
    if (m) {
      await new Promise((r) => setTimeout(r, Number(m[1])));
      return null;
    }
    m = /^(?:raise|throw)\s+(.*?);?$/.exec(text);
    if (m) return { exception: m[1] || 'Error' };
    return null;
  }
  const isCode = (n) => {
    const t = (lines[n - 1] ?? '').trim();
    return Boolean(t) && !t.startsWith('#') && !t.startsWith('//');
  };
  // Runs from the line it stopped before (that line's breakpoint is passed unless `checkFirst`):
  // `step` stops before the next line.
  async function run(step = false, checkFirst = false) {
    running = true;
    let first = true;
    for (let n = Math.max(1, current); n <= lines.length; n++) {
      if (!isCode(n)) continue;
      if (pauseAsked) {
        pauseAsked = false;
        current = n;
        return stop('pause');
      }
      if ((!first || checkFirst) && stopsAt(n)) {
        current = n;
        return stop('breakpoint', { hitBreakpointIds: [shared.ids.get(`${file}:${n}`)].filter(Boolean) });
      }
      first = false;
      const result = await exec(n);
      if (result?.exception) {
        current = n;
        if (shared.filters.includes('raised') || shared.filters.includes('uncaught')) {
          shared.afterException = true;
          return stop('exception', { description: 'Exception', text: result.exception });
        }
        output(`Traceback: ${result.exception}\n`, 'stderr');
        return finish(1);
      }
      if (step) {
        let next = n + 1;
        while (next <= lines.length && !isCode(next)) next++;
        if (next > lines.length) return finish(0);
        current = next;
        return stop('step');
      }
    }
    finish(0);
  }
  return {
    file,
    vars,
    get line() {
      return current;
    },
    get running() {
      return running;
    },
    start() {
      event('thread', { reason: 'started', threadId: 1 });
      if (config.stopOnEntry) {
        current = 1;
        while (current <= lines.length && !isCode(current)) current++;
        return stop('entry');
      }
      current = 1;
      run(false, true);
    },
    resume(step) {
      if (shared.afterException) {
        output('Traceback: the exception was not caught\n', 'stderr');
        return finish(1);
      }
      run(step);
    },
    pause() {
      pauseAsked = true;
    },
    end: () => finish(0),
    get ended() {
      return ended;
    },
  };
}

// One session: a connection (or stdio), its requests.
function session(write, { server = null, close = () => {} } = {}) {
  const { send } = framer(write);
  const shared = { breakpoints: new Map(), ids: new Map(), filters: [], onEnd: null };
  let runner = null;
  let config = null;
  let launchRequest = null;
  let nextBp = 1;
  const reply = (req, body = {}) => send({ type: 'response', request_seq: req.seq, command: req.command, success: true, body });
  const fail = (req, message) => send({ type: 'response', request_seq: req.seq, command: req.command, success: false, message, body: { error: { id: 1, format: message } } });
  const event = (name, body = {}) => send({ type: 'event', event: name, body });
  const me = { send, event, child: false, parent: null, runner: () => runner, ended: false };

  function handle(req) {
    if (req.type === 'response') {
      if (req.command === 'startDebugging') event('output', { category: 'console', output: `fake-dap: startDebugging answered ${req.success}\n` });
      return;
    }
    const args = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        reply(req, CAPS);
        if (mode === 'server') event('initialized');
        return;
      case 'launch':
      case 'attach':
        config = args;
        event('output', { category: 'console', output: `fake-dap: ${req.command} ${JSON.stringify(args)}\n` });
        if (args.__pendingTargetId && server) {
          // A child: it runs the program its parent was launched with.
          me.child = true;
          me.parent = server.parent;
          if (server.parent) server.parent.childSession = me;
          return reply(req);
        }
        if (mode === 'stdio') {
          launchRequest = req; // answered after configurationDone, as debugpy does
          event('initialized');
          return;
        }
        if (server) server.parent = me;
        return reply(req);
      case 'setBreakpoints': {
        const file = args.source?.path;
        const list = (args.breakpoints ?? []).map((b) => ({ ...b }));
        shared.breakpoints.set(file, list);
        if (server) server.breakpoints.set(file, list);
        return reply(req, {
          breakpoints: list.map((b) => {
            const id = nextBp++;
            shared.ids.set(`${file}:${b.line}`, id);
            return { id, verified: true, line: b.line };
          }),
        });
      }
      case 'setExceptionBreakpoints':
        shared.filters = args.filters ?? [];
        return reply(req, {});
      case 'configurationDone':
        reply(req);
        if (launchRequest) reply(launchRequest);
        if (mode === 'server' && !me.child) {
          // The parent asks for a session for the program's process.
          send({ type: 'request', command: 'startDebugging', arguments: { request: 'attach', configuration: { type: 'fake-child', name: 'Child process', __pendingTargetId: 'T1', program: config.program, cwd: config.cwd } } });
          return;
        }
        runner = makeRunner(send, config, shared);
        shared.onEnd = () => {
          if (me.parent && !me.parent.ended) me.parent.event('terminated');
        };
        setTimeout(() => runner.start(), 20);
        return;
      case 'threads':
        return reply(req, { threads: runner ? [{ id: 1, name: 'MainThread' }] : [] });
      case 'stackTrace':
        if (!runner) return fail(req, 'Not running');
        return reply(req, {
          stackFrames: [
            { id: 1, name: 'main', line: runner.line, column: 1, source: { name: path.basename(runner.file), path: runner.file } },
            { id: 2, name: 'runner', line: 1, column: 1, source: { name: '<runner>', sourceReference: 7 }, presentationHint: 'subtle' },
          ],
          totalFrames: 2,
        });
      case 'scopes':
        return reply(req, {
          scopes: [
            { name: 'Locals', variablesReference: 1, expensive: false },
            { name: 'Globals', variablesReference: 2, expensive: true },
          ],
        });
      case 'variables': {
        const ref = args.variablesReference;
        if (ref === 1) {
          let i = 0;
          return reply(req, {
            variables: [...(runner?.vars ?? new Map())].map(([name, v]) => {
              i++;
              return { name, value: v.value, type: v.items ? 'list' : v.num !== undefined ? 'int' : 'str', variablesReference: v.items ? 1000 + i : 0 };
            }),
          });
        }
        if (ref === 2) return reply(req, { variables: [{ name: '__name__', value: "'__main__'", type: 'str', variablesReference: 0 }] });
        if (ref > 1000) {
          const v = [...(runner?.vars ?? new Map()).values()][ref - 1001];
          return reply(req, { variables: (v?.items ?? []).map((item, n) => ({ name: String(n), value: item.value, type: 'int', variablesReference: 0 })) });
        }
        return reply(req, { variables: [] });
      }
      case 'evaluate':
        try {
          const v = literal(args.expression, runner?.vars ?? new Map());
          return reply(req, { result: v.value, type: v.items ? 'list' : 'int', variablesReference: 0 });
        } catch (err) {
          return fail(req, err.message);
        }
      case 'continue':
        reply(req, { allThreadsContinued: true });
        return runner?.resume(false);
      case 'next':
      case 'stepIn':
        reply(req);
        return runner?.resume(true);
      case 'stepOut':
        reply(req);
        return runner?.resume(false);
      case 'pause':
        reply(req);
        return runner?.pause();
      case 'terminate':
        reply(req);
        if (runner && !runner.ended) runner.end();
        else event('terminated');
        return;
      case 'disconnect':
        reply(req);
        me.ended = true;
        return setTimeout(close, 20);
      default:
        return fail(req, `fake-dap does not do ${req.command}`);
    }
  }
  return { handle, me };
}

if (mode === 'stdio') {
  process.stderr.write('fake-dap started (stdio)\n');
  const s = session((buf) => process.stdout.write(buf), { close: () => process.exit(0) });
  process.stdin.on('data', reader(s.handle));
  process.stdin.on('end', () => process.exit(0));
} else {
  const at = process.argv.indexOf('--server');
  const port = Number(process.argv[at + 1]);
  const host = process.argv[at + 2] || '127.0.0.1';
  const server = { parent: null, breakpoints: new Map() };
  const tcp = net.createServer((socket) => {
    const s = session((buf) => socket.write(buf), { server, close: () => socket.end() });
    // A child starts with its parent's breakpoints until it is told its own.
    socket.on('data', reader(s.handle));
    socket.on('error', () => {});
  });
  tcp.listen(port, host, () => process.stdout.write(`Debug server listening at ${host}:${port}\n`));
}
