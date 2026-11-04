package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestOwnerInstallClaimAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
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
	if err := store.ConfigureAutoInstallSigner("key", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	policy := ownerInstallPolicy{InstanceID: "inst_0123456789abcdef0123456789abcdef", OwnerSID: "S-1-5-21-1-2-3-1001"}
	grant := ownerInstallGrant{Version: 1, KeyID: "key", BrokerInstallationID: store.state.InstallationID, PolicyGeneration: store.state.PolicyGeneration,
		InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action",
		Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App", PackageVersion: "1.2.3", Source: "winget", InstallScope: "user", IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	var wg sync.WaitGroup
	var mu sync.Mutex
	claimed, duplicates := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, duplicate, err := store.ClaimOwnerInstall(grant, signature, policy, now)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				t.Errorf("claim: %v", err)
			} else if duplicate {
				duplicates++
			} else {
				claimed++
			}
		}()
	}
	wg.Wait()
	if claimed != 1 || duplicates != 7 {
		t.Fatalf("claims=%d duplicates=%d", claimed, duplicates)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.state.OwnerInstalls[grant.Nonce].Status; got != statusUnknown {
		t.Fatalf("interrupted outcome: %s", got)
	}
	record, duplicate, err := reopened.ClaimOwnerInstall(grant, signature, policy, now)
	if err != nil || !duplicate || record.Status != statusUnknown {
		t.Fatalf("unsafe retry: %+v %v %v", record, duplicate, err)
	}
	if _, err := reopened.FinishOwnerInstall(grant.Nonce, statusSucceeded, "DONE", now); err == nil {
		t.Fatal("finished an interrupted request")
	}
}
