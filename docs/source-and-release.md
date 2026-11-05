# Source and release boundaries

This repository is prepared from the Ragent product source. The execution
host, Android client, web workbench, account service source, TURN credential
broker source, and selected tests are included in the public tree. Deployment
credentials, production data, private operational records, and historical design
archives are excluded.

The public risk benchmark contains the Ragent-maintained boundary fixture only.
External datasets used in private evaluation are not distributed here, so its
results are not comparable to the full private benchmark.

The public tree has contributor-build and test changes on top of its
private source baseline. Those changes must be reviewed and reconciled before
the candidate is treated as a release. The public Git commit recorded on a
release, not an unpublished development checkout, will identify the public
source snapshot.

Do not assume that a published source snapshot can reproduce a particular
binary until the release notes state the build inputs, included components,
signing status, and verification result. A release may require toolchains or
service configurations that are not bundled here. In particular, production
signing keys and hosted-service credentials are never included.

The current Windows packaging configuration includes Node.js v24.12.0 notices.
Packaging with a different Node version requires adding that version's complete
upstream license and bundled dependency notices before building the MSI.

The account and relay code is available for inspection, but an independently
deployed service and a full cross-device connection have not yet been validated
from the public source. Windows currently uses the project's hosted endpoints
outside the isolated test configuration.
