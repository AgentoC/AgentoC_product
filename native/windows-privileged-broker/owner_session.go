package main

import (
	"errors"
	"strings"
)

// ownerSessionCandidate must come from a fresh OS session enumeration and a
// token observation, never from the installation request or the agent.
type ownerSessionCandidate struct {
	ID     uint32
	SID    string
	Active bool
	Usable bool
}

var errOwnerSessionUnavailable = errors.New("owner session unavailable or ambiguous")

// Select only a uniquely identified logged-on owner. Multiple concurrent
// sessions are not interchangeable: each has its own profile, environment,
// processes and lifecycle. Recheck the selected token immediately before use.
func selectOwnerSession(ownerSID string, sessions []ownerSessionCandidate) (uint32, error) {
	if ownerSID == "" || strings.TrimSpace(ownerSID) != ownerSID {
		return 0, errOwnerSessionUnavailable
	}
	var selected uint32
	for _, session := range sessions {
		if session.ID == 0 || !session.Usable || !strings.EqualFold(session.SID, ownerSID) {
			continue
		}
		if selected != 0 {
			return 0, errOwnerSessionUnavailable
		}
		selected = session.ID
	}
	if selected == 0 {
		return 0, errOwnerSessionUnavailable
	}
	return selected, nil
}
