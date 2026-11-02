"""Release publishing rejects incomplete metadata and uses only its version's notes."""

from pathlib import Path

import pytest

from app.version import __version__
from scripts.release_notes import release_notes


def test_current_version_has_publishable_changelog_notes():
    changelog = Path(__file__).resolve().parents[1] / "CHANGELOG.md"
    assert release_notes(changelog.read_text(encoding="utf-8"), __version__).startswith(
        f"## {__version__} — "
    )


def test_release_notes_select_matching_section():
    changelog = (
        "# Changelog\n\n## Unreleased\n\n- Pending work.\n\n"
        "## 0.4.0 — 2026-10-06\n\n- Require body-based activation.\n- Keep keys.\n\n"
        "## 0.3.3 — 2026-09-27\n\n- Older change.\n"
    )
    assert release_notes(changelog, "0.4.0") == (
        "## 0.4.0 — 2026-10-06\n\n- Require body-based activation.\n- Keep keys.\n"
    )


def test_release_notes_keep_backend_and_client_subsections():
    changelog = (
        "# Changelog\n\n## 0.5.0 — 2026-11-01\n\n### Backend\n\n- Server change.\n\n"
        "### Web\n\n- Client change.\n- Another.\n\n## 0.4.0 — 2026-10-06\n\n- Older.\n"
    )
    assert release_notes(changelog, "0.5.0") == (
        "## 0.5.0 — 2026-11-01\n\n### Backend\n\n- Server change.\n\n"
        "### Web\n\n- Client change.\n- Another.\n"
    )


@pytest.mark.parametrize("body", [
    "### Backend\n\n### Web\n\n- Empty backend.\n",
    "### Backend\n\n- One.\n\n### Backend\n\n- Duplicate.\n",
    "- Loose bullet.\n\n### Web\n\n- Grouped.\n",
    "### Web\n",
    "### Other\n\n- Unknown subsection.\n",
])
def test_release_notes_reject_malformed_subsections(body):
    with pytest.raises(ValueError):
        release_notes(f"## 0.5.0 — 2026-11-01\n\n{body}", "0.5.0")


@pytest.mark.parametrize("version", ["v0.4.0", "0.4", "0.04.0", "0.4.0\n", "0.4.0-beta"])
def test_release_notes_reject_invalid_version(version):
    with pytest.raises(ValueError, match="MAJOR.MINOR.PATCH"):
        release_notes("## 0.4.0 — 2026-10-06\n\n- Change.\n", version)


@pytest.mark.parametrize(
    "changelog",
    [
        "## 0.4.1 — 2026-10-06\n\n- Wrong version.\n",
        "## 0.4.0 — 2026-10-06\n- One.\n## 0.4.0 — 2026-10-07\n- Duplicate.\n",
        "## 0.4.0\n\n- Missing date.\n",
        "## 0.4.0 — 2026-02-30\n\n- Invalid date.\n",
        "## 0.4.0 — 2026-10-06\n\n## 0.3.3\n- Older change.\n",
        "## 0.4.0 — 2026-10-06\n\n- \n",
        "## 0.4.0 — 2026-10-06\n\n- Change\n  wrapped across lines.\n",
        "## \n\n- Malformed heading.\n",
    ],
)
def test_release_notes_reject_incomplete_or_ambiguous_section(changelog):
    with pytest.raises(ValueError):
        release_notes(changelog, "0.4.0")
