# Server installation script

$TMP_DIR="$env:TEMP\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

# Quote a runtime value for a *nested* PowerShell parse (the `powershell -c "…"`
# below re-parses the argument string it is handed). Same rule as
# src/common/shellQuote.ts's escapePowerShellArg: wrap in '…', double every '.
# Needed because $SERVER_DATA_DIR derives from the user-configurable
# `remote.SSH.serverInstallPath`, and a Windows path may legally contain `'`
# or `$` - either would escape the nested `'…'` and inject a command.
function psQuote($value) { "'" + ($value -replace "'", "''") + "'" }

# Every placeholder below is substituted as an *already single-quoted*
# PowerShell literal (serverSetup.ts's escapePowerShellArg), hence no quotes:
# in a double-quoted PowerShell string `$(…)` is a subexpression that gets
# evaluated and `"` ends the string, so splicing a user-configurable setting
# (serverInstallPath / serverDownloadUrlTemplate / serverBinaryName) into one
# was remote code execution at connect time.
$DISTRO_VERSION=%%DISTRO_VERSION%%
$DISTRO_COMMIT=%%DISTRO_COMMIT%%
$DISTRO_QUALITY=%%DISTRO_QUALITY%%
$DISTRO_VSCODIUM_RELEASE=%%DISTRO_VSCODIUM_RELEASE%%

$SERVER_APP_NAME=%%SERVER_APP_NAME%%
$SERVER_INITIAL_EXTENSIONS=%%SERVER_INITIAL_EXTENSIONS%%
$SERVER_LISTEN_FLAG="%%SERVER_LISTEN_FLAG%%"
$SERVER_DATA_DIR=%%SERVER_DATA_DIR%%
$SERVER_DATA_DIR_FLAG="%%SERVER_DATA_DIR_FLAG%%"
$SERVER_DIR="$SERVER_DATA_DIR\bin\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\bin\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\.$DISTRO_COMMIT.token"
$SERVER_ARCH=
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL=%%SERVER_DOWNLOAD_URL%%
$SERVER_VALIDATION_FLAG="%%SERVER_VALIDATION_FLAG%%"

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
  "%%SCRIPT_ID%%: start"
  "exitCode==$code=="
  "listeningOn==$LISTENING_ON=="
  "connectionToken==$SERVER_CONNECTION_TOKEN=="
  "logFile==$SERVER_LOGFILE=="
  "osReleaseId==$OS_RELEASE_ID=="
  "arch==$ARCH=="
  "platform==$PLATFORM=="
  "tmpDir==$TMP_DIR=="
%%ENV_VAR_LINES%%
  "%%SCRIPT_ID%%: end"
}

# $TMP_DIR is a freshly generated, never-before-seen path under %TEMP% (used
# for the --socket-path flag) - unlike the .sh variant, which reuses an
# already-existing $XDG_RUNTIME_DIR/tmp, nothing else creates this directory.
try {
  New-Item -ItemType Directory -Force -Path $TMP_DIR -ea Stop | Out-Null
} catch {
  "Error creating temp directory - $($_.ToString())"
  printInstallResults 1
  exit 0
}

# Per-install-path lock so two concurrent connects to the same remote can't
# race the download/extract of the same commit and corrupt it (parity with
# the .sh's flock-based lock at $SERVER_DATA_DIR).
$INSTALL_MUTEX_NAME = "vscode-server-install-" + ($SERVER_DIR -replace '[\\/:]', '_')
$INSTALL_MUTEX = New-Object System.Threading.Mutex($false, $INSTALL_MUTEX_NAME)
$INSTALL_MUTEX_OWNED = $false
try {
  $INSTALL_MUTEX_OWNED = $INSTALL_MUTEX.WaitOne([TimeSpan]::FromSeconds(30))
} catch [System.Threading.AbandonedMutexException] {
  # A previous holder crashed/was killed while still owning the mutex; the OS
  # still grants us ownership here. Proceed - the corrupt-dir cleanup below
  # already handles a half-finished extract left behind by that holder.
  $INSTALL_MUTEX_OWNED = $true
}
if(!$INSTALL_MUTEX_OWNED) {
  "Error could not acquire install lock within 30s"
  printInstallResults 1
  exit 0
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
# Use x64 version for ARM64, as it's not yet available.
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
  $SERVER_ARCH="x64"
}
else {
  "Error architecture not supported: $ARCH"
  printInstallResults 1
  exit 0
}

try {
  # Create installation folder
  if(!(Test-Path $SERVER_DIR)) {
    try {
      ni -it d $SERVER_DIR -f -ea si
    } catch {
      "Error creating server install directory - $($_.ToString())"
      printInstallResults 1
      exit 0
    }

    if(!(Test-Path $SERVER_DIR)) {
      "Error creating server install directory"
      printInstallResults 1
      exit 0
    }
  }

  cd $SERVER_DIR

  # Check if server script is already installed
  if(!(Test-Path $SERVER_SCRIPT)) {
    del vscode-server.tar.gz

    $REQUEST_ARGUMENTS = @{
      Uri="$SERVER_DOWNLOAD_URL"
      OutFile="vscode-server.tar.gz"
      UseBasicParsing=$True
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    try {
      # No -TimeoutSec: the previous 20s cap bounded the whole ~50MB transfer
      # (not just connect), so it aborted valid downloads on slower links.
      Invoke-RestMethod @REQUEST_ARGUMENTS
    } catch {
      "Error downloading server from $SERVER_DOWNLOAD_URL - $($_.ToString())"
      del -ea si vscode-server.tar.gz
      printInstallResults 1
      exit 0
    }

    if(Test-Path "vscode-server.tar.gz") {
      tar -xf vscode-server.tar.gz --strip-components 1

      if($LASTEXITCODE -ne 0) {
        "Error while extracting server contents"
        Remove-Item -Recurse -Force -ea si -Path (Join-Path $SERVER_DIR '*')
        del -ea si vscode-server.tar.gz
        printInstallResults 1
        exit 0
      }

      del vscode-server.tar.gz
    }
    else {
      "Error downloading server from $SERVER_DOWNLOAD_URL"
      printInstallResults 1
      exit 0
    }

    if(!(Test-Path $SERVER_SCRIPT)) {
      Remove-Item -Recurse -Force -ea si -Path (Join-Path $SERVER_DIR '*')
      "Error while installing the server binary"
      printInstallResults 1
      exit 0
    }
  }
  else {
    "Server script already installed in $SERVER_SCRIPT"
  }

  # Modify the commit in the remote server to match the local value
  if(%%MODIFY_PRODUCT_JSON%%) {
    echo "Will modify product.json on remote to match the commit value"
    (Get-Content -Raw "$SERVER_DIR\product.json") -replace '"commit": "[0-9a-f]+",', ('"commit": "' + $DISTRO_COMMIT + '",') |
    Set-Content -NoNewLine "$SERVER_DIR\product.json"
  }
}
finally {
  if($INSTALL_MUTEX_OWNED) {
    $INSTALL_MUTEX.ReleaseMutex()
  }
}

# Try to find if server is already running
if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\*") {
  echo "Server script is already running $SERVER_SCRIPT"
}
else {
  if(Test-Path $SERVER_LOGFILE) {
    del $SERVER_LOGFILE
  }
  if(Test-Path $SERVER_PIDFILE) {
    del $SERVER_PIDFILE
  }
  if(Test-Path $SERVER_TOKENFILE) {
    del $SERVER_TOKENFILE
  }

  $SERVER_CONNECTION_TOKEN=%%SERVER_CONNECTION_TOKEN%%
  [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

  # psQuote (not a bare '…') on the two paths: they are built from
  # $SERVER_DATA_DIR, so a `'` in the configured install path would otherwise
  # close the quote inside the nested `powershell -c` string below.
  $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_DATA_DIR_FLAG $SERVER_VALIDATION_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $(psQuote $SERVER_TOKENFILE) --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> $(psQuote $SERVER_LOGFILE)"

  $START_ARGUMENTS = @{
    FilePath = "powershell.exe"
    WindowStyle = "hidden"
    ArgumentList = @(
      # `& <quoted path>` (call operator + psQuote'd path), not a bare token -
      # otherwise a space in $SERVER_SCRIPT (e.g. "C:\Users\John Doe\...")
      # makes the nested powershell -c parser split it into two commands,
      # which fails "not recognized" while this outer script still reports
      # success (Start-Process only checks that powershell.exe itself launched).
      # psQuote rather than a literal '…' so a `'` in the path can't break out.
      "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "& $(psQuote $SERVER_SCRIPT) $SCRIPT_ARGUMENTS"
    )
    PassThru = $True
  }

  $SERVER_ID = (start @START_ARGUMENTS).ID

  if($SERVER_ID) {
    [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
  }
}

if(Test-Path $SERVER_TOKENFILE) {
  $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
  "Error server token file not found $SERVER_TOKENFILE"
  printInstallResults 1
  exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
  Path = $SERVER_LOGFILE
  Pattern = "Extension host agent listening on (\d+)"
}

# Poll for up to 35 * 500ms = 17.5s (parity with the .sh's `for i in {1..35}`)
# and fail loudly if the server never logs a listening address - previously
# this looped only 5 * 500ms = 2.5s and, on timeout, fell through to
# `printInstallResults 0` with an empty $LISTENING_ON, which authResolver.ts
# then used to open a tunnel to port 0.
if(Test-Path $SERVER_LOGFILE) {
  for($I = 1; $I -le 35; $I++) {
    $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

    if($GROUPS) {
      $LISTENING_ON = $GROUPS[1].Value
      break
    }

    sleep -Milliseconds 500
  }

  if(!$LISTENING_ON) {
    "Error server did not start successfully"
    printInstallResults 1
    exit 0
  }
}
else {
  "Error server log file not found $SERVER_LOGFILE"
  printInstallResults 1
  exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
  while($True) {
    if(!(gps -Id $SERVER_ID)) {
      "server died, exit"
      exit 0
    }

    sleep 30
  }
}
