"""Build the Personal Hub Madden ratings snapshot from EA's public ratings page."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlencode

EA = "https://www.ea.com"
RATINGS = f"{EA}/games/madden-nfl/ratings"
GROUPS = {
    code: group
    for group, codes in {
        "QB": "QB", "RB": "HB RB FB", "WR": "WR", "TE": "TE",
        "OL": "LT LG C RG RT", "DL": "LE RE LEDG REDG DT DT1",
        "LB": "LB LOLB MLB ROLB MIKE SAM WILL", "DB": "CB FS SS", "ST": "K P LS",
    }.items()
    for code in codes.split()
}


def get(url, *headers):
    args = ["curl", "-fsSL", "--max-time", "35", "--retry", "2"]
    for header in headers:
        args.extend(["-H", header])
    return subprocess.check_output([*args, url])


def page_metadata():
    page = get(RATINGS).decode()
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if not match:
        raise RuntimeError("EA no longer exposes the expected page data.")
    data = json.loads(match[1])
    props = data["props"]["pageProps"]
    if "madden nfl 27" not in json.dumps(props["gameDetails"]).lower():
        raise RuntimeError("EA did not return Madden NFL 27.")
    first = props["ratingDetails"]["items"][0]
    iterations = [(0, "1-base")]
    for item in first["availableIterations"]:
        match = re.fullmatch(r"madden-ratings-week-(\d+)", item["id"])
        if match:
            iterations.append((int(match[1]), item["id"]))
    return data["buildId"], sorted(set(iterations))


def fetch_week(build, week, iteration):
    players = {}
    expected = None
    for page in range(1, 101):
        params = urlencode({"franchiseSlug": "madden-nfl", "iteration": iteration, "page": page})
        url = f"{EA}/_next/data/{build}/en/games/madden-nfl/ratings.json?{params}"
        props = json.loads(get(url, "Accept: application/json", "x-nextjs-data: 1"))["pageProps"]
        if "madden nfl 27" not in json.dumps(props["gameDetails"]).lower():
            raise RuntimeError(f"EA returned the wrong edition for {iteration}.")
        details = props["ratingDetails"]
        total = int(details["totalItems"])
        if expected is None:
            expected = total
        if total != expected or not details["items"]:
            raise RuntimeError(f"Pagination changed while loading {iteration}.")
        for player in details["items"]:
            if (player.get("iteration") or {}).get("id") != iteration:
                raise RuntimeError(f"EA returned the wrong week for {iteration}.")
            if str(player["id"]) in players:
                raise RuntimeError(f"Duplicate player in {iteration}.")
            players[str(player["id"])] = player
        if len(players) >= expected:
            break
        time.sleep(.15)
    if not players or len(players) != expected:
        raise RuntimeError(f"Incomplete {iteration}: {len(players)} of {expected}.")
    print(f"Week {week}: {len(players):,} players", flush=True)
    return week, players


def rating(value):
    if not isinstance(value, (int, float)) or not 0 <= value <= 100:
        return None
    return value


def snapshot(weeks):
    fields = sorted({
        name for _, players in weeks for player in players.values()
        for name, stat in (player.get("stats") or {}).items()
        if name.lower() != "overall" and isinstance(stat, dict) and rating(stat.get("value")) is not None
    })
    rows = []
    for week, players in weeks:
        for player_id, player in sorted(players.items()):
            position = (player.get("position") or {}).get("id") or "Other"
            team = (player.get("team") or {}).get("label") or "Unassigned"
            name = " ".join(filter(None, [player.get("firstName"), player.get("lastName")]))
            overall = rating(player.get("overallRating"))
            if not name or overall is None:
                raise RuntimeError(f"Missing name or overall rating for {player_id}, week {week}.")
            stats = player.get("stats") or {}
            values = [rating((stats.get(field) or {}).get("value")) for field in fields]
            rows.append([player_id, name, team, position, GROUPS.get(position, "Other"), week, overall, *values])
    return {
        "version": 1, "source": "EA Sports Madden NFL 27",
        "refreshed": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fields": ["Overall", *fields], "rows": rows,
    }


def read_snapshot(path):
    data = json.loads(gzip.decompress(base64.b64decode(path.read_bytes())))
    if (data.get("version") != 1 or data.get("source") != "EA Sports Madden NFL 27"
            or not data.get("rows") or not data.get("fields") or data["fields"][0] != "Overall"):
        raise RuntimeError("The published snapshot has an unexpected format.")
    return data


def merge_snapshots(previous, incoming):
    if previous is None:
        return incoming
    fields = list(dict.fromkeys(previous["fields"] + incoming["fields"]))
    rows = []
    for dataset in (previous, incoming):
        indices = {field: index for index, field in enumerate(dataset["fields"], 6)}
        rows.extend(
            row[:6] + [row[indices[field]] if field in indices else None for field in fields]
            for row in dataset["rows"]
        )
    return {**incoming, "fields": fields, "rows": rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--only-new", action="store_true", help="Preserve existing history and fetch only new updates.")
    args = parser.parse_args()
    previous = read_snapshot(args.output) if args.only_new and args.output.exists() else None
    build, iterations = page_metadata()
    existing = {row[5] for row in previous["rows"]} if previous else set()
    pending = [(week, iteration) for week, iteration in iterations if week not in existing]
    if not pending:
        print("No new EA ratings updates. Published data is unchanged.", flush=True)
        return
    print(f"EA build {build}: fetching {len(pending)} new snapshots", flush=True)
    with ThreadPoolExecutor(max_workers=3) as executor:
        requests = [executor.submit(fetch_week, build, *entry) for entry in pending]
        weeks = [future.result() for future in requests]
    data = merge_snapshots(previous, snapshot(weeks))
    compressed = gzip.compress(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode(), mtime=0)
    encoded = base64.b64encode(compressed).decode()
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(encoded + "\n", encoding="ascii")
    temporary.replace(args.output)
    print(f"{len(data['rows']):,} player snapshots, {len(data['fields'])} ratings, {len(encoded):,} encoded bytes", flush=True)


if __name__ == "__main__":
    main()
