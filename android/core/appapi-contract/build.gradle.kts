plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "com.agentoncloud.android.api"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    buildFeatures { aidl = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.kotlin.test.junit)
}
