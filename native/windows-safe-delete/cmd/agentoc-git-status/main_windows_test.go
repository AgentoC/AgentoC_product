//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	safedelete "agentoc/windows-safe-delete"
)

func encodeRequest(t *testing.T, r request) []string {
	t.Helper()
	data, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return []string{"--request", base64.RawURLEncoding.EncodeToString(data)}
}

func TestStatusExecutorUsesPinnedGitAndSuppressesFsmonitor(t *testing.T) {
	var git string
	var digest [sha256.Size]byte
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, "git.exe")
		image, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		candidateDigest := sha256.Sum256(image)
		pin, err := safedelete.OpenPinnedExecutablePath(candidate, candidateDigest)
		if err != nil {
			continue
		}
		pin.Close()
		git, digest = candidate, candidateDigest
		break
	}
	if git == "" {
		t.Skip("no independently pinnable Git for Windows on PATH")
	}
	t.Logf("Git fixture executable: %s", git)
	root := t.TempDir()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(old)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	gitRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command(git, args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Git fixture failed: %v: %s", err, out)
		}
	}
	gitRun("init", "-q")
	if err := os.WriteFile(filepath.Join(root, "ordinary.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	gitRun("add", "ordinary.txt")
	hook := filepath.Join(root, "fixture-monitor.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nprintf invoked > fsmonitor-ran\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	gitRun("config", "core.fsmonitor", "./fixture-monitor.sh")
	gitRun("status", "--short")
	marker := filepath.Join(root, "fsmonitor-ran")
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("fixture did not execute fsmonitor")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	// Demonstrate that a workspace git.exe cannot replace the absolute image.
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shadow, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "git.exe"), shadow, 0700); err != nil {
		t.Fatal(err)
	}
	r := request{SchemaVersion: 1, Executable: git, SHA256: hex.EncodeToString(digest[:]), Cwd: root, Args: []string{"status", "--short"}}
	var out, stderr bytes.Buffer
	code, err := run(encodeRequest(t, r), &out, &stderr)
	if err != nil || code != 0 {
		t.Fatalf("status failed: code=%d err=%v stderr=%s", code, err, stderr.String())
	}
	if !strings.Contains(out.String(), "ordinary.txt") {
		t.Fatalf("unexpected status output: %s", out.String())
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("fsmonitor ran during controlled status")
	}
	r.SHA256 = strings.Repeat("0", 64)
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("wrong digest accepted")
	}
	r.SHA256 = hex.EncodeToString(digest[:])
	r.Cwd = filepath.Join(root, "other")
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("wrong cwd accepted")
	}
	r.Cwd = root
	r.Args = []string{"status", "--help"}
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("unsafe option accepted")
	}
	r.Args = []string{"status"}
	t.Setenv("GIT_CONFIG_COUNT", "1")
	if _, err := run(encodeRequest(t, r), &out, &stderr); err == nil {
		t.Fatal("environment override accepted")
	}
}

func TestStatusOptionsAndEnvironmentFailClosed(t *testing.T) {
	for _, args := range [][]string{{"status"}, {"status", "-sb"}, {"status", "--porcelain=v1", "-uno"}} {
		if !validStatusArgs(args) {
			t.Fatalf("valid args rejected: %q", args)
		}
	}
	for _, args := range [][]string{{}, {"status", "--help"}, {"-c", "core.fsmonitor=evil", "status"}, {"status", "--", "."}, {"status", ";"}} {
		if validStatusArgs(args) {
			t.Fatalf("unsafe args accepted: %q", args)
		}
	}
	if _, err := safeEnvironment([]string{"PATH=x", "Git_Config_Parameters=evil"}); err == nil {
		t.Fatal("case-insensitive override accepted")
	}
	if _, err := safeEnvironment([]string{"PATH=x", "GIT_CONFIG_NOSYSTEM=1"}); err != nil {
		t.Fatal(err)
	}
}
