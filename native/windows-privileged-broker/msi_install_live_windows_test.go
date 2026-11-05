//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This opt-in test uses a disposable unsigned, per-user MSI generated for QA.
// The test double replaces only publisher trust; normal signed-package trust is
// exercised separately with a real signed package and remains mandatory in the
// production windowsMSIInstaller.
type localMSIFixtureInstaller struct {
	system string
	temp   string
}

func (i localMSIFixtureInstaller) Install(ctx context.Context, g msiInstallGrant) (requestStatus, string) {
	if ctx.Err() != nil {
		return statusFailed, "MSI_INSTALL_CANCELLED_BEFORE_START"
	}
	pins, err := pinWindowsMSIArtifact(g.ArtifactPath, g.ArtifactSHA256)
	if err != nil {
		return statusFailed, "MSI_INSTALL_VERIFICATION_FAILED"
	}
	defer pins.Close()
	if verifyPinnedMSIEmbeddedMedia(pins) != nil {
		return statusFailed, "MSI_INSTALL_VERIFICATION_FAILED"
	}
	exe := filepath.Join(i.system, "msiexec.exe")
	executablePins, _, err := pinWindowsServiceImage(exe)
	if err != nil {
		return statusFailed, "MSI_INSTALL_VERIFICATION_FAILED"
	}
	defer executablePins.Close()
	if verifyPinnedSystemCatalog(executablePins, exe) != nil {
		return statusFailed, "MSI_INSTALL_VERIFICATION_FAILED"
	}
	code, err := runWindowsMSIProcess(exe, []string{"/i", pins.path, "/qn", "/norestart"}, os.Environ(), i.system)
	if err == nil && code == 0 {
		return statusSucceeded, "MSI_INSTALL_SUCCEEDED"
	}
	return statusFailed, "MSI_INSTALL_FAILED"
}
func TestMSIInstallRealLocalFixture(t *testing.T) {
	path := os.Getenv("AGENTOC_QA_DISPOSABLE_MSI")
	marker := os.Getenv("AGENTOC_QA_DISPOSABLE_MARKER")
	if path == "" || marker == "" {
		t.Skip("disposable local fixture not configured")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("fixture marker already exists")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(data)
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd := exec.Command(filepath.Join(system, "msiexec.exe"), "/x", path, "/qn", "/norestart")
		cmd.Env = os.Environ()
		if output, e := cmd.CombinedOutput(); e != nil {
			t.Errorf("fixture uninstall: %v %s", e, output)
		}
		if _, e := os.Stat(marker); !os.IsNotExist(e) {
			t.Errorf("fixture marker remains after uninstall: %v", e)
		}
	}()
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err = store.ConfigureAutoInstallSigner("key-1", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	grant := msiInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: state.InstallationID, PolicyGeneration: state.PolicyGeneration, RequestID: "qa-request", SessionID: "qa-session", RunID: "qa-run", TurnID: "qa-turn", ActionID: "qa-action", Nonce: "0123456789abcdefghijklmn", ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(digest[:]), PublisherSHA256: hex.EncodeToString(digest[:]), IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	bytes, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "msi_install.execute", MSIInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, bytes))}
	server := &brokerIPCServer{store: store, msiInstaller: localMSIFixtureInstaller{system: system, temp: os.TempDir()}}
	first := server.handleRequest(mustJSON(t, request), false)
	if first.Status != statusExecuting {
		t.Fatalf("claim: %+v", first)
	}
	server.workers.Wait()
	result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID}), false)
	if result.Status != statusSucceeded {
		t.Fatalf("installer result: %+v", result)
	}
	markerData, err := os.ReadFile(marker)
	if err != nil || string(markerData) != "AgentoC disposable installer QA\r\n" {
		t.Fatalf("installed marker: %q %v", markerData, err)
	}
	if replay := server.handleRequest(mustJSON(t, request), false); replay.Status != statusSucceeded {
		t.Fatalf("replay: %+v", replay)
	}
}
func TestMSIInstallGrantJSONMatchesControlPlane(t *testing.T) {
	grant := msiInstallGrant{Version: 1, KeyID: "key", BrokerInstallationID: "broker", PolicyGeneration: 1, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwx", ArtifactPath: `G:\A & B\测试.msi`, ArtifactSHA256: strings.Repeat("a", 64), PublisherSHA256: strings.Repeat("b", 64), IssuedMS: 1000, ExpiresMS: 2000}
	payload, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != "dfeee1d3ff0b93af8de9c44a4b7d861e8ad8212359f0bcf574b279b2d5ca7bcb" {
		t.Fatalf("cross-language grant mismatch: %x", digest)
	}
}
