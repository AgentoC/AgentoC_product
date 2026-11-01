//go:build windows

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

const adminPipeClientTimeout = 10 * time.Second

// runBrokerAdminCLI is the one-time local administrator entry for operations
// that must never be delegated through the ordinary ControlPlane pipe.
func runBrokerAdminCLI(args []string) error {
	if len(args) == 0 || args[0] != "admin" {
		return errors.New("APB_ADMIN_COMMAND_REQUIRED")
	}
	ownerReset := len(args) == 2 && args[1] == "owner-reset"
	if ownerReset {
		if err := requireAdministratorOrSystemForOwnerReset(); err != nil {
			return err
		}
	} else if err := requireElevatedAdministrator(); err != nil {
		return err
	}

	var request brokerRequest
	switch {
	case len(args) == 2 && args[1] == "target-configure":
		request = brokerRequest{Version: protocolVersion, Type: "target.configure"}
	case len(args) == 3 && args[1] == "device-revoke":
		deviceID := args[2]
		if len(deviceID) != 64 || !isLowerHex(deviceID) {
			return errors.New("APB_ADMIN_DEVICE_ID_INVALID")
		}
		request = brokerRequest{Version: protocolVersion, Type: "device.revoke", DeviceID: deviceID}
	case ownerReset:
		request = brokerRequest{Version: protocolVersion, Type: "owner.reset"}
	case len(args) >= 2 && args[1] == "enrollment-begin":
		flags := flag.NewFlagSet("enrollment-begin", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		publicKey := flags.String("public-key", "", "existing Android P-256 device public key (base64 DER)")
		ownerID := flags.String("owner-id", "", "stable local Owner identifier; defaults to this elevated user's SID")
		if err := flags.Parse(args[2:]); err != nil || flags.NArg() != 0 || *publicKey == "" {
			return errors.New("APB_ADMIN_ENROLLMENT_ARGUMENTS_INVALID")
		}
		deviceID, err := deviceIDForPublicKey(*publicKey)
		if err != nil {
			return errors.New("APB_ADMIN_DEVICE_PUBLIC_KEY_INVALID")
		}
		selectedOwnerID := *ownerID
		if selectedOwnerID == "" {
			identity, err := windows.GetCurrentProcessToken().GetTokenUser()
			if err != nil {
				return errors.New("APB_ADMIN_OWNER_ID_UNAVAILABLE")
			}
			selectedOwnerID = identity.User.Sid.String()
		}
		if !validOwnerID(selectedOwnerID) {
			return errors.New("APB_ADMIN_OWNER_ID_INVALID")
		}
		request = brokerRequest{
			Version: protocolVersion, Type: "enrollment.begin", OwnerID: selectedOwnerID,
			DeviceID: deviceID, PublicKey: *publicKey,
		}
	default:
		return errors.New("APB_ADMIN_COMMAND_INVALID")
	}

	response, err := exchangeBrokerAdminRequest(request)
	if err != nil {
		return err
	}
	if response.Type == "error" {
		if response.Code == "" || strings.ContainsAny(response.Code, "\r\n") {
			return errors.New("APB_ADMIN_BROKER_REFUSED")
		}
		return errors.New("APB_ADMIN_BROKER_" + response.Code)
	}
	if request.Type == "enrollment.begin" {
		if response.Type != "enrollment_challenge" || response.EnrollmentChallenge == nil {
			return errors.New("APB_ADMIN_ENROLLMENT_RESPONSE_INVALID")
		}
		fingerprint, err := brokerPublicKeyFingerprint(response.BrokerPublicKey)
		if err != nil || response.BrokerSignature == "" {
			return errors.New("APB_ADMIN_BROKER_IDENTITY_INVALID")
		}
		fmt.Fprintf(os.Stdout,
			"EnrollmentId=%s\nDeviceId=%s\nOwnerId=%s\nBrokerFingerprint=%s\nVerificationCode=%s\nExpiresAt=%s\n",
			response.EnrollmentChallenge.EnrollmentID,
			response.EnrollmentChallenge.DeviceID,
			response.EnrollmentChallenge.OwnerID,
			fingerprint,
			response.EnrollmentChallenge.VerificationCode,
			response.EnrollmentChallenge.ExpiresAt.Format(time.RFC3339),
		)
		return nil
	}
	if response.Type != "result" || response.Code == "" {
		return errors.New("APB_ADMIN_RESPONSE_INVALID")
	}
	fmt.Fprintf(os.Stdout, "Result=%s\nPolicyGeneration=%d\n", response.Code, response.PolicyGeneration)
	return nil
}

func requireElevatedAdministrator() error {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil || user.User.Sid.String() == "S-1-5-18" || !token.IsElevated() {
		return errors.New("APB_ADMIN_ELEVATION_REQUIRED")
	}
	administrators, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return errors.New("APB_ADMIN_MEMBERSHIP_UNAVAILABLE")
	}
	member, err := token.IsMember(administrators)
	if err != nil || !member {
		return errors.New("APB_ADMIN_ELEVATION_REQUIRED")
	}
	return nil
}

func requireAdministratorOrSystemForOwnerReset() error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err == nil && user.User.Sid.String() == "S-1-5-18" {
		return nil
	}
	return requireElevatedAdministrator()
}

func exchangeBrokerAdminRequest(request brokerRequest) (brokerResponse, error) {
	if err := validateRequest(request); err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_REQUEST_INVALID")
	}
	payload, err := json.Marshal(request)
	if err != nil || len(payload) == 0 || len(payload) > maxIPCFrame {
		return brokerResponse{}, errors.New("APB_ADMIN_REQUEST_INVALID")
	}
	pipeName, err := windows.UTF16PtrFromString(adminPipeName)
	if err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_PIPE_NAME_INVALID")
	}
	deadline := time.Now().Add(adminPipeClientTimeout)
	var pipe windows.Handle
	for {
		pipe, err = windows.CreateFile(pipeName, pipeClientAccessMask, 0, nil, windows.OPEN_EXISTING,
			windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IMPERSONATION, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return brokerResponse{}, errors.New("APB_ADMIN_PIPE_UNAVAILABLE")
		}
		if time.Now().After(deadline) {
			return brokerResponse{}, errors.New("APB_ADMIN_PIPE_TIMEOUT")
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer windows.CloseHandle(pipe)
	if err := verifyBrokerAdminPipeServer(pipe); err != nil {
		return brokerResponse{}, err
	}

	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if err := writeAdminPipeBytes(pipe, header[:]); err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_PIPE_WRITE_FAILED")
	}
	if err := writeAdminPipeBytes(pipe, payload); err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_PIPE_WRITE_FAILED")
	}
	if err := readAdminPipeBytes(pipe, header[:]); err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_PIPE_READ_FAILED")
	}
	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 || length > maxIPCFrame {
		return brokerResponse{}, errors.New("APB_ADMIN_RESPONSE_INVALID")
	}
	responsePayload := make([]byte, int(length))
	if err := readAdminPipeBytes(pipe, responsePayload); err != nil {
		return brokerResponse{}, errors.New("APB_ADMIN_PIPE_READ_FAILED")
	}
	var response brokerResponse
	if err := json.Unmarshal(responsePayload, &response); err != nil || response.Version != protocolVersion {
		return brokerResponse{}, errors.New("APB_ADMIN_RESPONSE_INVALID")
	}
	return response, nil
}

func verifyBrokerAdminPipeServer(pipe windows.Handle) error {
	var processID uint32
	if err := windows.GetNamedPipeServerProcessId(pipe, &processID); err != nil || processID == 0 {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
	if err != nil {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user.User.Sid.String() != "S-1-5-18" {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	serviceSID, _, _, err := windows.LookupSID("", `NT SERVICE\`+serviceName)
	if err != nil {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	if err := tokenHasExpectedServiceSID(token, serviceSID); err != nil {
		return errors.New("APB_ADMIN_PIPE_SERVER_IDENTITY_REFUSED")
	}
	return nil
}

func writeAdminPipeBytes(pipe windows.Handle, payload []byte) error {
	for offset := 0; offset < len(payload); {
		var written uint32
		if err := windows.WriteFile(pipe, payload[offset:], &written, nil); err != nil {
			return err
		}
		if written == 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += int(written)
	}
	return nil
}

func readAdminPipeBytes(pipe windows.Handle, payload []byte) error {
	for offset := 0; offset < len(payload); {
		var read uint32
		if err := windows.ReadFile(pipe, payload[offset:], &read, nil); err != nil {
			return err
		}
		if read == 0 {
			return windows.ERROR_BROKEN_PIPE
		}
		offset += int(read)
	}
	return nil
}
