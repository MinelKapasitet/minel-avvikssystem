@echo off
echo.
echo  ================================================
echo   Minel Avvikssystem
echo  ================================================
echo.

where node >nul 2>&1
if %errorlevel% equ 0 (
  echo  Starter server...
  node server.js
  goto :done
)

echo  FEIL: Node.js er ikke installert.
echo.
echo  Last ned gratis fra: https://nodejs.org  (velg LTS v22+)
echo.

:done
pause
