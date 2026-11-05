package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMSIInstallClaimIsDurableAndSingleUse(t *testing.T) {
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
	if err := store.ConfigureAutoInstallSigner("key-1", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	grant := msiInstallGrant{Version: 1, KeyID: "key-1", BrokerInstallationID: state.InstallationID, PolicyGeneration: state.PolicyGeneration,
		RequestID: "request-1", SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1",
		Nonce: "0123456789abcdefghijklmn", ArtifactPath: `G:\work\fixture.msi`, ArtifactSHA256: strings.Repeat("a", 64), PublisherSHA256: strings.Repeat("b", 64),
		IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := msiInstallSigningBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims, duplicates := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, duplicate, err := store.ClaimMSIInstall(grant, signature, now)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				t.Errorf("claim: %v", err)
			} else if duplicate {
				duplicates++
			} else {
				claims++
			}
		}()
	}
	wg.Wait()
	if claims != 1 || duplicates != 7 {
		t.Fatalf("claims=%d duplicates=%d", claims, duplicates)
	}
	winget := autoInstallGrant{Version: 1, KeyID: grant.KeyID, BrokerInstallationID: grant.BrokerInstallationID,
		PolicyGeneration: grant.PolicyGeneration, RequestID: grant.RequestID, SessionID: grant.SessionID, RunID: grant.RunID,
		TurnID: grant.TurnID, ActionID: grant.ActionID, Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App",
		VersionID: "1.2.3", Source: "winget", InstallScope: "machine", IssuedMS: grant.IssuedMS, ExpiresMS: grant.ExpiresMS}
	wingetMessage, err := autoInstallSigningBytes(winget)
	if err != nil {
		t.Fatal(err)
	}
	wingetSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, wingetMessage))
	if _, _, err := store.ClaimAutoInstall(winget, wingetSignature, now); err != errRequestConflict {
		t.Fatalf("cross-adapter request collision: %v", err)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	record, duplicate, err := reopened.ClaimMSIInstall(grant, signature, now)
	if err != nil || !duplicate || record.Status != statusUnknown {
		t.Fatalf("unsafe retry: %+v %v %v", record, duplicate, err)
	}
	if _, err := reopened.FinishMSIInstall(grant.Nonce, statusSucceeded, "DONE", now); err == nil {
		t.Fatal("finished interrupted request")
	}
	conflict := grant
	conflict.Nonce = "abcdefghijklmnopqrstuvwx"
	message, _ = msiInstallSigningBytes(conflict)
	signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	if _, _, err := reopened.ClaimMSIInstall(conflict, signature, now); err != errRequestConflict {
		t.Fatalf("request ID conflict: %v", err)
	}
	newGrant := grant
	newGrant.RequestID = "request-2"
	newGrant.Nonce = "abcdefghijklmnopqrstuvwx"
	message, _ = msiInstallSigningBytes(newGrant)
	newSignature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	if _, duplicate, err := reopened.ClaimMSIInstall(newGrant, newSignature, now); err != nil || duplicate {
		t.Fatalf("new request: %v %v", duplicate, err)
	}
	if _, err := reopened.FinishMSIInstall(newGrant.Nonce, statusSucceeded, "MSI_INSTALL_SUCCEEDED", now); err != nil {
		t.Fatal(err)
	}
	if result, ok := reopened.GetMSIInstall(newGrant.RequestID); !ok || result.Status != statusSucceeded {
		t.Fatalf("missing completed status: %+v", result)
	}
	if err := reopened.ResetOwner(now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := reopened.ClaimMSIInstall(newGrant, newSignature, now); err == nil {
		t.Fatal("owner reset failed to revoke signer")
	}
}
