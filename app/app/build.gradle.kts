import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val mobiStorePassword = providers.gradleProperty("mobiReleaseStorePassword").orNull
val mobiKeyPassword = providers.gradleProperty("mobiReleaseKeyPassword").orNull
val mobiStoreFile = providers.gradleProperty("mobiReleaseStoreFile").orNull?.let { file(it) }
    ?: File(System.getProperty("user.home"), ".mobi/mobi-release.jks")
val mobiSigningAvailable = !mobiStorePassword.isNullOrBlank() &&
    !mobiKeyPassword.isNullOrBlank() && mobiStoreFile.isFile

android {
    namespace = "dev.mobi"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    useLibrary("android.car")
    defaultConfig {
        applicationId = "dev.mobi"
        minSdk = 34
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
        val base = providers.gradleProperty("mobiServerBaseUrl").getOrElse("https://mobi-dev.mobi-car.workers.dev")
        buildConfigField("String", "MOBI_SERVER_BASE_URL", "\"${base.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        if (mobiSigningAvailable) {
            create("mobiRelease") {
                storeFile = mobiStoreFile
                storePassword = mobiStorePassword
                keyAlias = providers.gradleProperty("mobiReleaseKeyAlias").getOrElse("mobi-release")
                keyPassword = mobiKeyPassword
                storeType = "JKS"
            }
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("mobiRelease")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.register("exportSubmissionApk") {
    group = "distribution"
    description = "Copy the signed release APK to the contest apk directory."
    dependsOn("assembleRelease")
    doLast {
        if (!mobiSigningAvailable) {
            throw GradleException(
                "Submission APK requires a release keystore and mobiReleaseStorePassword / " +
                    "mobiReleaseKeyPassword in private user Gradle properties. assembleRelease remains unsigned without them."
            )
        }
        val teamName = providers.environmentVariable("TEAM_NAME").getOrElse("MOBI").trim()
        require(teamName.matches(Regex("[\\p{L}\\p{N} _-]{1,80}"))) {
            "TEAM_NAME must contain 1–80 letters, numbers, spaces, underscores or hyphens."
        }
        val strings = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(file("src/main/res/values/strings.xml")).getElementsByTagName("string")
        val appName = (0 until strings.length).map { strings.item(it) }
            .single { it.attributes.getNamedItem("name").nodeValue == "app_name" }.textContent.trim()
        require(appName.matches(Regex("[\\p{L}\\p{N} _-]{1,80}"))) { "Unsafe app display name for APK filename." }
        val source = layout.buildDirectory.file("outputs/apk/release/app-release.apk").get().asFile
        check(source.isFile) { "Signed release APK is missing; unsigned/debug APKs cannot be exported." }
        val destination = File(rootProject.projectDir.parentFile, "apk/${teamName}_${appName}_release.apk")
        destination.parentFile.mkdirs()
        source.copyTo(destination, overwrite = true)
        logger.lifecycle("Submission APK: apk/${destination.name}")
    }
}
dependencies {
    implementation("ai.pleos.playground:NaviHelper:3.0.5")
    implementation("com.google.zxing:core:3.5.4")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
