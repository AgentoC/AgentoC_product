package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"
)

type msiInstallRecord struct {
	Grant     msiInstallGrant `json:"grant"`
	Digest    string          `json:"digest"`
	Status    requestStatus   `json:"status"`
	Code      string          `json:"code"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// MSI claims live in the existing hash-chained audit log so a broker predating
// MSI support can still read its state after a downgrade. The nonce and claim
// are written together in a single atomic state transaction.
func msiInstallRecords(state *persistedBrokerState) (map[string]msiInstallRecord, error) {
	records := make(map[string]msiInstallRecord)
	nonces := make(map[string]string)
	noncesByDigest := make(map[string]string)
	ids := make(map[string]bool)
	for _, entry := range state.Audit {
		if !strings.HasPrefix(entry.Event, "msi_install.") {
			continue
		}
		if !isSHA256Hex(entry.Digest) || !validRequestID(entry.RequestID) {
			return nil, errStateInvalid
		}
		switch entry.Event {
		case "msi_install.nonce":
			if !autoInstallNoncePattern.MatchString(entry.RequestID) || nonces[entry.RequestID] != "" {
				return nil, errStateInvalid
			}
			if noncesByDigest[entry.Digest] != "" {
				return nil, errStateInvalid
			}
			nonces[entry.RequestID] = entry.Digest
			noncesByDigest[entry.Digest] = entry.RequestID
		case "msi_install.executing":
			if ids[entry.RequestID] || records[entry.Digest].Digest != "" {
				return nil, errStateInvalid
			}
			nonce := noncesByDigest[entry.Digest]
			if nonce == "" {
				return nil, errStateInvalid
			}
			ids[entry.RequestID] = true
			records[entry.Digest] = msiInstallRecord{Grant: msiInstallGrant{Nonce: nonce, RequestID: entry.RequestID}, Digest: entry.Digest, Status: statusExecuting, Code: entry.Code, CreatedAt: entry.Timestamp, UpdatedAt: entry.Timestamp}
		case "msi_install.succeeded", "msi_install.failed", "msi_install.unknown":
			record, ok := records[entry.Digest]
			if !ok || record.Grant.RequestID != entry.RequestID || record.Status != statusExecuting {
				return nil, errStateInvalid
			}
			record.Status = requestStatus(strings.TrimPrefix(entry.Event, "msi_install."))
			record.Code, record.UpdatedAt = entry.Code, entry.Timestamp
			records[entry.Digest] = record
		default:
			return nil, errStateInvalid
		}
	}
	if len(nonces) != len(records) {
		return nil, errStateInvalid
	}
	return records, nil
}

func msiRequestIDExists(state *persistedBrokerState, id string) bool {
	for _, entry := range state.Audit {
		if entry.Event == "msi_install.executing" && entry.RequestID == id {
			return true
		}
	}
	return false
}

func markInterruptedMSIInstalls(state *persistedBrokerState, code string) (bool, error) {
	records, err := msiInstallRecords(state)
	if err != nil {
		return false, err
	}
	changed := false
	for _, record := range records {
		if record.Status == statusExecuting {
			if err := appendAuditState(state, "msi_install.unknown", record.Grant.RequestID, code, record.Digest); err != nil {
				return false, err
			}
			changed = true
		}
	}
	return changed, nil
}

func (s *brokerStore) ClaimMSIInstall(grant msiInstallGrant, signature string, now time.Time) (msiInstallRecord, bool, error) {
	message, err := msiInstallSigningBytes(grant)
	if err != nil {
		return msiInstallRecord{}, false, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(message))
	var result msiInstallRecord
	duplicate := false
	err = s.transact(func(state *persistedBrokerState) error {
		if grant.BrokerInstallationID != state.InstallationID || grant.PolicyGeneration != state.PolicyGeneration || state.AutoInstallSigner == nil || state.AutoInstallSigner.KeyID != grant.KeyID {
			return errMSIInstallGrant
		}
		key, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey)
		if err != nil || verifyMSIInstallGrant(grant, signature, key, now) != nil {
			return errMSIInstallGrant
		}
		records, err := msiInstallRecords(state)
		if err != nil {
			return err
		}
		for _, old := range records {
			if old.Grant.Nonce == grant.Nonce {
				if old.Digest != digest {
					return errRequestConflict
				}
				old.Grant = grant
				result, duplicate = old, true
				return nil
			}
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.AutoInstalls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.OwnerInstalls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.ServiceControls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		if _, ok := state.Requests[grant.RequestID]; ok {
			return errRequestConflict
		}
		if len(records) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = msiInstallRecord{Grant: grant, Digest: digest, Status: statusExecuting, Code: "EXECUTION_STARTED", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		if err := s.appendAudit(state, "msi_install.nonce", grant.Nonce, "MSI_NONCE_CLAIMED", digest); err != nil {
			return err
		}
		return s.appendAudit(state, "msi_install.executing", grant.RequestID, result.Code, digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) FinishMSIInstall(nonce string, status requestStatus, code string, now time.Time) (msiInstallRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return msiInstallRecord{}, errStateInvalid
	}
	var result msiInstallRecord
	err := s.transact(func(state *persistedBrokerState) error {
		records, err := msiInstallRecords(state)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.Grant.Nonce == nonce {
				if record.Status != statusExecuting || !validAuditCode(code) {
					return errStateInvalid
				}
				record.Status, record.Code, record.UpdatedAt = status, code, now.UTC()
				result = record
				return s.appendAudit(state, "msi_install."+string(status), record.Grant.RequestID, code, record.Digest)
			}
		}
		return errStateInvalid
	})
	return result, err
}

func (s *brokerStore) GetMSIInstall(requestID string) (msiInstallRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, err := msiInstallRecords(&s.state)
	if err != nil {
		return msiInstallRecord{}, false
	}
	for _, record := range records {
		if record.Grant.RequestID == requestID {
			return record, true
		}
	}
	return msiInstallRecord{}, false
}
