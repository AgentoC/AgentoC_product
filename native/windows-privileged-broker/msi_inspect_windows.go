//go:build windows

package main

func inspectWindowsMSI(request msiInspectRequest) (*msiInspectFacts, error) {
	pins, err := pinWindowsMSIArtifact(request.ArtifactPath, request.ArtifactSHA256)
	if err != nil {
		return nil, err
	}
	defer pins.Close()
	if err := verifyPinnedMSIEmbeddedMedia(pins); err != nil {
		return nil, err
	}
	publisher, err := inspectPinnedMSIPublisher(pins)
	if err != nil {
		return nil, err
	}
	return &msiInspectFacts{ArtifactPath: request.ArtifactPath, ArtifactSHA256: request.ArtifactSHA256, PublisherSHA256: publisher}, nil
}
