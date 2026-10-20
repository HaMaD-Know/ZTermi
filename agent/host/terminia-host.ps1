# Terminia agent - PowerShell host process.
#
# Started by terminia-agent.mjs, one process per session. Commands run in ONE
# persistent runspace, so variables, functions, modules and the current
# location persist between commands exactly as in a console session.
#
# Protocol: JSON lines. Requests arrive on stdin; replies are written to stdout
# prefixed with an ASCII record separator + "TERMINIA:" so they can never be
# confused with output that a native program writes to the inherited handle.
#
#   in : {"type":"run","id":..,"script":..}
#        {"type":"exec","id":..,"program":..,"args":[..],"cwd":..}
#        {"type":"cancel","id":..}  {"type":"complete","id":..,"input":..,"cursor":..}  {"type":"exit"}
#   out: {"type":"ready",..}  {"type":"out","id":..,"stream":..,"text":..}
#        {"type":"done","id":..,"success":..,"exitCode":..,"cwd":..,"cancelled":..,"error":..,"durationMs":..}
#        {"type":"completion","id":..,"replacementIndex":..,"replacementLength":..,"matches":[..]}
# Works with Windows PowerShell 5.1 and PowerShell 7+.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$Marker = [string][char]0x1e + 'TERMINIA:'
$Width = 120
if ($env:TERMINIA_WIDTH -match '^\d+$' -and [int]$env:TERMINIA_WIDTH -ge 40) { $Width = [int]$env:TERMINIA_WIDTH }

function Send-Message($message) {
    $stdout.WriteLine($Marker + (ConvertTo-Json -InputObject $message -Compress -Depth 6))
}

$iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
$rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($iss)
$rs.Open()

function Invoke-InRunspace([scriptblock]$configure) {
    $p = [PowerShell]::Create()
    $p.Runspace = $rs
    try {
        & $configure $p
        return $p.Invoke()
    } finally {
        $p.Dispose()
    }
}

if ($env:TERMINIA_CWD) {
    try {
        Invoke-InRunspace { param($p) [void]$p.AddCommand('Set-Location').AddParameter('LiteralPath', $env:TERMINIA_CWD) } | Out-Null
    } catch {
        Send-Message @{ type = 'log'; text = "Could not change to $($env:TERMINIA_CWD): $($_.Exception.Message)" }
    }
}

function Get-Cwd {
    try { return [string]$rs.SessionStateProxy.Path.CurrentLocation.Path } catch { return '' }
}

function Get-LastExitCode {
    try { return $rs.SessionStateProxy.GetVariable('LASTEXITCODE') } catch { return $null }
}

function Format-Record($record) {
    return ((($record | Out-String -Width $Width) -replace "`r`n", "`n") -replace '\s+$', '')
}

function Send-Output([string]$id, [string]$stream, [string]$text) {
    Send-Message @{ type = 'out'; id = $id; stream = $stream; text = $text }
}

function Read-Streams($command) {
    $id = $command.id
    $ps = $command.ps
    foreach ($line in $command.output.ReadAll()) { Send-Output $id 'stdout' ("$line" + "`n") }
    foreach ($record in $ps.Streams.Error.ReadAll()) { Send-Output $id 'stderr' ((Format-Record $record) + "`n") }
    foreach ($record in $ps.Streams.Warning.ReadAll()) { Send-Output $id 'warning' ("WARNING: " + $record.Message + "`n") }
    foreach ($record in $ps.Streams.Verbose.ReadAll()) { Send-Output $id 'verbose' ("VERBOSE: " + $record.Message + "`n") }
    foreach ($record in $ps.Streams.Debug.ReadAll()) { Send-Output $id 'debug' ("DEBUG: " + $record.Message + "`n") }
    if ($null -ne $ps.Streams.Information) {
        foreach ($record in $ps.Streams.Information.ReadAll()) { Send-Output $id 'information' ("$($record.MessageData)" + "`n") }
    }
}

function Start-Pipeline([string]$id, $ps) {
    [void]$ps.AddCommand('Out-String').AddParameter('Stream').AddParameter('Width', $Width)
    $output = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $inputData = New-Object 'System.Management.Automation.PSDataCollection[psobject]'
    $inputData.Complete()
    $before = Get-LastExitCode
    $async = $ps.BeginInvoke($inputData, $output)
    return @{ id = $id; ps = $ps; output = $output; async = $async; started = [DateTime]::UtcNow; before = $before; cancelled = $false }
}

function Start-Script([string]$id, [string]$script) {
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script)
    return Start-Pipeline $id $ps
}

# Structured execution: the program and every argument are passed as separate
# values (AddCommand/AddArgument). No command line is ever parsed.
function Start-Exec([string]$id, [string]$program, $arguments, [string]$cwd) {
    # Only real programs and scripts on PATH - never aliases, functions or cmdlets.
    $resolved = Get-Command -Name $program -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $resolved) { throw "'$program' was not found on this host's PATH." }
    $extension = [System.IO.Path]::GetExtension([string]$resolved.Source).ToLowerInvariant()
    $isBatch = $resolved.CommandType -eq 'Application' -and ($extension -eq '.cmd' -or $extension -eq '.bat')
    $list = @()
    if ($null -ne $arguments) { $list = @($arguments) }
    foreach ($argument in $list) {
        $text = [string]$argument
        if ($isBatch -and $text -match '[&|<>%"]') {
            throw "'$text' contains characters that cmd.exe would interpret ($program runs as a batch file). Use the interactive session instead."
        }
        if ($resolved.CommandType -eq 'Application' -and $PSVersionTable.PSEdition -eq 'Desktop' -and $text.Contains('"')) {
            throw "Windows PowerShell 5.1 cannot pass double quotes to native programs reliably. Install PowerShell 7 on this host or avoid quotes."
        }
    }
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddCommand('Set-Location').AddParameter('LiteralPath', $cwd)
    [void]$ps.AddStatement()
    [void]$ps.AddCommand([string]$resolved.Source)
    foreach ($argument in $list) { [void]$ps.AddArgument([string]$argument) }
    return Start-Pipeline $id $ps
}

function Complete-Command($command) {
    $errorText = $null
    try {
        [void]$command.ps.EndInvoke($command.async)
    } catch {
        $ex = $_.Exception
        while ($ex -is [System.Management.Automation.MethodInvocationException] -and $null -ne $ex.InnerException) { $ex = $ex.InnerException }
        if ($command.cancelled -or $ex -is [System.Management.Automation.PipelineStoppedException]) {
            $command.cancelled = $true
        } elseif ($ex -is [System.Management.Automation.IContainsErrorRecord] -and $null -ne $ex.ErrorRecord) {
            $errorText = Format-Record $ex.ErrorRecord
        } else {
            $errorText = $ex.Message
        }
    }
    Read-Streams $command
    $after = Get-LastExitCode
    $hadErrors = $command.ps.HadErrors -or ($null -ne $errorText)
    if ($command.cancelled) { $exit = 130 }
    elseif ($after -is [int] -and $after -ne $command.before) { $exit = $after }
    elseif ($hadErrors) { $exit = 1 }
    else { $exit = 0 }
    Send-Message @{
        type       = 'done'
        id         = $command.id
        success    = ((-not $hadErrors) -and ($exit -eq 0))
        exitCode   = $exit
        cwd        = (Get-Cwd)
        cancelled  = $command.cancelled
        error      = $errorText
        durationMs = [int]([DateTime]::UtcNow - $command.started).TotalMilliseconds
    }
    $command.ps.Dispose()
}

function Get-Completion($message, $busy) {
    $result = @{ type = 'completion'; id = $message.id; replacementIndex = [int]$message.cursor; replacementLength = 0; matches = @() }
    if ($busy) { return $result }
    try {
        $completion = Invoke-InRunspace {
            param($p)
            [void]$p.AddCommand('TabExpansion2').AddParameter('inputScript', [string]$message.input).AddParameter('cursorColumn', [int]$message.cursor)
        } | Select-Object -First 1
        if ($null -ne $completion) {
            $result.replacementIndex = [int]$completion.ReplacementIndex
            $result.replacementLength = [int]$completion.ReplacementLength
            $result.matches = @($completion.CompletionMatches | Select-Object -First 200 | ForEach-Object {
                @{ text = [string]$_.CompletionText; type = [string]$_.ResultType; tooltip = [string]$_.ToolTip }
            })
        }
    } catch {
        Send-Message @{ type = 'log'; text = "Completion failed: $($_.Exception.Message)" }
    }
    return $result
}

Send-Message @{ type = 'ready'; cwd = (Get-Cwd); edition = [string]$PSVersionTable.PSEdition; version = [string]$PSVersionTable.PSVersion }

$current = $null
$pending = $stdin.ReadLineAsync()
$exitRequested = $false
while (-not $exitRequested) {
    $didWork = $false
    if ($pending.IsCompleted) {
        $line = $pending.Result
        if ($null -eq $line) { break }
        $pending = $stdin.ReadLineAsync()
        $didWork = $true
        $message = $null
        try { $message = ConvertFrom-Json -InputObject $line } catch { Send-Message @{ type = 'log'; text = 'Ignored a malformed request.' } }
        if ($null -ne $message) {
            switch ([string]$message.type) {
                'run' {
                    if ($null -ne $current) {
                        Send-Message @{ type = 'done'; id = $message.id; success = $false; exitCode = $null; cwd = ''; cancelled = $false; error = 'Another command is running in this session.'; durationMs = 0 }
                    } else {
                        try { $current = Start-Script ([string]$message.id) ([string]$message.script) }
                        catch { Send-Message @{ type = 'done'; id = $message.id; success = $false; exitCode = 1; cwd = (Get-Cwd); cancelled = $false; error = $_.Exception.Message; durationMs = 0 } }
                    }
                }
                'exec' {
                    if ($null -ne $current) {
                        Send-Message @{ type = 'done'; id = $message.id; success = $false; exitCode = $null; cwd = ''; cancelled = $false; error = 'Another command is running in this session.'; durationMs = 0 }
                    } else {
                        try { $current = Start-Exec ([string]$message.id) ([string]$message.program) $message.args ([string]$message.cwd) }
                        catch { Send-Message @{ type = 'done'; id = $message.id; success = $false; exitCode = 1; cwd = (Get-Cwd); cancelled = $false; error = $_.Exception.Message; durationMs = 0 } }
                    }
                }
                'cancel' {
                    if ($null -ne $current -and $current.id -eq [string]$message.id -and -not $current.cancelled) {
                        $current.cancelled = $true
                        [void]$current.ps.BeginStop($null, $null)
                    }
                }
                'complete' { Send-Message (Get-Completion $message ($null -ne $current)) }
                'exit' { $exitRequested = $true }
            }
        }
    }
    if ($null -ne $current) {
        Read-Streams $current
        if ($current.async.IsCompleted) {
            Complete-Command $current
            $current = $null
            $didWork = $true
        }
    }
    if (-not $didWork) { Start-Sleep -Milliseconds 25 }
}

if ($null -ne $current) { try { $current.ps.Stop() } catch { } }
$rs.Close()
