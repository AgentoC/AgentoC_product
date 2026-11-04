package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type testServiceTarget struct {
	hashes                []string
	starts, stops, closes int
	stopErr               error
}

func (s *testServiceTarget) Fingerprint() (string, error) {
	h := s.hashes[0]
	if len(s.hashes) > 1 {
		s.hashes = s.hashes[1:]
	}
	return h, nil
}
func (s *testServiceTarget) Start(context.Context) error { s.starts++; return nil }
func (s *testServiceTarget) Stop(context.Context) error  { s.stops++; return s.stopErr }
func (s *testServiceTarget) Close() error                { s.closes++; return nil }

func TestServiceControlBindsOneTargetAndDoesNotRetryPartialRestart(t *testing.T) {
	hash := strings.Repeat("a", 64)
	for _, tc := range []struct {
		action        string
		hashes        []string
		stopErr       error
		status        requestStatus
		starts, stops int
	}{
		{"start-service", []string{hash}, nil, statusSucceeded, 1, 0},
		{"stop-service", []string{hash}, nil, statusSucceeded, 0, 1},
		{"restart-service", []string{hash, hash}, nil, statusSucceeded, 1, 1},
		{"restart-service", []string{hash, strings.Repeat("b", 64)}, nil, statusUnknown, 0, 1},
		{"restart-service", []string{hash}, errors.New("uncertain"), statusUnknown, 0, 1},
		{"start-service", []string{strings.Repeat("b", 64)}, nil, statusFailed, 0, 0},
	} {
		target := &testServiceTarget{hashes: tc.hashes, stopErr: tc.stopErr}
		opens := 0
		result := runServiceControl(context.Background(), serviceControlRequest{Name: "Example Service", Action: tc.action, DefinitionHash: hash}, func(name string) (serviceControlTarget, error) {
			opens++
			if name != "Example Service" {
				t.Fatal("wrong service")
			}
			return target, nil
		})
		if result.Status != tc.status || target.starts != tc.starts || target.stops != tc.stops || target.closes != 1 || opens != 1 {
			t.Fatalf("%s: %+v target=%+v opens=%d", tc.action, result, target, opens)
		}
	}
}

func TestServiceControlRejectsInvalidRequestsBeforeOpening(t *testing.T) {
	hash := strings.Repeat("a", 64)
	for _, request := range []serviceControlRequest{{Name: "", Action: "start-service", DefinitionHash: hash}, {Name: "bad*", Action: "start-service", DefinitionHash: hash}, {Name: "valid", Action: "delete", DefinitionHash: hash}, {Name: "valid", Action: "stop-service", DefinitionHash: "short"}} {
		result := runServiceControl(context.Background(), request, func(string) (serviceControlTarget, error) { t.Fatal("opened invalid request"); return nil, nil })
		if result.Code != "SERVICE_REQUEST_INVALID" {
			t.Fatalf("unexpected result: %+v", result)
		}
	}
}
