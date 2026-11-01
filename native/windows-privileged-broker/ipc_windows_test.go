//go:build windows

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestRecoverableBrokerPipeConnectError(t *testing.T) {
	for _, code := range []error{
		windows.ERROR_NO_DATA,
		windows.ERROR_PIPE_NOT_CONNECTED,
		windows.ERROR_OPERATION_ABORTED,
	} {
		if !recoverableBrokerPipeConnectError(code) {
			t.Fatalf("connect error should be recoverable: %v", code)
		}
	}
	for _, code := range []error{windows.ERROR_ACCESS_DENIED, windows.ERROR_INVALID_HANDLE, errors.New("unexpected")} {
		if recoverableBrokerPipeConnectError(code) {
			t.Fatalf("connect error must remain fatal: %v", code)
		}
	}
}

func TestPipeACLsSeparateHealthAndRequestClientsWithoutPipeInstanceCreation(t *testing.T) {
	controlPlaneSID, err := windows.StringToSid("S-1-5-80-1-2-3-4-5")
	if err != nil {
		t.Fatal(err)
	}
	for _, health := range []bool{true, false} {
		name := "request"
		if health {
			name = "health"
		}
		t.Run(name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(pipeSecurityDescriptor(controlPlaneSID, health))
			if err != nil {
				t.Fatalf("invalid named pipe ACL: %v", err)
			}
			acl, _, err := sd.DACL()
			if err != nil || acl == nil {
				t.Fatalf("named pipe DACL unavailable: %v", err)
			}
			serviceSIDRights := uint32(0)
			for index := uint32(0); index < uint32(acl.AceCount); index++ {
				var ace *windows.ACCESS_ALLOWED_ACE
				if err := windows.GetAce(acl, index, &ace); err != nil {
					t.Fatal(err)
				}
				if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
					continue
				}
				sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
				if sid.Equals(controlPlaneSID) {
					serviceSIDRights = uint32(ace.Mask)
				}
			}
			if serviceSIDRights != pipeClientAccessMask || serviceSIDRights&0x00000004 != 0 {
				t.Fatalf("ControlPlane rights allow pipe instance creation or are incomplete: 0x%08x", serviceSIDRights)
			}
			if health && uint32(acl.AceCount) != 3 {
				t.Fatalf("health DACL should include SYSTEM, Administrators, and ControlPlane only: %d ACEs", acl.AceCount)
			}
			if !health && uint32(acl.AceCount) != 2 {
				t.Fatalf("request DACL should include SYSTEM and ControlPlane only: %d ACEs", acl.AceCount)
			}
		})
	}
}

func TestAdminPipeACLIsLimitedToLocalAdministratorsAndSystem(t *testing.T) {
	sd, err := windows.SecurityDescriptorFromString(adminPipeSecurityDescriptor())
	if err != nil {
		t.Fatalf("invalid admin named pipe ACL: %v", err)
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || uint32(acl.AceCount) != 2 {
		t.Fatalf("admin pipe DACL must contain exactly two ACEs: acl=%v err=%v", acl, err)
	}
	principals := map[string]bool{"S-1-5-18": false, "S-1-5-32-544": false}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || uint32(ace.Mask) != windows.GENERIC_ALL {
			t.Fatalf("admin pipe ACE is not an allow-full-control ACE: type=%d mask=0x%08x", ace.Header.AceType, ace.Mask)
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if _, ok := principals[principal]; !ok || principals[principal] {
			t.Fatalf("admin pipe ACL grants unexpected or duplicate principal %s", principal)
		}
		principals[principal] = true
	}
	for principal, found := range principals {
		if !found {
			t.Fatalf("admin pipe ACL does not grant required maintenance principal %s", principal)
		}
	}
}

func TestSystemCanUseAdminPipeOnlyToResetOwner(t *testing.T) {
	reset, err := json.Marshal(brokerRequest{Version: protocolVersion, Type: "owner.reset"})
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := json.Marshal(brokerRequest{Version: protocolVersion, Type: "enrollment.begin"})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name            string
		userSID         string
		isAdministrator bool
		payload         []byte
		want            bool
	}{
		{name: "system owner reset", userSID: "S-1-5-18", payload: reset, want: true},
		{name: "system cannot enroll", userSID: "S-1-5-18", payload: enrollment, want: false},
		{name: "admin can enroll", userSID: "S-1-5-21-1", isAdministrator: true, payload: enrollment, want: true},
		{name: "standard user denied", userSID: "S-1-5-21-1", payload: reset, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := allowAdminPipeRequest(test.userSID, test.isAdministrator, test.payload); got != test.want {
				t.Fatalf("admin pipe admission: got %v, want %v", got, test.want)
			}
		})
	}
}

func TestAdminPipeKernelACLRejectsNonElevatedLocalClient(t *testing.T) {
	if isAdministratorToken(windows.GetCurrentProcessToken()) {
		t.Skip("test process is elevated; use the non-elevated local acceptance run")
	}
	pipeID, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := `\\.\pipe\AgentoC.PrivilegedBroker.AdminACLTest.` + pipeID
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString(adminPipeSecurityDescriptor())
	if err != nil {
		t.Fatal(err)
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	pipe, err := windows.CreateNamedPipe(namePointer,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		1, maxIPCFrame+4, maxIPCFrame+4, 0, &sa)
	if err != nil {
		t.Fatalf("create isolated admin pipe: %v", err)
	}
	defer windows.CloseHandle(pipe)
	client, err := windows.CreateFile(namePointer, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
	if err == nil {
		_ = windows.CloseHandle(client)
		t.Fatal("non-elevated local process opened the administrator pipe")
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("admin pipe rejected a standard process for an unexpected reason: %v", err)
	}
}

func TestRequestPipeKernelACLRejectsUntrustedLocalProcess(t *testing.T) {
	controlPlaneSID, err := windows.StringToSid("S-1-5-80-1-2-3-4-5")
	if err != nil {
		t.Fatal(err)
	}
	pipeID, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := `\\.\pipe\AgentoC.PrivilegedBroker.Test.` + pipeID
	namePointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString(pipeSecurityDescriptor(controlPlaneSID, false))
	if err != nil {
		t.Fatal(err)
	}
	sa := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}
	pipe, err := windows.CreateNamedPipe(namePointer,
		windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_OVERLAPPED,
		windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		1, maxIPCFrame+4, maxIPCFrame+4, 0, &sa)
	if err != nil {
		t.Fatalf("create isolated request pipe: %v", err)
	}
	defer windows.CloseHandle(pipe)
	stopEvent, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(stopEvent)
	connected := make(chan error, 1)
	go func() {
		ok, connectErr := waitForPipeClient(pipe, stopEvent)
		if connectErr == nil && ok {
			connectErr = errors.New("untrusted process connected to the request pipe")
		}
		connected <- connectErr
	}()

	client, openErr := windows.CreateFile(namePointer,
		windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if openErr == nil {
		_ = windows.CloseHandle(client)
		t.Fatal("untrusted local process opened the request pipe")
	}
	if !errors.Is(openErr, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("request pipe open failed for an unexpected reason: %v", openErr)
	}
	if err := windows.SetEvent(stopEvent); err != nil {
		t.Fatal(err)
	}
	select {
	case connectErr := <-connected:
		if !errors.Is(connectErr, errIPCStopped) {
			t.Fatalf("isolated pipe server did not stop cleanly: %v", connectErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("isolated pipe server remained blocked after stop")
	}
}

func TestBrokerNamedPipesRoundTripLocallyWithoutSCM(t *testing.T) {
	currentToken := windows.GetCurrentProcessToken()
	user, err := currentToken.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	store, err := openBrokerStore(filepath.Join(root, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	pipeSuffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	healthName := `\\.\pipe\AgentoC.PrivilegedBroker.LocalTest.` + pipeSuffix + `.Health.v1`
	requestName := `\\.\pipe\AgentoC.PrivilegedBroker.LocalTest.` + pipeSuffix + `.Request.v1`
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, healthName, requestName)
	if err != nil {
		t.Fatal(err)
	}
	runResult := make(chan error, 1)
	go func() { runResult <- server.Run(context.Background()) }()
	stopAndWait := func() {
		server.Stop()
		select {
		case runErr := <-runResult:
			if runErr != nil {
				t.Errorf("local IPC server stopped with error: %v", runErr)
			}
		case <-time.After(3 * time.Second):
			t.Error("local IPC server did not stop")
		}
	}
	t.Cleanup(stopAndWait)

	health := exchangeTestPipeRequest(t, healthName, brokerRequest{Version: protocolVersion, Type: "health"})
	if health.Type != "health" || health.Code != "BROKER_DISABLED" || health.ExecutionEnabled {
		t.Fatalf("unexpected local health response: %+v", health)
	}
	proposal := validProposal()
	response := exchangeTestPipeRequest(t, requestName, proposal)
	if response.Type != "result" || response.RequestID != proposal.RequestID || response.Status != statusDenied || response.Code != "BROKER_TARGET_NOT_CONFIGURED" {
		t.Fatalf("unexpected local proposal response: %+v", response)
	}
	status := exchangeTestPipeRequest(t, requestName, brokerRequest{Version: protocolVersion, Type: "status", RequestID: proposal.RequestID})
	if status.Status != statusDenied || status.Code != "BROKER_TARGET_NOT_CONFIGURED" {
		t.Fatalf("unexpected local status response: %+v", status)
	}
	healthWrite := exchangeTestPipeRequest(t, healthName, proposal)
	if healthWrite.Type != "error" || healthWrite.Code != "HEALTH_PIPE_READ_ONLY" {
		t.Fatalf("health pipe accepted a mutation: %+v", healthWrite)
	}
	if _, ok := store.GetRequest(proposal.RequestID); !ok {
		t.Fatal("local IPC proposal was not persisted")
	}
	if err := validateState(store.Snapshot()); err != nil {
		t.Fatalf("local IPC state and audit did not validate: %v", err)
	}
}

func TestBrokerPipeClientFactsAcceptLocalTestIdentity(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	suffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	healthName := `\\.\pipe\AgentoC.PrivilegedBroker.IdentityTest.` + suffix + `.Health.v1`
	requestName := `\\.\pipe\AgentoC.PrivilegedBroker.IdentityTest.` + suffix + `.Request.v1`
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, healthName, requestName)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		server.Stop()
		_ = windows.DisconnectNamedPipe(server.requestPipe)
		_ = windows.CloseHandle(server.requestPipe)
		_ = windows.CloseHandle(server.healthPipe)
		_ = windows.CloseHandle(server.adminPipe)
		_ = windows.CloseHandle(server.stopEvent)
	})
	connected := make(chan error, 1)
	go func() {
		ok, connectErr := waitForPipeClient(server.requestPipe, server.stopEvent)
		if connectErr == nil && !ok {
			connectErr = errors.New("local test pipe did not connect")
		}
		connected <- connectErr
	}()
	name, err := windows.UTF16PtrFromString(requestName)
	if err != nil {
		t.Fatal(err)
	}
	client, err := windows.CreateFile(name, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
	if err != nil {
		t.Fatalf("open identity-test pipe: %v", err)
	}
	defer windows.CloseHandle(client)
	if err := <-connected; err != nil {
		t.Fatalf("connect identity-test pipe: %v", err)
	}
	facts, err := getPipeClientFacts(server.requestPipe, user.User.Sid, false)
	if err != nil {
		t.Fatalf("inspect local test peer facts: %v", err)
	}
	if facts.PID == 0 || facts.UserSID != user.User.Sid.String() || facts.ServiceSID != user.User.Sid.String() || facts.IsAdministrator {
		t.Fatalf("unexpected local test peer facts: %+v", facts)
	}
}

func TestRequestPipeRejectsLoopbackUNCClient(t *testing.T) {
	if os.Getenv("AGENTOC_BROKER_REMOTE_PIPE_TEST") != "1" {
		t.Skip("set AGENTOC_BROKER_REMOTE_PIPE_TEST=1 to exercise the SMB/UNC path")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	suffix, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	const prefix = `\\.\pipe\AgentoC.PrivilegedBroker.RemoteTest.`
	requestName := prefix + suffix
	server, err := newBrokerIPCServerForPipeNames(store, user.User.Sid, requestName+".Health", requestName)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		server.Stop()
		_ = windows.DisconnectNamedPipe(server.requestPipe)
		_ = windows.CloseHandle(server.requestPipe)
		_ = windows.CloseHandle(server.healthPipe)
		_ = windows.CloseHandle(server.adminPipe)
		_ = windows.CloseHandle(server.stopEvent)
	}()
	connected := make(chan error, 1)
	go func() {
		ok, connectErr := waitForPipeClient(server.requestPipe, server.stopEvent)
		if connectErr == nil && ok {
			connectErr = errors.New("loopback UNC client connected despite PIPE_REJECT_REMOTE_CLIENTS")
		}
		connected <- connectErr
	}()
	leaf := strings.TrimPrefix(requestName, `\\.\pipe\`)
	remotePath, err := windows.UTF16PtrFromString(`\\localhost\pipe\` + leaf)
	if err != nil {
		t.Fatal(err)
	}
	client, openErr := windows.CreateFile(remotePath, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
		windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
	if openErr == nil {
		_ = windows.CloseHandle(client)
		t.Fatal("loopback UNC client opened the request pipe")
	}
	if !errors.Is(openErr, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("loopback UNC request was refused outside the pipe security check: %v", openErr)
	}
	server.Stop()
	select {
	case connectErr := <-connected:
		if !errors.Is(connectErr, errIPCStopped) {
			t.Fatalf("remote-reject pipe did not stop cleanly: %v", connectErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote-reject pipe server remained blocked after stop")
	}
}

func exchangeTestPipeRequest(t *testing.T, pipeName string, request brokerRequest) brokerResponse {
	t.Helper()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(pipeName)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var pipe windows.Handle
	for {
		pipe, err = windows.CreateFile(name, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
			windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			t.Fatalf("open local test pipe: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("local test pipe did not accept a client: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer windows.CloseHandle(pipe)
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(encoded)))
	writeTestPipeBytes(t, pipe, header[:])
	writeTestPipeBytes(t, pipe, encoded)
	readTestPipeBytes(t, pipe, header[:])
	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 || length > maxIPCFrame {
		t.Fatalf("invalid local test response frame length: %d", length)
	}
	body := make([]byte, int(length))
	readTestPipeBytes(t, pipe, body)
	var response brokerResponse
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode local test pipe response: %v", err)
	}
	return response
}

func writeTestPipeBytes(t *testing.T, pipe windows.Handle, value []byte) {
	t.Helper()
	for offset := 0; offset < len(value); {
		var written uint32
		if err := windows.WriteFile(pipe, value[offset:], &written, nil); err != nil {
			t.Fatalf("write local test pipe: %v", err)
		}
		if written == 0 {
			t.Fatal("local test pipe made no write progress")
		}
		offset += int(written)
	}
}

func readTestPipeBytes(t *testing.T, pipe windows.Handle, value []byte) {
	t.Helper()
	for offset := 0; offset < len(value); {
		var read uint32
		if err := windows.ReadFile(pipe, value[offset:], &read, nil); err != nil {
			t.Fatalf("read local test pipe after %d of %d bytes: %v", offset, len(value), err)
		}
		if read == 0 {
			t.Fatalf("local test pipe closed after %d of %d bytes", offset, len(value))
		}
		offset += int(read)
	}
}

func TestBrokerIPCHandlersRemainDisabledWithoutProtectedPolicy(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := &brokerIPCServer{store: store}
	request := validProposal()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response := server.handleRequest(encoded, true)
	if response.Code != "HEALTH_PIPE_READ_ONLY" || response.ExecutionEnabled {
		t.Fatalf("health pipe exposed a write path: %+v", response)
	}
	response = server.handleRequest(encoded, false)
	if response.Status != statusDenied || response.Code != "BROKER_TARGET_NOT_CONFIGURED" || response.RequestID != request.RequestID {
		t.Fatalf("unconfigured Broker did not fail closed: %+v", response)
	}
	statusRequest, _ := json.Marshal(brokerRequest{Version: protocolVersion, Type: "status", RequestID: request.RequestID})
	response = server.handleRequest(statusRequest, false)
	if response.Status != statusDenied || response.Code != "BROKER_TARGET_NOT_CONFIGURED" {
		t.Fatalf("status query did not project the durable denial: %+v", response)
	}
	healthRequest, _ := json.Marshal(brokerRequest{Version: protocolVersion, Type: "health"})
	response = server.handleRequest(healthRequest, true)
	if response.Type != "health" || response.Code != "BROKER_DISABLED" || response.InstallationID != store.Snapshot().InstallationID || response.ExecutionEnabled {
		t.Fatalf("unexpected disabled Broker health response: %+v", response)
	}
}

func TestAdminOperationsRequireTheDedicatedHandlerAndReturnSignedEnrollment(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	server := &brokerIPCServer{store: store}
	private, publicKey, deviceID := makeApprovalKey(t)
	begin := brokerRequest{Version: protocolVersion, Type: "enrollment.begin", OwnerID: "owner-local-1", DeviceID: deviceID, PublicKey: publicKey}
	encoded, err := json.Marshal(begin)
	if err != nil {
		t.Fatal(err)
	}
	denied := server.handleRequest(encoded, false)
	if denied.Type != "error" || denied.Code != "REQUEST_PIPE_OPERATION_REFUSED" || len(store.Snapshot().Enrollments) != 0 {
		t.Fatalf("request pipe accepted a privileged enrollment operation: %+v", denied)
	}
	response := server.handleAdminRequest(encoded)
	if response.Type != "enrollment_challenge" || response.EnrollmentChallenge == nil || response.BrokerPublicKey != store.BrokerPublicKey() || response.BrokerSignature == "" {
		t.Fatalf("admin pipe did not return an authenticated enrollment challenge: %+v", response)
	}
	challengeBytes, err := brokerEnrollmentSignatureBytes(*response.EnrollmentChallenge)
	if err != nil || verifyBrokerSignature(response.BrokerPublicKey, response.BrokerSignature, challengeBytes) != nil {
		t.Fatalf("admin enrollment challenge did not verify: %v", err)
	}
	pendingRequest := mustJSON(t, brokerRequest{Version: protocolVersion, Type: "enrollment.pending", DeviceID: deviceID})
	pending := server.handleRequest(pendingRequest, false)
	if pending.Type != "enrollment_challenge" || pending.EnrollmentChallenge == nil ||
		pending.EnrollmentChallenge.EnrollmentID != response.EnrollmentChallenge.EnrollmentID ||
		pending.BrokerPublicKey != response.BrokerPublicKey {
		t.Fatalf("Owner request pipe did not relay the exact signed challenge to its bound device: %+v", pending)
	}
	pendingChallengeBytes, err := brokerEnrollmentSignatureBytes(*pending.EnrollmentChallenge)
	if err != nil || verifyBrokerSignature(pending.BrokerPublicKey, pending.BrokerSignature, pendingChallengeBytes) != nil {
		t.Fatalf("Owner request pipe returned an unverifiable enrollment challenge: %v", err)
	}
	deviceBytes, err := enrollmentSigningBytes(*response.EnrollmentChallenge)
	if err != nil {
		t.Fatal(err)
	}
	complete := brokerRequest{Version: protocolVersion, Type: "enrollment.complete", EnrollmentID: response.EnrollmentChallenge.EnrollmentID,
		VerificationCode: response.EnrollmentChallenge.VerificationCode, Signature: signApprovalMessage(t, private, deviceBytes)}
	encoded, err = json.Marshal(complete)
	if err != nil {
		t.Fatal(err)
	}
	completed := server.handleRequest(encoded, false)
	if completed.Type != "result" || completed.Code != "DEVICE_ENROLLED" || completed.DeviceID != deviceID || len(store.Snapshot().Devices) != 1 {
		t.Fatalf("the signed device could not complete its administrator-started enrollment: %+v", completed)
	}
}

type fakeBrokerTargetController struct {
	fingerprint string
	restarts    int
	restartErr  error
}

func (f *fakeBrokerTargetController) Fingerprint() (string, error) { return f.fingerprint, nil }

func (f *fakeBrokerTargetController) Restart(expected string) (brokerOperationResult, error) {
	if expected != f.fingerprint {
		return brokerOperationResult{}, errTargetChanged
	}
	f.restarts++
	if f.restartErr != nil {
		return brokerOperationResult{}, f.restartErr
	}
	return brokerOperationResult{Operation: "service.restart", TargetID: firstBrokerTargetID, Detail: "test restart"}, nil
}

func TestBrokerChallengeApprovalRevalidatesTargetAndRunsOnce(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	target := &fakeBrokerTargetController{fingerprint: strings.Repeat("a", 64)}
	server := &brokerIPCServer{store: store, target: target}
	configured := server.handleAdminRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "target.configure"}))
	if configured.Code != "TARGET_CONFIGURED" || store.Snapshot().TargetFingerprint != target.fingerprint {
		t.Fatalf("admin target configuration failed: %+v", configured)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	begin := brokerRequest{Version: protocolVersion, Type: "enrollment.begin", OwnerID: "owner-local-1", DeviceID: deviceID, PublicKey: publicKey}
	enrollmentResponse := server.handleAdminRequest(mustJSON(t, begin))
	if enrollmentResponse.EnrollmentChallenge == nil {
		t.Fatalf("enrollment challenge missing: %+v", enrollmentResponse)
	}
	enrollmentBytes, err := enrollmentSigningBytes(*enrollmentResponse.EnrollmentChallenge)
	if err != nil {
		t.Fatal(err)
	}
	complete := brokerRequest{Version: protocolVersion, Type: "enrollment.complete", EnrollmentID: enrollmentResponse.EnrollmentChallenge.EnrollmentID,
		VerificationCode: enrollmentResponse.EnrollmentChallenge.VerificationCode, Signature: signApprovalMessage(t, private, enrollmentBytes)}
	if response := server.handleAdminRequest(mustJSON(t, complete)); response.Code != "DEVICE_ENROLLED" {
		t.Fatalf("device enrollment failed: %+v", response)
	}
	proposal := validProposal()
	challengeResponse := server.handleRequest(mustJSON(t, proposal), false)
	if challengeResponse.Status != statusAwaitingDevice || challengeResponse.Challenge == nil || challengeResponse.BrokerSignature == "" {
		t.Fatalf("proposal did not receive an authenticated device challenge: %+v", challengeResponse)
	}
	challengeBytes, err := brokerSignatureBytes(*challengeResponse.Challenge)
	if err != nil || verifyBrokerSignature(challengeResponse.BrokerPublicKey, challengeResponse.BrokerSignature, challengeBytes) != nil {
		t.Fatalf("Broker challenge attestation did not verify: %v", err)
	}
	decisionBytes, err := approvalSigningBytes(*challengeResponse.Challenge, "approve")
	if err != nil {
		t.Fatal(err)
	}
	decision := brokerRequest{Version: protocolVersion, Type: "decision", RequestID: proposal.RequestID, DeviceID: deviceID,
		Choice: "approve", Signature: signApprovalMessage(t, private, decisionBytes)}
	result := server.handleRequest(mustJSON(t, decision), false)
	if result.Status != statusSucceeded || result.Code != "SERVICE_RESTARTED" || result.Result == nil || target.restarts != 1 {
		t.Fatalf("signed approval did not complete one target restart: result=%+v restarts=%d", result, target.restarts)
	}
	if replay := server.handleRequest(mustJSON(t, decision), false); replay.Code != "DECISION_CONSUMED" || target.restarts != 1 {
		t.Fatalf("decision replay caused a second restart: response=%+v restarts=%d", replay, target.restarts)
	}
	status := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: proposal.RequestID}), false)
	if status.Status != statusSucceeded || status.Result == nil || status.Result.TargetID != firstBrokerTargetID {
		t.Fatalf("status did not project durable restart result: %+v", status)
	}
}

func TestBrokerApprovalFailsClosedWhenTargetChanges(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	target := &fakeBrokerTargetController{fingerprint: strings.Repeat("a", 64)}
	server := &brokerIPCServer{store: store, target: target}
	if response := server.handleAdminRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "target.configure"})); response.Code != "TARGET_CONFIGURED" {
		t.Fatalf("target configuration failed: %+v", response)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment, err := store.BeginEnrollment("owner-local-1", deviceID, publicKey, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	enrollmentBytes, err := enrollmentSigningBytes(enrollment)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CompleteEnrollment(enrollment.EnrollmentID, enrollment.VerificationCode, signApprovalMessage(t, private, enrollmentBytes), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	proposal := validProposal()
	challenge := server.handleRequest(mustJSON(t, proposal), false).Challenge
	if challenge == nil {
		t.Fatal("target change test received no approval challenge")
	}
	decisionBytes, err := approvalSigningBytes(*challenge, "approve")
	if err != nil {
		t.Fatal(err)
	}
	target.fingerprint = strings.Repeat("b", 64)
	decision := brokerRequest{Version: protocolVersion, Type: "decision", RequestID: proposal.RequestID, DeviceID: deviceID,
		Choice: "approve", Signature: signApprovalMessage(t, private, decisionBytes)}
	result := server.handleRequest(mustJSON(t, decision), false)
	if result.Status != statusFailed || result.Code != "BROKER_TARGET_CHANGED" || target.restarts != 0 {
		t.Fatalf("target replacement was not denied before execution: %+v restarts=%d", result, target.restarts)
	}
}

func TestBrokerPersistsUnknownTargetRestartOutcomeAndRejectsReplay(t *testing.T) {
	store, err := openBrokerStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	target := &fakeBrokerTargetController{fingerprint: strings.Repeat("c", 64), restartErr: errTargetOutcomeUnknown}
	server := &brokerIPCServer{store: store, target: target}
	if response := server.handleAdminRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "target.configure"})); response.Code != "TARGET_CONFIGURED" {
		t.Fatalf("target configuration failed: %+v", response)
	}
	private, publicKey, deviceID := makeApprovalKey(t)
	enrollment := server.handleAdminRequest(mustJSON(t, brokerRequest{
		Version: protocolVersion, Type: "enrollment.begin", OwnerID: "owner-local-1", DeviceID: deviceID, PublicKey: publicKey,
	}))
	if enrollment.EnrollmentChallenge == nil {
		t.Fatalf("enrollment challenge missing: %+v", enrollment)
	}
	enrollmentMessage, err := enrollmentSigningBytes(*enrollment.EnrollmentChallenge)
	if err != nil {
		t.Fatal(err)
	}
	if response := server.handleAdminRequest(mustJSON(t, brokerRequest{
		Version: protocolVersion, Type: "enrollment.complete", EnrollmentID: enrollment.EnrollmentChallenge.EnrollmentID,
		VerificationCode: enrollment.EnrollmentChallenge.VerificationCode,
		Signature:        signApprovalMessage(t, private, enrollmentMessage),
	})); response.Code != "DEVICE_ENROLLED" {
		t.Fatalf("device enrollment failed: %+v", response)
	}
	proposal := validProposal()
	challenge := server.handleRequest(mustJSON(t, proposal), false).Challenge
	if challenge == nil {
		t.Fatal("proposal did not receive an approval challenge")
	}
	decisionMessage, err := approvalSigningBytes(*challenge, "approve")
	if err != nil {
		t.Fatal(err)
	}
	decision := brokerRequest{
		Version: protocolVersion, Type: "decision", RequestID: proposal.RequestID,
		DeviceID: deviceID, Choice: "approve", Signature: signApprovalMessage(t, private, decisionMessage),
	}
	result := server.handleRequest(mustJSON(t, decision), false)
	if result.Status != statusUnknown || result.Code != "SERVICE_RESTART_OUTCOME_UNKNOWN" || target.restarts != 1 {
		t.Fatalf("ambiguous SCM side effect was not persisted as unknown: response=%+v restarts=%d", result, target.restarts)
	}
	if replay := server.handleRequest(mustJSON(t, decision), false); replay.Code != "DECISION_CONSUMED" || target.restarts != 1 {
		t.Fatalf("unknown execution was retried after approval replay: response=%+v restarts=%d", replay, target.restarts)
	}
	status := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "status", RequestID: proposal.RequestID}), false)
	if status.Status != statusUnknown || status.Code != "SERVICE_RESTART_OUTCOME_UNKNOWN" {
		t.Fatalf("unknown execution status was not durable: %+v", status)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestBrokerIPCRequestRateLimitIsBoundedAndRecovers(t *testing.T) {
	server := &brokerIPCServer{}
	start := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	for index := 0; index < maxRequestsPerMinute; index++ {
		if !server.allowRequest(start.Add(time.Duration(index) * time.Millisecond)) {
			t.Fatalf("request %d was unexpectedly rate-limited", index+1)
		}
	}
	if server.allowRequest(start.Add(time.Second)) {
		t.Fatal("request above the per-minute limit was accepted")
	}
	if !server.allowRequest(start.Add(time.Minute)) {
		t.Fatal("rate limit did not recover after one minute")
	}
}
