plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.voicebook"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.voicebook"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0"
    }

    // One APK per processor type keeps the download small (phones: arm64-v8a).
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    signingConfigs {
        // A fixed key, so every new version installs over the previous one.
        create("release") {
            storeFile = file("voicebook.keystore")
            storePassword = "voicebook"
            keyAlias = "voicebook"
            keyPassword = "voicebook"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    // Native neural voice (sherpa-onnx with Kokoro). Downloaded by the build (see the workflow).
    implementation(files("libs/sherpa-onnx.aar"))
    implementation("org.apache.commons:commons-compress:1.27.1")
    implementation("androidx.core:core:1.13.1")
}
