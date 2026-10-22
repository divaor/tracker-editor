import { html, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

/** Runs the recorded macro several times, or until the end of the file. */
export function MacroDialog({ steps, actions, onClose }) {
  const [times, setTimes] = useState(10);
  const input = useRef(null);
  useLayoutEffect(() => input.current?.select(), []);
  const run = (n) => {
    onClose();
    actions.playMacro(n);
  };
  return html`<${Modal} title="Run the macro" onClose=${onClose}>
    <p class="muted small">The last macro you recorded (${steps} step${steps === 1 ? '' : 's'}) runs from the cursor, in the open file.</p>
    <form class="macro-form" onSubmit=${(e) => (e.preventDefault(), run(Math.max(1, Number(times) || 1)))}>
      <label class="field"><span>Times</span><input ref=${input} type="number" min="1" max="10000" value=${times} onInput=${(e) => setTimes(e.currentTarget.value)} /></label>
      <button type="submit" class="btn primary"><${Icon} name="play" size=${14} />Run ${Math.max(1, Number(times) || 1)} times</button>
      <button type="button" class="btn" onClick=${() => run('end')}><${Icon} name="skipForward" size=${14} />Run to the end of the file</button>
    </form>
  </${Modal}>`;
}
