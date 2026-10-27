// A pseudo-terminal for the app's own Node.js (mobile/node/pty.cjs gives it node-pty's face for
// electron/localShell.cjs): a shell on the phone for the terminal panel. A Node-API addon.
//   fork(file, argv[], env[], cwd, cols, rows) → { pid, fd }   the shell in a new pty
//   resize(fd, cols, rows)                                       the window's size
//   wait(pid) → exit code, or null while it runs                 (never blocks)
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <pty.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#define CHECK(call)                                                   \
  do {                                                                \
    if ((call) != napi_ok) {                                          \
      napi_throw_error(env, NULL, "Wrong arguments for the terminal"); \
      return NULL;                                                    \
    }                                                                 \
  } while (0)

static char *string_of(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return NULL;
  char *out = malloc(length + 1);
  if (!out) return NULL;
  napi_get_value_string_utf8(env, value, out, length + 1, &length);
  return out;
}

// A NULL-terminated list of strings from a JavaScript array (freed with free_list).
static char **list_of(napi_env env, napi_value array) {
  uint32_t n = 0;
  if (napi_get_array_length(env, array, &n) != napi_ok) return NULL;
  char **out = calloc(n + 1, sizeof(char *));
  if (!out) return NULL;
  for (uint32_t i = 0; i < n; i++) {
    napi_value item;
    napi_get_element(env, array, i, &item);
    out[i] = string_of(env, item);
  }
  return out;
}

static void free_list(char **list) {
  if (!list) return;
  for (char **p = list; *p; p++) free(*p);
  free(list);
}

static napi_value Fork(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  if (argc < 6) {
    napi_throw_error(env, NULL, "Wrong arguments for the terminal");
    return NULL;
  }
  char *file = string_of(env, args[0]);
  char **argv = list_of(env, args[1]);
  char **envp = list_of(env, args[2]);
  char *cwd = string_of(env, args[3]);
  int32_t cols = 80, rows = 24;
  napi_get_value_int32(env, args[4], &cols);
  napi_get_value_int32(env, args[5], &rows);
  struct winsize size = {.ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols};
  int master = -1;
  pid_t pid = forkpty(&master, NULL, NULL, &size);
  if (pid == 0) {
    // The child: only what is safe between fork and exec.
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    for (int s = 1; s < 32; s++) signal(s, SIG_DFL);
    if (cwd && cwd[0] && chdir(cwd) != 0) {
      // stays in the folder it started in
    }
    execve(file, argv, envp);
    _exit(127);
  }
  int failure = pid < 0 ? errno : 0;
  free(file);
  free(cwd);
  free_list(argv);
  free_list(envp);
  if (pid < 0) {
    napi_throw_error(env, NULL, strerror(failure));
    return NULL;
  }
  fcntl(master, F_SETFD, FD_CLOEXEC);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  napi_value result, v;
  napi_create_object(env, &result);
  napi_create_int32(env, pid, &v);
  napi_set_named_property(env, result, "pid", v);
  napi_create_int32(env, master, &v);
  napi_set_named_property(env, result, "fd", v);
  return result;
}

static napi_value Resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  int32_t fd = -1, cols = 80, rows = 24;
  napi_get_value_int32(env, args[0], &fd);
  napi_get_value_int32(env, args[1], &cols);
  napi_get_value_int32(env, args[2], &rows);
  struct winsize size = {.ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols};
  ioctl(fd, TIOCSWINSZ, &size);
  return NULL;
}

static napi_value Wait(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  CHECK(napi_get_cb_info(env, info, &argc, args, NULL, NULL));
  int32_t pid = -1;
  napi_get_value_int32(env, args[0], &pid);
  int status = 0;
  pid_t done = waitpid(pid, &status, WNOHANG);
  napi_value result;
  if (done == pid) {
    napi_create_int32(env, WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status), &result);
  } else if (done < 0 && errno == ECHILD) {
    napi_create_int32(env, 0, &result);  // already collected
  } else {
    napi_get_null(env, &result);
  }
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
      {"fork", NULL, Fork, NULL, NULL, NULL, napi_default, NULL},
      {"resize", NULL, Resize, NULL, NULL, NULL, napi_default, NULL},
      {"wait", NULL, Wait, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof *props, props);
  return exports;
}
