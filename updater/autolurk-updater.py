#!/usr/bin/env python3
# AutoLurk updater. The browser starts this when the dashboard's Update now is
# clicked. It reads one message, updates the folder above this one, and replies.
# Anything printed to stdout breaks the browser's message framing.

import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

FOLDER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
BRANCH = re.compile(r"^[A-Za-z0-9_./-]+$")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack("<I", header)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_reply(reply):
    body = json.dumps(reply).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def read_manifest(folder):
    with open(os.path.join(folder, "manifest.json"), encoding="utf-8") as handle:
        return json.load(handle)


def update_with_git():
    result = subprocess.run(
        ["git", "-C", FOLDER, "pull", "--ff-only"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError("git pull failed: " + (result.stderr or result.stdout).strip())
    return "git"


def update_with_zip(message):
    owner, repo, branch = str(message.get("owner", "")), str(message.get("repo", "")), str(message.get("branch", ""))
    if not NAME.match(owner) or not NAME.match(repo):
        raise RuntimeError("That is not a GitHub repository.")
    if not BRANCH.match(branch) or ".." in branch:
        raise RuntimeError("That is not a branch name.")
    url = f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()

    with tempfile.TemporaryDirectory(prefix="autolurk-update-") as work:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                target = os.path.realpath(os.path.join(work, member))
                if not target.startswith(os.path.realpath(work) + os.sep):
                    raise RuntimeError("The download contains an unsafe path.")
            archive.extractall(work)
        roots = [entry for entry in os.listdir(work) if os.path.isdir(os.path.join(work, entry))]
        if len(roots) != 1 or not os.path.isfile(os.path.join(work, roots[0], "manifest.json")):
            raise RuntimeError("The download has no manifest.json.")
        source = os.path.join(work, roots[0])
        current, nxt = read_manifest(FOLDER), read_manifest(source)
        if nxt.get("name") != current.get("name"):
            raise RuntimeError("That download is not AutoLurk.")
        if nxt.get("key") != current.get("key"):
            raise RuntimeError("That download would change the extension id. It was not applied.")
        for base, _dirs, files in os.walk(source):
            relative = os.path.relpath(base, source)
            destination = os.path.normpath(os.path.join(FOLDER, relative))
            os.makedirs(destination, exist_ok=True)
            for name in files:
                shutil.copyfile(os.path.join(base, name), os.path.join(destination, name))
    return "zip"


def main():
    try:
        message = read_message()
        if message is None:
            return
        if message.get("action") == "status":
            send_reply({"ok": True, "version": read_manifest(FOLDER).get("version"), "folder": FOLDER})
            return
        if message.get("action") != "update":
            raise RuntimeError("Unknown request.")
        if os.path.isdir(os.path.join(FOLDER, ".git")) and shutil.which("git"):
            method = update_with_git()
        else:
            method = update_with_zip(message)
        send_reply({"ok": True, "method": method, "version": read_manifest(FOLDER).get("version")})
    except Exception as error:
        send_reply({"ok": False, "error": str(error)})


main()
