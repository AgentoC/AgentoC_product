package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStorePersistsIdempotentProposalsAndAudit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	request := validProposal()
	now := time.Date(2026, 10, 22, 12, 30, 0, 0, time.UTC)
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	enrollmentBytes, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode, signApprovalMessage(t, private, enrollmentBytes), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	first, duplicate, err := store.RecordProposal(request, now)
	if err != nil || duplicate || first.Status != statusProposed {
		t.Fatalf("first proposal result: record=%+v duplicate=%t error=%v", first, duplicate, err)
	}
	second, duplicate, err := store.RecordProposal(request, now.Add(time.Minute))
	if err != nil || !duplicate || second.Digest != first.Digest || second.CreatedAt != first.CreatedAt {
		t.Fatalf("retry did not return durable proposal: record=%+v duplicate=%t error=%v", second, duplicate, err)
	}
	if _, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}

	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := reopened.GetRequest(request.RequestID)
	if !ok || record.Status != statusAwaitingDevice || record.Challenge == nil {
		t.Fatalf("reopened request status mismatch: %+v found=%t", record, ok)
	}
	state := reopened.Snapshot()
	if len(state.Audit) != 5 || state.Audit[0].Event != "broker.initialized" || state.Audit[1].Event != "device.enrollment_proposed" || state.Audit[2].Event != "device.enrolled" || state.Audit[3].Event != "request.proposed" || state.Audit[4].Event != "request.awaiting_device" {
		t.Fatalf("unexpected audit history: %+v", state.Audit)
	}
	if err := validateState(state); err != nil {
		t.Fatalf("valid persisted state did not validate: %v", err)
	}
}

func TestGetRequestStatusPersistsElapsedDeviceChallengeOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 26, 2, 30, 0, 0, time.UTC)
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	message, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode,
		signApprovalMessage(t, private, message), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	request := validProposal()
	if _, _, err := store.RecordProposal(request, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	pending, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), now.Add(3*time.Second))
	if err != nil || pending.Challenge == nil {
		t.Fatalf("challenge setup failed: record=%+v err=%v", pending, err)
	}
	before, found, err := store.GetRequestStatus(request.RequestID, pending.Challenge.ExpiresAt.Add(-time.Second))
	if err != nil || !found || before.Status != statusAwaitingDevice {
		t.Fatalf("live status changed: record=%+v found=%t err=%v", before, found, err)
	}
	expired, found, err := store.GetRequestStatus(request.RequestID, pending.Challenge.ExpiresAt)
	if err != nil || !found || expired.Status != statusExpired || expired.Code != "DECISION_EXPIRED" {
		t.Fatalf("elapsed status was not persisted: record=%+v found=%t err=%v", expired, found, err)
	}
	again, found, err := store.GetRequestStatus(request.RequestID, pending.Challenge.ExpiresAt.Add(time.Minute))
	if err != nil || !found || again.Status != statusExpired || again.Code != "DECISION_EXPIRED" {
		t.Fatalf("terminal status changed: record=%+v found=%t err=%v", again, found, err)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	durable, found := reopened.GetRequest(request.RequestID)
	if !found || durable.Status != statusExpired || durable.Code != "DECISION_EXPIRED" {
		t.Fatalf("elapsed status was not durable: record=%+v found=%t", durable, found)
	}
	expiredEvents := 0
	for _, entry := range reopened.Snapshot().Audit {
		if entry.Event == "request.expired" && entry.RequestID == request.RequestID && entry.Code == "DECISION_EXPIRED" {
			expiredEvents++
		}
	}
	if expiredEvents != 1 {
		t.Fatalf("expiry must be audited once: count=%d", expiredEvents)
	}
}

func TestPendingRequestsRequireEnrolledDeviceAndPageLiveChallenges(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 22, 12, 30, 0, 0, time.UTC)
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	enrollmentMessage, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode,
		signApprovalMessage(t, private, enrollmentMessage), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxPendingPageSize+2; i++ {
		request := testProposalRequest(fmt.Sprintf("pending-%02d", i))
		created := now.Add(time.Duration(i+2) * time.Second)
		if _, _, err := store.RecordProposal(request, created); err != nil {
			t.Fatal(err)
		}
		if _, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), created.Add(time.Second)); err != nil {
			t.Fatal(err)
		}
	}

	firstPage, cursor, hasMore, err := store.PendingRequests(deviceID, "", now.Add(3*time.Second))
	if err != nil || len(firstPage) != maxPendingPageSize || !hasMore || cursor != firstPage[len(firstPage)-1].Request.RequestID {
		t.Fatalf("first pending page mismatch: count=%d cursor=%q more=%t err=%v", len(firstPage), cursor, hasMore, err)
	}
	secondPage, nextCursor, hasMore, err := store.PendingRequests(deviceID, cursor, now.Add(3*time.Second))
	if err != nil || len(secondPage) != 2 || hasMore || nextCursor != "" {
		t.Fatalf("second pending page mismatch: count=%d cursor=%q more=%t err=%v", len(secondPage), nextCursor, hasMore, err)
	}
	expired, _, _, err := store.PendingRequests(deviceID, "", now.Add(4*time.Minute))
	if err != nil || len(expired) != 0 {
		t.Fatalf("expired challenges were listed: count=%d err=%v", len(expired), err)
	}
	if _, _, _, err := store.PendingRequests(strings.Repeat("b", 64), "", now); !errors.Is(err, errDeviceNotEnrolled) {
		t.Fatalf("unregistered device queried the pending list: %v", err)
	}
}

func TestStoreRejectsRequestIDConflictAndInvalidTransitions(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	request := validProposal()
	now := time.Now().UTC()
	if _, _, err := store.RecordProposal(request, now); err != nil {
		t.Fatal(err)
	}
	changed := request
	changed.ActionID = "other-action"
	if _, _, err := store.RecordProposal(changed, now); !errors.Is(err, errRequestConflict) {
		t.Fatalf("request ID collision was not rejected: %v", err)
	}
	if _, err := store.Transition(request.RequestID, statusSucceeded, "", now); !errors.Is(err, errStateInvalid) {
		t.Fatalf("invalid state transition was not rejected: %v", err)
	}
	if record, _ := store.GetRequest(request.RequestID); record.Status != statusProposed {
		t.Fatalf("rejected transition changed state: %+v", record)
	}
}

func TestTargetReconfigurationExpiresPendingApprovalsAndAdvancesGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 22, 12, 30, 0, 0, time.UTC)
	firstFingerprint := strings.Repeat("a", 64)
	if err := store.ConfigureTarget(firstFingerprint, now); err != nil {
		t.Fatal(err)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	enrollmentBytes, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode,
		signApprovalMessage(t, private, enrollmentBytes), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	request := validProposal()
	if _, _, err := store.RecordProposal(request, now.Add(3*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AwaitDeviceApproval(request.RequestID, firstFingerprint, now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	before := store.Snapshot()
	if before.Requests[request.RequestID].Status != statusAwaitingDevice {
		t.Fatalf("request did not enter device approval: %+v", before.Requests[request.RequestID])
	}

	secondFingerprint := strings.Repeat("b", 64)
	if err := store.ConfigureTarget(secondFingerprint, now.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	after := store.Snapshot()
	record := after.Requests[request.RequestID]
	if after.PolicyGeneration != before.PolicyGeneration+1 || after.TargetFingerprint != secondFingerprint {
		t.Fatalf("target reconfiguration did not advance policy: before=%+v after=%+v", before, after)
	}
	if record.Status != statusExpired || record.Code != "TARGET_POLICY_CHANGED" {
		t.Fatalf("pending approval survived target reconfiguration: %+v", record)
	}
	if err := validateState(after); err != nil {
		t.Fatalf("reconfigured state did not validate: %v", err)
	}
	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Snapshot().Requests[request.RequestID].Status != statusExpired {
		t.Fatal("target-change expiration was not durable")
	}
}

func TestPendingEnrollmentOnlyExposesTheBoundLiveChallenge(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 22, 12, 30, 0, 0, time.UTC)
	private, publicKey, deviceID := makeApprovalKey(t)
	if _, err := store.PendingEnrollment(deviceID, now); !errors.Is(err, errEnrollmentNotFound) {
		t.Fatalf("missing enrollment did not fail closed: %v", err)
	}
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.PendingEnrollment(deviceID, now.Add(time.Second))
	if err != nil || got != enrollment {
		t.Fatalf("live enrollment was not returned exactly: got=%+v want=%+v err=%v", got, enrollment, err)
	}
	if _, err := store.PendingEnrollment(strings.Repeat("b", 64), now.Add(time.Second)); !errors.Is(err, errEnrollmentNotFound) {
		t.Fatalf("challenge was exposed to a different device: %v", err)
	}
	if _, err := store.PendingEnrollment(deviceID, enrollment.ExpiresAt); !errors.Is(err, errEnrollmentExpired) {
		t.Fatalf("expired challenge remained available: %v", err)
	}

	message, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode,
		signApprovalMessage(t, private, message), now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PendingEnrollment(deviceID, now.Add(3*time.Second)); !errors.Is(err, errEnrollmentNotFound) {
		t.Fatalf("completed enrollment remained pending: %v", err)
	}
}

func TestStoreRecoversInterruptedExecutionWithoutReplaying(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-account-123", deviceID, publicKey, now)
	if err != nil {
		t.Fatal(err)
	}
	enrollmentMessage, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode,
		signApprovalMessage(t, private, enrollmentMessage), now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	first := testProposalRequest("recovery-authorized")
	second := testProposalRequest("recovery-executing")
	for _, request := range []brokerRequest{first, second} {
		if _, _, err := store.RecordProposal(request, now.Add(2*time.Second)); err != nil {
			t.Fatal(err)
		}
		if _, err := store.AwaitDeviceApproval(request.RequestID, strings.Repeat("a", 64), now.Add(3*time.Second)); err != nil {
			t.Fatal(err)
		}
		record, _ := store.GetRequest(request.RequestID)
		message, err := approvalSigningBytes(*record.Challenge, "approve")
		if err != nil {
			t.Fatal(err)
		}
		decision := brokerRequest{Version: protocolVersion, Type: "decision", RequestID: request.RequestID,
			DeviceID: deviceID, Choice: "approve", Signature: signApprovalMessage(t, private, message)}
		if _, err := store.ApplySignedDecision(decision, now.Add(4*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Transition(second.RequestID, statusExecuting, "EXECUTION_STARTED", now.Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}

	reopened, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	authorized, _ := reopened.GetRequest(first.RequestID)
	executing, _ := reopened.GetRequest(second.RequestID)
	if authorized.Status != statusExpired || authorized.Code != "EXECUTION_NOT_STARTED" || authorized.Challenge != nil {
		t.Fatalf("authorization without execution was not expired on restart: %+v", authorized)
	}
	if executing.Status != statusUnknown || executing.Code != "EXECUTION_OUTCOME_UNKNOWN" || executing.Challenge != nil {
		t.Fatalf("interrupted side effect was not made unknown on restart: %+v", executing)
	}
	state := reopened.Snapshot()
	if err := validateState(state); err != nil {
		t.Fatalf("recovered state did not validate: %v", err)
	}
	for _, requestID := range []string{first.RequestID, second.RequestID} {
		if _, duplicate, err := reopened.RecordProposal(mustProposalForStoreTest(requestID), now.Add(6*time.Second)); err != nil || !duplicate {
			t.Fatalf("recovered request cannot be safely queried idempotently: id=%s duplicate=%t error=%v", requestID, duplicate, err)
		}
	}
	if reopened.Snapshot().Requests[second.RequestID].Status != statusUnknown {
		t.Fatal("duplicate request replay changed unknown execution status")
	}
}

func mustProposalForStoreTest(requestID string) brokerRequest {
	request := testProposalRequest(requestID)
	return request
}

func TestStoreRejectsTamperedAuditAndUnknownStateFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := openBrokerStore(path)
	if err != nil {
		t.Fatal(err)
	}
	state := store.Snapshot()
	state.Audit[0].Event = "audit.changed"
	if err := validateState(state); !errors.Is(err, errStateInvalid) {
		t.Fatalf("tampered audit chain was accepted: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	object["adminShell"] = true
	tampered, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, tampered, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openBrokerStore(path); !errors.Is(err, errStateInvalid) {
		t.Fatalf("unknown persisted state field was accepted: %v", err)
	}
}
