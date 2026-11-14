@echo off
setlocal
cd /d "%~dp0"
chcp 936 >nul 2>nul
title EyePilot - AI 眼控与用眼健康助手

if exist "runtime\python.exe" (
  echo.
  echo   正在启动 EyePilot ...
  "runtime\python.exe" serve.py
  if errorlevel 1 pause
  exit /b
)

where python >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   正在启动 EyePilot ...
  python serve.py
  if errorlevel 1 pause
  exit /b
)

echo.
echo   没有找到可用的运行环境。
echo   正常压缩包内应包含 runtime\python.exe，请完整解压后重试。
echo   或安装 Python 3.9+：https://www.python.org/downloads/
echo.
echo   注意：必须通过 http://127.0.0.1:8848/ 访问。
echo.
pause
