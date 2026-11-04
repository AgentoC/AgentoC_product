//go:build windows

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestOwnerInstallIPCClaimsOnceAndReportsStatus(t *testing.T) {
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
	now := time.Now().UTC().Truncate(time.Millisecond)
	policy := ownerInstallPolicy{Version: 1, InstanceID: "inst_0123456789abcdef0123456789abcdef", OwnerSID: "S-1-5-21-1-2-3-1001", Port: 7690}
	if err := store.ConfigureAutoInstallSigner(policy.InstanceID, base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	grant := ownerInstallGrant{Version: 1, KeyID: policy.InstanceID, BrokerInstallationID: store.state.InstallationID, PolicyGeneration: store.state.PolicyGeneration,
		InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action",
		Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App", PackageVersion: "1.2.3", Source: "winget", InstallScope: "user", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	request := brokerRequest{Version: protocolVersion, Type: "owner_install.execute", OwnerInstall: &grant, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))}
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := &brokerIPCServer{store: store, ownerPolicy: func() (ownerInstallPolicy, error) { return policy, nil },
		ownerInstaller: func(_ context.Context, sid, id, version string) ownerInstallResult {
			calls.Add(1)
			if sid != policy.OwnerSID || id != grant.PackageID || version != grant.PackageVersion {
				t.Error("wrong execution binding")
			}
			return ownerInstallResult{Status: "succeeded", Code: "OWNER_INSTALL_SUCCEEDED"}
		}}
	first := server.handleRequest(payload, false)
	second := server.handleRequest(payload, false)
	if first.Status != statusExecuting || second.Type == "error" {
		t.Fatalf("claim response: %+v %+v", first, second)
	}
	server.workers.Wait()
	statusPayload, _ := json.Marshal(brokerRequest{Version: protocolVersion, Type: "status", RequestID: grant.RequestID})
	status := server.handleRequest(statusPayload, false)
	if calls.Load() != 1 || status.Status != statusSucceeded || status.OwnerInstall == nil || status.OwnerInstall.Nonce != grant.Nonce {
		t.Fatalf("unexpected outcome: %d %+v", calls.Load(), status)
	}
	bad := request
	modified := grant
	modified.PackageID = "Other.App"
	bad.OwnerInstall = &modified
	badPayload, _ := json.Marshal(bad)
	if response := server.handleRequest(badPayload, false); response.Code != "OWNER_INSTALL_AUTHORIZATION_DENIED" {
		t.Fatalf("modified signature accepted: %+v", response)
	}
}
