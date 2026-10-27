// Starts the app's own Node.js (nodejs-mobile's libnode) in NodeService's process, with its
// output in the system log (tag TrackerNode). Node runs until that process ends.
#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *TAG = "TrackerNode";
int out_pipe[2];
int err_pipe[2];

void *forward(void *arg) {
  const int fd = *static_cast<int *>(arg);
  const int priority = fd == err_pipe[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
  char buf[2048];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
    if (buf[n - 1] == '\n') --n;
    buf[n] = 0;
    __android_log_write(priority, TAG, buf);
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

extern "C" JNIEXPORT jint JNICALL Java_com_divaor_trackereditor_NodeService_startNode(JNIEnv *env, jclass, jobjectArray args) {
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
  __android_log_write(ANDROID_LOG_INFO, TAG, "Starting Node.js");
  return node::Start(argc, argv.data());
}
