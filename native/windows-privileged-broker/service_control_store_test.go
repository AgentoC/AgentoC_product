package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"fmt"
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
	proposed, duplicate, err := store.ProposeServiceControl(grant, signature, now)
	if err != nil || duplicate || proposed.Status != statusAwaitingDevice {
		t.Fatalf("proposal: %+v %v", proposed, err)
	}
	if pending, _, more, err := store.PendingServiceControls(deviceID, "", now); err != nil || more || len(pending) != 1 || pending[0].Grant.RequestID != grant.RequestID {
		t.Fatalf("pending: %+v %v", pending, err)
	}
	recoveredPending, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if pending, _, _, err := recoveredPending.PendingServiceControls(deviceID, "", now); err != nil || len(pending) != 1 {
		t.Fatal("pending approval did not survive restart")
	}
	brokerKey, attestation, err := store.AttestServiceControl(grant, signature, deviceID, now)
	if err != nil || verifyBrokerSignature(brokerKey, attestation, serviceControlBrokerSigningBytes(grant)) != nil {
		t.Fatal("broker did not attest the exact review grant")
	}
	if _, _, err := store.AttestServiceControl(grant, signature, strings.Repeat("0", 64), now); err == nil {
		t.Fatal("unenrolled device received review attestation")
	}
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
	if _, _, err := store.AttestServiceControl(grant, signature, deviceID, now); err == nil {
		t.Fatal("claimed operation was re-attested")
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
	record, duplicate, err = reopened.ClaimServiceControl(grant, signature, proof, now)
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
	if _, _, err := reopened.ProposeServiceControl(completed, completedSig, now); err != nil {
		t.Fatal(err)
	}
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
	if _, _, err := reopened.ProposeServiceControl(rotating, rotatingSig, now); err != nil {
		t.Fatal(err)
	}
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

func TestPendingServiceControlPaginationAndExpiration(t *testing.T) {
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
	if err := store.ConfigureAutoInstallSigner("key", base64.RawURLEncoding.EncodeToString(der), now); err != nil {
		t.Fatal(err)
	}
	_, deviceID := enrollServiceTestDevice(t, store, now)
	snapshot := store.Snapshot()
	for i := 0; i < maxPendingPageSize+1; i++ {
		id := fmt.Sprintf("request-%02d", i)
		grant := serviceControlGrant{Version: 1, KeyID: "key", BrokerInstallationID: snapshot.InstallationID, PolicyGeneration: snapshot.PolicyGeneration,
			RequestID: id, SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: fmt.Sprintf("nonce%020d", i),
			ServiceName: "Example", Action: "start-service", DefinitionHash: strings.Repeat("a", 64), Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
		sig := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(grant)))
		if _, _, err := store.ProposeServiceControl(grant, sig, now); err != nil {
			t.Fatal(err)
		}
	}
	first, cursor, more, err := store.PendingServiceControls(deviceID, "", now)
	if err != nil || !more || len(first) != maxPendingPageSize || cursor != first[len(first)-1].Grant.RequestID {
		t.Fatal("first page invalid")
	}
	second, _, more, err := store.PendingServiceControls(deviceID, cursor, now)
	if err != nil || more || len(second) != 1 || second[0].Grant.RequestID <= cursor {
		t.Fatal("second page invalid")
	}
	if _, _, _, err := store.PendingServiceControls(strings.Repeat("0", 64), "", now); err != errDeviceNotEnrolled {
		t.Fatal("unenrolled device saw pending approvals")
	}
	if expired, _, _, err := store.PendingServiceControls(deviceID, "", now.Add(time.Minute)); err != nil || len(expired) != 0 {
		t.Fatal("expired approvals remained visible")
	}
	if record, ok := store.GetServiceControl("request-00"); !ok || record.Status != statusExpired {
		t.Fatal("expiry was not persisted")
	}
}
