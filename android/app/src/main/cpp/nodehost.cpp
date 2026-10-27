// Starts the app's own Node.js (nodejs-mobile's libnode) in NodeService's process. Its output
// goes to the system log (tag TrackerNode) and to node.log (AppLog's file, for "Send a log").
// Node runs until that process ends.
#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *TAG = "TrackerNode";
int out_pipe[2];
int err_pipe[2];
FILE *log_file = nullptr;
pthread_mutex_t log_lock = PTHREAD_MUTEX_INITIALIZER;

void to_file(const char *stream, const char *text) {
  if (!log_file) return;
  char stamp[32];
  time_t now = time(nullptr);
  struct tm tm_now;
  localtime_r(&now, &tm_now);
  strftime(stamp, sizeof stamp, "%Y-%m-%d %H:%M:%S", &tm_now);
  pthread_mutex_lock(&log_lock);
  fprintf(log_file, "%s [%s] %s\n", stamp, stream, text);
  fflush(log_file);
  pthread_mutex_unlock(&log_lock);
}

void *forward(void *arg) {
  const int fd = *static_cast<int *>(arg);
  const bool err = fd == err_pipe[0];
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(err ? ANDROID_LOG_WARN : ANDROID_LOG_INFO, TAG, buf);
    to_file(err ? "stderr" : "stdout", buf);
  }
  return nullptr;
}

void redirect_output() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(out_pipe) == 0 && pipe(err_pipe) == 0) {
    dup2(out_pipe[1], STDOUT_FILENO);
    dup2(err_pipe[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, forward, &out_pipe[0]);
    pthread_detach(t1);
    pthread_create(&t2, nullptr, forward, &err_pipe[0]);
    pthread_detach(t2);
  }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL Java_com_divaor_trackereditor_NodeService_startNode(JNIEnv *env, jclass, jobjectArray args, jstring logPath) {
  const char *path = env->GetStringUTFChars(logPath, nullptr);
  if (path && *path) log_file = fopen(path, "a");
  env->ReleaseStringUTFChars(logPath, path);
  redirect_output();
  const jsize argc = env->GetArrayLength(args);
  std::vector<std::string> strings;
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(args, i));
    const char *chars = env->GetStringUTFChars(s, nullptr);
    strings.emplace_back(chars);
    env->ReleaseStringUTFChars(s, chars);
    env->DeleteLocalRef(s);
    total += strings.back().size() + 1;
  }
  // libuv wants the arguments in one block of memory, one after the other.
  char *block = static_cast<char *>(calloc(total, 1));
  std::vector<char *> argv(argc + 1, nullptr);
  char *at = block;
  for (jsize i = 0; i < argc; i++) {
    memcpy(at, strings[i].c_str(), strings[i].size() + 1);
    argv[i] = at;
    at += strings[i].size() + 1;
  }
  // The arguments hold the start configuration (tokens): never written out.
  __android_log_write(ANDROID_LOG_INFO, TAG, "Starting Node.js");
  to_file("host", "Starting Node.js");
  const int code = node::Start(argc, argv.data());
  char ended[64];
  snprintf(ended, sizeof ended, "Node.js returned %d", code);
  to_file("host", ended);
  return code;
}
