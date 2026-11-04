package main

import (
	"crypto/ecdsa"
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

func enrollServiceTestDevice(t *testing.T, store *brokerStore, now time.Time) (*ecdsa.PrivateKey, string) {
	t.Helper()
	private, public, deviceID := makeApprovalKey(t)
	challenge, err := store.BeginEnrollment("owner", deviceID, public, now)
	if err != nil {
		t.Fatal(err)
	}
	message, err := enrollmentSigningBytes(challenge)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(challenge.EnrollmentID, challenge.VerificationCode, signApprovalMessage(t, private, message), now); err != nil {
		t.Fatal(err)
	}
	return private, deviceID
}

func TestServiceControlClaimIsAtomicAndCrashIsUnknown(t *testing.T) {
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
	deviceKey, deviceID := enrollServiceTestDevice(t, store, now)
	snapshot := store.Snapshot()
	grant := serviceControlGrant{Version: 1, KeyID: "key", BrokerInstallationID: snapshot.InstallationID, PolicyGeneration: snapshot.PolicyGeneration,
		RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: "abcdefghijklmnopqrstuvwx",
		ServiceName: "测试服务", Action: "restart-service", DefinitionHash: strings.Repeat("a", 64), Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(grant)))
	proof := serviceOwnerProof{DeviceID: deviceID, Signature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(grant))}
	if _, _, err := store.ClaimServiceControl(grant, signature, serviceOwnerProof{}, now); err == nil {
		t.Fatal("missing owner proof accepted")
	}
	forged := grant
	forged.ServiceName, forged.RequestID, forged.Nonce = "Different service", "forged", "forgedabcdefghijklmnopqr"
	forgedSig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(forged)))
	if _, _, err := store.ClaimServiceControl(forged, forgedSig, proof, now); err == nil {
		t.Fatal("valid control-plane signature reused an owner proof for a different service")
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	claims, duplicates := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, duplicate, err := store.ClaimServiceControl(grant, signature, proof, now)
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
	conflict := grant
	conflict.Nonce = "otherabcdefghijklmnopqrstuvw"
	conflictSig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(conflict)))
	conflictProof := serviceOwnerProof{DeviceID: deviceID, Signature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(conflict))}
	if _, _, err := store.ClaimServiceControl(conflict, conflictSig, conflictProof, now); err != errRequestConflict {
		t.Fatalf("request collision: %v", err)
	}
	proposal := validProposal()
	proposal.RequestID = grant.RequestID
	if _, _, err := store.RecordProposal(proposal, now); err != errRequestConflict {
		t.Fatalf("cross-operation collision: %v", err)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := reopened.GetServiceControl(grant.RequestID)
	if !ok || record.Status != statusUnknown {
		t.Fatalf("recovery: %+v", record)
	}
	record, duplicate, err := reopened.ClaimServiceControl(grant, signature, proof, now)
	if err != nil || !duplicate || record.Status != statusUnknown {
		t.Fatalf("unsafe replay: %+v %v %v", record, duplicate, err)
	}
	if _, err := reopened.FinishServiceControl(grant.Nonce, statusSucceeded, "DONE", now); err == nil {
		t.Fatal("interrupted request was completed")
	}
	completed := grant
	completed.Nonce, completed.RequestID = "completedabcdefghijklmnop", "completed"
	completedSig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(completed)))
	completedProof := serviceOwnerProof{DeviceID: deviceID, Signature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(completed))}
	if _, _, err := reopened.ClaimServiceControl(completed, completedSig, completedProof, now); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.FinishServiceControl(completed.Nonce, statusSucceeded, "SERVICE_CONTROL_SUCCEEDED", now); err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.GetServiceControl(completed.RequestID); !ok || got.Status != statusSucceeded {
		t.Fatal("completed result missing")
	}
	rotating := grant
	rotating.Nonce, rotating.RequestID = "rotatingabcdefghijklmnopq", "rotating"
	rotatingSig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(rotating)))
	rotatingProof := serviceOwnerProof{DeviceID: deviceID, Signature: signApprovalMessage(t, deviceKey, serviceControlOwnerSigningBytes(rotating))}
	if _, _, err := reopened.ClaimServiceControl(rotating, rotatingSig, rotatingProof, now); err != nil {
		t.Fatal(err)
	}
	newPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	newDer, err := x509.MarshalPKIXPublicKey(newPublic)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.ConfigureAutoInstallSigner("new-key", base64.RawURLEncoding.EncodeToString(newDer), now); err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.GetServiceControl(rotating.RequestID); !ok || got.Status != statusUnknown {
		t.Fatal("signer rotation did not mark active action unknown")
	}
}
