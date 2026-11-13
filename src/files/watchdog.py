"""PID 1: remove this ephemeral workspace when the bot's proxy disappears."""
import socket
import subprocess
import time

proxy = subprocess.Popen(['socat', 'TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork', 'UNIX-CONNECT:/run/egress.sock'])
try:
    while proxy.poll() is None:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5)
            connection.connect('/run/egress.sock')
        time.sleep(5)
finally:
    proxy.terminate()
