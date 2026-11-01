# Android source overview

The Android project is organized into `app`, reusable `core` modules, feature
modules, and integrations. `core/protocol` and `core/auth` contain protocol and
authentication contracts and unit tests; `feature/workbench` contains workbench
features and presentation. The project root README explains the contributor
debug build and its Google-service limitations.

Internal implementation plans and device-test records are not included in this
source export. Public release notes must state which flows were actually tested.
