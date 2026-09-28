#!/usr/bin/env python3
"""Generate brain/INDEX.md: one line per repository file with a short description.

Sources (nothing is written by hand in INDEX.md):
  * code, config, assets  -> the matching section of a brain/codemap/*.md sheet
                             (heading "## `path`" or "### `path`" + its **Role** line,
                             or a table row "| `path` | description |");
  * Markdown documents    -> their first "> " quote line, else their "# " title.

Usage (from the repo root):
    python brain/codemap/build-index.py          # rewrite brain/INDEX.md
    python brain/codemap/build-index.py --check  # exit 1 if a file has no description

Run it after any file creation, deletion or rename (after updating the codemap sheet).
Only the standard library is used, so any Python 3.8+ works (Windows, WSL, Linux).
"""

import io
import os
import re
import subprocess
import sys
from collections import OrderedDict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CODEMAP_DIR = os.path.join(ROOT, "brain", "codemap")
OUT = os.path.join(ROOT, "brain", "INDEX.md")
MAX_LEN = 220

HEADING_RE = re.compile(r"^#{2,4} .*?`([^`]+)`")
TABLE_RE = re.compile(r"^\| `([^`]+)` \| (.+?) \|")
ROLE_RE = re.compile(r"^\*\*(Role|Covers|Rôle|Couvre)\*\*[^:]*: ?(.*)")


def tracked_files():
    out = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, text=True, encoding="utf-8",
    )
    files = sorted({f for f in out.splitlines() if f and os.path.exists(os.path.join(ROOT, f))})
    return [f for f in files if f != "brain/INDEX.md"]


def shorten(text):
    """Keep the first sentence (outside backticks), capped to MAX_LEN characters."""
    text = re.sub(r"\s+", " ", text).strip()
    in_code = False
    for i, ch in enumerate(text):
        if ch == "`":
            in_code = not in_code
        elif ch == "." and not in_code and (i + 1 == len(text) or text[i + 1] == " ") and i > 20:
            text = text[: i + 1]
            break
    if len(text) > MAX_LEN:
        cut = text[:MAX_LEN]
        if cut.count("`") % 2:  # never leave an open code span
            cut = cut[: cut.rfind("`")]
        text = cut.rstrip(" ,;:") + " …"
    return text


def codemap_descriptions():
    """Map file path -> (description, codemap sheet name)."""
    found = {}
    for name in sorted(os.listdir(CODEMAP_DIR)):
        if not name.endswith(".md") or name.startswith("_") or name == "README.md":
            continue
        with io.open(os.path.join(CODEMAP_DIR, name), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        for i, line in enumerate(lines):
            row = TABLE_RE.match(line)
            if row and row.group(1) not in found and not row.group(2).startswith("-"):
                found[row.group(1)] = (shorten(row.group(2)), name)
                continue
            head = HEADING_RE.match(line)
            if not head or head.group(1) in found:
                continue
            desc = ""
            for nxt in lines[i + 1 : i + 12]:
                if nxt.startswith("#"):
                    break
                role = ROLE_RE.match(nxt)
                if role:
                    desc = role.group(2)
                    if not desc.strip():  # "**Couvre** :" followed by a bullet list
                        bullets = [b for b in lines[lines.index(nxt, i) + 1 : i + 14] if b.startswith("- ")]
                        desc = bullets[0][2:] if bullets else ""
                    break
                if not desc and nxt.strip() and not nxt.startswith(("**", "-", "|", ">", "```")):
                    desc = nxt  # short form: a plain paragraph right under the heading
            found[head.group(1)] = (shorten(desc) if desc else "", name)
    return found


BOILERPLATE = (
    "Status", "**Status", "Statut", "**Statut", "Specs", "**Specs", "Codemaps", "**Codemaps",
    "For agentic workers", "Newest entries", "Entrées les plus récentes",
)


def markdown_description(path):
    """Title of the document, followed by its first meaningful "> " quote line."""
    title, quote = "", ""
    with io.open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("# ") and not title:
                title = line[2:].strip()
            elif line.startswith("> ") and len(line.strip()) > 3 and not quote:
                text = line[2:].replace("**", "").strip()
                if not text.startswith(BOILERPLATE):
                    quote = text
            if title and quote:
                break
    feature_sheet = path.startswith("brain/features/") and not path.endswith(("README.md", "_FORMAT.md"))
    if title and quote and not feature_sheet:  # feature sheets open with metadata, not a summary
        return shorten("%s : %s" % (title.rstrip(" ."), quote))
    return shorten(title or quote)


def group_of(path):
    """One group per parent directory ("(root)" for top-level files)."""
    parent = os.path.dirname(path).replace(os.sep, "/")
    return parent or "(root)"


def main():
    check = "--check" in sys.argv
    files = tracked_files()
    cmap = codemap_descriptions()
    groups = OrderedDict()
    missing = []
    for f in files:
        desc, sheet = cmap.get(f, ("", ""))
        if not desc and f.endswith(".md"):
            desc, sheet = markdown_description(f), ""
        if not desc:
            missing.append(f)
            desc = "**(undocumented: add a section in brain/codemap)**"
        groups.setdefault(group_of(f), []).append((f, desc, sheet))

    if check:
        for f in missing:
            print("undocumented:", f)
        print("%d files, %d undocumented" % (len(files), len(missing)))
        sys.exit(1 if missing else 0)

    out = [
        "# Index of every repository file",
        "",
        "> One line per file (%d files): one-sentence role and detailed codemap sheet. **Generated**, do not edit by hand:"
        " `python brain/codemap/build-index.py` (`--check` lists undocumented files). Search it; do not read it end to end." % len(files),
        "",
        "Detail of a code file: open the sheet shown and search for the `## path/to/file` section."
        " Documents: the description is their title and introduction line.",
        "",
    ]
    for group, entries in sorted(groups.items(), key=lambda kv: ("" if kv[0] == "(root)" else kv[0])):
        out.append("## `%s`" % group if group != "(root)" else "## Repository root")
        out.append("")
        for f, desc, sheet in entries:
            ref = " · [%s](codemap/%s)" % (sheet[:-3], sheet) if sheet else ""
            out.append("- `%s` : %s%s" % (f, desc, ref))
        out.append("")
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(out))
    print("wrote brain/INDEX.md: %d files, %d undocumented" % (len(files), len(missing)))


if __name__ == "__main__":
    main()
