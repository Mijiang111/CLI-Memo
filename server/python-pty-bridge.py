#!/usr/bin/env python3
import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--cols", type=int, default=96)
    parser.add_argument("--rows", type=int, default=28)
    args = parser.parse_args()

    pid, master_fd = pty.fork()
    if pid == 0:
        os.chdir(args.cwd)
        env = os.environ.copy()
        env["TERM"] = env.get("TERM", "xterm-256color")
        env["COLUMNS"] = str(args.cols)
        env["LINES"] = str(args.rows)
        shell_name = os.path.basename(args.shell)
        shell_args = [args.shell]
        if shell_name in ("zsh", "bash", "sh"):
            shell_args.append("-i")
        os.execvpe(args.shell, shell_args, env)

    set_winsize(master_fd, args.rows, args.cols)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    def forward_signal(signum, _frame):
        try:
            os.kill(pid, signum)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, forward_signal)

    stdin_open = True

    while True:
        try:
            watch = [master_fd]
            if stdin_open:
                watch.append(stdin_fd)
            readable, _, _ = select.select(watch, [], [])
        except OSError:
            break

        if stdin_open and stdin_fd in readable:
            data = os.read(stdin_fd, 4096)
            if not data:
                stdin_open = False
            else:
                os.write(master_fd, data)

        if master_fd in readable:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(stdout_fd, data)

        try:
            child_pid, status = os.waitpid(pid, os.WNOHANG)
            if child_pid == pid:
                if os.WIFEXITED(status):
                    return os.WEXITSTATUS(status)
                if os.WIFSIGNALED(status):
                    return 128 + os.WTERMSIG(status)
                return 0
        except ChildProcessError:
            return 0

    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
