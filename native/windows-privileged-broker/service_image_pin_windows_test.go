//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestServiceImagePinsPreventReplacementAndWrites(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "image-dir")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(dir, "service.exe")
	if err := os.WriteFile(image, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias.exe")
	linked := os.Link(image, alias) == nil
	pins, snapshot, err := pinWindowsServiceImage(image)
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if snapshot.Path != image || snapshot.Digest == "" {
		t.Fatal("image snapshot missing")
	}
	if err := os.WriteFile(image, []byte("changed"), 0600); err == nil {
		t.Fatal("write succeeded while image was pinned")
	}
	if linked {
		if err := os.WriteFile(alias, []byte("changed through hard link"), 0600); err == nil {
			t.Fatal("hard link bypassed image write pin")
		}
		// Removing a different hard-link name may succeed, but must not
		// remove or make the pinned service path writable.
		_ = os.Remove(alias)
		if err := os.WriteFile(image, []byte("changed after unlink"), 0600); err == nil {
			t.Fatal("unlinking a hard link bypassed image write pin")
		}
	}
	if err := os.Rename(image, filepath.Join(dir, "renamed.exe")); err == nil {
		t.Fatal("image replacement succeeded while pinned")
	}
	if err := os.Rename(dir, filepath.Join(root, "renamed-dir")); err == nil {
		t.Fatal("ancestor replacement succeeded while pinned")
	}
	pins.Close()
	if err := os.WriteFile(image, []byte("after"), 0600); err != nil {
		t.Fatalf("released image remains locked: %v", err)
	}
}

func TestServiceTargetImagesRemainPinned(t *testing.T) {
	root := t.TempDir()
	image := filepath.Join(root, "service with spaces.exe")
	if err := os.WriteFile(image, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	pins, err := pinWindowsServiceImages("Fixture", mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, BinaryPathName: `"` + image + `" -service`})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, pin := range pins {
			pin.Close()
		}
	}()
	if len(pins) != 1 {
		t.Fatalf("unexpected pin count: %d", len(pins))
	}
	if err := os.WriteFile(image, []byte("changed"), 0600); err == nil {
		t.Fatal("pinned service image was writable")
	}
}

func TestPowerShellServicePinsScriptAsWellAsHost(t *testing.T) {
	root := t.TempDir()
	host := filepath.Join(root, "powershell.exe")
	script := filepath.Join(root, "service script.ps1")
	if err := os.WriteFile(host, []byte("host fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("script fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	config := mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
		BinaryPathName: `"` + host + `" -NoProfile -NonInteractive -File "` + script + `" -Mode service`}
	images, _, err := snapshotWindowsServiceImages("Fixture", config)
	if err != nil || len(images) != 2 || images[1].Path != script {
		t.Fatalf("script not included: %+v %v", images, err)
	}
	pins, err := pinWindowsServiceImages("Fixture", config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, pin := range pins {
			pin.Close()
		}
	}()
	if err := os.WriteFile(script, []byte("changed"), 0600); err == nil {
		t.Fatal("script was writable while service was pinned")
	}
	if err := os.Rename(script, filepath.Join(root, "other.ps1")); err == nil {
		t.Fatal("script was replaceable while service was pinned")
	}
}

func TestPowerShellServiceRejectsUnpinnableCode(t *testing.T) {
	for _, args := range [][]string{
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-Command", "Get-Content X"},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-EncodedCommand", "QQ=="},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-File", "relative.ps1"},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-File", `C:\data\bad.txt`},
		{`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, "-ExecutionPolicy"},
	} {
		if _, err := serviceCommandFileDependencies(args); err == nil {
			t.Fatalf("accepted unpinnable PowerShell invocation: %v", args)
		}
	}
	if dependencies, err := serviceCommandFileDependencies([]string{`C:\Program Files\Example\service.exe`, "-service"}); err != nil || len(dependencies) != 0 {
		t.Fatalf("ordinary service executable was rejected: %v %v", dependencies, err)
	}
}

func TestManagedServiceEntryFilesAreIncludedAndPinned(t *testing.T) {
	for _, tc := range []struct{ host, entry, options string }{
		{"node.exe", "server.mjs", ""},
		{"python3.12.exe", "worker.py", "-I -u "},
		{"dotnet.exe", "app.dll", "exec "},
		{"java.exe", "app.jar", "-jar "},
		{"cmd.exe", "start.cmd", "/c "},
		{"cscript.exe", "worker.vbs", "//nologo "},
	} {
		t.Run(tc.host, func(t *testing.T) {
			root := t.TempDir()
			host := filepath.Join(root, tc.host)
			entry := filepath.Join(root, tc.entry)
			if err := os.WriteFile(host, []byte("host"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(entry, []byte("entry"), 0600); err != nil {
				t.Fatal(err)
			}
			suffix := " --service"
			if tc.host == "cmd.exe" {
				suffix = ""
			}
			config := mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
				BinaryPathName: `"` + host + `" ` + tc.options + `"` + entry + `"` + suffix}
			images, _, err := snapshotWindowsServiceImages("Fixture", config)
			if err != nil || len(images) != 2 || images[1].Path != entry {
				t.Fatalf("entry not included: %+v %v", images, err)
			}
			if err := os.WriteFile(entry, []byte("changed before approval"), 0600); err != nil {
				t.Fatal(err)
			}
			changed, _, err := snapshotWindowsServiceImages("Fixture", config)
			if err != nil || len(changed) != 2 || changed[1].Digest == images[1].Digest {
				t.Fatalf("changed entry did not change snapshot: %+v %v", changed, err)
			}
			pins, err := pinWindowsServiceImages("Fixture", config)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				for _, pin := range pins {
					pin.Close()
				}
			}()
			if err := os.WriteFile(entry, []byte("changed"), 0600); err == nil {
				t.Fatal("managed service entry was writable")
			}
		})
	}
}

func TestManagedServiceRejectsInlineAndAmbiguousEntry(t *testing.T) {
	for _, args := range [][]string{
		{`C:\tools\node.exe`, "-e", "run()"},
		{`C:\tools\node.exe`, "relative.js"},
		{`C:\tools\python.exe`, "-c", "run()"},
		{`C:\tools\python3.exe`, "-m", "package"},
		{`C:\tools\python.exe`, `C:\tools\entry.txt`},
		{`C:\tools\dotnet.exe`, "exec", "--additionalprobingpath", `C:\evil`, `C:\app\app.dll`},
		{`C:\tools\dotnet.exe`, "run"},
		{`C:\tools\java.exe`, "-cp", `C:\app`, "Main"},
		{`C:\Windows\System32\cmd.exe`, "/c", `C:\scripts\one.cmd & calc.exe`},
		{`C:\Windows\System32\cmd.exe`, "/c", `C:\scripts\one.cmd`, "&", "calc.exe"},
		{`C:\Windows\System32\wscript.exe`, "relative.vbs"},
		{`C:\Windows\System32\rundll32.exe`, `C:\lib\plugin.dll,Run;calc`},
	} {
		if _, err := serviceCommandFileDependencies(args); err == nil {
			t.Fatalf("accepted ambiguous entry: %v", args)
		}
	}
}

func TestRundllServicePinsLibrary(t *testing.T) {
	root := t.TempDir()
	host, library := filepath.Join(root, "rundll32.exe"), filepath.Join(root, "plugin.dll")
	if err := os.WriteFile(host, []byte("host"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(library, []byte("library"), 0600); err != nil {
		t.Fatal(err)
	}
	config := mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, BinaryPathName: `"` + host + `" "` + library + `,Run"`}
	images, _, err := snapshotWindowsServiceImages("Fixture", config)
	if err != nil || len(images) != 2 || images[1].Path != library {
		t.Fatalf("library not included: %+v %v", images, err)
	}
	pins, err := pinWindowsServiceImages("Fixture", config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, pin := range pins {
			pin.Close()
		}
	}()
	if err := os.WriteFile(library, []byte("changed"), 0600); err == nil {
		t.Fatal("service library was writable")
	}
}
