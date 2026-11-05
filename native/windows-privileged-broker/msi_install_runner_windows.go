//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

type windowsMSIInstaller struct {
	run   func(string, []string, []string, string) (int, error)
	paths func() (string, string, string, error)
	now   func() time.Time
}

// Once started, do not kill the client on cancellation: the Windows Installer
// service may still be consuming the package. Keep its file pins until the
// client actually exits. A service crash still leaves the durable claim unknown.
func runWindowsMSIProcess(executable string, args, env []string, cwd string) (int, error) {
	cmd := exec.Command(executable, args...)
	cmd.Dir, cmd.Env = cwd, env
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

func (installer windowsMSIInstaller) systemPaths() (string, string, string, error) {
	if installer.paths != nil {
		return installer.paths()
	}
	root, e1 := windows.GetWindowsDirectory()
	system, e2 := windows.GetSystemDirectory()
	temp, e3 := brokerStateDirectory()
	if e1 != nil || e2 != nil || e3 != nil {
		return "", "", "", errRuntimeIntegrity
	}
	return root, system, temp, nil
}

func (installer windowsMSIInstaller) Install(ctx context.Context, grant msiInstallGrant) (requestStatus, string) {
	if ctx == nil || ctx.Err() != nil {
		return statusFailed, "MSI_INSTALL_CANCELLED_BEFORE_START"
	}
	prepared, err := prepareWindowsMSIInstall(grant)
	if err != nil {
		return statusFailed, "MSI_INSTALL_VERIFICATION_FAILED"
	}
	defer prepared.Close()
	root, system, temp, err := installer.systemPaths()
	if err != nil || !filepath.IsAbs(root) || !filepath.IsAbs(system) || !filepath.IsAbs(temp) ||
		!strings.EqualFold(filepath.Clean(system), filepath.Clean(filepath.Dir(prepared.executable))) {
		return statusFailed, "MSI_INSTALL_SYSTEM_UNAVAILABLE"
	}
	now := time.Now
	if installer.now != nil {
		now = installer.now
	}
	if ctx.Err() != nil || grant.ExpiresMS <= now().UnixMilli() {
		return statusFailed, "MSI_INSTALL_CANCELLED_BEFORE_START"
	}
	env := []string{"SystemRoot=" + root, "WINDIR=" + root, "PATH=" + system, "TEMP=" + temp, "TMP=" + temp}
	for _, key := range []string{"ProgramData", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive", "PROCESSOR_ARCHITECTURE"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	run := installer.run
	if run == nil {
		run = runWindowsMSIProcess
	}
	exit, runErr := run(prepared.executable, prepared.arguments, env, system)
	if exit == 0 && runErr == nil {
		return statusSucceeded, "MSI_INSTALL_SUCCEEDED"
	}
	if exit == 3010 {
		return statusSucceeded, "MSI_INSTALL_REBOOT_REQUIRED"
	}
	if exit == 1641 || exit < 0 {
		return statusUnknown, "MSI_INSTALL_OUTCOME_UNKNOWN"
	}
	return statusFailed, "MSI_INSTALL_FAILED"
}
