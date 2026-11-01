plugins {
    alias(libs.plugins.android.library)

    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "com.agentoncloud.android.sdk"
    compileSdk = 37
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    api(project(":core:appapi-contract"))
    api(libs.kotlinx.coroutines.android)
    api("androidx.activity:activity:1.9.3")
}
