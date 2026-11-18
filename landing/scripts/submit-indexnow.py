"""Notify IndexNow of an already published release. Dry-run unless --submit is supplied.

Only the generated canonical public inventory is accepted. This does not claim
indexation, ranking or inclusion in any AI answer. No scheduled resubmission.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--submit", action="store_true")
    parser.add_argument("paths", nargs="*", help="Changed canonical paths, e.g. / /financas")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    build = json.loads((root / "dist/build.json").read_text())
    origin = build["siteOrigin"]
    if origin != "https://astraacessor.pro":
        raise ValueError("Refusing to submit a preview or unrecognized domain")
    inventory = build["publicUrls"]
    urls = list(dict.fromkeys(origin + path for path in args.paths)) if args.paths else inventory
    if not urls or any(url not in inventory for url in urls):
        raise ValueError("Only existing canonical public pages can be submitted")
    key = build["indexNowKey"]
    key_location = f"{origin}/{key}.txt"
    payload = {
        "host": urllib.parse.urlsplit(origin).hostname,
        "key": key,
        "keyLocation": key_location,
        "urlList": urls,
    }
    if not args.submit:
        print(json.dumps({"mode": "dry-run", "payload": payload}, ensure_ascii=False, indent=2))
        return

    # Never notify before the real, indexable release and ownership file are live.
    headers = {"User-Agent": "Astra-IndexNow-Release/1.0", "DNT": "1"}
    with urllib.request.urlopen(urllib.request.Request(origin + "/health", headers=headers), timeout=25) as response:
        health = json.load(response)
    if health.get("preview") is not False or health.get("release") != build["release"]:
        raise ValueError("The built release is not live on the official domain")
    with urllib.request.urlopen(urllib.request.Request(key_location, headers=headers), timeout=25) as response:
        if response.status != 200 or response.headers.get_content_type() != "text/plain" or response.read().decode("utf-8") != key:
            raise ValueError("The public UTF-8 ownership key is missing or invalid")
    request = urllib.request.Request(
        "https://api.indexnow.org/indexnow",
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, body = response.status, response.read(2000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read(2000).decode("utf-8", errors="replace")
    result = {
        "submittedAt": datetime.now(timezone.utc).isoformat(),
        "release": build["release"],
        "endpoint": request.full_url,
        "status": status,
        "urlCount": len(urls),
        "urls": urls,
        "result": "received" if status == 200 else "key-validation-pending" if status == 202 else "rejected",
        "response": body,
        "indexationConfirmed": False,
    }
    (root / "artifacts").mkdir(exist_ok=True)
    (root / "artifacts/indexnow-submission.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if status not in (200, 202):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
