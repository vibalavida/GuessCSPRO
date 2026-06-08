import json
import re
import sys
from html import unescape
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_HTML = PROJECT_ROOT / "Counter-Strike Player statistics database _ HLTV.org.html"
PLAYERS_JSON = PROJECT_ROOT / "players_data.json"
CLEANED_JSON = PROJECT_ROOT / "players_data_cleaned.json"


def strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", "", value)
    return unescape(text).replace("\xa0", " ").strip()


def normalize_player_link(raw_href: str) -> str:
    href = unescape(raw_href).strip()
    if not href:
        return "Unknown"
    if href.startswith("/"):
        href = f"https://www.hltv.org{href}"
    href = href.split("?")[0]
    href = href.replace("/stats/players/", "/player/")
    return href


def extract_table(html: str) -> str:
    match = re.search(
        r'<table class="stats-table player-ratings-table">(.*?)</table>',
        html,
        flags=re.S,
    )
    if not match:
        raise ValueError("未找到 player-ratings-table 表格")
    return match.group(1)


def parse_headers(table_html: str) -> list[str]:
    thead_match = re.search(r"<thead>(.*?)</thead>", table_html, flags=re.S)
    if not thead_match:
        raise ValueError("未找到表头")
    headers = re.findall(r"<th[^>]*>(.*?)</th>", thead_match.group(1), flags=re.S)
    return [strip_tags(header) for header in headers]


def parse_rows(table_html: str) -> list[str]:
    tbody_match = re.search(r"<tbody>(.*?)</tbody>", table_html, flags=re.S)
    if not tbody_match:
        raise ValueError("未找到表格内容")
    return re.findall(r"<tr[^>]*>(.*?)</tr>", tbody_match.group(1), flags=re.S)


def parse_player_cell(cell_html: str) -> tuple[str, str, str]:
    name_match = re.search(r"<a [^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", cell_html, flags=re.S)
    img_match = re.search(r'<img[^>]*alt="([^"]+)"', cell_html, flags=re.S)

    player_name = strip_tags(name_match.group(2)) if name_match else "Unknown"
    player_link = normalize_player_link(name_match.group(1)) if name_match else "Unknown"
    country = unescape(img_match.group(1)).strip() if img_match else "Unknown"
    return player_name, player_link, country


def parse_team_cell(attrs: str, cell_html: str) -> str:
    data_sort_match = re.search(r'data-sort="([^"]+)"', attrs)
    if data_sort_match:
        return unescape(data_sort_match.group(1)).strip()

    img_match = re.search(r'<img[^>]*alt="([^"]+)"', cell_html, flags=re.S)
    if img_match:
        return unescape(img_match.group(1)).strip()

    text = strip_tags(cell_html)
    return text or "No team"


def parse_saved_html(html_path: Path) -> tuple[list[str], dict[str, dict]]:
    html = html_path.read_text(encoding="utf-8")
    table_html = extract_table(html)
    headers = parse_headers(table_html)
    rows = parse_rows(table_html)

    players = {}
    for row_html in rows:
        cells = re.findall(r"<td([^>]*)>(.*?)</td>", row_html, flags=re.S)
        if len(cells) != len(headers):
            continue

        row_data = {}
        player_name = "Unknown"
        player_link = "Unknown"
        country = "Unknown"

        for index, (attrs, cell_html) in enumerate(cells):
            header = headers[index]
            if header == "Player":
                player_name, player_link, country = parse_player_cell(cell_html)
                row_data["Player"] = player_name
                row_data["country"] = country
                row_data["link"] = player_link
            elif header == "Teams":
                row_data["Teams"] = strip_tags(cell_html)
                row_data["team"] = parse_team_cell(attrs, cell_html)
            else:
                row_data[header] = strip_tags(cell_html)

        if player_name != "Unknown":
            players[player_name] = row_data

    return headers, players


def load_existing_cleaned() -> dict[str, dict]:
    if not CLEANED_JSON.exists():
        return {}
    with CLEANED_JSON.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def build_outputs(parsed_players: dict[str, dict], existing_cleaned: dict[str, dict]) -> tuple[dict, dict]:
    raw_output = {}
    cleaned_output = {}

    for player_name, parsed in parsed_players.items():
        old = existing_cleaned.get(player_name, {})
        country = parsed.get("country") or old.get("country") or "Unknown"
        team = parsed.get("team") or old.get("team") or "No team"
        birth_year = old.get("birth_year", "Unknown")
        role = old.get("role", "Unknown")
        majapp = old.get("majapp", 0)

        raw_entry = dict(parsed)
        raw_entry["country"] = country
        raw_entry["team"] = team
        raw_entry["birth_year"] = birth_year
        raw_entry["role"] = role
        raw_entry["majapp"] = majapp
        raw_output[player_name] = raw_entry

        cleaned_output[player_name] = {
            "link": parsed.get("link", old.get("link", "Unknown")),
            "country": country,
            "team": team,
            "birth_year": birth_year,
            "role": role,
            "majapp": majapp,
        }

    return raw_output, cleaned_output


def main() -> int:
    html_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_HTML
    if not html_path.exists():
        print(f"文件不存在: {html_path}")
        return 1

    _, parsed_players = parse_saved_html(html_path)
    existing_cleaned = load_existing_cleaned()
    raw_output, cleaned_output = build_outputs(parsed_players, existing_cleaned)

    PLAYERS_JSON.write_text(json.dumps(raw_output, ensure_ascii=False, indent=4), encoding="utf-8")
    CLEANED_JSON.write_text(json.dumps(cleaned_output, ensure_ascii=False, indent=4), encoding="utf-8")

    new_players = sorted(set(cleaned_output) - set(existing_cleaned))
    removed_players = sorted(set(existing_cleaned) - set(cleaned_output))

    print(f"已解析 {len(parsed_players)} 名选手")
    print(f"已写入 {PLAYERS_JSON.name} 和 {CLEANED_JSON.name}")
    print(f"新增选手 {len(new_players)} 名，移除选手 {len(removed_players)} 名")

    if new_players:
        print("新增示例:", ", ".join(new_players[:10]))
    if removed_players:
        print("移除示例:", ", ".join(removed_players[:10]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
