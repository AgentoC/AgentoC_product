pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
    versionCatalogs { create("libs") { from(files("../../gradle/libs.versions.toml")) } }
}
rootProject.name = "AgentoC Share Source QA"
include(":core:appapi-contract", ":sdk:android")
project(":core").projectDir = file("../../core")
project(":sdk").projectDir = file("../../sdk")
project(":core:appapi-contract").projectDir = file("../../core/appapi-contract")
project(":sdk:android").projectDir = file("../../sdk/android")
