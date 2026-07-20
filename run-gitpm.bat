@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
title GitPM

echo ========================================
echo            Запуск GitPM
echo ========================================
echo.

echo [1/3] Проверяю системные зависимости...
where node >nul 2>&1
if errorlevel 1 (
  echo ОШИБКА: Node.js не найден.
  echo Установите Node.js 20.19.2: https://nodejs.org/
  goto :failed
)
node scripts\check-gitpm-prerequisites.mjs
if errorlevel 1 (
  goto :failed
)

echo [2/3] Проверяю зависимости проекта...
call corepack pnpm install --frozen-lockfile
if errorlevel 1 (
  echo.
  echo ОШИБКА: не удалось проверить или установить зависимости проекта.
  echo Проверьте подключение к интернету и сообщения pnpm выше.
  goto :failed
)

echo.
echo [3/3] Читаю конфигурацию и запускаю GitPM...
echo       Сервер:   http://127.0.0.1:3000
echo       Интерфейс: http://127.0.0.1:5173
echo.
echo Чтобы остановить приложение, закройте это окно или нажмите Ctrl+C.
echo ========================================
echo.

node scripts\run-gitpm-local.mjs %*
set "EXIT_CODE=%ERRORLEVEL%"
rem 0xC000013A is Windows' normal Ctrl+C/console-close status. Depending on
rem cmd.exe, it can be exposed as either a signed or an unsigned number.
if "%EXIT_CODE%"=="-1073741510" exit /b 0
if "%EXIT_CODE%"=="3221225786" exit /b 0
if not "%EXIT_CODE%"=="0" (
  echo.
  echo GitPM завершился с ошибкой ^(код %EXIT_CODE%^).
  goto :failed
)
exit /b 0

:failed
echo.
echo Запуск остановлен. Нажмите любую клавишу, чтобы закрыть окно.
pause >nul
exit /b 1
