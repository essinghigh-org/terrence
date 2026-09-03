/*
 * landlock-runner: apply Linux Landlock filesystem restrictions to the
 * current process, then exec a target program.
 *
 * Terrence runs Terraform/OpenTofu (and their providers + local-exec
 * provisioner shells) through this helper so untrusted IaC code can only
 * reach an explicit allow-list of paths:
 *
 *   - the run work directory            (read/write/execute)
 *   - the terraform/tofu binary dir     (read/execute)
 *   - provider mirror / plugin dirs     (read)
 *   - system libraries + /bin, /usr/bin (read/execute)
 *   - /etc, /dev/null, /dev/urandom     (read)
 *
 * Everything else — including STORAGE_DIR (database, state archives,
 * encryption key, other workspaces' configs) — is unreachable.
 *
 * Landlock restrictions are inherited across fork/exec, so providers and
 * provisioner children stay confined. No privileges are required: this
 * works for unprivileged users on kernels with Landlock enabled (>= 5.13).
 *
 * Usage:
 *   landlock-runner --probe                       # print ABI version, exit 0 if usable
 *   landlock-runner --probe-loopback              # exit 0 if loopback-deny is supported
 *   landlock-runner --rwx=DIR --rx=DIR --ro=DIR --cwd=DIR [--deny-net] [--deny-loopback] -- CMD [ARGS...]
 *
 * --deny-net needs Landlock ABI >= 4 and blocks ALL TCP bind/connect.
 * Landlock is all-or-nothing, so selective filtering cannot be expressed
 * with it. --deny-loopback adds a second layer for exactly one selective
 * rule: TCP connect(2) to loopback (127/8, ::1, ::ffff:127/8) fails with
 * EACCES. Everything else — public internet, RFC1918, UDP, Unix sockets —
 * is untouched. Enforcement is a seccomp user-space notification
 * supervisor forked before restrict_self (so it stays unconfined and can
 * inspect tracee sockets via pidfd_getfd); the tracee confines itself with
 * Landlock exactly as before, then installs a filter routing connect(2) to
 * the supervisor. Syscall-level interception covers statically linked Go
 * provider binaries that bypass LD_PRELOAD-style hooks.
 *
 * Design limits (documented, not accidental): UDP is unfiltered (notably
 * DNS stubs on loopback keep working); bind() is unfiltered (listening on
 * loopback cannot reach host services); foreign-ABI (32-bit compat)
 * tracees are allowed outright; an unreadable destination fails closed.
 * Requires a kernel with SECCOMP_RET_USER_NOTIF (5.0+) for --deny-loopback;
 * Landlock itself still needs >= 5.13.
 *
 * Exit codes: 0 = exec succeeded (child's exit code is inherited via exec),
 * 1 = usage error, 2 = Landlock unavailable/failed, 126/127 from exec.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/prctl.h>
#include <linux/seccomp.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#ifndef __NR_seccomp
#if defined(__x86_64__)
#define __NR_seccomp 317
#elif defined(__aarch64__)
#define __NR_seccomp 277
#else
#error "deny-loopback supervisor supports x86_64 and aarch64 only"
#endif
#endif

#if defined(__x86_64__)
#define LOOP_SUPERVISOR_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define LOOP_SUPERVISOR_ARCH AUDIT_ARCH_AARCH64
#endif

/* Seccomp op 4 (headers older than 5.9 lack the name; the running kernel
 * only needs to implement it, which probe_loopback verifies). */
#ifndef SECCOMP_GET_NOTIF_FD
#define SECCOMP_GET_NOTIF_FD 4
#endif
#ifndef SECCOMP_FILTER_FLAG_NEW_LISTENER
#define SECCOMP_FILTER_FLAG_NEW_LISTENER (1UL << 3)
#endif

/* Version reported by --version. Bump on user-visible runner changes. */
#define LANDLOCK_RUNNER_VERSION "1.3.0"

#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

/* ---- access rights (subset used here) ---- */
#define LL_EXECUTE   (1ULL << 0)
#define LL_WRITE_FILE (1ULL << 1)
#define LL_READ_FILE (1ULL << 2)
#define LL_READ_DIR  (1ULL << 3)
#define LL_REMOVE_DIR (1ULL << 4)
#define LL_REMOVE_FILE (1ULL << 5)
#define LL_MAKE_CHAR (1ULL << 6)
#define LL_MAKE_DIR  (1ULL << 7)
#define LL_MAKE_REG  (1ULL << 8)
#define LL_MAKE_SOCK (1ULL << 9)
#define LL_MAKE_FIFO (1ULL << 10)
#define LL_MAKE_BLOCK (1ULL << 11)
#define LL_MAKE_SYM  (1ULL << 12)
#define LL_REFER     (1ULL << 13) /* ABI >= 2 */
#define LL_TRUNCATE  (1ULL << 14) /* ABI >= 3 */
#define LL_IOCTL_DEV (1ULL << 15) /* ABI >= 5 */
#define LL_RESOLVE_UNIX (1ULL << 16) /* ABI >= 9 */

#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) /* ABI >= 6 */
#define LL_SCOPE_SIGNAL (1ULL << 1) /* ABI >= 6 */

#define LL_READ (LL_READ_FILE | LL_READ_DIR)
#define LL_RW   (LL_READ | LL_WRITE_FILE | LL_REMOVE_DIR | LL_REMOVE_FILE | \
                 LL_MAKE_CHAR | LL_MAKE_DIR | LL_MAKE_REG | LL_MAKE_SOCK | \
                 LL_MAKE_FIFO | LL_MAKE_BLOCK | LL_MAKE_SYM | LL_RESOLVE_UNIX)
#define LL_EXEC  (LL_EXECUTE | LL_READ)

/* Keep building against older libc kernel headers while using newer Landlock
 * fields when the running kernel supports them. */
struct ll_ruleset_attr {
    uint64_t handled_access_fs;
    uint64_t handled_access_net;
    uint64_t scoped;
};

static long landlock_abi(void);

/* Rights the ruleset handles. Masked by ABI at runtime. */
static uint64_t handled_access(long abi) {
    uint64_t mask = LL_RW | LL_EXEC;
    if (abi >= 2) mask |= LL_REFER;
    if (abi >= 3) mask |= LL_TRUNCATE;
    if (abi >= 5) mask |= LL_IOCTL_DEV;
    if (abi < 9) mask &= ~LL_RESOLVE_UNIX;
    return mask;
}

/* Cap a requested access mask to what this ABI supports. */
static uint64_t abi_mask(uint64_t access, long abi) {
    /* Unknown bits are rejected by the kernel. */
    if (abi < 9) access &= ~LL_RESOLVE_UNIX;
    if (abi < 5) access &= ~LL_IOCTL_DEV;
    if (abi < 3) access &= ~LL_TRUNCATE;
    if (abi < 2) access &= ~LL_REFER;
    return access;
}

static long landlock_abi(void) {
    return syscall(__NR_landlock_create_ruleset, NULL, 0,
                   LANDLOCK_CREATE_RULESET_VERSION);
}

static int add_path_rule(int ruleset_fd, long abi, uint64_t access, const char *path) {
    int dir_fd = open(path, O_PATH | O_CLOEXEC);
    if (dir_fd < 0) {
        fprintf(stderr, "landlock-runner: cannot open '%s': %s\\n",
                path, strerror(errno));
        return -1;
    }

    struct stat st;
    if (fstat(dir_fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
        /* Non-directory target (regular file, chardev like /dev/null):
         * the kernel rejects directory-scoped rights here with EINVAL.
         * Intersect with exactly the rights valid on a file target.
         * RESOLVE_UNIX (ABI >= 9) is file-compatible: it gates pathname
         * UNIX socket resolution, so keep it for socket files. */
        access &= abi_mask(LL_EXECUTE | LL_WRITE_FILE | LL_READ_FILE
                           | ((abi >= 3) ? LL_TRUNCATE : 0)
                           | ((abi >= 5) ? LL_IOCTL_DEV : 0)
                           | ((abi >= 9) ? LL_RESOLVE_UNIX : 0),
                           abi);
        if (access == 0) {
            /* Nothing grantable on this target; skip rather than fail. */
            close(dir_fd);
            return 0;
        }
    }

    struct landlock_path_beneath_attr rule = {0};
    rule.allowed_access = access;
    rule.parent_fd = dir_fd;

    long ret = syscall(__NR_landlock_add_rule, ruleset_fd,
                       LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
    if (ret != 0) {
        fprintf(stderr, "landlock-runner: add_rule '%s': %s\n",
                path, strerror(errno));
        close(dir_fd);
        return -1;
    }
    close(dir_fd);
    return 0;
}

/* ---- loopback-deny supervisor (seccomp user-space notifications) ----
 *
 * See the file header for the rationale. The tracee (child) installs a
 * filter routing connect(2) to the supervisor; the supervisor allows
 * everything except TCP connects to loopback, which fail with EACCES.
 * Only the connect path is intercepted, so steady-state overhead is one
 * notification round-trip per TCP connection setup — negligible next to
 * network RTT, and zero for steady-state I/O.
 *
 * Trust boundary: the supervisor is forked BEFORE restrict_self and never
 * execs the target, so it keeps /proc access for socket-type checks. It
 * runs only this trusted code (same trust as the worker that spawned it).
 * The tracee confines itself with Landlock exactly as in the
 * non-supervised path, then adds the seccomp filter before exec, so
 * providers and provisioner children inherit both layers.
 *
 * Cancellation: supervisor and tracees share the runner's process group
 * (no setsid/setpgid anywhere), so the worker's group kill reaches all of
 * them; the supervisor additionally forwards SIGTERM/SIGINT/SIGHUP to the
 * direct child. Exit status (including fatal signals) is propagated.
 */

static int read_remote(pid_t pid, void *dst, const void *src, size_t len) {
    struct iovec li = { .iov_base = dst, .iov_len = len };
    struct iovec ri = { .iov_base = (void *)src, .iov_len = len };
    ssize_t n = process_vm_readv(pid, &li, 1, &ri, 1, 0);
    return n == (ssize_t)len ? 0 : -1;
}

/* Socket type of fd in the tracee. Returns the SO_TYPE, -1 when
 * undeterminable, or -2 when the fd is not a socket at all (so the caller
 * can let the kernel report ENOTSOCK instead of masking it).
 *
 * Method: readlink confirms "socket:[...]", then pidfd_getfd steals a real
 * fd into the supervisor for getsockopt. Two dead ends this avoids:
 * getsockopt on an O_PATH fd always fails, and open() on a socket
 * /proc/pid/fd link fails with ENOTDIR. pidfd syscalls go through
 * syscall(2) directly for old-toolchain builds. */
#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif
static int tracee_socket_type(pid_t pid, int fd) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/fd/%d", (int)pid, fd);
    char link[128];
    ssize_t n = readlink(path, link, sizeof link - 1);
    if (n <= 0) return -1;
    link[n] = '\0';
    if (strncmp(link, "socket:[", 8) != 0) return -2; /* not a socket */
    int pidfd = (int)syscall(__NR_pidfd_open, pid, 0);
    if (pidfd < 0) return -1;
    int s = (int)syscall(__NR_pidfd_getfd, pidfd, fd, 0);
    close(pidfd);
    if (s < 0) return -1;
    int type = -1;
    socklen_t len = sizeof type;
    if (getsockopt(s, SOL_SOCKET, SO_TYPE, &type, &len) != 0) type = -1;
    close(s);
    return type;
}

static int v6_is_loopback(const unsigned char b[16]) {
    static const unsigned char one[16] =
        { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1 };
    static const unsigned char mapped[12] =
        { 0,0,0,0,0,0,0,0,0,0,0xff,0xff };
    if (memcmp(b, one, 16) == 0) return 1;
    return memcmp(b, mapped, 12) == 0 && b[12] == 127;
}

/* 0 = allow, otherwise the errno to fail connect(2) with. Fail closed on
 * anything unexpected: an unreadable or unclassifiable destination is
 * denied rather than waved through. */
static int decide_connect(pid_t pid, unsigned long long fd,
                          unsigned long long addr, unsigned long long addrlen) {
    unsigned short family = 0;
    if (addr == 0) return EACCES;
    if (read_remote(pid, &family, (const void *)(uintptr_t)addr, sizeof family) != 0)
        return EACCES;
    int is_loopback = 0;
    if (family == AF_INET) {
        struct sockaddr_in a;
        if (addrlen < sizeof a) return EACCES;
        if (read_remote(pid, &a, (const void *)(uintptr_t)addr, sizeof a) != 0)
            return EACCES;
        is_loopback = ((const unsigned char *)&a.sin_addr.s_addr)[0] == 127;
    } else if (family == AF_INET6) {
        struct sockaddr_in6 a6;
        if (addrlen < sizeof a6) return EACCES;
        if (read_remote(pid, &a6, (const void *)(uintptr_t)addr, sizeof a6) != 0)
            return EACCES;
        is_loopback = v6_is_loopback(a6.sin6_addr.s6_addr);
    } else {
        return 0; /* Unix, netlink, ... : out of scope */
    }
    if (!is_loopback) return 0;
    /* Loopback destination: only TCP is in scope (UDP keeps working so DNS
     * stubs on loopback keep resolving). Confirmed non-sockets are waved
     * through so the kernel reports the natural error; anything else
     * unclassifiable fails closed. */
    int type = tracee_socket_type(pid, (int)fd);
    if (type == SOCK_STREAM) return EACCES;
    if (type == -2) return 0; /* not a socket: kernel fails it naturally */
    if (type < 0) return EACCES;
    return 0;
}

/* Install the connect-trap filter in the tracee; returns the notification
 * fd to hand to the supervisor, or -1. NEW_LISTENER makes the install
 * itself yield the fd. TSYNC is deliberately absent: the tracee is
 * single-threaded here, post-exec threads inherit the filter, and
 * TSYNC+NEW_LISTENER is rejected with EINVAL. */
static int install_connect_trap(void) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, LOOP_SUPERVISOR_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 (unsigned int)offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_connect, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog prog = {
        .len = (unsigned short)(sizeof filter / sizeof filter[0]),
        .filter = filter,
    };
    /* With NEW_LISTENER the install call itself returns the notification
     * fd on success (negative errno on failure). */
    long listener = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                            SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
    if (listener < 0)
        return -1;
    return (int)listener;
}

static int probe_loopback(void) {
    unsigned int action = SECCOMP_RET_USER_NOTIF;
    if (syscall(__NR_seccomp, SECCOMP_GET_ACTION_AVAIL, 0, &action) != 0) {
        fprintf(stderr, "landlock-runner: seccomp user-notify unavailable: %s\n",
                strerror(errno));
        return 2;
    }
    /* Action availability alone does not prove the listener mechanism
     * works (e.g. TSYNC+NEW_LISTENER installs fail with EINVAL), so
     * install a no-op filter exactly the way the tracee does. The probe
     * exits immediately, so the harmless allow-all filter dies with it. */
    struct sock_filter filter[] = {
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog prog = {
        .len = (unsigned short)(sizeof filter / sizeof filter[0]),
        .filter = filter,
    };
    prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    long listener = syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER,
                            SECCOMP_FILTER_FLAG_NEW_LISTENER, &prog);
    if (listener < 0) {
        fprintf(stderr, "landlock-runner: seccomp listener unsupported: %s\n",
                strerror(errno));
        return 2;
    }
    close((int)listener);
    printf("ok\n");
    return 0;
}

static int send_fd(int sock, int fd) {
    struct msghdr m;
    memset(&m, 0, sizeof m);
    struct iovec i = { .iov_base = (void *)"", .iov_len = 1 };
    m.msg_iov = &i;
    m.msg_iovlen = 1;
    char c[CMSG_SPACE(sizeof(int))];
    memset(c, 0, sizeof c);
    m.msg_control = c;
    m.msg_controllen = sizeof c;
    struct cmsghdr *h = CMSG_FIRSTHDR(&m);
    h->cmsg_level = SOL_SOCKET;
    h->cmsg_type = SCM_RIGHTS;
    h->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(h), &fd, sizeof fd);
    return sendmsg(sock, &m, 0) == 1 ? 0 : -1;
}

static int recv_fd(int sock) {
    struct msghdr m;
    memset(&m, 0, sizeof m);
    char byte = 0;
    struct iovec i = { .iov_base = &byte, .iov_len = 1 };
    m.msg_iov = &i;
    m.msg_iovlen = 1;
    char c[CMSG_SPACE(sizeof(int))];
    memset(c, 0, sizeof c);
    m.msg_control = c;
    m.msg_controllen = sizeof c;
    if (recvmsg(sock, &m, 0) != 1) return -1;
    struct cmsghdr *h = CMSG_FIRSTHDR(&m);
    if (h == NULL || h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS)
        return -1;
    int fd = -1;
    memcpy(&fd, CMSG_DATA(h), sizeof fd);
    return fd;
}

static volatile sig_atomic_t fwd_sig = 0;
static pid_t fwd_child = -1;

static void fwd_handler(int sig) {
    fwd_sig = sig;
    if (fwd_child > 0) kill(fwd_child, sig);
}

static int supervise(pid_t child, int listener) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = fwd_handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    fwd_child = child;

    int status = 0;
    int reaped = 0;
    int idle_grace = 0;
    for (;;) {
        struct pollfd p = { .fd = listener, .events = POLLIN };
        int pr = poll(&p, 1, 200);
        if (pr < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (pr > 0) {
            struct seccomp_notif req;
            memset(&req, 0, sizeof req);
            if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, &req) != 0) {
                if (errno == EINTR) continue;
                /* ENOENT: no tasks still hold the filter (every tracee
                 * exited). Not an error: fall through and reap below. */
                break;
            }
            struct seccomp_notif_resp resp;
            memset(&resp, 0, sizeof resp);
            resp.id = req.id;
            int deny = EACCES;
            if (req.data.nr == SYS_connect) {
                deny = decide_connect(req.pid, req.data.args[0],
                                      req.data.args[1], req.data.args[2]);
            } else {
                deny = 0; /* defensive: the filter only traps connect */
            }
            if (deny != 0) {
                /* NOTE: resp.error takes a NEGATED errno. A positive value is
              * applied to the tracee's return register as-is, which reads
              * as success (verified live: +EACCES surfaced as rc=13).
              * Always send -deny so the tracee sees -1/EACCES. */
             resp.error = -deny;
                resp.val = 0;
                resp.flags = 0;
            } else {
                resp.error = 0;
                resp.val = 0;
                resp.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
            }
            int sr = ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, &resp);
            if (sr != 0 && errno != ENOENT) {
                break;
            }
            idle_grace = 0;
            continue;
        }
        pid_t w = waitpid(child, &status, WNOHANG);
        if (w == child) {
            reaped = 1;
            if (++idle_grace >= 5) break; /* ~1s drain for stragglers */
        } else if (w < 0 && errno == ECHILD) {
            break;
        }
    }
    close(listener);
    if (!reaped) {
        /* The common path out (POLLHUP then RECV ENOENT) fires before the
         * WNOHANG reap above ever runs. The child is usually already a
         * zombie here; reap it synchronously. */
        pid_t w;
        while ((w = waitpid(child, &status, 0)) < 0 && errno == EINTR) {
        }
        if (w == child) reaped = 1;
    }
    if (!reaped) {
        /* Lost the child without reaping it; do not pretend success. */
        return 2;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) {
        signal(WTERMSIG(status), SIG_DFL);
        raise(WTERMSIG(status));
    }
    return 2;
}

static int probe(void) {
    long abi = landlock_abi();
    if (abi < 1) {
        fprintf(stderr, "landlock-runner: Landlock not supported (ABI %ld)\n", abi);
        return 2;
    }
    printf("%ld\n", abi);
    return 0;
}

static void usage(void) {
    fprintf(stderr,
        "usage: landlock-runner --probe\n"
        "   or: landlock-runner --probe-loopback\n"
        "   or: landlock-runner (--rwx=PATH | --rw=PATH | --rw-files=PATH | --rx=PATH | --ro=PATH)* [--deny-net] [--deny-loopback] [--cwd=DIR] -- CMD [ARGS...]\n");
}

int main(int argc, char **argv) {
    if (argc < 2) {
        usage();
        return 1;
    }

    if (strcmp(argv[1], "--probe") == 0) {
        return probe();
    }

    if (strcmp(argv[1], "--probe-loopback") == 0) {
        return probe_loopback();
    }

    if (strcmp(argv[1], "--version") == 0) {
        printf("landlock-runner %s (Landlock ABI %ld)\n", LANDLOCK_RUNNER_VERSION, landlock_abi());
        return 0;
    }

    const char *cwd = NULL;
    int deny_net = 0;
    int deny_loopback = 0;

    /* First pass: collect rules (no restrictions applied yet). */
    struct { const char *path; uint64_t access; } rules[64];
    int n_rules = 0;

    int i = 1;
    int saw_dashdash = 0;
    int cmd_start = -1;

    for (; i < argc; i++) {
        const char *arg = argv[i];
        if (strcmp(arg, "--") == 0) {
            saw_dashdash = 1;
            cmd_start = i + 1;
            break;
        }
        if (strcmp(arg, "--deny-net") == 0) {
            deny_net = 1;
            continue;
        }
        if (strcmp(arg, "--deny-loopback") == 0) {
            deny_loopback = 1;
            continue;
        }
        if (strncmp(arg, "--cwd=", 6) == 0) {
            cwd = arg + 6;
            continue;
        }
        const char *path = NULL;
        uint64_t access = 0;
        if (strncmp(arg, "--rwx=", 6) == 0) { path = arg + 6; access = LL_RW | LL_EXEC | LL_TRUNCATE; }
        else if (strncmp(arg, "--rw=", 5) == 0) { path = arg + 5; access = LL_RW; }
        else if (strncmp(arg, "--rw-files=", 11) == 0) { path = arg + 11; access = LL_READ | LL_WRITE_FILE; }
        else if (strncmp(arg, "--rx=", 5) == 0) { path = arg + 5; access = LL_EXEC; }
        else if (strncmp(arg, "--ro=", 5) == 0) { path = arg + 5; access = LL_READ; }
        else {
            fprintf(stderr, "landlock-runner: unknown option: %s\n", arg);
            usage();
            return 1;
        }
        if (n_rules >= 64) {
            fprintf(stderr, "landlock-runner: too many rules\n");
            return 1;
        }
        rules[n_rules].path = path;
        rules[n_rules].access = access;
        n_rules++;
    }

    if (!saw_dashdash || cmd_start >= argc) {
        usage();
        return 1;
    }

    /* --deny-loopback splits here, BEFORE any restriction: the parent
     * becomes the (unconfined, trusted) supervisor so it keeps /proc
     * access for socket-type checks; the child falls through, confines
     * itself with Landlock exactly as below, then installs the
     * connect-trap and hands the notification fd to the supervisor. */
    int tracee_sock = -1;
    if (deny_loopback) {
        int sv[2];
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) {
            fprintf(stderr, "landlock-runner: socketpair: %s\n", strerror(errno));
            return 2;
        }
        pid_t c = fork();
        if (c < 0) {
            fprintf(stderr, "landlock-runner: fork: %s\n", strerror(errno));
            return 2;
        }
        if (c > 0) {
            close(sv[1]);
            int listener = recv_fd(sv[0]);
            close(sv[0]);
            if (listener < 0) {
                fprintf(stderr, "landlock-runner: supervisor handshake failed\n");
                kill(c, SIGKILL);
                int st = 0;
                while (waitpid(c, &st, 0) < 0 && errno == EINTR) {}
                return 2;
            }
            return supervise(c, listener);
        }
        close(sv[0]);
        tracee_sock = sv[1];
    }

    /* Query ABI; refuse to run without Landlock support. */
    long abi = landlock_abi();
    if (abi < 1) {
        fprintf(stderr, "landlock-runner: Landlock not supported (ABI %ld)\n", abi);
        return 2;
    }

    /* prctl(PR_SET_NO_NEW_PRIVS) is required before restrict_self. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        fprintf(stderr, "landlock-runner: prctl(PR_SET_NO_NEW_PRIVS): %s\n",
                strerror(errno));
        return 2;
    }

    if (deny_net && abi < 4) {
        fprintf(stderr, "landlock-runner: --deny-net requires Landlock ABI >= 4 (got %ld)\n", abi);
        return 2;
    }
    struct ll_ruleset_attr rs_attr = {0};
    rs_attr.handled_access_fs = handled_access(abi);
    if (deny_net && abi >= 4) {
        rs_attr.handled_access_net = (1ULL << 0) | (1ULL << 1); /* BIND_TCP | CONNECT_TCP */
    }
    if (abi >= 6) {
        rs_attr.scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL;
    }
    size_t rs_attr_size;
    if (abi >= 6) rs_attr_size = sizeof(rs_attr);
    else if (abi >= 4) rs_attr_size = sizeof(rs_attr.handled_access_fs) + sizeof(rs_attr.handled_access_net);
    else rs_attr_size = sizeof(rs_attr.handled_access_fs);
    int ruleset_fd = (int) syscall(__NR_landlock_create_ruleset, &rs_attr,
                                   rs_attr_size, 0);
    if (ruleset_fd < 0) {
        fprintf(stderr, "landlock-runner: create_ruleset: %s\n",
                strerror(errno));
        return 2;
    }

    for (int r = 0; r < n_rules; r++) {
        if (add_path_rule(ruleset_fd, abi, abi_mask(rules[r].access, abi), rules[r].path) != 0) {
            close(ruleset_fd);
            return 2;
        }
    }

    if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
        fprintf(stderr, "landlock-runner: restrict_self: %s\n", strerror(errno));
        close(ruleset_fd);
        return 2;
    }
    close(ruleset_fd);

    if (deny_loopback) {
        int listener = install_connect_trap();
        if (listener < 0 || send_fd(tracee_sock, listener) != 0) {
            fprintf(stderr, "landlock-runner: connect-trap setup failed: %s\n",
                    strerror(errno));
            if (listener >= 0) close(listener);
            close(tracee_sock);
            _exit(2);
        }
        close(listener);
        close(tracee_sock);
    }

    if (cwd != NULL && chdir(cwd) != 0) {
        fprintf(stderr, "landlock-runner: chdir '%s': %s\n", cwd, strerror(errno));
        return 126;
    }

    execvp(argv[cmd_start], &argv[cmd_start]);
    fprintf(stderr, "landlock-runner: exec '%s': %s\n",
            argv[cmd_start], strerror(errno));
    return (errno == ENOENT) ? 127 : 126;
}
