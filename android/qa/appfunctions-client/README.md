# Independent AppFunctions caller-admission probe

```text
Read android/docs/app-api-appfunctions.md and the implementation ledger. Build this
standalone QA project using the parent Android wrapper and the configured SDK.
Install the tested Ragent APK and this APK on an explicitly selected owned API 36+
device, verify their installed hashes and launch ProbeActivity. Capture its actual
UI tree and platform logs. Require different caller/target UIDs, bind=DENIED and
execute=DENIED. Do not change platform permissions or temporary-caller allowlists.
Report unavailable platforms and unexpected error codes separately from a pass.
```

This application uses package `com.agentoncloud.appfunctions.qa` and its own Android
UID. It has no Ragent SDK dependency and no Owner policy access. Its Activity
attempts direct binding to the permission-protected generated service and a native
AppFunctionManager call to the read-only `listComputers` function. The output shows
the actual caller/target UIDs and both outcomes. It never submits a PC task.

The Manifest requests EXECUTE_APP_FUNCTIONS, but installation alone does not grant
that platform permission. A pending result, NOT_BOUND, ERROR code or an unexpected
success cannot substitute for DENIED. Self-calls in Ragent instrumentation are a
different evidence gate and cannot prove foreign caller admission.

Use the parent's Gradle wrapper with project directory `qa/appfunctions-client`.
This nested project imports the root version catalog, uses built-in Kotlin and
compiles against SDK 37 with min/target 36. Configure the existing SDK through
ANDROID_HOME/ANDROID_SDK_ROOT or untracked local.properties. It is QA infrastructure,
not a production application or a certified Gemini caller. Preserve original logs
and report the exact source, APK hashes, system image and device serial.
