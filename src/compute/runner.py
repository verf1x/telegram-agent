"""Trusted Linux launcher. Never evaluate generated code outside bubblewrap."""
import base64
import ctypes
import errno
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import sysconfig
import tempfile
import time

MAX_WIRE = 9 * 1024 * 1024

# This program runs only INSIDE the namespace. Its output is untrusted and the
# Node adapter validates the final payload independently before delivery.
GUEST = r'''
import os,sys,io,json,base64,stat,traceback
sys.path.insert(0,"/opt/packages")
class Limited(io.StringIO):
 def write(self,s):
  if self.tell()+len(s)>65536: raise RuntimeError("Output limit exceeded")
  return super().write(s)
# Fixed pre-created files bound metadata as well as bytes. Opening a missing
# filename cannot create it; direct syscalls receive EPERM from seccomp.
import builtins
_original_open=builtins.open
def existing_open(file,mode="r",buffering=-1,encoding=None,errors=None,newline=None,closefd=True,opener=None):
 if isinstance(file,int): return _original_open(file,mode,buffering,encoding,errors,newline,closefd,opener)
 def existing(path,flags): return os.open(path,flags & ~os.O_CREAT)
 return _original_open(file,mode,buffering,encoding,errors,newline,closefd,existing)
builtins.open=existing_open
io.open=existing_open
out,err=Limited(),Limited()
wire=sys.stdout
sys.stdout,sys.stderr=out,err
ok=True
try:
 code=sys.stdin.buffer.read(65537).decode("utf-8")
 if len(code.encode())>65536: raise RuntimeError("Code limit exceeded")
 exec(compile(code,"<calculation>","exec"),{"__name__":"__main__"})
except BaseException as exc:
 ok=False
 try: err.write(type(exc).__name__+": "+str(exc)[:2000])
 except BaseException: pass
images=[]
try:
 for name in sorted(os.listdir("/work")):
  if not name.lower().endswith(".png") or os.stat("/work/"+name,follow_symlinks=False).st_size==0: continue
  if len(images)>=4: raise RuntimeError("Image count limit exceeded")
  fd=os.open("/work/"+name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>2*1024*1024: raise RuntimeError("Invalid image")
   data=os.read(fd,2*1024*1024+1)
  finally: os.close(fd)
  images.append({"base64":base64.b64encode(data).decode("ascii")})
except BaseException:
 ok=False;images=[]
wire.write(json.dumps({"success":ok,"stdout":out.getvalue(),"stderr":err.getvalue(),"images":images}))
'''

def seccomp_file():
    lib = ctypes.CDLL('libseccomp.so.2')
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    class ArgCmp(ctypes.Structure):
        _fields_=[('arg',ctypes.c_uint),('op',ctypes.c_uint),('datum_a',ctypes.c_uint64),('datum_b',ctypes.c_uint64)]
    lib.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(ArgCmp)]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx: raise RuntimeError('Isolation unavailable')
    try:
        blocked = '''fork vfork clone clone3 socket socketpair connect bind listen accept accept4
        sendto sendmsg sendmmsg recvfrom recvmsg recvmmsg getsockopt setsockopt shutdown
        io_uring_setup io_uring_enter io_uring_register ptrace process_vm_readv process_vm_writev
        mount umount2 pivot_root setns unshare bpf perf_event_open keyctl add_key request_key
        open_by_handle_at name_to_handle_at kexec_load reboot swapon swapoff userfaultfd mkdir mkdirat mknod mknodat link linkat symlink symlinkat memfd_create openat2'''.split()
        for name in blocked:
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and lib.seccomp_rule_add(ctx, 0x50000 | errno.EPERM, number, 0):
                raise RuntimeError('Isolation unavailable')
        # SCMP_CMP_MASKED_EQ: block creation even through libc/ctypes/direct syscalls.
        for name,arg in [('open',1),('openat',2)]:
            number=lib.seccomp_syscall_resolve_name(name.encode())
            if number<0: continue
            for mask,value in [(os.O_CREAT,os.O_CREAT),(os.O_TMPFILE,os.O_TMPFILE)]:
                comparison=ArgCmp(arg,7,mask,value)
                if lib.seccomp_rule_add_array(ctx,0x50000|errno.EPERM,number,1,ctypes.byref(comparison)):
                    raise RuntimeError('Isolation unavailable')
        result = tempfile.TemporaryFile()
        if lib.seccomp_export_bpf(ctx, result.fileno()): raise RuntimeError('Isolation unavailable')
        result.seek(0)
        return result
    finally: lib.seccomp_release(ctx)

def runtime_files():
    interpreter = Path(sys.executable).resolve()
    stdlib = Path(sysconfig.get_path('stdlib')).resolve()
    packages = Path(sysconfig.get_path('purelib')).resolve()
    if packages == stdlib or not (packages/'numpy').is_dir(): raise RuntimeError('Prepared runtime required')
    # Discover the ELF dependency closure of this explicitly prepared Python
    # installation. No whole /usr, /usr/lib, home, repository or /etc mounts.
    dependencies = set()
    objects = [interpreter] + [p for p in (stdlib/'lib-dynload').glob('*.so') if not p.name.startswith('_tkinter')] + list(packages.rglob('*.so'))
    for binary in objects:
        report = subprocess.run(['/usr/bin/ldd',str(binary)],capture_output=True,text=True,env={'PATH':'/usr/bin'},timeout=10)
        if report.returncode: raise RuntimeError('Runtime closure unavailable')
        for line in report.stdout.splitlines():
            for word in line.split():
                if word.startswith('/'):
                    path = Path(word)
                    if path.exists() and path.is_file(): dependencies.add(str(path))
            if 'not found' in line: raise RuntimeError('Runtime closure unavailable')
    return interpreter,stdlib,packages,dependencies

def run():
    # If the bot exits unexpectedly, stop this launcher and its PID namespace.
    parent_pid=int(sys.argv[1])
    libc=ctypes.CDLL(None)
    if libc.prctl(1,signal.SIGTERM,0,0,0)!=0 or os.getppid()!=parent_pid:
        raise RuntimeError('Parent unavailable')
    request = json.loads(sys.stdin.buffer.read(70000))
    code = request.get('code')
    if not isinstance(code,str) or len(code.encode())>65536: raise RuntimeError('Invalid calculation')
    interpreter,stdlib,packages,libraries=runtime_files()
    with seccomp_file() as bpf, open('/dev/null','rb') as empty:
        command=['/usr/sbin/prlimit','--as=1073741824','--cpu=20','--fsize=4194304','--nofile=64','--core=0','--',
            '/usr/sbin/bwrap','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv',
            '--setenv','HOME','/tmp','--setenv','PATH','/nonexistent','--setenv','LANG','C.UTF-8',
            '--setenv','MPLBACKEND','Agg','--setenv','MPLCONFIGDIR','/tmp/mpl',
            '--setenv','OPENBLAS_NUM_THREADS','1','--setenv','OMP_NUM_THREADS','1','--setenv','MKL_NUM_THREADS','1',
            '--proc','/proc','--dev','/dev','--size','33554432','--tmpfs','/tmp','--size','67108864','--tmpfs','/work',
            '--ro-bind',str(interpreter),'/runtime/python','--ro-bind',str(stdlib),str(stdlib),
            '--ro-bind',str(packages),'/opt/packages']
        for library in sorted(libraries):
            if library.startswith(str(stdlib)+'/') or library.startswith(str(packages)+'/'): continue
            command += ['--ro-bind',library,library]
        empty_fds=[]
        for name in ['result.png','image-2.png','image-3.png','image-4.png']+[f'scratch-{n}.txt' for n in range(8)]:
            fd=os.dup(empty.fileno());empty_fds.append(fd)
            command += ['--file',str(fd),'/work/'+name]
        command += ['--dir','/tmp/mpl']
        command += ['--remount-ro','/proc','--remount-ro','/dev','--remount-ro','/','--chdir','/work','--seccomp',str(bpf.fileno()),'--','/runtime/python','-I','-c',GUEST]
        child = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            pass_fds=(bpf.fileno(),*empty_fds),env={'PATH':'/usr/bin'},close_fds=True)
        for fd in empty_fds: os.close(fd)
        def terminate(*_):
            child.kill()
            child.wait()
            raise RuntimeError('Calculation cancelled')
        signal.signal(signal.SIGTERM,terminate)
        try:
            child.stdin.write(code.encode());child.stdin.close()
            selector=selectors.DefaultSelector()
            selector.register(child.stdout,selectors.EVENT_READ,'out');selector.register(child.stderr,selectors.EVENT_READ,'err')
            outputs={'out':bytearray(),'err':bytearray()};deadline=time.monotonic()+30
            while selector.get_map():
                if time.monotonic()>deadline: raise RuntimeError('Calculation deadline exceeded')
                for key,_ in selector.select(timeout=0.1):
                    chunk=os.read(key.fileobj.fileno(),65536)
                    if not chunk: selector.unregister(key.fileobj);continue
                    outputs[key.data].extend(chunk)
                    if len(outputs[key.data])>(MAX_WIRE if key.data=='out' else 65536): raise RuntimeError('Calculation output limit exceeded')
            if child.wait(timeout=1):
                raise RuntimeError('Calculation failed: '+outputs['err'].decode(errors='replace')[:2000])
            # Validate the untrusted protocol before returning it, including PNG
            # decoding in the trusted parent after the worker has stopped.
            result=json.loads(outputs['out'])
            from PIL import Image
            import io
            if not isinstance(result,dict) or len(result.get('images',[]))>4: raise RuntimeError('Invalid result')
            total=0
            for image in result.get('images',[]):
                data=base64.b64decode(image['base64'],validate=True);total+=len(data)
                if len(data)>2*1024*1024 or total>6*1024*1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'): raise RuntimeError('Invalid image')
                with Image.open(io.BytesIO(data)) as png:
                    if png.format!='PNG' or max(png.size)>4096 or png.width*png.height>16000000: raise RuntimeError('Invalid image')
                    png.verify()
            if not isinstance(result.get('stdout'),str) or not isinstance(result.get('stderr'),str) or len(result['stdout'])+len(result['stderr'])>131072: raise RuntimeError('Invalid output')
            print(json.dumps(result))
        finally:
            if child.poll() is None: child.kill();child.wait()

if __name__=='__main__':
    try: run()
    except BaseException:
        # Do not return host paths, library diagnostics, environment or stack.
        print(json.dumps({'success':False,'stdout':'','stderr':'Calculation unavailable or resource limit exceeded','images':[]}))
        sys.exit(1)
