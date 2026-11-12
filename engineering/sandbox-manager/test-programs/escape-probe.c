/*
 * A program for the sandbox tests (ADR 0020). Run inside a sandbox, it tries, one at a time, the
 * system calls and files that real container escapes have used, and says for each whether the
 * sandbox denied it or let it through:
 *
 *   <name> denied <ERRNO>      the call was refused (a permission, a missing call or a missing file)
 *   <name> reachable <ERRNO>   the call got past the checks. The errno is what it ended with, or
 *                              "OK" if it succeeded. Every call is made with arguments that do
 *                              nothing harmful if it is let through.
 *
 * Every attempt is made in a child process of its own, so that one that succeeds (a new user
 * namespace, say) cannot change what the next one sees. It is built static, so that it runs on any
 * image, and it takes no input.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/swap.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__x86_64__)
#include <sys/io.h>
#endif

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#ifndef AF_ALG
#define AF_ALG 38
#endif
#ifndef PR_CAP_AMBIENT
#define PR_CAP_AMBIENT 47
#define PR_CAP_AMBIENT_RAISE 2
#endif

#define DENIED (-1)
#define REACHABLE 0

struct outcome {
  int code;
  int err;
};

struct vsock_address {
  unsigned short family;
  unsigned short reserved;
  unsigned int port;
  unsigned int cid;
  unsigned char zero[4];
};

static const char *errname(int e) {
  switch (e) {
    case 0: return "OK";
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case ESRCH: return "ESRCH";
    case EBADF: return "EBADF";
    case EACCES: return "EACCES";
    case EFAULT: return "EFAULT";
    case EBUSY: return "EBUSY";
    case EEXIST: return "EEXIST";
    case ENODEV: return "ENODEV";
    case ENOTDIR: return "ENOTDIR";
    case EINVAL: return "EINVAL";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case ENOSYS: return "ENOSYS";
    case ENODATA: return "ENODATA";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    case EAFNOSUPPORT: return "EAFNOSUPPORT";
    case ENXIO: return "ENXIO";
    case ESTALE: return "ESTALE";
    case ECONNREFUSED: return "ECONNREFUSED";
    case ENETUNREACH: return "ENETUNREACH";
    case EINPROGRESS: return "EINPROGRESS";
    default: return "E_OTHER";
  }
}

/*
 * What a failed call means. A refusal because of who is asking, or a call or file that is not
 * there, is a denial. Anything else (bad arguments, a missing path we made up) means the check on
 * who is asking was passed. `absent` is for calls where a missing file is the denial.
 */
static int verdict(long result, int absent) {
  if (result >= 0) return REACHABLE;
  int e = errno;
  int denied = e == EPERM || e == EACCES || e == ENOSYS || e == EAFNOSUPPORT || e == EOPNOTSUPP ||
               e == EROFS || (absent && (e == ENOENT || e == ENODEV || e == ENXIO));
  errno = e;
  return denied ? DENIED : REACHABLE;
}

static int t_unshare_user(void) { return verdict(unshare(CLONE_NEWUSER), 0); }
static int t_unshare_mount(void) { return verdict(unshare(CLONE_NEWNS), 0); }
static int t_unshare_net(void) { return verdict(unshare(CLONE_NEWNET), 0); }
static int t_unshare_pid(void) { return verdict(unshare(CLONE_NEWPID), 0); }
static int t_unshare_ipc(void) { return verdict(unshare(CLONE_NEWIPC), 0); }
static int t_unshare_uts(void) { return verdict(unshare(CLONE_NEWUTS), 0); }

/* What a program can do once it has a user namespace of its own, where it is allowed to make one. */
static int t_userns_mount_tmpfs(void) {
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) return verdict(-1, 0);
  return verdict(mount("none", "/mnt", "tmpfs", 0, NULL), 0);
}

/* Reachable only if the file was written: whatever stopped it, stopped it. */
static int write_after_remount(const char *mountpoint, const char *file) {
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) != 0) return DENIED;
  if (mount(NULL, mountpoint, NULL, MS_REMOUNT | MS_BIND, NULL) != 0) return DENIED;
  int fd = open(file, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return DENIED;
  close(fd);
  unlink(file);
  errno = 0;
  return REACHABLE;
}
static int t_userns_remount_source_writable(void) {
  return write_after_remount("/workspace", "/workspace/escaped-by-remount");
}
static int t_userns_remount_root_writable(void) {
  return write_after_remount("/", "/escaped-by-remount");
}

static int t_mount_tmpfs(void) { return verdict(mount("none", "/mnt", "tmpfs", 0, NULL), 0); }
static int t_mount_bind(void) { return verdict(mount("/scratch", "/mnt", NULL, MS_BIND, NULL), 0); }
static int t_remount_root_writable(void) {
  return verdict(mount(NULL, "/", NULL, MS_REMOUNT, NULL), 0);
}
static int t_umount_proc(void) { return verdict(umount2("/proc", 0), 0); }
static int t_chroot(void) { return verdict(chroot("/"), 0); }
static int t_pivot_root(void) { return verdict(syscall(SYS_pivot_root, "/", "/"), 0); }
static int t_fsopen(void) {
#ifdef SYS_fsopen
  return verdict(syscall(SYS_fsopen, "tmpfs", 0), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_setns_mount(void) {
  int fd = open("/proc/self/ns/mnt", O_RDONLY);
  if (fd < 0) return verdict(-1, 1);
  return verdict(setns(fd, CLONE_NEWNS), 0);
}

/* The call behind the "Shocker" escape: a file handle opened with no regard to the mount. */
static int t_open_by_handle_at(void) {
#ifdef SYS_open_by_handle_at
  struct {
    unsigned int handle_bytes;
    int handle_type;
    unsigned char f_handle[8];
  } handle = {8, 1, {0}};
  int mount_fd = open("/", O_RDONLY);
  return verdict(syscall(SYS_open_by_handle_at, mount_fd, &handle, O_RDONLY), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}

static int t_bpf(void) {
#ifdef SYS_bpf
  unsigned char attr[128] = {0};
  return verdict(syscall(SYS_bpf, 0, attr, sizeof attr), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_perf_event_open(void) {
#ifdef SYS_perf_event_open
  unsigned int attr[32] = {0};
  attr[1] = 112;
  return verdict(syscall(SYS_perf_event_open, attr, 0, -1, -1, 0), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_userfaultfd(void) {
#ifdef SYS_userfaultfd
  return verdict(syscall(SYS_userfaultfd, 0), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_keyctl(void) {
#ifdef SYS_keyctl
  return verdict(syscall(SYS_keyctl, 0, -4, 0), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_io_uring_setup(void) {
#ifdef SYS_io_uring_setup
  unsigned char params[120] = {0};
  return verdict(syscall(SYS_io_uring_setup, 1, params), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_finit_module(void) {
#ifdef SYS_finit_module
  return verdict(syscall(SYS_finit_module, -1, "", 0), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
/* A wrong magic number: refused with EINVAL, after the permission check, if it were let through. */
static int t_reboot(void) { return verdict(syscall(SYS_reboot, 0, 0, 0, NULL), 0); }
static int t_swapon(void) { return verdict(swapon("/nonexistent-swap", 0), 0); }
static int t_clock_settime(void) {
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  return verdict(clock_settime(CLOCK_REALTIME, &now), 0);
}
static int t_sethostname(void) { return verdict(sethostname("probe", 5), 0); }
static int t_read_kernel_log(void) {
  char buffer[16];
  return verdict(syscall(SYS_syslog, 3, buffer, sizeof buffer), 0);
}
static int t_ioperm(void) {
#if defined(__x86_64__)
  return verdict(ioperm(0x80, 1, 1), 0);
#else
  errno = ENOSYS;
  return DENIED;
#endif
}
static int t_acct(void) { return verdict(acct("/scratch/acct"), 0); }

static int t_mknod_character_device(void) {
  return verdict(mknod("/scratch/null", S_IFCHR | 0666, makedev(1, 3)), 0);
}
static int t_mknod_block_device(void) {
  return verdict(mknod("/scratch/disk", S_IFBLK | 0666, makedev(8, 0)), 0);
}
static int t_open_dev_mem(void) { return verdict(open("/dev/mem", O_RDONLY), 1); }
static int t_open_dev_kmsg(void) { return verdict(open("/dev/kmsg", O_RDONLY), 1); }
static int t_open_dev_disk(void) { return verdict(open("/dev/sda", O_RDONLY), 1); }

/* Opening is not enough: a file that is masked opens and has nothing in it. */
static int t_read_proc_kcore(void) {
  int fd = open("/proc/kcore", O_RDONLY);
  if (fd < 0) return verdict(-1, 1);
  char buffer[16];
  ssize_t n = read(fd, buffer, sizeof buffer);
  if (n > 0) {
    errno = 0;
    return REACHABLE;
  }
  errno = ENODATA;
  return DENIED;
}
static int t_open_cgroup_for_writing(void) {
  return verdict(open("/sys/fs/cgroup/cgroup.procs", O_WRONLY), 1);
}
static int t_open_proc_sys_for_writing(void) {
  return verdict(open("/proc/sys/kernel/core_pattern", O_WRONLY), 1);
}
static int t_open_sysrq_for_writing(void) {
  return verdict(open("/proc/sysrq-trigger", O_WRONLY), 1);
}

static int t_setuid_root(void) { return verdict(setuid(0), 0); }
static int t_setgroups(void) { return verdict(setgroups(0, NULL), 0); }
static int t_raise_ambient_capability(void) {
  return verdict(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, 21, 0, 0), 0);
}

static int t_socket_packet(void) { return verdict(socket(AF_PACKET, SOCK_RAW, 0), 0); }
static int t_socket_alg(void) { return verdict(socket(AF_ALG, SOCK_SEQPACKET, 0), 0); }
static int t_socket_netlink_audit(void) { return verdict(socket(AF_NETLINK, SOCK_RAW, 9), 0); }
/* A socket to the host that is not a network: in a virtual machine, it reaches the hypervisor. */
static int t_socket_vsock(void) {
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return verdict(-1, 0);
  struct vsock_address host = {AF_VSOCK, 0, 1, 2, {0}};
  fcntl(fd, F_SETFL, O_NONBLOCK);
  connect(fd, (struct sockaddr *)&host, sizeof host);
  return REACHABLE;
}

struct test {
  const char *name;
  int (*run)(void);
};

static const struct test tests[] = {
    {"unshare_user_namespace", t_unshare_user},
    {"unshare_mount_namespace", t_unshare_mount},
    {"unshare_network_namespace", t_unshare_net},
    {"unshare_pid_namespace", t_unshare_pid},
    {"unshare_ipc_namespace", t_unshare_ipc},
    {"unshare_uts_namespace", t_unshare_uts},
    {"user_namespace_then_mount_tmpfs", t_userns_mount_tmpfs},
    {"user_namespace_then_make_source_writable", t_userns_remount_source_writable},
    {"user_namespace_then_make_root_writable", t_userns_remount_root_writable},
    {"mount_tmpfs", t_mount_tmpfs},
    {"mount_bind", t_mount_bind},
    {"remount_root_writable", t_remount_root_writable},
    {"unmount_proc", t_umount_proc},
    {"chroot", t_chroot},
    {"pivot_root", t_pivot_root},
    {"fsopen", t_fsopen},
    {"setns_mount_namespace", t_setns_mount},
    {"open_by_handle_at", t_open_by_handle_at},
    {"bpf", t_bpf},
    {"perf_event_open", t_perf_event_open},
    {"userfaultfd", t_userfaultfd},
    {"keyctl", t_keyctl},
    {"io_uring_setup", t_io_uring_setup},
    {"finit_module", t_finit_module},
    {"reboot", t_reboot},
    {"swapon", t_swapon},
    {"set_the_clock", t_clock_settime},
    {"set_the_hostname", t_sethostname},
    {"read_kernel_log", t_read_kernel_log},
    {"ioperm", t_ioperm},
    {"process_accounting", t_acct},
    {"mknod_character_device", t_mknod_character_device},
    {"mknod_block_device", t_mknod_block_device},
    {"open_dev_mem", t_open_dev_mem},
    {"open_dev_kmsg", t_open_dev_kmsg},
    {"open_dev_disk", t_open_dev_disk},
    {"read_proc_kcore", t_read_proc_kcore},
    {"write_cgroup_files", t_open_cgroup_for_writing},
    {"write_proc_sys", t_open_proc_sys_for_writing},
    {"write_sysrq_trigger", t_open_sysrq_for_writing},
    {"setuid_root", t_setuid_root},
    {"setgroups", t_setgroups},
    {"raise_ambient_capability", t_raise_ambient_capability},
    {"socket_packet", t_socket_packet},
    {"socket_alg", t_socket_alg},
    {"socket_netlink_audit", t_socket_netlink_audit},
    {"socket_vsock", t_socket_vsock},
};

static void attempt(const struct test *test) {
  int fds[2];
  if (pipe(fds) != 0) {
    printf("%s failed pipe\n", test->name);
    return;
  }
  pid_t child = fork();
  if (child < 0) {
    printf("%s failed fork\n", test->name);
    return;
  }
  if (child == 0) {
    close(fds[0]);
    errno = 0;
    struct outcome outcome;
    outcome.code = test->run();
    outcome.err = errno;
    if (write(fds[1], &outcome, sizeof outcome) != sizeof outcome) _exit(1);
    _exit(0);
  }
  close(fds[1]);
  struct outcome outcome;
  ssize_t n = read(fds[0], &outcome, sizeof outcome);
  close(fds[0]);
  int status = 0;
  waitpid(child, &status, 0);
  if (n != sizeof outcome) {
    printf("%s failed child-ended\n", test->name);
    return;
  }
  printf("%s %s %s\n", test->name, outcome.code == DENIED ? "denied" : "reachable",
         errname(outcome.err));
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  for (size_t i = 0; i < sizeof tests / sizeof tests[0]; i++) attempt(&tests[i]);
  printf("done\n");
  return 0;
}
