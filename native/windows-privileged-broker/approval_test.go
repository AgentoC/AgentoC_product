package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testProposalRequest(requestID string) brokerRequest {
	return brokerRequest{
		Version: protocolVersion, Type: "propose", RequestID: requestID,
		SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1",
		Operation: "service.restart", TargetID: firstBrokerTargetID,
	}
}

func makeApprovalKey(t *testing.T) (*ecdsa.PrivateKey, string, string) {
	t.Helper()
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := base64.StdEncoding.EncodeToString(der)
	deviceID, err := deviceIDForPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	return private, publicKey, deviceID
}

func signApprovalMessage(t *testing.T, private *ecdsa.PrivateKey, message []byte) string {
	t.Helper()
	digest := sha256.Sum256(message)
	signature, err := ecdsa.SignASN1(rand.Reader, private, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(signature)
}

func TestDeviceEnrollmentRequiresKeyProofAndLocalCode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 123456789, time.UTC)
	challenge, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	if challenge.DeviceID != deviceID || challenge.OwnerID != "owner-account-123" || challenge.PolicyGeneration != 1 || challenge.VerificationCode == "00000000" {
		t.Fatalf("unexpected enrollment challenge: %+v", challenge)
	}

	message, err := enrollmentSigningBytes(challenge)
	if err != nil {
		t.Fatal(err)
	}
	brokerMessage, err := brokerEnrollmentSignatureBytes(challenge)
	if err != nil {
		t.Fatal(err)
	}
	brokerSignature, err := store.SignEnrollmentChallenge(challenge)
	if err != nil || verifyBrokerSignature(store.BrokerPublicKey(), brokerSignature, brokerMessage) != nil {
		t.Fatalf("Broker did not authenticate its enrollment challenge: err=%v", err)
	}
	changedEnrollment := challenge
	changedEnrollment.OwnerID = "other-owner"
	changedBrokerMessage, err := brokerEnrollmentSignatureBytes(changedEnrollment)
	if err != nil || verifyBrokerSignature(store.BrokerPublicKey(), brokerSignature, changedBrokerMessage) == nil {
		t.Fatalf("Broker enrollment signature did not bind the owner: err=%v", err)
	}
	signature := signApprovalMessage(t, private, message)
	if _, err := store.CompleteEnrollment(challenge.EnrollmentID, "00000000", signature, now.Add(time.Second)); !errors.Is(err, errEnrollmentCodeMismatch) {
		t.Fatalf("wrong comparison code was accepted: %v", err)
	}
	device, err := store.CompleteEnrollment(challenge.EnrollmentID, challenge.VerificationCode, signature, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if device.DeviceID != deviceID || store.state.OwnerID != "owner-account-123" || store.state.PolicyGeneration != 2 {
		t.Fatalf("device enrollment did not bind the owner and advance policy: device=%+v state=%+v", device, store.state)
	}
	if _, err := store.CompleteEnrollment(challenge.EnrollmentID, challenge.VerificationCode, signature, now.Add(2*time.Second)); !errors.Is(err, errEnrollmentNotFound) {
		t.Fatalf("enrollment proof replay was accepted: %v", err)
	}
}

func TestApprovalDecisionBindsEveryChallengeFieldAndIsOneUse(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	enrollmentMessage, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode, signApprovalMessage(t, private, enrollmentMessage), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	request := testProposalRequest("decision-1")
	if _, _, err := store.RecordProposal(request, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	record, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	message, err := approvalSigningBytes(*record.Challenge, "approve")
	if err != nil {
		t.Fatal(err)
	}
	brokerMessage, err := brokerSignatureBytes(*record.Challenge)
	if err != nil {
		t.Fatal(err)
	}
	brokerSignature, err := store.SignApprovalChallenge(*record.Challenge)
	if err != nil || verifyBrokerSignature(store.BrokerPublicKey(), brokerSignature, brokerMessage) != nil {
		t.Fatalf("Broker did not authenticate its approval challenge: err=%v", err)
	}
	signature := signApprovalMessage(t, private, message)
	decision := brokerRequest{Version: protocolVersion, Type: "decision", RequestID: request.RequestID, DeviceID: deviceID, Choice: "approve", Signature: signature}

	changed := *record.Challenge
	changed.TargetFingerprint = strings.Repeat("b", 64)
	changedMessage, err := approvalSigningBytes(changed, "approve")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(message, changedMessage) {
		t.Fatal("canonical approval bytes omitted the modified target")
	}
	decision.Signature = signApprovalMessage(t, private, changedMessage)
	if verifyDeviceSignature(publicKey, decision.Signature, message) == nil {
		t.Fatal("signature over a modified target verified against the original challenge")
	}
	if _, err := store.ApplySignedDecision(decision, now.Add(3*time.Second)); !errors.Is(err, errDecisionSignature) {
		t.Fatalf("modified target signature was accepted: %v", err)
	}
	if stored, _ := store.GetRequest(request.RequestID); stored.Status != statusAwaitingDevice {
		t.Fatalf("invalid signature consumed request: %+v", stored)
	}

	decision.Signature = signature
	result, err := store.ApplySignedDecision(decision, now.Add(4*time.Second))
	if err != nil || result.Status != statusAuthorized || result.Code != "DEVICE_APPROVED" {
		t.Fatalf("valid signed approval failed: result=%+v err=%v", result, err)
	}
	if _, err := store.ApplySignedDecision(decision, now.Add(5*time.Second)); !errors.Is(err, errDecisionConsumed) {
		t.Fatalf("signed decision replay was accepted: %v", err)
	}
}

func TestPolicyGenerationRevocationExpiresOutstandingApproval(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	message, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode, signApprovalMessage(t, private, message), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	request := testProposalRequest("decision-revoke")
	if _, _, err := store.RecordProposal(request, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeDevice(deviceID, now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if record, _ := store.GetRequest(request.RequestID); record.Status != statusExpired || record.Code != "DEVICE_REVOKED" {
		t.Fatalf("device revocation left an approval live: %+v", record)
	}
	if err := store.ResetOwner(now.Add(4 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if store.state.OwnerID != "" || len(store.state.Devices) != 0 || store.state.PolicyGeneration != 4 {
		t.Fatalf("owner reset did not revoke the binding: %+v", store.state)
	}
}

func TestExpiredEnrollmentCannotBeCompleted(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	now := time.Now().UTC()
	challenge, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	message, err := enrollmentSigningBytes(challenge)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(challenge.EnrollmentID, challenge.VerificationCode, signApprovalMessage(t, private, message), now.Add(deviceEnrollmentLifetime+time.Second)); !errors.Is(err, errEnrollmentExpired) {
		t.Fatalf("expired enrollment was accepted: %v", err)
	}
	if store.state.OwnerID != "" || len(store.state.Devices) != 0 || len(store.state.Enrollments) != 0 {
		t.Fatalf("expired enrollment changed device trust: %+v", store.state)
	}
}

func TestSchemaOneMigrationRevokesPendingApproval(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	request := testProposalRequest("migration-1")
	record, _, err := store.RecordProposal(request, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	record.Status = statusAwaitingDevice
	state := store.Snapshot()
	state.SchemaVersion = 1
	state.Devices = nil
	state.Enrollments = nil
	state.OwnerID = ""
	state.Requests[request.RequestID] = record
	if err := writeStateFile(path, state); err != nil {
		t.Fatal(err)
	}
	migrated, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := migrated.GetRequest(request.RequestID)
	if !ok || migrated.state.SchemaVersion != stateSchemaVersion || got.Status != statusExpired || got.Code != "MIGRATION_AUTHORIZATION_REVOKED" || got.Challenge != nil {
		t.Fatalf("legacy pending approval was not invalidated: state=%+v record=%+v", migrated.state, got)
	}
	if migrated.state.Audit[len(migrated.state.Audit)-1].Event != "broker.state_migrated" {
		t.Fatal("migration audit event missing")
	}
}

func TestBrokerSigningIdentityPersistsAndSchemaTwoMigrationRotatesIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	firstKey := store.BrokerPublicKey()
	reopened, err := openBrokerStore(path)
	if err != nil || reopened.BrokerPublicKey() != firstKey {
		t.Fatalf("Broker signing identity did not persist: err=%v", err)
	}
	request := testProposalRequest("migration-v2")
	if _, _, err := reopened.RecordProposal(request, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	legacy := reopened.Snapshot()
	legacy.SchemaVersion = 2
	legacy.BrokerPrivateKey = ""
	legacy.BrokerPublicKey = ""
	legacy.PolicyGeneration++
	if err := writeStateFile(path, legacy); err != nil {
		t.Fatal(err)
	}
	migrated, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if migrated.BrokerPublicKey() == firstKey || migrated.state.PolicyGeneration != legacy.PolicyGeneration+1 {
		t.Fatalf("schema migration failed to rotate Broker authority: before=%q after=%q generation=%d", firstKey, migrated.BrokerPublicKey(), migrated.state.PolicyGeneration)
	}
	record, ok := migrated.GetRequest(request.RequestID)
	if !ok || !record.Legacy || record.Status != statusExpired || record.Challenge != nil {
		t.Fatalf("schema migration retained an actionable legacy proposal: %+v found=%t", record, ok)
	}
	if err := validateState(migrated.Snapshot()); err != nil {
		t.Fatalf("migrated schema two state is invalid: %v", err)
	}
}

func TestApprovalContractGoldenVectors(t *testing.T) {
	created := time.Date(2026, 10, 22, 1, 2, 3, 123456789, time.UTC)
	enrollment := brokerEnrollmentChallenge{
		EnrollmentID: "enroll-1", BrokerInstallationID: "broker-1", PolicyGeneration: 7, OwnerID: "owner-1",
		DeviceID: strings.Repeat("1", 64), PublicKeyFingerprint: strings.Repeat("1", 64), Nonce: "nonce-1",
		VerificationCode: "12345678", CreatedAt: created, ExpiresAt: created.Add(5 * time.Minute),
	}
	approval := brokerChallenge{
		BrokerInstallationID: "broker-1", OwnerID: "owner-1", PolicyGeneration: 7, RequestID: "req-1",
		Operation: "service.restart", TargetID: firstBrokerTargetID, TargetFingerprint: strings.Repeat("a", 64),
		SessionID: "session-1", RunID: "run-1", TurnID: "turn-1", ActionID: "action-1", Nonce: "nonce-1",
		CreatedAt: created, ExpiresAt: created.Add(requestApprovalLifetime),
	}
	deviceEnrollment, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	brokerEnrollment, err := brokerEnrollmentSignatureBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	codeBytes, err := encodeEnrollmentCodeInput(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	deviceApproval, err := approvalSigningBytes(approval, "approve")
	if err != nil {
		t.Fatal(err)
	}
	brokerApproval, err := brokerSignatureBytes(approval)
	if err != nil {
		t.Fatal(err)
	}
	for name, vector := range map[string]struct {
		bytes    []byte
		expected string
	}{
		"device-enrollment": {deviceEnrollment, "2be468a6428f3344c73e20fb4b4b14bcfe62a740a645793a2bc46acc3eb46f02"},
		"broker-enrollment": {brokerEnrollment, "fde25edb4f19efbf5b8aca661c5bb281b834fe44ff7f1a7c6971ae8be71aca21"},
		"enrollment-code":   {codeBytes, "f0cadff165abc5c29fdb6810274a686630959d11c7445b52e56aa4384b6401c0"},
		"device-approval":   {deviceApproval, "d3a6add21e8c9ac5ef70004ca7245be41a1676fd25733d7a8b5a949f3e58484a"},
		"broker-approval":   {brokerApproval, "305fc88793715279e22d5f619d0119bf650999f56a9d7f035fbdf59cf7fe25f5"},
	} {
		digest := sha256.Sum256(vector.bytes)
		if got := fmt.Sprintf("%x", digest); got != vector.expected {
			t.Errorf("%s canonical vector changed: got=%s want=%s", name, got, vector.expected)
		}
	}
	code, err := enrollmentCode(enrollment)
	if err != nil || code != "39827441" {
		t.Fatalf("enrollment verification code vector changed: code=%s err=%v", code, err)
	}
}
