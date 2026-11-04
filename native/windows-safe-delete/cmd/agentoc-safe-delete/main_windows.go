//go:build windows

// This non-elevated helper is intended to run only after the sidecar validates
// a run-bound request. It never accepts shell source or an arbitrary executable.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	safedelete "agentoc/windows-safe-delete"
)

type request struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Workspace       string `json:"workspace"`
	Relative        string `json:"relative"`
	Target          string `json:"target,omitempty"`
	TargetFromCwd   bool   `json:"targetFromCwd,omitempty"`
	ContentsOnly    bool   `json:"contentsOnly"`
	Force           bool   `json:"force"`
	RequestKey      string `json:"requestKey"`
	OriginalCommand string `json:"originalCommand,omitempty"`
}

var requestKey = regexp.MustCompile(`^gate:[a-f0-9]{64}$`)

func run(args []string) (int, error) {
	if len(args) != 2 || args[0] != "--request" || len(args[1]) > 32768 {
		return 0, errors.New("invalid request envelope")
	}
	bytesIn, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(bytesIn) != args[1] {
		return 0, errors.New("invalid request encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(bytesIn))
	decoder.DisallowUnknownFields()
	var input request
	if err = decoder.Decode(&input); err != nil {
		return 0, errors.New("invalid request data")
	}
	var extra any
	if err = decoder.Decode(&extra); err != io.EOF {
		return 0, errors.New("invalid trailing request data")
	}
	if input.SchemaVersion != 1 || len(input.Workspace) > 32767 || len(input.Relative) > 32767 || len(input.OriginalCommand) > 8192 || !requestKey.MatchString(input.RequestKey) {
		return 0, errors.New("invalid request fields")
	}
	if input.TargetFromCwd {
		if input.Relative != "" || input.Target == "" || len(input.Target) > 8192 {
			return 0, errors.New("invalid working-directory target")
		}
		cwd, cwdErr := os.Getwd()
		if cwdErr != nil {
			return 0, errors.New("working directory unavailable")
		}
		target := input.Target
		if !filepath.IsAbs(target) {
			target = filepath.Join(cwd, target)
		}
		input.Relative, err = filepath.Rel(input.Workspace, target)
		if err != nil {
			return 0, errors.New("target is outside workspace")
		}
	} else if input.Target != "" || input.Relative == "" {
		return 0, errors.New("invalid relative target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	tree, err := safedelete.CaptureTree(ctx, input.Workspace, input.Relative, input.ContentsOnly)
	if err != nil {
		return 0, fmt.Errorf("target validation failed: %w", err)
	}
	return tree.CommitWithOptions(ctx, input.Force)
}

func main() {
	count, err := run(os.Args[1:])
	result := struct {
		OK      bool   `json:"ok"`
		Deleted int    `json:"deleted"`
		Error   string `json:"error,omitempty"`
	}{OK: err == nil, Deleted: count}
	if err != nil {
		result.Error = err.Error()
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
	if err != nil {
		os.Exit(1)
	}
}
