@echo off
echo Mengaktifkan Google Chrome untuk Bot DeepSeek...
echo Pastikan Anda login ke chat.deepseek.com jika ini adalah pertama kalinya.
start chrome.exe --remote-debugging-port=9222 --user-data-dir="%~dp0.chrome_debug_profile" "https://chat.deepseek.com"
exit
