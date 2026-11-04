//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

type ownerInspectionOutput struct{ buffer bytes.Buffer }

func (output *ownerInspectionOutput) Write(p []byte) (int, error) {
	if len(p) > 64*1024-output.buffer.Len() {
		return 0, errors.New("owner inspection output too large")
	}
	return output.buffer.Write(p)
}

// Runs only the fixed metadata inspection program under the verified owner.
func runOwnerInspection(ctx context.Context, token windows.Token, executable string, args, env []string, cwd string) ([]byte, error) {
	if ctx == nil || token == 0 || !filepath.IsAbs(executable) || !filepath.IsAbs(cwd) || env == nil {
		return nil, errOwnerSessionUnavailable
	}
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir, cmd.Env = cwd, env
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(token), HideWindow: true}
	var output ownerInspectionOutput
	cmd.Stdout, cmd.Stderr = &output, io.Discard
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return output.buffer.Bytes(), nil
}

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
