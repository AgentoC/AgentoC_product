#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>

int main(void) {
  struct ucred credentials;
  socklen_t length = sizeof(credentials);

  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
    fprintf(stderr, "SO_PEERCRED failed: %s\n", strerror(errno));
    return 1;
  }
  if (length != sizeof(credentials)) {
    fprintf(stderr, "SO_PEERCRED returned an unexpected size\n");
    return 1;
  }

  printf("{\"pid\":%ld,\"uid\":%ld,\"gid\":%ld}\n",
    (long)credentials.pid,
    (long)credentials.uid,
    (long)credentials.gid);
  return 0;
}
