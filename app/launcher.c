// SlateWiper.app's main executable. A real Mach-O binary (not a script) so that
// macOS attributes permission prompts to "SlateWiper" rather than to the first
// non-Apple binary down the chain (which was node). It spawns app-main.sh and
// waits — it must stay alive as the responsible process, so no exec().
// SLATE_REPO (the checkout holding app-main.sh) is baked in at build time by app/build.sh.
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#ifndef SLATE_REPO
#error build with -DSLATE_REPO='"/path/to/slatewiper"' (app/build.sh does this)
#endif
int main(int argc, char **argv) {
  char path[1024];
  snprintf(path, sizeof path, "%s/app-main.sh", SLATE_REPO);
  char **args = calloc(argc + 1, sizeof(char *));
  args[0] = path;
  for (int i = 1; i < argc; i++) args[i] = argv[i];
  pid_t pid;
  int rc = posix_spawn(&pid, path, NULL, NULL, args, environ);
  if (rc != 0) { fprintf(stderr, "spawn %s: %s\n", path, strerror(rc)); return 1; }
  int st = 0;
  waitpid(pid, &st, 0);
  return WIFEXITED(st) ? WEXITSTATUS(st) : 1;
}
