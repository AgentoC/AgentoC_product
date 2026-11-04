//go:build windows

// This non-elevated executor is not an approval authority. The caller must
// independently authorize the Git image, its dependencies and the workspace.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	safedelete "agentoc/windows-safe-delete"
)

type request struct {
	SchemaVersion int          `json:"schemaVersion"`
	Executable    string       `json:"executable"`
	SHA256        string       `json:"sha256"`
	Cwd           string       `json:"cwd"`
	Args          []string     `json:"args"`
	Dependencies  []dependency `json:"dependencies,omitempty"`
}

type dependency struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func decodeDigest(value string) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || value != strings.ToLower(value) {
		return digest, errors.New("invalid executable digest")
	}
	copy(digest[:], decoded)
	return digest, nil
}

var statusOptions = map[string]bool{
	"--short": true, "--branch": true, "--long": true, "--porcelain": true,
	"--porcelain=v1": true, "--porcelain=v2": true, "--show-stash": true,
	"--no-renames": true, "--renames": true, "--ahead-behind": true, "--no-ahead-behind": true,
	"--untracked-files": true, "--untracked-files=no": true, "--untracked-files=normal": true, "--untracked-files=all": true,
	"--ignored": true, "--ignored=no": true, "--ignored=traditional": true, "--ignored=matching": true,
	"-u": true, "-uno": true, "-unormal": true, "-uall": true,
}

func validStatusArgs(args []string) bool {
	if len(args) < 1 || len(args) > 64 || args[0] != "status" {
		return false
	}
	for _, arg := range args[1:] {
		if statusOptions[arg] {
			continue
		}
		if len(arg) < 2 || arg[0] != '-' {
			return false
		}
		for _, c := range arg[1:] {
			if c != 's' && c != 'b' && c != 'z' {
				return false
			}
		}
	}
	return true
}

func safeEnvironment(env []string) ([]string, error) {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			return nil, errors.New("invalid process environment")
		}
		upper := strings.ToUpper(name)
		if strings.HasPrefix(upper, "GIT_") {
			// These two settings do not select code or additional file paths;
			// the executor supplies its own lock setting below.
			if upper == "GIT_CONFIG_NOSYSTEM" {
				out = append(out, entry)
				continue
			}
			if upper == "GIT_OPTIONAL_LOCKS" || upper == "GIT_PAGER" {
				continue
			}
			return nil, errors.New("Git environment overrides require review")
		}
		out = append(out, entry)
	}
	return append(out, "GIT_OPTIONAL_LOCKS=0"), nil
}

func run(args []string, stdout, stderr io.Writer) (int, error) {
	// Keep the encoded argument below Windows' process command-line limit.
	if len(args) != 2 || args[0] != "--request" || len(args[1]) > 30000 {
		return 0, errors.New("invalid request")
	}
	data, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil {
		return 0, errors.New("invalid request encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.SchemaVersion != 1 ||
		!strings.EqualFold(filepath.Base(input.Executable), "git.exe") || !validStatusArgs(input.Args) || len(input.Dependencies) > 256 {
		return 0, errors.New("invalid Git status request")
	}
	if !filepath.IsAbs(input.Cwd) || len(filepath.VolumeName(input.Cwd)) != 2 {
		return 0, errors.New("invalid working directory")
	}
	actual, err := os.Getwd()
	if err != nil || !strings.EqualFold(filepath.Clean(actual), filepath.Clean(input.Cwd)) {
		return 0, errors.New("working directory mismatch")
	}
	digest, err := decodeDigest(input.SHA256)
	if err != nil {
		return 0, err
	}
	env, err := safeEnvironment(os.Environ())
	if err != nil {
		return 0, err
	}
	pin, err := safedelete.OpenPinnedExecutablePath(input.Executable, digest)
	if err != nil {
		return 0, errors.New("Git executable identity unavailable")
	}
	defer pin.Close()
	// Callers must establish a complete dependency set and trust its digests.
	// Pinning only this supplied set is deliberately not authorization.
	seen := map[string]bool{strings.ToLower(filepath.Clean(input.Executable)): true}
	var dependencies []*safedelete.PinnedExecutablePath
	defer func() {
		for i := len(dependencies) - 1; i >= 0; i-- {
			_ = dependencies[i].Close()
		}
	}()
	for _, dep := range input.Dependencies {
		key := strings.ToLower(filepath.Clean(dep.Path))
		if seen[key] {
			return 0, errors.New("duplicate executable dependency")
		}
		seen[key] = true
		depDigest, err := decodeDigest(dep.SHA256)
		if err != nil {
			return 0, err
		}
		depPin, err := safedelete.OpenPinnedDependencyPath(dep.Path, depDigest)
		if err != nil {
			return 0, errors.New("Git dependency identity unavailable")
		}
		dependencies = append(dependencies, depPin)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	commandArgs := append([]string{"--no-pager", "-c", "core.fsmonitor=false", "--no-optional-locks"}, input.Args...)
	cmd := exec.CommandContext(ctx, pin.Path(), commandArgs...)
	cmd.Dir = input.Cwd
	cmd.Env = env
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode(), nil
		}
		return 0, errors.New("Git status execution failed")
	}
	return 0, nil
}

func main() {
	code, err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}
