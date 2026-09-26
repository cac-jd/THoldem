@echo off
rem Update THoldem and open it in your browser (Windows).
cd /d "%~dp0"
git pull --ff-only || echo Could not update (offline?) - opening the copy you have.
start "" "index.html"
