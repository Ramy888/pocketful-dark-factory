#!/usr/bin/env python3
"""Flag task-specific detail in seat mandates.

A mandate must stay generic: no endpoint paths, field names, error codes, test ids or
domain vocabulary. Terms come from three sources:

  structure  patterns that are never generic (URL paths, the test-id attribute)
  seed       seed-terms.txt, a placeholder vocabulary list for use before a spec exists
  spec       tokens derived from the specification files passed with --spec

Code-shaped spec tokens (ERR_X, sender_id, spin-submit) and whole paths (/a/b) are
errors. Plain-word spec tokens (memo), bare path segments (the word `requests` from
`/requests`) and status-code-like numbers are warnings, because a generic word can also
be ordinary English. Exit status is 1 on any error, or on any warning with --strict.

The required `Harness:` and `Model:` field names are exempt; their values are not.

Usage: lint_mandates.py MANDATE... [--spec SPEC...] [--seed FILE] [--strict]
"""

import argparse
import re
import sys
from pathlib import Path

DEFAULT_SEED = Path(__file__).resolve().parent / "seed-terms.txt"

# The lookbehind skips "a/b" words and "@owner/handle" / "@<owner>/handle" band handles.
URL_PATH = re.compile(r"(?<![\w.:/>])/[A-Za-z{][\w{}:.\-]*(?:/[\w{}:.\-]+)*")
TEST_ID_ATTR = re.compile(r"data-testid", re.IGNORECASE)
STATUS_CODE = re.compile(r"\b[1-5]\d\d\b")

BACKTICK = re.compile(r"`([^`\n]+)`")
JSON_KEY = re.compile(r"[\"']([A-Za-z_][\w\-]*)[\"']\s*:")
UPPER_SNAKE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
TEST_ID_VALUE = re.compile(r"data-testid\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE)
PATH_PARAM = re.compile(r"^[{:]|[{}]")
PLAIN_WORD = re.compile(r"^[a-z]+$")

# The grader requires every mandate to declare the harness and model its seat runs, and
# `harness` is itself a seed term, so the required field names have to be exempt or every
# mandate fails on the line the grader asked for. Only the field name is exempt: the value
# is still linted, so `Model: /a/b` and `Model: the wallet runner` are still caught. The
# shape is the one the grader's own scan accepts, anchored so prose cannot reach it.
SEAT_HEADER = re.compile(r"^[-*_ \t]*(?:Harness|Model)[*_ \t]*:", re.IGNORECASE)


def load_seed(path):
    terms = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            terms.append(line)
    return terms


def spec_tokens(spec_paths):
    """Return (code_tokens, path_segments, plain_words) derived from the spec."""
    code, segments, plain = set(), set(), set()
    for spec in spec_paths:
        text = Path(spec).read_text()
        candidates = set()
        for span in BACKTICK.findall(text):
            candidates.update(span.split())
        candidates.update(JSON_KEY.findall(text))
        candidates.update(UPPER_SNAKE.findall(text))
        candidates.update(TEST_ID_VALUE.findall(text))
        for path in URL_PATH.findall(text):
            candidates.add(path)
            segments.update(
                seg for seg in path.strip("/").split("/")
                if seg and not PATH_PARAM.search(seg) and len(seg) > 2
            )
        for token in candidates:
            token = token.strip(".,;:()[]\"'")
            if len(token) < 3:
                continue
            (plain if PLAIN_WORD.match(token) else code).add(token)
    plain -= {s.lower() for s in segments}
    return code, segments, plain


def whole_word(term, flags=0):
    return re.compile(r"(?<![\w\-])" + re.escape(term) + r"(?![\w\-])", flags)


def lint(mandate_paths, seed_terms, spec_paths):
    code, segments, plain = spec_tokens(spec_paths) if spec_paths else (set(), set(), set())
    rules = [("ERROR", "structure", "url path", URL_PATH),
             ("ERROR", "structure", "test-id attribute", TEST_ID_ATTR),
             ("WARN", "structure", "status-code-like number", STATUS_CODE)]
    rules += [("ERROR", "seed", t, whole_word(t, re.IGNORECASE)) for t in seed_terms]
    rules += [("ERROR", "spec", t, whole_word(t)) for t in sorted(code)]
    # A bare path segment warns rather than errors. The graders ban `/requests`, not the
    # word `requests`: their term list deliberately omits plain words the spec happens to
    # use, because banning those would fail every entry. The full path is still an error
    # through the structure rule above, so the real signal is kept.
    rules += [("WARN", "spec path", t, whole_word(t, re.IGNORECASE)) for t in sorted(segments)]
    rules += [("WARN", "spec word", t, whole_word(t, re.IGNORECASE)) for t in sorted(plain)]

    findings = []
    for path in mandate_paths:
        for lineno, line in enumerate(Path(path).read_text().splitlines(), 1):
            # Blank out the required field name, keeping the offsets of everything after
            # it so a finding still points at the right place on the line.
            scanned = SEAT_HEADER.sub(lambda m: " " * len(m.group(0)), line, count=1)
            for level, source, label, pattern in rules:
                for match in pattern.finditer(scanned):
                    findings.append((level, f"{path}:{lineno}: {level} [{source}] "
                                            f"{match.group(0)!r} ({label}): {line.strip()}"))
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mandates", nargs="+")
    parser.add_argument("--spec", nargs="+", default=[])
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)

    findings = lint(args.mandates, load_seed(args.seed), args.spec)
    for _, message in findings:
        print(message)
    errors = sum(1 for level, _ in findings if level == "ERROR")
    warnings = len(findings) - errors
    print(f"{len(args.mandates)} file(s): {errors} error(s), {warnings} warning(s)")
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
