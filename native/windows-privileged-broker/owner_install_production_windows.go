//go:build windows

package main

import (
	"context"

	"golang.org/x/sys/windows"
)

// Only the service-created runner has access to the protected runtime lease.
// The request cannot supply a path, token, environment or executable.
func runInstalledOwnerInstall(ctx context.Context, ownerSID, packageID, version string) ownerInstallResult {
	runner := ownerInstallRunner{
		acquireRuntime: func() (string, func(), error) {
			lease, err := acquireInstalledAutoRuntime()
			return lease.vendor, lease.close, err
		},
		tokens:      windowsOwnerTokenSource(),
		environment: func(token windows.Token) ([]string, error) { return token.Environ(false) },
		paths: func() (string, string, error) {
			root, err := windows.GetWindowsDirectory()
			if err != nil {
				return "", "", err
			}
			systemDir, err := windows.GetSystemDirectory()
			return root, systemDir, err
		},
		run: runOwnerProcess,
	}
	return runner.install(ctx, ownerSID, packageID, version)
}
