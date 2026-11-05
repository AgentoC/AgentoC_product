//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeMSIInstaller struct {
	calls   atomic.Int32
	release chan struct{}
}

func (f *fakeMSIInstaller) Install(ctx context.Context, _ msiInstallGrant) (requestStatus, string) {
	f.calls.Add(1)
	select {
	case <-f.release:
		return statusSucceeded, "MSI_INSTALL_SUCCEEDED"
	case <-ctx.Done():
		return statusUnknown, "MSI_INSTALL_OUTCOME_UNKNOWN"
	}
}
func TestMSIInstallIPCOnceAndPoll(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.ConfigureAutoInstallSigner("key-1", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	grant := msiInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: state.InstallationID, PolicyGeneration: state.PolicyGeneration, RequestID: "request-msi", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "0123456789abcdefghijklmn", ArtifactPath: `G:\work\fixture.msi`, ArtifactSHA256: strings.Repeat("a", 64), PublisherSHA256: strings.Repeat("b", 64), IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "msi_install.execute", MSIInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))}
	runner := &fakeMSIInstaller{release: make(chan struct{})}
	server := &brokerIPCServer{store: store, msiInstaller: runner}
	bad := request
	bad.Signature = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	if result := server.handleRequest(mustJSON(t, bad), false); result.Code != "MSI_INSTALL_AUTHORIZATION_DENIED" {
		t.Fatalf("bad signature: %+v", result)
	}
	if result := server.handleRequest(mustJSON(t, request), true); result.Code != "HEALTH_PIPE_READ_ONLY" {
		t.Fatalf("health: %+v", result)
	}
	for i := 0; i < 2; i++ {
		if result := server.handleRequest(mustJSON(t, request), false); result.Status != statusExecuting || result.MSIDigest == "" {
			t.Fatalf("claim: %+v", result)
		}
	}
	smuggle := request
	smuggle.Type = "health"
	smuggle.Signature = ""
	if result := server.handleRequest(mustJSON(t, smuggle), false); result.Code != "REQUEST_INVALID" {
		t.Fatalf("smuggled field: %+v", result)
	}
	close(runner.release)
	server.workers.Wait()
	if runner.calls.Load() != 1 {
		t.Fatalf("calls: %d", runner.calls.Load())
	}
	result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID}), false)
	if result.Status != statusSucceeded || result.Code != "MSI_INSTALL_SUCCEEDED" || result.MSIDigest == "" {
		t.Fatalf("status: %+v", result)
	}
}
