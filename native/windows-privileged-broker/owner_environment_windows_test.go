//go:build windows

package main

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerInstallEnvironment(t *testing.T) {
	user := []string{`USERPROFILE=D:\Users\owner`, `LOCALAPPDATA=D:\Users\owner\AppData\Local`, `APPDATA=\\server\owner\Roaming`, `PATH=D:\attacker`, `PSModulePath=D:\attacker`, `ProgramFiles=D:\attacker`, `ProgramData=D:\attacker`, `ComSpec=D:\attacker\cmd.exe`, `TEMP=D:\Users\owner\Temp`}
	folders := ownerSystemFolders{programData: `E:\SharedData`, programFiles: `F:\Apps`, programFilesX86: `F:\Apps32`, programFilesX64: `F:\Apps`}
	env, err := ownerInstallEnvironmentWithFolders(user, `C:\Windows`, `C:\Windows\System32`, `D:\Protected\Vendor`, folders)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	for _, required := range []string{`USERPROFILE=D:\Users\owner`, `APPDATA=\\server\owner\Roaming`, `TMP=D:\Users\owner\Temp`, `PATH=C:\Windows\System32`, `ComSpec=C:\Windows\System32\cmd.exe`, `PATHEXT=.COM;.EXE;.BAT;.CMD`, `ProgramData=E:\SharedData`, `ProgramFiles=F:\Apps`, `ProgramFiles(x86)=F:\Apps32`, `ProgramW6432=F:\Apps`} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %q in environment", required)
		}
	}
	if strings.Contains(joined, `D:\attacker`) {
		t.Fatal("inherited user-controlled executable or system path")
	}
	if _, err := ownerInstallEnvironmentWithFolders(user, `C:\Windows`, `C:\Windows\System32`, `D:\Vendor`, ownerSystemFolders{programFiles: `relative`}); err == nil {
		t.Fatal("accepted invalid machine folder")
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
	env, err := ownerInstallEnvironment(userEnv, root, systemDir, systemDir)
	if err != nil {
		t.Fatalf("current user profile environment rejected: %v", err)
	}
	folders := installedOwnerSystemFolders()
	joined := strings.Join(env, "\n")
	for _, entry := range []struct{ key, value string }{
		{"ProgramData", folders.programData}, {"ProgramFiles", folders.programFiles},
		{"ProgramFiles(x86)", folders.programFilesX86}, {"ProgramW6432", folders.programFilesX64},
	} {
		if entry.value != "" && !strings.Contains(joined, entry.key+"="+entry.value) {
			t.Fatalf("missing Windows-known folder %s", entry.key)
		}
	}
}
