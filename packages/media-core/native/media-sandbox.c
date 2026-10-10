/* US-127 Linux sandbox. File opens are brokered and injected by seccomp ADDFD:
 * only the immutable staged input, pre-created output and ELF runtime libraries.
 * No open syscall is continued (avoids pathname TOCTOU). The sole initial exec
 * occurs before parsing attacker bytes, in a single-threaded trusted child.
 * Exit 125 means infrastructure/setup failure, never an uploaded-media verdict.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
static pid_t child_pid; static volatile sig_atomic_t stop;
static void terminate(int s){(void)s;stop=1;if(child_pid>0)kill(child_pid,SIGKILL);}
static void fail(void){fputs("Media sandbox unavailable.\n",stderr);if(child_pid>0){kill(child_pid,SIGKILL);while(waitpid(child_pid,NULL,0)<0&&errno==EINTR){}}exit(125);}
static unsigned long num(const char*s,unsigned long max){char*end;errno=0;unsigned long n=strtoul(s,&end,10);if(errno||!*s||*end||n<1||n>max)fail();return n;}
static void limit(int kind,rlim_t n,rlim_t hard){struct rlimit r={n,hard};if(setrlimit(kind,&r))fail();}
#if defined(__x86_64__)
#define ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported architecture
#endif
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
#define NOTIFY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,n,0,1), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_USER_NOTIF)
static int install(void){
 struct sock_filter f[]={BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,ARCH,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#if defined(__x86_64__)
 BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
#endif
 DENY(SYS_socket),DENY(SYS_socketpair),DENY(SYS_connect),DENY(SYS_ptrace),DENY(SYS_process_vm_readv),DENY(SYS_process_vm_writev),DENY(SYS_open_by_handle_at),DENY(SYS_io_uring_setup),DENY(SYS_mount),DENY(SYS_unshare),DENY(SYS_bpf),DENY(SYS_execveat),DENY(SYS_openat2),
 DENY(SYS_unlink),DENY(SYS_unlinkat),DENY(SYS_rename),DENY(SYS_renameat),DENY(SYS_renameat2),
 DENY(SYS_link),DENY(SYS_linkat),DENY(SYS_symlink),DENY(SYS_symlinkat),DENY(SYS_mkdir),DENY(SYS_mkdirat),DENY(SYS_rmdir),
 DENY(SYS_truncate),DENY(SYS_chmod),DENY(SYS_fchmodat),DENY(SYS_chown),DENY(SYS_fchownat),DENY(SYS_mknod),DENY(SYS_mknodat),
 #ifdef SYS_fork
 DENY(SYS_fork),DENY(SYS_vfork),
#endif
 DENY(SYS_memfd_create),DENY(SYS_personality),
 /* glibc must use inspectable clone flags; allow threads, never forked work. */
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_clone3,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|ENOSYS),
 BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,SYS_clone,0,4),
 BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,args[0])),
 BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x10000,1,0), /* CLONE_THREAD */
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW),
 NOTIFY(SYS_openat),NOTIFY(SYS_execve),
#ifdef SYS_open
 NOTIFY(SYS_open),NOTIFY(SYS_creat),
#endif
 BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
 struct sock_fprog p={.len=sizeof(f)/sizeof(f[0]),.filter=f};if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))fail();
 int fd=syscall(SYS_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_NEW_LISTENER,&p);if(fd<0)fail();return fd;
}
static void sendfd(int sock,int fd){char b=0,control[CMSG_SPACE(sizeof(int))]={0};struct iovec i={&b,1};struct msghdr m={.msg_iov=&i,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};struct cmsghdr*c=CMSG_FIRSTHDR(&m);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int));memcpy(CMSG_DATA(c),&fd,sizeof(fd));if(sendmsg(sock,&m,0)<0)fail();}
static int recvfd(int sock){char b,control[CMSG_SPACE(sizeof(int))]={0};struct iovec i={&b,1};struct msghdr m={.msg_iov=&i,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};if(recvmsg(sock,&m,0)<=0)fail();struct cmsghdr*c=CMSG_FIRSTHDR(&m);if(!c||c->cmsg_type!=SCM_RIGHTS)fail();int fd;memcpy(&fd,CMSG_DATA(c),sizeof(fd));return fd;}
static int readpath(pid_t pid,uint64_t address,char*out){char path[64];snprintf(path,sizeof(path),"/proc/%d/mem",pid);int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0)return -1;ssize_t n=pread(fd,out,PATH_MAX,(off_t)address);close(fd);if(n<=0||!memchr(out,0,(size_t)n))return -1;return 0;}
static int fixedfd(int fd,int flags){char p[64];snprintf(p,sizeof(p),"/proc/self/fd/%d",fd);return open(p,(flags&(O_ACCMODE|O_TRUNC|O_APPEND|O_NONBLOCK))|O_CLOEXEC);}
static int library(const char*path){char full[PATH_MAX];if(!realpath(path,full))return -1;if(strncmp(full,"/usr/lib/",9)&&strncmp(full,"/lib/",5)) {errno=EACCES;return -1;}const char*s=strstr(full,".so");if(!s){errno=EACCES;return -1;}for(s+=3;*s;s++)if((*s<'0'||*s>'9')&&*s!='.'){errno=EACCES;return -1;}int fd=open(full,O_RDONLY|O_CLOEXEC);unsigned char magic[4];if(fd>=0&&(pread(fd,magic,4,0)!=4||memcmp(magic,"\177ELF",4))){close(fd);errno=EACCES;return -1;}return fd;}
static int regular(const char*p,int flags){int fd=open(p,flags|O_CLOEXEC|O_NOFOLLOW);struct stat s;if(fd<0||fstat(fd,&s)||!S_ISREG(s.st_mode))fail();return fd;}
static int broker(int listener,int inputfd,int outputfd,const char*input,const char*output,const char*exe){
 int status,executed=0;
 while(!stop){if(waitpid(child_pid,&status,WNOHANG)==child_pid)return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
  struct pollfd p={listener,POLLIN,0};int ready=poll(&p,1,50);if(ready<0&&errno!=EINTR)fail();if(ready<=0)continue;
  struct seccomp_notif q={0};struct seccomp_notif_resp r={0};if(ioctl(listener,SECCOMP_IOCTL_NOTIF_RECV,&q)){if(errno==ENOENT||errno==EINTR)continue;fail();}r.id=q.id;r.error=-EACCES;
  int nr=q.data.nr;char path[PATH_MAX]={0};uint64_t addr=nr==SYS_openat?q.data.args[1]:q.data.args[0];int fd=-1;
  if(!readpath(q.pid,addr,path)&&ioctl(listener,SECCOMP_IOCTL_NOTIF_ID_VALID,&q.id)==0){
   if(nr==SYS_execve){if(!executed&&!strcmp(path,exe)){executed=1;r.error=0;r.flags=SECCOMP_USER_NOTIF_FLAG_CONTINUE;}}
   else{
    int flags=nr==SYS_openat?(int)q.data.args[2]:(int)q.data.args[1];
#ifdef SYS_creat
    if(nr==SYS_creat)flags=O_WRONLY|O_CREAT|O_TRUNC;
#endif
    /* Only exact absolute staged files; libraries are independently checked ELF files. */
    if(path[0]=='/'&&!strcmp(path,input)&&!(flags&(O_WRONLY|O_RDWR|O_CREAT|O_TRUNC)))fd=fixedfd(inputfd,O_RDONLY);
    else if(outputfd>=0&&path[0]=='/'&&!strcmp(path,output)&&!(flags&(O_DIRECTORY|O_PATH)))fd=fixedfd(outputfd,flags);
    else if(!(flags&(O_WRONLY|O_RDWR|O_CREAT|O_TRUNC))){if(!strcmp(path,"/etc/ld.so.cache"))fd=open(path,O_RDONLY|O_CLOEXEC);else fd=library(path);}
    if(fd<0)r.error=-(errno?errno:EACCES);
    else{struct seccomp_notif_addfd add={.id=q.id,.srcfd=(uint32_t)fd,.newfd_flags=O_CLOEXEC};int injected=ioctl(listener,SECCOMP_IOCTL_NOTIF_ADDFD,&add);if(injected>=0){r.val=injected;r.error=0;}else r.error=-errno;close(fd);}
   }
  }
  if(ioctl(listener,SECCOMP_IOCTL_NOTIF_SEND,&r)&&errno!=ENOENT&&errno!=EINTR)fail();
 }
 while(waitpid(child_pid,&status,0)<0&&errno==EINTR){}return 128+SIGTERM;
}
int main(int argc,char**argv){
 if(argc==3&&!strcmp(argv[1],"--check-child")){int a=open(argv[2],O_RDONLY),b=open("/etc/passwd",O_RDONLY),c=socket(AF_INET,SOCK_STREAM,0);if(a>=0)close(a);if(b>=0)close(b);if(c>=0)close(c);return a>=0&&b<0&&c<0?0:125;}
 if(argc==2&&!strcmp(argv[1],"--check")){
  char exe[PATH_MAX],input[]="/tmp/editagent-sandbox-check-XXXXXX";if(!realpath(argv[0],exe))fail();int fd=mkstemp(input);if(fd<0)fail();close(fd);pid_t p=fork();if(p<0)fail();if(!p){execl(exe,exe,"2","134217728","1048576",input,"-",exe,"--",exe,"--check-child",input,(char*)NULL);fail();}int status;while(waitpid(p,&status,0)<0&&errno==EINTR){}unlink(input);return WIFEXITED(status)?WEXITSTATUS(status):125;
 }
 if(argc<9||strcmp(argv[7],"--")||argv[8][0]!='/'||strcmp(argv[6],argv[8])||argv[4][0]!='/')fail();
 unsigned long cpu=num(argv[1],60),mem=num(argv[2],2147483648UL),bytes=num(argv[3],67108864UL);
 int in=regular(argv[4],O_RDONLY),out=strcmp(argv[5],"-")?regular(argv[5],O_RDWR):-1,sv[2];if(socketpair(AF_UNIX,SOCK_DGRAM|SOCK_CLOEXEC,0,sv))fail();
 signal(SIGTERM,terminate);signal(SIGINT,terminate);child_pid=fork();if(child_pid<0)fail();
 if(!child_pid){pid_t parent=getppid();if(prctl(PR_SET_PDEATHSIG,SIGKILL)||getppid()!=parent)fail();close(sv[0]);close(in);if(out>=0)close(out);limit(RLIMIT_CPU,cpu,cpu+1);limit(RLIMIT_AS,mem,mem);limit(RLIMIT_FSIZE,bytes,bytes);limit(RLIMIT_CORE,0,0);limit(RLIMIT_NOFILE,64,64);int fd=install();sendfd(sv[1],fd);close(fd);close(sv[1]);execv(argv[8],argv+8);fail();}
 close(sv[1]);int listener=recvfd(sv[0]);close(sv[0]);int result=broker(listener,in,out,argv[4],argv[5],argv[8]);close(listener);close(in);if(out>=0)close(out);return result;
}
