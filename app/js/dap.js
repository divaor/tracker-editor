// The debugger (desktop): a Debug Adapter Protocol client for the sessions the main process
// runs (dap.cjs through desktop.dap: the page names a file; the main process picks the adapter
// and fills in the launch). One run at a time: its top session and the child sessions an
// adapter asks for (js-debug runs each process as one). Each session: initialize → launch (not
// waited for: debugpy answers it after configurationDone) → initialized → the breakpoints of
// every file, the exception filters → configurationDone. Then what the adapters say: a stop
// (threads → the stack → the frame's scopes → variables, loaded as they are opened; the watch
// expressions evaluated), output for the debug console, the end. Kept outside Preact like the
// terminals: `onChange` says when to draw again; `onStop` / `onRun` / `onEnd` let the app show
// the paused line.
import { addToConsole, consoleOutput, exceptionFilters, firstOpen, focusFrame, framePlace, refsToLoad, sourceBreakpoints, stopReason, variableRows } from './debugTools.js';

export class DapError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

const baseName = (p) => String(p).split(/[\\/]/).pop();
const initializeArgs = (adapterID) => ({
  clientID: 'tracker-editor',
  clientName: 'Tracker Editor',
  adapterID,
  pathFormat: 'path',
  linesStartAt1: true,
  columnsStartAt1: true,
  supportsVariableType: true,
  supportsVariablePaging: false,
  // Programs write to the debug console (the launch says so); a terminal is never asked for.
  supportsRunInTerminalRequest: false,
  supportsMemoryReferences: false,
  supportsProgressReporting: false,
  supportsInvalidatedEvent: false,
  supportsStartDebuggingRequest: true,
  locale: 'en',
});
// DAP's error messages: "name '{x}' is not defined" with { x }.
const formatError = (error) => String(error.format ?? '').replace(/\{(\w+)\}/g, (_m, k) => String(error.variables?.[k] ?? `{${k}}`));

/**
 * The debugger. `bridge`: desktop.dap. `breakpoints()` → { path: list } (the settings'),
 * `exceptions()` → { uncaught, all }, `watches()` → [expression]. Timeouts in ms.
 */
export function createDebugger({ bridge, breakpoints = () => ({}), exceptions = () => ({ uncaught: true, all: false }), watches = () => [], onChange = () => {}, onStop = () => {}, onRun = () => {}, onEnd = () => {}, timeout = 10000, launchTimeout = 60000 }) {
  const sessions = new Map(); // id → session of this run
  let run = null;
  let focusToken = 0;
  let stopToken = 0;
  const changed = () => onChange(run);

  const unsubs = [
    bridge.onMessage(({ id, data }) => {
      const s = sessions.get(id);
      if (!s) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      receive(s, msg);
    }),
    bridge.onExit?.((exit) => exited(exit)) ?? (() => {}),
  ];

  // ---- Messages ----

  function makeSession(info, parent = null) {
    const s = { id: info.id, info, parent, seq: 1, pending: new Map(), caps: {}, configured: false, ended: false, threads: [], launched: null, verified: new Map(), terminated: false };
    sessions.set(s.id, s);
    return s;
  }
  const label = (s) => s?.info?.label ?? 'The debugger';
  const send = (s, msg) => bridge.send(s.id, JSON.stringify(msg));
  function request(s, command, args = {}, ms = timeout) {
    if (!s || s.ended) return Promise.reject(new DapError(`${command}: the session has ended`, 'ended'));
    const seq = s.seq++;
    return new Promise((resolve, reject) => {
      const timer = ms
        ? setTimeout(() => {
            s.pending.delete(seq);
            reject(new DapError(`${label(s)} did not answer ${command} in ${Math.round(ms / 1000)} s`, 'timeout'));
          }, ms)
        : null;
      s.pending.set(seq, { resolve, reject, timer, command });
      send(s, { seq, type: 'request', command, arguments: args });
    });
  }
  const respond = (s, req, { body = {}, error = '' } = {}) => send(s, { seq: s.seq++, type: 'response', request_seq: req.seq, command: req.command, success: !error, ...(error ? { message: error } : { body }) });

  function receive(s, msg) {
    if (msg.type === 'response') {
      const p = s.pending.get(msg.request_seq);
      if (!p) return;
      s.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new DapError(msg.body?.error?.format ? formatError(msg.body.error) : msg.message || `${p.command} failed`, msg.message ?? ''));
      return;
    }
    if (msg.type === 'event') return onEvent(s, msg.event, msg.body ?? {});
    if (msg.type === 'request') return reverse(s, msg);
  }

  const say = (text, kind = 'console') => {
    if (!run) return;
    run.console = addToConsole(run.console, { kind, text: text.endsWith('\n') ? text : `${text}\n` });
    changed();
  };

  function onEvent(s, name, body) {
    if (!run || !sessions.has(s.id)) return;
    // After the end, what the program wrote last still shows (it may come after the top's end).
    if (run.status === 'ended' && name !== 'output') return;
    switch (name) {
      case 'initialized':
        return configure(s).catch((err) => say(err.message, 'error'));
      case 'stopped':
        return stopped(s, body).catch((err) => say(err.message, 'error'));
      case 'continued':
        if (run.status === 'paused' && (body.allThreadsContinued !== false || run.focus?.thread === body.threadId)) running(s);
        return;
      case 'output': {
        const entry = consoleOutput(body);
        if (entry) {
          run.console = addToConsole(run.console, entry);
          changed();
        }
        return;
      }
      case 'exited':
        return say(`The program ended (exit code ${body.exitCode}).`, body.exitCode ? 'error' : 'important');
      case 'terminated':
        return terminated(s);
      case 'breakpoint':
        return breakpointEvent(s, body);
      case 'thread':
        if (body.reason === 'exited') {
          s.threads = s.threads.filter((t) => t.id !== body.threadId);
          changed();
        }
        return;
      case 'capabilities':
        s.caps = { ...s.caps, ...(body.capabilities ?? {}) };
        return;
      default:
    }
  }

  // What an adapter asks of the client: a child session (js-debug), a terminal (never).
  async function reverse(s, req) {
    if (req.command === 'startDebugging') {
      let info;
      try {
        info = await bridge.child(s.id, req.seq);
      } catch (err) {
        info = { error: err.message };
      }
      if (!info?.id || !run || run.status === 'ended') return respond(s, req, { error: info?.error ?? 'The run has ended.' });
      const c = makeSession(info, s);
      run.sessions.push(c);
      respond(s, req);
      changed();
      return begin(c).catch((err) => say(`${label(c)}: ${err.message}`, 'error'));
    }
    if (req.command === 'runInTerminal') return respond(s, req, { error: 'Programs run in the debug console here, not in a terminal.' });
    return respond(s, req, { error: `Not supported here: ${req.command}` });
  }

  // ---- A session's start ----

  async function begin(s) {
    s.caps = (await request(s, 'initialize', initializeArgs(s.info.config?.type || (s.info.adapter === 'python' ? 'debugpy' : 'pwa-node')))) ?? {};
    // The main process fills in the launch (or attach). debugpy answers it after configurationDone.
    s.launched = request(s, 'launch', {}, launchTimeout);
    s.launched.catch((err) => {
      if (!s.ended && run && !run.stopping && run.status !== 'ended') {
        say(`${label(s)} could not start the program: ${err.message}`, 'error');
        stop();
      }
    });
  }

  async function configure(s) {
    if (s.configured || s.ended) return;
    s.configured = true;
    const all = breakpoints();
    await Promise.all(Object.entries(all).map(([path, list]) => setBreakpointsOn(s, path, list).catch((err) => say(`Breakpoints in ${baseName(path)}: ${err.message}`, 'error'))));
    if (s.caps.exceptionBreakpointFilters?.length) await request(s, 'setExceptionBreakpoints', { filters: exceptionFilters(s.caps, exceptions(), { test: Boolean(run?.test) }) }).catch((err) => say(err.message, 'error'));
    if (s.caps.supportsConfigurationDoneRequest) await request(s, 'configurationDone', {});
    if (run?.status === 'starting') {
      run.status = 'running';
      onRun(run);
      changed();
    }
  }

  async function setBreakpointsOn(s, path, list) {
    const sent = sourceBreakpoints(list, s.caps);
    const res = await request(s, 'setBreakpoints', { source: { path, name: baseName(path) }, breakpoints: sent, lines: sent.map((b) => b.line), sourceModified: false });
    s.verified.set(
      path,
      (res.breakpoints ?? []).map((b, i) => ({ id: b.id, asked: sent[i]?.line, line: b.line ?? sent[i]?.line, verified: b.verified !== false, message: b.message ?? '' })),
    );
    changed();
  }
  function breakpointEvent(s, body) {
    const bp = body.breakpoint;
    if (!bp || bp.id == null) return;
    for (const list of s.verified.values()) {
      const at = list.find((b) => b.id === bp.id);
      if (at) {
        if (body.reason === 'removed') at.verified = false;
        else Object.assign(at, { verified: bp.verified !== false, line: bp.line ?? at.line, message: bp.message ?? '' });
      }
    }
    changed();
  }

  // ---- Stops ----

  async function stopped(s, body) {
    const token = ++stopToken;
    run.status = 'paused';
    run.reason = stopReason(body);
    // Where it stopped, at once: F5 or a step pressed before the stack is read still go there.
    run.focus = { session: s.id, thread: body.threadId ?? null, frame: null };
    changed();
    let threads = [];
    try {
      threads = (await request(s, 'threads')).threads ?? [];
    } catch {
      // the stack still says where
    }
    if (token !== stopToken || !run) return;
    const threadId = body.threadId ?? threads[0]?.id ?? null;
    const known = new Map(s.threads.map((t) => [t.id, t]));
    s.threads = threads.map((t) => ({ id: t.id, name: t.name, paused: Boolean(body.allThreadsStopped) || t.id === threadId, frames: known.get(t.id)?.frames ?? [] }));
    if (threadId != null && !s.threads.some((t) => t.id === threadId)) s.threads.push({ id: threadId, name: `Thread ${threadId}`, paused: true, frames: [] });
    if (body.reason === 'exception' && s.caps.supportsExceptionInfoRequest && threadId != null) {
      try {
        const info = await request(s, 'exceptionInfo', { threadId });
        const what = [info.exceptionId, info.description].filter(Boolean).join(': ');
        if (what) run.reason = stopReason({ reason: 'exception', text: what });
      } catch {
        // the stop's own words
      }
    }
    const thread = s.threads.find((t) => t.id === threadId);
    let frames = [];
    if (threadId != null) {
      try {
        frames = (await request(s, 'stackTrace', { threadId, startFrame: 0, levels: 50 })).stackFrames ?? [];
      } catch (err) {
        say(`The stack: ${err.message}`, 'error');
      }
    }
    if (token !== stopToken || !run || run.status !== 'paused') return;
    if (thread) thread.frames = frames;
    const frame = focusFrame(frames);
    await selectFrame(s.id, threadId, frame?.id ?? null);
    if (token !== stopToken) return;
    onStop({ run, session: s, frame, place: framePlace(frame), reason: run.reason });
  }

  /** Shows a frame: its scopes (the locals open), the open variables, the watch expressions in it. */
  async function selectFrame(sessionId, threadId, frameId) {
    if (!run) return;
    const token = ++focusToken;
    run.focus = { session: sessionId, thread: threadId, frame: frameId };
    run.scopes = [];
    run.children = new Map();
    changed();
    const s = sessions.get(sessionId);
    if (!s || frameId == null) return;
    let scopes = [];
    try {
      scopes = (await request(s, 'scopes', { frameId })).scopes ?? [];
    } catch (err) {
      say(`Variables: ${err.message}`, 'error');
    }
    if (token !== focusToken || !run) return;
    run.scopes = scopes;
    for (const name of firstOpen(scopes)) if (!run.closed.has(name)) run.open.add(name);
    changed();
    await Promise.all([loadOpen(token), refreshWatches()]);
  }
  /** A frame of the stack shown, as when it stopped there (its place goes to the app). */
  async function showFrame(sessionId, threadId, frameId) {
    await selectFrame(sessionId, threadId, frameId);
    const s = sessions.get(sessionId);
    const frame = s?.threads.find((t) => t.id === threadId)?.frames.find((f) => f.id === frameId);
    if (frame) onStop({ run, session: s, frame, place: framePlace(frame), reason: run?.reason ?? '', picked: true });
  }

  // The children of the open variables not loaded yet, a level at a time.
  async function loadOpen(token = focusToken) {
    for (let round = 0; round < 10 && run && token === focusToken; round++) {
      const refs = refsToLoad(variableRows(run.scopes, run.children, run.open), run.children);
      if (!refs.length) return;
      await Promise.all(refs.map((ref) => loadChildren(ref, token)));
    }
  }
  async function loadChildren(ref, token) {
    const s = sessions.get(run?.focus?.session);
    if (!s || run.children.has(ref)) return;
    run.children.set(ref, null);
    let vars;
    try {
      vars = (await request(s, 'variables', { variablesReference: ref })).variables ?? [];
    } catch (err) {
      vars = [{ name: '(could not read)', value: err.message, variablesReference: 0 }];
    }
    if (token !== focusToken || !run) return;
    run.children.set(ref, vars);
    changed();
  }
  /** A variable (or scope) row opened or closed. */
  function toggle(row) {
    if (!run || !row.ref) return;
    if (run.open.has(row.path)) {
      run.open.delete(row.path);
      if (row.scope) run.closed.add(row.path);
    } else {
      run.open.add(row.path);
      run.closed.delete(row.path);
    }
    changed();
    loadOpen();
  }

  async function refreshWatches() {
    if (!run) return;
    const list = watches();
    const s = sessions.get(run.focus?.session);
    const frameId = run.focus?.frame;
    const token = focusToken;
    const out = new Map();
    await Promise.all(
      list.map(async (expression) => {
        if (!s || run.status !== 'paused' || frameId == null) return out.set(expression, { value: '', error: '' });
        try {
          const r = await request(s, 'evaluate', { expression, frameId, context: 'watch' });
          out.set(expression, { value: r.result ?? '', type: r.type ?? '', error: '' });
        } catch (err) {
          out.set(expression, { value: '', error: err.message });
        }
      }),
    );
    if (!run || token !== focusToken) return;
    run.watch = out;
    changed();
  }

  // The session things are asked of: the frame's, else the newest one still running (js-debug's
  // child, where the program is), else the top.
  const focusSession = () => {
    const f = sessions.get(run?.focus?.session);
    if (f && !f.ended) return f;
    return [...(run?.sessions ?? [])].reverse().find((s) => !s.ended && s.configured) ?? run?.top ?? null;
  };

  /** Evaluates `expression` in the debug console (in the frame shown when paused). */
  async function evaluate(expression) {
    if (!run || run.status === 'ended' || !expression.trim()) return;
    say(`› ${expression}`, 'input');
    const s = focusSession();
    try {
      const r = await request(s, 'evaluate', { expression, ...(run.status === 'paused' && run.focus?.frame != null ? { frameId: run.focus.frame } : {}), context: 'repl' });
      say(String(r.result ?? ''), 'result');
    } catch (err) {
      say(err.message, 'error');
    }
    if (run?.status === 'paused') refreshWatches();
  }

  // ---- Going on ----

  function running(s) {
    for (const t of s.threads) {
      t.paused = false;
      t.frames = [];
    }
    stopToken++;
    focusToken++;
    run.status = 'running';
    run.reason = '';
    run.scopes = [];
    run.children = new Map();
    run.watch = new Map();
    onRun(run);
    changed();
  }
  async function control(command) {
    if (run?.status !== 'paused') return false;
    const s = sessions.get(run.focus?.session);
    if (!s) return false;
    let threadId = run.focus?.thread ?? s.threads.find((t) => t.paused)?.id ?? s.threads[0]?.id;
    if (threadId == null) {
      try {
        threadId = (await request(s, 'threads')).threads?.[0]?.id;
      } catch {
        // asked with none
      }
    }
    if (threadId == null) return false;
    running(s);
    try {
      await request(s, command, { threadId });
    } catch (err) {
      say(`${command}: ${err.message}`, 'error');
    }
    return true;
  }
  async function pause() {
    if (run?.status !== 'running') return false;
    const s = focusSession();
    if (!s) return false;
    let threadId = s.threads[0]?.id;
    if (threadId == null) {
      try {
        threadId = (await request(s, 'threads')).threads?.[0]?.id;
      } catch {
        // asked with no thread
      }
    }
    try {
      await request(s, 'pause', { threadId: threadId ?? 0 });
    } catch (err) {
      say(`Pause: ${err.message}`, 'error');
    }
    return true;
  }

  // ---- The end ----

  function terminated(s) {
    if (s.terminated) return;
    s.terminated = true;
    if (run?.stopping) return; // stop() ends it
    // The adapter is told the session is over (it cleans up), then the session ends.
    request(s, 'disconnect', { terminateDebuggee: true }, 3000)
      .catch(() => {})
      .finally(() => {
        if (!s.parent) {
          bridge.stop(s.id)?.catch?.(() => {});
          finish();
        } else endSession(s);
      });
  }
  function endSession(s) {
    if (s.ended) return;
    s.ended = true;
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DapError(`${p.command}: the session has ended`, 'ended'));
    }
    s.pending.clear();
    if (run?.focus?.session === s.id && run.status === 'paused') running(s);
    changed();
    // js-debug's top session ends after its last child; should it not say so, the run ends anyway.
    const r = run;
    if (s.parent && r && r.status !== 'ended' && !r.stopping && r.sessions.every((x) => !x.parent || x.ended)) {
      setTimeout(() => {
        if (run === r && r.status !== 'ended' && !r.stopping && r.sessions.every((x) => !x.parent || x.ended)) stop();
      }, 3000);
    }
  }
  function exited({ id, code, message }) {
    const s = sessions.get(id);
    if (!s || s.ended) return;
    endSession(s);
    if (s.parent) return;
    if (run && !run.stopping && !s.terminated && run.status !== 'ended') say(`${label(s)} ended${code != null ? ` (code ${code})` : ''}.${message ? `\n${message}` : ''}`, 'error');
    finish();
  }
  function finish() {
    const r = run;
    if (!r || r.status === 'ended') return;
    r.status = 'ended';
    r.reason = '';
    for (const s of r.sessions) endSession(s);
    r.scopes = [];
    r.children = new Map();
    r.watch = new Map();
    bridge.active?.(false);
    onEnd(r);
    changed();
  }

  /** Stops the run: each session asked to end its program (children first), then its adapter. */
  async function stop() {
    const r = run;
    if (!r || r.status === 'ended') return;
    r.stopping = true;
    const live = r.sessions.filter((s) => !s.ended);
    const ask = (s) => request(s, 'disconnect', { terminateDebuggee: true }, 3000).catch(() => {});
    await Promise.all(live.filter((s) => s.parent).map(ask));
    if (r.top && !r.top.ended) await ask(r.top);
    if (r.top) await Promise.resolve(bridge.stop(r.top.id)).catch(() => {});
    finish();
  }

  /**
   * Debugs `file` (a disk tab's path): `test` { framework, target } debugs a test instead. →
   * { id } once its adapter runs, else what the main process said ({ missing }, { none },
   * { error }); the run before (ended) stays shown then.
   */
  async function start(file, { test = null } = {}) {
    if (run && run.status !== 'ended') await stop();
    const before = run;
    for (const s of before?.sessions ?? []) sessions.delete(s.id);
    const r = { file, test, label: baseName(file), status: 'starting', reason: '', adapter: '', sessions: [], top: null, console: [], focus: null, scopes: [], children: new Map(), open: before?.open ?? new Set(), closed: before?.closed ?? new Set(), watch: new Map(), stopping: false, startedAt: Date.now() };
    run = r;
    changed();
    let info;
    try {
      info = await bridge.start(file, test ? { test } : {});
    } catch (err) {
      info = { error: err.message };
    }
    if (run !== r) return { stale: true };
    if (!info?.id) {
      run = before;
      changed();
      return info ?? { error: 'The debugger did not start.' };
    }
    const top = makeSession(info, null);
    r.top = top;
    r.adapter = info.adapter;
    r.label = info.name || `Debug ${baseName(file)}`;
    r.sessions.push(top);
    bridge.active?.(true);
    const c = info.config ?? {};
    say(`${info.label}: ${c.module ? `${c.module} ${(c.args ?? []).join(' ')}` : [c.program ?? file, ...(c.args ?? [])].join(' ')}`, 'console');
    begin(top).catch((err) => {
      say(`${info.label} did not start: ${err.message}`, 'error');
      stop();
    });
    return { id: top.id };
  }
  async function restart() {
    if (!run) return null;
    const { file, test } = run;
    await stop();
    return start(file, { test });
  }

  /** A file's breakpoints changed: sent again to the sessions running. */
  async function setBreakpoints(path) {
    if (!run || run.status === 'ended') return;
    const list = breakpoints()[path] ?? [];
    await Promise.all(run.sessions.filter((s) => s.configured && !s.ended).map((s) => setBreakpointsOn(s, path, list).catch(() => {})));
  }
  /** The exception choices changed. */
  async function setExceptions() {
    if (!run || run.status === 'ended') return;
    await Promise.all(run.sessions.filter((s) => s.configured && !s.ended && s.caps.exceptionBreakpointFilters?.length).map((s) => request(s, 'setExceptionBreakpoints', { filters: exceptionFilters(s.caps, exceptions(), { test: Boolean(run.test) }) }).catch(() => {})));
  }
  /** The adapters' word on a file's breakpoints: Map(line asked → { verified, line, message }); a line counts as verified when a session says so. */
  function breakpointStates(path) {
    const out = new Map();
    if (!run || run.status === 'ended') return out;
    for (const s of run.sessions) {
      for (const b of s.verified.get(path) ?? []) {
        const was = out.get(b.asked);
        if (!was || (!was.verified && b.verified)) out.set(b.asked, { verified: b.verified, line: b.line, message: b.message });
      }
    }
    return out;
  }
  /** Every thread of the run, with its session, for the call stack. */
  const threads = () => (run?.sessions ?? []).flatMap((s) => s.threads.map((t) => ({ ...t, session: s.id, sessionName: s.parent ? s.info.name : '' })));

  return {
    get run() {
      return run;
    },
    active: () => Boolean(run && run.status !== 'ended'),
    paused: () => run?.status === 'paused',
    start,
    stop,
    restart,
    continue: () => control('continue'),
    stepOver: () => control('next'),
    stepInto: () => control('stepIn'),
    stepOut: () => control('stepOut'),
    pause,
    showFrame,
    toggle,
    rows: () => (run ? variableRows(run.scopes, run.children, run.open) : []),
    evaluate,
    refreshWatches,
    setBreakpoints,
    setExceptions,
    breakpointStates,
    threads,
    clearConsole() {
      if (run) {
        run.console = [];
        changed();
      }
    },
    dispose() {
      for (const u of unsubs) u?.();
    },
  };
}
