//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// runOwnerProcess is a private execution primitive. Its caller must validate
// authorization, pin the executable and construct the environment first; it
// never resolves an executable using PATH or inherits the service environment.
// Cancellation after a process was started leaves the operation outcome unknown.
func runOwnerProcess(ctx context.Context, token windows.Token, executable string, args, env []string, cwd string) (int, error) {
	if ctx == nil || token == 0 || !filepath.IsAbs(executable) || !filepath.IsAbs(cwd) || env == nil {
		return -1, errOwnerSessionUnavailable
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(token), HideWindow: true}
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), err
	}
	return -1, err
}
