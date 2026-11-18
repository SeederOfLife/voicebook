#!/bin/bash
# Installs the APK on the emulator, opens it, runs the native voice self-test and
# collects screenshots, the generated voice sample and the logs into out/.
set -x
mkdir -p out
adb logcat -c
adb install -r voicebook-x86_64.apk || { echo "install failed" > out/result.txt; exit 1; }
adb shell pm grant app.voicebook android.permission.POST_NOTIFICATIONS || true
adb shell am start -n app.voicebook/.MainActivity --ez selftest true
sleep 30
adb exec-out screencap -p > out/screen-1-start.png
status="timeout"
for i in $(seq 1 100); do
  if adb logcat -d -s VBTEST:I | grep -q "done ok"; then status="ok"; break; fi
  if adb logcat -d -s VBTEST:I | grep -q "done failed"; then status="failed"; break; fi
  sleep 10
done
adb logcat -d -s VBTEST:* Voicebook:* > out/vbtest.txt
adb exec-out screencap -p > out/screen-2-after.png
adb pull /sdcard/Android/data/app.voicebook/files/selftest.wav out/selftest.wav || true
# Open the sample story in the page and screenshot it.
adb shell input tap 540 1500 || true
sleep 3
adb exec-out screencap -p > out/screen-3.png
adb logcat -d > out/logcat.txt
echo "$status" > out/result.txt
cat out/vbtest.txt | tail -20
[ "$status" = "ok" ]
