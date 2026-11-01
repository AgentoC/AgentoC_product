package com.andysagent.agentoc

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.agentoc.core.auth.AndroidCredentialStore
import com.andysagent.agentoc.core.auth.AndroidDeviceIdentityStore
import com.andysagent.agentoc.core.auth.PairingAuthenticator
import com.andysagent.agentoc.core.datastore.ClientConfigStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device E2E: run the real PairingAuthenticator against a real host reachable
 * from the emulator (10.0.2.2). Exercises AndroidKeyStore P-256 generation +
 * v3 redeem + challenge/verify + credential/config persistence end to end.
 *
 * Usage:
 *   adb shell am instrument -w -e pairingUri "agentoc://pair?... " \
 *     com.andysagent.agentoc.test/androidx.test.runner.AndroidJUnitRunner
 *   -e class com.andysagent.agentoc.PairingE2ETest
 */
@RunWith(AndroidJUnit4::class)
class PairingE2ETest {

    @Test
    fun realHostPairingRedeemsDevice() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val uri = InstrumentationRegistry.getArguments().getString("pairingUri")
        assumeTrue("Pairing E2E requires -e pairingUri <agentoc://pair...>", !uri.isNullOrBlank())
        val pairingUri = uri ?: return@runBlocking

        val identity = AndroidDeviceIdentityStore(context)
        val creds = AndroidCredentialStore(context)
        creds.clear()
        val config = ClientConfigStore(context)

        val pairing = PairingAuthenticator(identity, creds, config)
        val result = pairing.redeem(pairingUri, "E2E Device")

        assertTrue("endpoint should be saved", config.instance.first()?.endpoint?.isNotBlank() == true)
        assertTrue("credential should be stored", creds.read(result.instanceId) != null)

        // Result proves the full flow: device enrolled with an authVersion-3 key.
        println("PAIRING_E2E_OK instance=${result.instanceId} device=${result.deviceId} " +
            "credentialType=${result.credentialType} endpoint=${result.endpoint} " +
            "scope=${result.credentialScope}")
    }
}
