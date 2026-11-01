@echo off
setlocal

rem Legacy diagnostic tunnel. The current Windows runtime uses the public
rem broker URL directly; this is retained only for explicit SSH-path testing.
set "SSH_EXE=C:\Windows\System32\OpenSSH\ssh.exe"

:connect
"%SSH_EXE%" -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=yes -L 127.0.0.1:7710:127.0.0.1:7710 oracle
timeout /t 5 /nobreak >nul
goto connect
