@echo off
cd /d "C:\Users\pc\Downloads\scrcpy-win64-v3.3.1\scrcpy-win64-v3.3.1"
adb connect 192.168.0.100
scrcpy
pause
