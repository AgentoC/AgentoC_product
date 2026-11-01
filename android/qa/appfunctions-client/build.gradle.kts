plugins { alias(libs.plugins.android.application) }
android {
    namespace = "com.agentoncloud.appfunctions.qa"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.agentoncloud.appfunctions.qa"
        minSdk = 36
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
