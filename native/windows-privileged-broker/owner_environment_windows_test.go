//go:build windows

package main

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerInstallEnvironment(t *testing.T) {
	user := []string{`USERPROFILE=D:\Users\owner`, `LOCALAPPDATA=D:\Users\owner\AppData\Local`, `APPDATA=\\server\owner\Roaming`, `PATH=D:\attacker`, `PSModulePath=D:\attacker`, `TEMP=D:\Users\owner\Temp`}
	env, err := ownerInstallEnvironment(user, `C:\Windows`, `C:\Windows\System32`, `D:\Protected\Vendor`)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, required := range []string{`USERPROFILE=D:\Users\owner`, `APPDATA=\\server\owner\Roaming`, `TMP=D:\Users\owner\Temp`, `PATH=C:\Windows\System32`} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %q in environment", required)
		}
	}
	if strings.Contains(joined, `D:\attacker`) {
		t.Fatal("inherited executable or module path")
	}
	for _, invalid := range [][]string{
		append(append([]string{}, user...), `userprofile=D:\Other`),
		{`USERPROFILE=relative`, `LOCALAPPDATA=D:\Local`, `APPDATA=D:\Roaming`},
		{`USERPROFILE=D:\Owner`, `LOCALAPPDATA=D:\Local`},
	} {
		if _, err := ownerInstallEnvironment(invalid, `C:\Windows`, `C:\Windows\System32`, `D:\Vendor`); err == nil {
			t.Fatal("accepted invalid profile environment")
		}
	}
}

func TestOwnerInstallEnvironmentFromCurrentToken(t *testing.T) {
	token := windows.GetCurrentProcessToken()
	userEnv, err := token.Environ(false)
	if err != nil {
		t.Fatal(err)
	}
	root, err := windows.GetWindowsDirectory()
	if err != nil {
		t.Fatal(err)
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ownerInstallEnvironment(userEnv, root, systemDir, systemDir); err != nil {
		t.Fatalf("current user profile environment rejected: %v", err)
	}
}
