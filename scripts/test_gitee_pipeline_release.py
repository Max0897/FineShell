import json
import tempfile
import unittest
from pathlib import Path

from gitee_pipeline_release import (
    GiteeAttachment,
    ReleaseError,
    create_gitee_updater_manifest,
    load_trigger,
)


GITEE_URL = (
    "https://gitee.com/api/v5/repos/Max0897/FineShell/"
    "releases/42/attach_files/7/download"
)


class TriggerTests(unittest.TestCase):
    def test_loads_valid_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trigger.json"
            path.write_text(
                json.dumps(
                    {
                        "tag": "v1.2.3",
                        "commit": "a" * 40,
                        "github_repository": "Max0897/fineshell",
                    }
                ),
                encoding="utf-8",
            )
            trigger = load_trigger(path)
        self.assertEqual(trigger.tag, "v1.2.3")
        self.assertEqual(trigger.github_repository, "Max0897/fineshell")

    def test_rejects_invalid_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trigger.json"
            path.write_text('{"tag":"latest"}', encoding="utf-8")
            with self.assertRaises(ReleaseError):
                load_trigger(path)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.platforms = {
            "darwin-aarch64": self._platform("mac-arm.tar.gz"),
            "darwin-x86_64": self._platform("mac-x64.tar.gz"),
            "linux-x86_64-deb": self._platform("linux-x64.deb"),
            "linux-aarch64-deb": self._platform("linux-arm.deb"),
            "windows-x86_64-nsis": self._platform("windows-x64.exe"),
            "windows-aarch64-nsis": self._platform("windows-arm.exe"),
        }

    @staticmethod
    def _platform(name):
        return {
            "signature": "signed",
            "url": f"https://github.com/Max0897/fineshell/releases/download/v1.2.3/{name}",
        }

    def _attachments(self):
        return [
            GiteeAttachment(name=name, size=1, download_url=GITEE_URL)
            for name in (
                "mac-arm.tar.gz",
                "mac-x64.tar.gz",
                "linux-x64.deb",
                "linux-arm.deb",
                "windows-x64.exe",
                "windows-arm.exe",
            )
        ]

    def test_maps_updater_urls_to_gitee_attachments(self):
        result = create_gitee_updater_manifest(
            {"version": "1.2.3", "platforms": self.platforms},
            self._attachments(),
            "v1.2.3",
        )
        self.assertTrue(
            all(
                value["url"] == GITEE_URL
                for value in result["platforms"].values()
            )
        )

    def test_rejects_missing_attachment(self):
        with self.assertRaisesRegex(ReleaseError, "缺少更新附件"):
            create_gitee_updater_manifest(
                {"version": "1.2.3", "platforms": self.platforms},
                self._attachments()[:-1],
                "v1.2.3",
            )

    def test_rejects_version_mismatch(self):
        with self.assertRaisesRegex(ReleaseError, "版本"):
            create_gitee_updater_manifest(
                {"version": "1.2.4", "platforms": self.platforms},
                self._attachments(),
                "v1.2.3",
            )


if __name__ == "__main__":
    unittest.main()
