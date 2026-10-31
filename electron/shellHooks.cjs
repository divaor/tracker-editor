// Shell integration for the terminal on this computer (desktop): each shell is started so that
// it says its folder after each command, so the terminal's file:line links stay right after a
// cd (the page reads OSC 7 "file://host/path", or OSC 9;9 "path" from PowerShell and cmd). The
// person's own startup files run first, as they would without it.
// - bash, Git Bash: --init-file with a script that runs ~/.bashrc (or the login files), then
//   adds a PROMPT_COMMAND;
// - zsh: ZDOTDIR points at a folder whose startup files run the person's own, then add a precmd;
// - fish: --init-command adds a function run when $PWD changes;
// - PowerShell: -NoExit -EncodedCommand wraps the prompt function (after the profile);
// - cmd: the PROMPT variable writes the folder before the usual prompt.
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
  local LC_ALL=C __te_s __te_o= __te_c __te_i
  __te_s="$(pwd -W 2>/dev/null || pwd)"
  [[ "$__te_s" == /* ]] || __te_s="/$__te_s"
  for ((__te_i = 0; __te_i < ${'$'}{#__te_s}; __te_i++)); do
    __te_c="${'$'}{__te_s:__te_i:1}"
    case "$__te_c" in
      [-/:_.~a-zA-Z0-9]) __te_o+="$__te_c" ;;
      *) printf -v __te_c '%%%02X' "'$__te_c"; __te_o+="$__te_c" ;;
    esac
  done
  printf '\e]7;file://%s%s\a' "${'$'}{HOSTNAME:-}" "$__te_o"
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND+=(__te_osc7)
else
  PROMPT_COMMAND="__te_osc7${'$'}{PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
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
  local LC_ALL=C s="$PWD" o= c i
  for (( i = 1; i <= ${'$'}{#s}; i++ )); do
    c="${'$'}{s[i]}"
    case "$c" in
      ([-/:_.~a-zA-Z0-9]) o+="$c" ;;
      (*) printf -v c '%%%02X' "'$c"; o+="$c" ;;
    esac
  done
  printf '\e]7;file://%s%s\a' "$HOST" "$o"
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __te_osc7 || precmd_functions+=(__te_osc7)
# Not a login shell: no .zlogin comes, so ZDOTDIR is the person's again now.
[[ -o login ]] || ZDOTDIR="$TE_ZDOTDIR"
`;
const ZSH = {
  '.zshenv': zshFile('.zshenv'),
  '.zprofile': zshFile('.zprofile'),
  '.zshrc': zshFile('.zshrc', ZSH_HOOK),
  '.zlogin': `${zshFile('.zlogin')}ZDOTDIR="$TE_ZDOTDIR"\n`,
};

const FISH = String.raw`function __te_osc7 --on-variable PWD; printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD); end; __te_osc7`;

// After the profile: the prompt function, wrapped so it first writes the folder (OSC 9;9,
// which Windows Terminal reads too). Only for folders of the file system.
const POWERSHELL = String.raw`$global:__TeOldPrompt = $function:prompt
function global:prompt {
  $l = $ExecutionContext.SessionState.Path.CurrentLocation
  $s = if ($global:__TeOldPrompt) { & $global:__TeOldPrompt } else { "PS $($l.Path)> " }
  if ($l.Provider.Name -eq 'FileSystem') { "$([char]27)]9;9;$([char]34)$($l.ProviderPath)$([char]34)$([char]7)" + $s } else { $s }
}`;

// cmd: $E is Escape, $P the folder; the person's own PROMPT (or cmd's usual $P$G) after it.
const cmdPrompt = (own) => `$E]9;9;$P$E\\${own || '$P$G'}`;

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
 * How to start `shell` (from listShells) so it says its folder: { args, env } to use instead
 * of its own, given the scripts written in `dir`. Unknown shells start as they are.
 */
function integrate(shell, env, dir, opts = {}) {
  const base = { args: shell.args, env };
  if (!dir || !shell.integration) return base;
  try {
    if (shell.integration === 'bash') {
      const { bash } = writeHooks(dir, opts);
      // A login shell would skip --init-file: the init file runs the login files instead.
      const login = shell.args.includes('-l') || shell.args.includes('--login');
      // Git Bash takes C:/… better than C:\… as an argument.
      const file = /^[A-Za-z]:\\/.test(bash) ? bash.replace(/\\/g, '/') : bash;
      return { args: ['--init-file', file, '-i'], env: { ...env, ...(login ? { TRACKER_LOGIN: '1' } : {}) } };
    }
    if (shell.integration === 'zsh') {
      const { zsh } = writeHooks(dir, opts);
      return { args: shell.args, env: { ...env, ZDOTDIR: zsh, ...(env.ZDOTDIR ? { TE_ZDOTDIR: env.ZDOTDIR } : {}) } };
    }
  } catch {
    // the folder cannot be written: the shell as it is
    return base;
  }
  if (shell.integration === 'fish') return { args: [...shell.args, '--init-command', FISH], env };
  if (shell.integration === 'powershell') return { args: [...shell.args, '-NoExit', '-EncodedCommand', Buffer.from(POWERSHELL, 'utf16le').toString('base64')], env };
  if (shell.integration === 'cmd') return { args: shell.args, env: { ...env, PROMPT: cmdPrompt(env.PROMPT) } };
  return base;
}

module.exports = { integrate, writeHooks, BASH, ZSH, FISH, POWERSHELL, cmdPrompt };
