//go:build windows

package main

import (
	"errors"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// A prepared install retains its file pins until Close. Preparation does not
// authorize execution; callers must claim a verified grant before starting it.
type preparedMSIInstall struct {
	pins       *msiArtifactPins
	executable string
	arguments  []string
}

func (p *preparedMSIInstall) Close() {
	if p != nil && p.pins != nil {
		p.pins.Close()
		p.pins = nil
	}
}

func prepareWindowsMSIInstall(grant msiInstallGrant) (*preparedMSIInstall, error) {
	if !validMSIArtifactPath(grant.ArtifactPath) || !msiDigestPattern.MatchString(grant.ArtifactSHA256) || !msiDigestPattern.MatchString(grant.PublisherSHA256) {
		return nil, errors.New("MSI install binding invalid")
	}
	pins, err := pinWindowsMSIArtifact(grant.ArtifactPath, grant.ArtifactSHA256)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			pins.Close()
		}
	}()
	if err := verifyPinnedMSIPublisher(pins, grant.PublisherSHA256); err != nil {
		return nil, err
	}
	if err := verifyPinnedMSIEmbeddedMedia(pins); err != nil {
		return nil, err
	}
	systemDir, err := windows.GetSystemDirectory()
	if err != nil || !filepath.IsAbs(systemDir) || len(filepath.VolumeName(systemDir)) != 2 {
		return nil, errors.New("Windows system directory unavailable")
	}
	prepared := &preparedMSIInstall{pins: pins, executable: filepath.Join(systemDir, "msiexec.exe"), arguments: []string{"/i", pins.path, "/qn", "/norestart"}}
	failed = false
	return prepared, nil
}
