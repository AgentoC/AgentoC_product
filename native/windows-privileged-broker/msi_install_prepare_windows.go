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
	pins           *msiArtifactPins
	executablePins *serviceImagePins
	executable     string
	arguments      []string
}

func (p *preparedMSIInstall) Close() {
	if p != nil && p.executablePins != nil {
		p.executablePins.Close()
		p.executablePins = nil
	}
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
	executable := filepath.Join(systemDir, "msiexec.exe")
	executablePins, _, err := pinWindowsServiceImage(executable)
	if err != nil {
		return nil, errors.New("Windows Installer executable unavailable")
	}
	if verifyPinnedSystemCatalog(executablePins, executable) != nil {
		executablePins.Close()
		return nil, errors.New("Windows Installer executable is not protected")
	}
	prepared := &preparedMSIInstall{pins: pins, executablePins: executablePins, executable: executable, arguments: []string{"/i", pins.path, "/qn", "/norestart"}}
	failed = false
	return prepared, nil
}
