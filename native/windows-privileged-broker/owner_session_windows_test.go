//go:build windows

package main

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerTokenRealCurrentProcess(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	if _, err := tokenAuthenticationID(token); err != nil {
		t.Fatalf("cannot read actual token logon identifier: %v", err)
	}
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	session, err := tokenUint32(token, windows.TokenSessionId)
	if err != nil {
		t.Fatal(err)
	}
	if session == 0 {
		t.Skip("interactive user session required")
	}
	if err := verifyOwnerSessionToken(token, "S-1-5-18", session); err == nil {
		t.Fatal("accepted a mismatched owner SID")
	}
	if err := verifyOwnerSessionToken(token, user.User.Sid.String(), session+1); err == nil {
		t.Fatal("accepted a mismatched session")
	}
	if token.IsElevated() {
		if err := verifyOwnerSessionToken(token, user.User.Sid.String(), session); err == nil {
			t.Fatal("accepted an elevated user token")
		}
		return
	}
	if err := verifyOwnerSessionToken(token, user.User.Sid.String(), session); err != nil {
		t.Fatalf("ordinary interactive token was rejected: %v", err)
	}
}

func TestAcquireOwnerSessionToken(t *testing.T) {
	for _, test := range []struct {
		name                                    string
		changed, rejected, newLogon, queryFails bool
		want                                    bool
	}{
		{name: "matching session and logon", want: true},
		{name: "session changed", changed: true},
		{name: "token rejected", rejected: true},
		{name: "session id reused for another logon", newLogon: true},
		{name: "token query fails", queryFails: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var discoveries, queries int
			var closed []windows.Token
			source := ownerTokenSource{
				discover: func(string) (uint32, error) {
					discoveries++
					if test.changed && discoveries > 1 {
						return 4, nil
					}
					return 3, nil
				},
				query: func(uint32) (windows.Token, error) {
					queries++
					if test.queryFails {
						return 0, errors.New("query")
					}
					return windows.Token(queries), nil
				},
				verify: func(windows.Token, string, uint32) error {
					if test.rejected {
						return errors.New("mismatch")
					}
					return nil
				},
				sameLogon: func(windows.Token, windows.Token) bool { return !test.newLogon },
				close:     func(token windows.Token) error { closed = append(closed, token); return nil },
			}
			token, session, err := acquireOwnerSessionToken("S-1-5-21-1-2-3-1001", source)
			if (err == nil) != test.want {
				t.Fatalf("unexpected error: %v", err)
			}
			if test.want {
				if token != 1 || session != 3 || len(closed) != 1 || closed[0] != 2 {
					t.Fatalf("invalid token ownership: %d %d %v", token, session, closed)
				}
			} else if token != 0 || session != 0 || len(closed) != queries && !test.queryFails {
				t.Fatalf("failed acquisition leaked a token: %d %d %v", token, session, closed)
			}
		})
	}
}
