// Shell integration for the terminal on this computer (desktop): each shell is started so that
// it says its folder after each command, so the terminal's file:line links stay right after a
// cd (the page reads OSC 7 "file://host/path", or OSC 9;9 "path" from PowerShell and cmd), and
// that a command ended, with its exit code (OSC 633;D;code, as VS Code's shell integration: a test
// run's results are read then), and (0.54) the line about to run (OSC 633;E;line;nonce, then
// 633;C): a Terminals tab offers to run a login it was running (ssh…) again when it comes back.
// The nonce (TE_NONCE, taken out of the environment at once, so programs do not see it) tells
// those from a program's output. The person's own startup files run first, as they would without it.
// - bash, Git Bash: --init-file with a script that runs ~/.bashrc (or the login files), then
//   adds a PROMPT_COMMAND and PS0 (the line, from the history: bash has no preexec);
// - zsh: ZDOTDIR points at a folder whose startup files run the person's own, then add a precmd
//   and a preexec;
// - fish: --init-command adds a function run when $PWD changes, fish_postexec and fish_preexec;
// - PowerShell: -NoExit -EncodedCommand wraps the prompt function (after the profile) and
//   PSReadLine's PSConsoleHostReadLine (the line read);
// - cmd: the PROMPT variable writes the folder before the usual prompt (no line: cmd cannot).
// The scripts are written to a folder of the app's own (`dir`): outside programs cannot read
// files inside the app's asar.
const fs = require('node:fs');
const path = require('node:path');

const BASH = String.raw`# Tracker Editor: your startup files, then the folder after each command (OSC 7).
if [ -n "$TRACKER_LOGIN" ]; then
  [ -r /etc/profile ] && . /etc/profile
  for __te_f in ~/.bash_profile ~/.bash_login ~/.profile; do [ -r "$__te_f" ] && { . "$__te_f"; break; }; done
  unset __te_f
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
__te_osc7() {
  local __te_ec=$? LC_ALL=C __te_s __te_o= __te_c __te_i
  __te_s="$(pwd -W 2>/dev/null || pwd)"
  [[ "$__te_s" == /* ]] || __te_s="/$__te_s"
  for ((__te_i = 0; __te_i < ${'$'}{#__te_s}; __te_i++)); do
    __te_c="${'$'}{__te_s:__te_i:1}"
    case "$__te_c" in
      [-/:_.~a-zA-Z0-9]) __te_o+="$__te_c" ;;
      *) printf -v __te_c '%%%02X' "'$__te_c"; __te_o+="$__te_c" ;;
    esac
  done
  printf '\e]7;file://%s%s\a\e]633;D;%s\a' "${'$'}{HOSTNAME:-}" "$__te_o" "$__te_ec"
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__te_osc7)
else
  PROMPT_COMMAND="__te_osc7${'$'}{PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
# The line about to run (OSC 633;E, escaped as VS Code's shell integration does), then that it runs
# (633;C): PS0 is shown after a line is read, before it runs (bash 4.4 and later). The nonce says
# these come from here, not from a program's output.
__te_nonce="${'$'}{TE_NONCE:-}"
unset TE_NONCE
__te_preexec() {
  local __te_l __te_b='\\' __te_s='\x3b' __te_n='\x0a' __te_r='\x0d' __te_t='\x09'
  __te_l="$(HISTTIMEFORMAT= builtin history 1)"
  if [[ "$__te_l" =~ ^[[:space:]]*[0-9]+\*?[[:space:]]+(.*)$ ]]; then __te_l="${'$'}{BASH_REMATCH[1]}"; else __te_l=; fi
  __te_l="${'$'}{__te_l//\\/"$__te_b"}"; __te_l="${'$'}{__te_l//;/"$__te_s"}"; __te_l="${'$'}{__te_l//$'\n'/"$__te_n"}"
  __te_l="${'$'}{__te_l//$'\r'/"$__te_r"}"; __te_l="${'$'}{__te_l//$'\t'/"$__te_t"}"; __te_l="${'$'}{__te_l//[[:cntrl:]]/}"
  printf '\e]633;E;%s;%s\a\e]633;C\a' "$__te_l" "$__te_nonce"
}
[ -n "$__te_nonce" ] && PS0='$(__te_preexec)'"${'$'}{PS0:-}"
`;

// zsh reads $ZDOTDIR/.zshenv, .zprofile (login), .zshrc (interactive), .zlogin (login): each of
// ours runs the person's own (from TE_ZDOTDIR, their ZDOTDIR or home), then hands back.
const zshFile = (name, extra = '') => String.raw`# Tracker Editor: your own ${name}, then back to this folder for the next one.
__te_here="$ZDOTDIR"
ZDOTDIR="${'$'}{TE_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/${name}" ]] && . "$ZDOTDIR/${name}"
TE_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$__te_here"
${extra}`;
const ZSH_HOOK = String.raw`__te_osc7() {
  local ec=$? LC_ALL=C s="$PWD" o= c i
  for (( i = 1; i <= ${'$'}{#s}; i++ )); do
    c="${'$'}{s[i]}"
    case "$c" in
      ([-/:_.~a-zA-Z0-9]) o+="$c" ;;
      (*) printf -v c '%%%02X' "'$c"; o+="$c" ;;
    esac
  done
  printf '\e]7;file://%s%s\a\e]633;D;%s\a' "$HOST" "$o" "$ec"
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __te_osc7 || precmd_functions+=(__te_osc7)
# The line about to run, as typed (OSC 633;E, escaped as VS Code's integration does; its nonce says
# it comes from here), then that it runs (633;C).
__te_nonce="${'$'}{TE_NONCE:-}"
unset TE_NONCE
__te_preexec() {
  local l="$1" b='\\' s='\x3b' n='\x0a' r='\x0d' t='\x09'
  l="${'$'}{l//\\/"$b"}"; l="${'$'}{l//;/"$s"}"; l="${'$'}{l//$'\n'/"$n"}"; l="${'$'}{l//$'\r'/"$r"}"; l="${'$'}{l//$'\t'/"$t"}"; l="${'$'}{l//[[:cntrl:]]/}"
  printf '\e]633;E;%s;%s\a\e]633;C\a' "$l" "$__te_nonce"
}
[[ -n "$__te_nonce" ]] && { autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook preexec __te_preexec || preexec_functions+=(__te_preexec); }
# Not a login shell: no .zlogin comes, so ZDOTDIR is the person's again now.
[[ -o login ]] || ZDOTDIR="$TE_ZDOTDIR"
`;
const ZSH = {
  '.zshenv': zshFile('.zshenv'),
  '.zprofile': zshFile('.zprofile'),
  '.zshrc': zshFile('.zshrc', ZSH_HOOK),
  '.zlogin': `${zshFile('.zlogin')}ZDOTDIR="$TE_ZDOTDIR"\n`,
};

// The line about to run comes to fish_preexec: escaped line by line (a command substitution would
// split it at line breaks), the lines joined by \x0a.
const FISH = String.raw`function __te_osc7 --on-variable PWD; printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD); end; function __te_done --on-event fish_postexec; printf '\e]633;D;%s\a' $status; end; __te_osc7
set -g __te_nonce "$TE_NONCE"; set -e TE_NONCE
function __te_preexec --on-event fish_preexec
  test -n "$__te_nonce"; or return
  set -l parts (string split \n -- $argv[1])
  set parts (string replace -a -- '\\' '\\\\' $parts)
  set parts (string replace -a -- ';' '\x3b' $parts)
  set parts (string replace -a -- \t '\x09' $parts)
  set parts (string replace -ra -- '[[:cntrl:]]' '' $parts)
  printf '\e]633;E;%s;%s\a\e]633;C\a' (string join '\x0a' -- $parts) $__te_nonce
end`;

// After the profile: the prompt function, wrapped so it first writes the folder (OSC 9;9,
// which Windows Terminal reads too). Only for folders of the file system.
const POWERSHELL = String.raw`$global:__TeOldPrompt = $function:prompt
function global:prompt {
  $ok = $?
  $code = $global:LASTEXITCODE
  $done = "$([char]27)]633;D;$(if ($ok) { 0 } elseif ($code) { $code } else { 1 })$([char]7)"
  $l = $ExecutionContext.SessionState.Path.CurrentLocation
  $s = if ($global:__TeOldPrompt) { & $global:__TeOldPrompt } else { "PS $($l.Path)> " }
  if ($l.Provider.Name -eq 'FileSystem') { $done + "$([char]27)]9;9;$([char]34)$($l.ProviderPath)$([char]34)$([char]7)" + $s } else { $done + $s }
}
$global:__TeNonce = $env:TE_NONCE
Remove-Item Env:TE_NONCE -ErrorAction SilentlyContinue
if ($global:__TeNonce -and (Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue)) {
  $global:__TeReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__TeReadLine
    # Saying the line must never get in the way of running it.
    try {
      $e = [regex]::Replace([string]$line, '[\x00-\x1f\\;]', { param($m) '\x{0:x2}' -f [int][char]$m.Value })
      [Console]::Write("$([char]27)]633;E;$e;$($global:__TeNonce)$([char]7)$([char]27)]633;C$([char]7)")
    } catch {}
    $line
  }
}`;

// cmd: $E is Escape, $P the folder; the person's own PROMPT (or cmd's usual $P$G) after it. cmd
// cannot put the exit code in its prompt: a command ended, without it.
const cmdPrompt = (own) => `$E]633;D$E\\$E]9;9;$P$E\\${own || '$P$G'}`;

/** Writes the scripts into `dir` (once per version of them); returns where they are. */
function writeHooks(dir, { write = fs.writeFileSync, mkdir = fs.mkdirSync, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const files = { 'bash/init.bash': BASH, ...Object.fromEntries(Object.entries(ZSH).map(([name, text]) => [`zsh/${name}`, text])) };
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    let same = false;
    try {
      same = read(file) === text;
    } catch {
      // not written yet
    }
    if (same) continue;
    mkdir(path.dirname(file), { recursive: true });
    write(file, text, { mode: 0o644 });
  }
  return { bash: path.join(dir, 'bash', 'init.bash'), zsh: path.join(dir, 'zsh') };
}

/**
 * How to start `shell` (from listShells) so it says its folder, when a command ended and (with a
 * `nonce`: hex) the line it runs: { args, env, integrated, nonce? } to use instead of its own,
 * given the scripts written in `dir`. Unknown shells start as they are (`integrated` false).
 */
function integrate(shell, env, dir, { nonce = '', ...opts } = {}) {
  const base = { args: shell.args, env, integrated: false };
  if (!dir || !shell.integration) return base;
  // The shells that say the line they run get the nonce it comes with (not cmd).
  const said = /^[0-9a-f]{8,64}$/.test(nonce) ? { TE_NONCE: nonce } : {};
  const withNonce = (r) => (said.TE_NONCE ? { ...r, env: { ...r.env, ...said }, nonce } : r);
  try {
    if (shell.integration === 'bash') {
      const { bash } = writeHooks(dir, opts);
      // A login shell would skip --init-file: the init file runs the login files instead.
      const login = shell.args.includes('-l') || shell.args.includes('--login');
      // Git Bash takes C:/… better than C:\… as an argument.
      const file = /^[A-Za-z]:\\/.test(bash) ? bash.replace(/\\/g, '/') : bash;
      return withNonce({ args: ['--init-file', file, '-i'], env: { ...env, ...(login ? { TRACKER_LOGIN: '1' } : {}) }, integrated: true });
    }
    if (shell.integration === 'zsh') {
      const { zsh } = writeHooks(dir, opts);
      return withNonce({ args: shell.args, env: { ...env, ZDOTDIR: zsh, ...(env.ZDOTDIR ? { TE_ZDOTDIR: env.ZDOTDIR } : {}) }, integrated: true });
    }
  } catch {
    // the folder cannot be written: the shell as it is
    return base;
  }
  if (shell.integration === 'fish') return withNonce({ args: [...shell.args, '--init-command', FISH], env, integrated: true });
  if (shell.integration === 'powershell') return withNonce({ args: [...shell.args, '-NoExit', '-EncodedCommand', Buffer.from(POWERSHELL, 'utf16le').toString('base64')], env, integrated: true });
  if (shell.integration === 'cmd') return { args: shell.args, env: { ...env, PROMPT: cmdPrompt(env.PROMPT) }, integrated: true };
  return base;
}

module.exports = { integrate, writeHooks, BASH, ZSH, FISH, POWERSHELL, cmdPrompt };
