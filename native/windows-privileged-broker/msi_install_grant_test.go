package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestMSIInstallGrantBindsArtifactPublisherAndRun(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1700000000000)
	grant := msiInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: "broker-1", PolicyGeneration: 1,
		RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1",
		Nonce: "0123456789abcdefghijklmn", ArtifactPath: `G:\work\fixture.msi`, ArtifactSHA256: strings.Repeat("a", 64),
		PublisherSHA256: strings.Repeat("b", 64), IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	if err := verifyMSIInstallGrant(grant, signature, public, now); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*msiInstallGrant){
		"artifact":   func(g *msiInstallGrant) { g.ArtifactPath = `G:\work\other.msi` },
		"digest":     func(g *msiInstallGrant) { g.ArtifactSHA256 = strings.Repeat("c", 64) },
		"publisher":  func(g *msiInstallGrant) { g.PublisherSHA256 = strings.Repeat("c", 64) },
		"run":        func(g *msiInstallGrant) { g.RunID = "run-2" },
		"generation": func(g *msiInstallGrant) { g.PolicyGeneration++ },
	} {
		changed := grant
		mutate(&changed)
		if verifyMSIInstallGrant(changed, signature, public, now) == nil {
			t.Fatalf("accepted tampered %s", name)
		}
	}
	if verifyMSIInstallGrant(grant, signature, public, now.Add(time.Minute)) == nil {
		t.Fatal("accepted expired grant")
	}
	if verifyMSIInstallGrant(grant, signature, public, now.Add(-time.Millisecond)) == nil {
		t.Fatal("accepted future grant")
	}
	for name, mutate := range map[string]func(*msiInstallGrant){
		"invalid digest":    func(g *msiInstallGrant) { g.ArtifactSHA256 = "unverified" },
		"invalid publisher": func(g *msiInstallGrant) { g.PublisherSHA256 = "unverified" },
		"unsafe path":       func(g *msiInstallGrant) { g.ArtifactPath = `G:\work\..\fixture.msi` },
		"long lifetime":     func(g *msiInstallGrant) { g.ExpiresMS = g.IssuedMS + 60001 },
	} {
		invalid := grant
		mutate(&invalid)
		bytes, err := msiInstallSigningBytes(invalid)
		if err != nil {
			t.Fatal(err)
		}
		validSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, bytes))
		if verifyMSIInstallGrant(invalid, validSignature, public, now) == nil {
			t.Fatalf("accepted signed %s", name)
		}
	}
}

func TestMSIInstallGrantRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{`relative.msi`, `\\server\share\a.msi`, `C:\work\..\a.msi`, `C:\work/../a.msi`,
		`C:\work\a.msi:stream`, `C:\work\a.msi `, `C:\work\%TEMP%\a.msi`, `C:\work\a.exe`, `C:\work\\a.msi`} {
		if validMSIArtifactPath(path) {
			t.Fatalf("accepted unsafe path %q", path)
		}
	}
	for _, path := range []string{`G:\work\fixture.msi`, `D:\项目 空格\文件.MSI`} {
		if !validMSIArtifactPath(path) {
			t.Fatalf("rejected valid path %q", path)
		}
	}
}
