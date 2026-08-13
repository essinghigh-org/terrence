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
 *   landlock-runner --rwx=DIR --rx=DIR --ro=DIR --cwd=DIR -- CMD [ARGS...]
 *
 * Exit codes: 0 = exec succeeded (child's exit code is inherited via exec),
 * 1 = usage error, 2 = Landlock unavailable/failed, 126/127 from exec.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <linux/prctl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
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

/* Version reported by --version. Bump on user-visible runner changes. */
#define LANDLOCK_RUNNER_VERSION "1.2.0"

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

static int add_path_rule(int ruleset_fd, uint64_t access, const char *path) {
    int dir_fd = open(path, O_PATH | O_CLOEXEC);
    if (dir_fd < 0) {
        fprintf(stderr, "landlock-runner: cannot open '%s': %s\n",
                path, strerror(errno));
        return -1;
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
        "   or: landlock-runner (--rwx=PATH | --rw=PATH | --rw-files=PATH | --rx=PATH | --ro=PATH)* [--cwd=DIR] -- CMD [ARGS...]\n");
}

int main(int argc, char **argv) {
    if (argc < 2) {
        usage();
        return 1;
    }

    if (strcmp(argv[1], "--probe") == 0) {
        return probe();
    }

    if (strcmp(argv[1], "--version") == 0) {
        printf("landlock-runner %s (Landlock ABI %ld)\n", LANDLOCK_RUNNER_VERSION, landlock_abi());
        return 0;
    }

    const char *cwd = NULL;

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

    struct ll_ruleset_attr rs_attr = {0};
    rs_attr.handled_access_fs = handled_access(abi);
    if (abi >= 6) {
        rs_attr.scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL;
    }
    size_t rs_attr_size = abi >= 6 ? sizeof(rs_attr) : sizeof(rs_attr.handled_access_fs);
    int ruleset_fd = (int) syscall(__NR_landlock_create_ruleset, &rs_attr,
                                   rs_attr_size, 0);
    if (ruleset_fd < 0) {
        fprintf(stderr, "landlock-runner: create_ruleset: %s\n",
                strerror(errno));
        return 2;
    }

    for (int r = 0; r < n_rules; r++) {
        if (add_path_rule(ruleset_fd, abi_mask(rules[r].access, abi), rules[r].path) != 0) {
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

    if (cwd != NULL && chdir(cwd) != 0) {
        fprintf(stderr, "landlock-runner: chdir '%s': %s\n", cwd, strerror(errno));
        return 126;
    }

    execvp(argv[cmd_start], &argv[cmd_start]);
    fprintf(stderr, "landlock-runner: exec '%s': %s\n",
            argv[cmd_start], strerror(errno));
    return (errno == ENOENT) ? 127 : 126;
}
