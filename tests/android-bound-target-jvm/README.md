# Bound target controller offline JVM fixture

This runs the real `BoundTargetConnection.kt`, the existing Android controller
test bodies, and the cached real supervisor, transport and lease classes. Only
the Android runner/Application/network monitor and WebRTC boundary are replaced.
The additional tests exercise successful fresh-plan publication, the actual
30 second proactive renewal interval, transient carrier retention, original
contract/candidate and credential expiry, denial, A/B session reuse and captured
reservation release. A synthetic plan represents the output of
the trusted verification callback; these tests do not verify signatures or prove
phone, network, TURN, Google or installed service behavior.

Reuse an existing `compileDebugKotlin` classpath manifest with `libraries` and
`compilerClasspath` arrays of absolute cached jar paths. Set `JAVA_HOME` to the
same JDK. The runner never downloads dependencies or invokes ADB or Gradle.
It needs cached JUnit 4.13.2 and Hamcrest 1.3, and writes only to a new output
directory. Missing dependencies fail the test setup.

```powershell
python tests/android-bound-target-jvm/run.py --classpath-manifest D:/qa/app-main-compile-classpath.json --output D:/qa/controller-run
```

Output preserves the exact compiled controller, transformed tests, boundary
stubs, compiler/test logs and source hashes frozen at staging. Each Java process
has a 180 second bound; a timeout records exit 124. Do not overwrite a prior run.
