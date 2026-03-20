<#
.SYNOPSIS
    Downloads all Antichess games for a Lichess user, organised by opponent rating range.

.DESCRIPTION
    Calls the Lichess API and saves each game as an individual PGN file under:
        lichessGames\
            unrated\
            0-999\
            1000-1199\
            1200-1399\
            1400-1599\
            1600-1799\
            1800-1999\
            2000+\

.EXAMPLE
    .\download_lichess_games.ps1
#>

# ── Configuration ─────────────────────────────────────────────────────────────
$Username  = "gpdkr212"
$OutputDir = "E:\agency\AIWorkflows\AntiChessPuzzles\lichessGames"
$ApiUrl    = "https://lichess.org/api/games/user/$Username" +
             "?variant=antichess&clocks=false&evals=false&opening=true"
# ──────────────────────────────────────────────────────────────────────────────

function Get-RatingBucket([int]$rating) {
    if     ($rating -lt 1000) { "0-999" }
    elseif ($rating -lt 1200) { "1000-1199" }
    elseif ($rating -lt 1400) { "1200-1399" }
    elseif ($rating -lt 1600) { "1400-1599" }
    elseif ($rating -lt 1800) { "1600-1799" }
    elseif ($rating -lt 2000) { "1800-1999" }
    else                      { "2000+" }
}

function Get-PgnHeader([string]$pgn, [string]$tag) {
    if ($pgn -match "\[$tag `"([^`"]+)`"\]") { $Matches[1] } else { $null }
}

function Get-OpponentRating([string]$pgn, [string]$userLower) {
    $white = (Get-PgnHeader $pgn "White") -replace '(?i)^(.*)$','$1'
    if ($white.ToLower() -eq $userLower) {
        $raw = Get-PgnHeader $pgn "BlackElo"
    } else {
        $raw = Get-PgnHeader $pgn "WhiteElo"
    }
    if ($raw -and $raw -ne "?") {
        $n = 0
        if ([int]::TryParse($raw, [ref]$n)) { return $n }
    }
    return $null
}

function Get-SafeFilename([string]$pgn, [int]$index) {
    $date  = (Get-PgnHeader $pgn "Date") -replace '\.', '' 
    $white = (Get-PgnHeader $pgn "White") -replace '[^\w]', '_'
    $black = (Get-PgnHeader $pgn "Black") -replace '[^\w]', '_'
    if (-not $date)  { $date  = "unknown" }
    if (-not $white) { $white = "unknown" }
    if (-not $black) { $black = "unknown" }
    "antichess_${date}_${white}_vs_${black}_{0:D4}.pgn" -f $index
}

# ── Download ───────────────────────────────────────────────────────────────────
Write-Host "`nDownloading Antichess games for '$Username' from Lichess..." -ForegroundColor Cyan

$tempFile = [System.IO.Path]::GetTempFileName()
try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add("Accept",     "application/x-chess-pgn")
    $wc.Headers.Add("User-Agent", "antichess-puzzle-downloader/1.0")
    $wc.DownloadFile($ApiUrl, $tempFile)
} catch [System.Net.WebException] {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -eq 429) {
        Write-Host "Rate limited (429). Wait a minute and try again." -ForegroundColor Red
    } elseif ($code -eq 404) {
        Write-Host "User '$Username' not found on Lichess." -ForegroundColor Red
    } else {
        Write-Host "HTTP error ${code}: $_" -ForegroundColor Red
    }
    Remove-Item $tempFile -ErrorAction SilentlyContinue
    exit 1
} catch {
    Write-Host "Network error: $_" -ForegroundColor Red
    Remove-Item $tempFile -ErrorAction SilentlyContinue
    exit 1
}

$rawPgn = [System.IO.File]::ReadAllText($tempFile, [System.Text.Encoding]::UTF8)
Remove-Item $tempFile -ErrorAction SilentlyContinue

# Split into individual games on [Event "..."] boundaries
$games = [regex]::Split($rawPgn, '(?m)(?=^\[Event\s+")') |
         Where-Object { $_.Trim() -ne '' } |
         ForEach-Object { $_.Trim() }

if ($games.Count -eq 0) {
    Write-Host "No Antichess games found for '$Username'." -ForegroundColor Yellow
    Write-Host "(Account may be private, or no antichess games played yet.)"
    exit 0
}

Write-Host "Found $($games.Count) game(s). Saving to '$OutputDir'...`n" -ForegroundColor Green

$userLower = $Username.ToLower()
$counts    = @{}
$i         = 0

foreach ($game in $games) {
    $i++

    $rating = Get-OpponentRating $game $userLower
    $bucket = if ($null -ne $rating) { Get-RatingBucket $rating } else { "unrated" }
    $folder = Join-Path $OutputDir $bucket

    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }

    $filename = Get-SafeFilename $game $i
    $filepath = Join-Path $folder $filename

    # Avoid overwriting
    if (Test-Path $filepath) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($filepath)
        $filepath = Join-Path $folder "${base}_dup${i}.pgn"
    }

    [System.IO.File]::WriteAllText($filepath, $game, [System.Text.Encoding]::UTF8)

    $ratingStr = if ($null -ne $rating) { $rating.ToString() } else { "unrated" }
    Write-Host ("  [{0,4}/{1}]  {2,-12}  opp={3,-6}  {4}" -f $i, $games.Count, $bucket, $ratingStr, $filename)

    $counts[$bucket] = ($counts[$bucket] -as [int]) + 1
}

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Host "`n── Summary " + ("─" * 50) -ForegroundColor Cyan
$bucketOrder = @("unrated","0-999","1000-1199","1200-1399","1400-1599","1600-1799","1800-1999","2000+")
foreach ($b in $bucketOrder) {
    if ($counts.ContainsKey($b)) {
        Write-Host ("  {0,-14}  {1,4} game(s)" -f $b, $counts[$b])
    }
}
Write-Host "`n  Total: $i game(s) saved to $OutputDir" -ForegroundColor Green
