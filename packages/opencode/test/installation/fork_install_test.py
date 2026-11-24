"""Installer boundary tests; called by Bun CI and runnable with Python directly."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[4] / "script" / "fm-install.py"
SPEC = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    def test_arguments(self):
        self.assertEqual(installer.arguments([]).channel, "stable")
        self.assertEqual(installer.arguments([]).mode, "release")
        self.assertEqual(installer.arguments(["--version", "1.18.31-fmv3-beta.18"]).channel, "beta")
        for argv in (["--mode", "build", "--channel", "stable"],
                     ["--mode", "build", "--version", "v1.2.3-fmv2"],
                     ["--ref", "dev"], ["--source", "."],
                     ["--mode", "build", "--source", ".", "--ref", "dev"],
                     ["--channel", "stable", "--version", "v1.2.3-fmv2-beta.1"],
                     ["--version", "v1.2.3"], ["--version", "v1.2.3-fmv2.01"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                installer.arguments(argv)

    def test_empty_xdg_config_home_falls_back_to_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(installer.Path, "home", return_value=directory), patch.dict(os.environ, {"XDG_CONFIG_HOME": "", "SHELL": "/usr/bin/fish"}):
                self.assertEqual(installer.arguments([]).config_dir, directory / ".config/opencode")
                if os.name != "nt":
                    installer.configure_path(directory / "bin")
                    self.assertTrue((directory / ".config/fish/config.fish").is_file())

    def test_legacy_toml_rejected_before_installing(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            config = directory / "config"
            original = 'autoupdate = true\ndisabled_providers = ["custom"]\n'
            config.write_text(original)
            with self.assertRaisesRegex(ValueError, "Migrate legacy TOML"):
                installer.prepare_config(directory)
            self.assertEqual(config.read_text(), original)
            self.assertFalse((directory / "opencode.json").exists())

    def test_release_selection_and_pagination(self):
        releases = [
            {"tag_name": "v1.18.31-fmv2.1"},
            {"tag_name": "v1.18.31-fmv3-beta.9", "prerelease": True},
            {"tag_name": "v1.18.31-fmv3-beta.18"},
            {"tag_name": "v1.18.31-fmv4", "draft": True},
            {"tag_name": "v1.18.31-fmv4.1", "prerelease": True},
            {"tag_name": "v99.0.0"},
        ]
        with patch.object(installer, "fetch", side_effect=[json.dumps(releases[:2]), json.dumps(releases[2:]), "[]"]) as fetch:
            self.assertEqual(installer.get_release("beta")["tag_name"], "v1.18.31-fmv3-beta.18")
            self.assertEqual(fetch.call_count, 3)
        self.assertEqual(installer.select_release(releases, "stable")["tag_name"], "v1.18.31-fmv2.1")
        with self.assertRaises(ValueError):
            installer.select_release(releases, "beta", "v1.18.31-fmv2.1")

    def test_config_precedence_and_comments(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "config.json").write_text('{"disabled_providers":["old"]}')
            (directory / "opencode.json").write_text('{"disabled_providers":["private-disabled"],"model":"fm/glm"}')
            original = '\ufeff{\r\n // keep credentials and strings exactly\r\n "provider":{"fm":{"apiKey":"{env:KEY}","url":"http://host/a//b/*x*/"}},\r\n "autoupdate": true,\r\n}\r\n'
            (directory / "opencode.jsonc").write_bytes(original.encode())
            target, result = installer.prepare_config(directory)
            parsed = installer.parse_jsonc(result.decode())[0]
            self.assertEqual(target.name, "opencode.jsonc")
            self.assertEqual(parsed["disabled_providers"], ["private-disabled", "opencode", "opencode-go"])
            self.assertIs(parsed["autoupdate"], False)
            self.assertIn('"provider":{"fm":{"apiKey":"{env:KEY}","url":"http://host/a//b/*x*/"}}', result.decode())
            self.assertIn("// keep credentials and strings exactly\r\n", result.decode())
            self.assertEqual(result.decode(), installer.update_config(result.decode(), parsed["disabled_providers"]))
            self.assertEqual((directory / "opencode.jsonc").read_bytes(), original.encode())

    def test_invalid_config_and_new_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            target, data = installer.prepare_config(directory)
            self.assertFalse(target.exists())
            self.assertEqual(json.loads(data), {"autoupdate": False, "disabled_providers": ["opencode", "opencode-go"]})
            for value in ('{"secret":"dont-print",', '[]', '{"disabled_providers":true}', '{"model":NaN}', '{"model":Infinity}'):
                target.write_text(value)
                with self.assertRaises(ValueError) as error:
                    installer.prepare_config(directory)
                self.assertNotIn("dont-print", str(error.exception))

    def test_escaped_unicode_and_top_level_duplicate_keys(self):
        text = '{"autoupdate":true,"autoupdate":"notify","disabled_providers":["\\ud800"],}'
        result = installer.update_config(text, ["\ud800"])
        result.encode("utf-8")
        value = installer.parse_jsonc(result)[0]
        self.assertIs(value["autoupdate"], False)
        self.assertEqual(value["disabled_providers"], ["\ud800", "opencode", "opencode-go"])

    @unittest.skipIf(os.name == "nt", "Unix shell profile behavior")
    def test_path_preserves_non_utf8_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = b"# legacy comment: \xff\n"
            profile = directory / ".bashrc"
            profile.write_bytes(original)
            target = directory / "path with 'quotes' and $sign"
            with patch.object(installer.Path, "home", return_value=directory), patch.dict(os.environ, {"SHELL": "/bin/bash"}):
                installer.configure_path(target)
                once = profile.read_bytes()
                installer.configure_path(target)
            self.assertTrue(once.startswith(original))
            self.assertEqual(profile.read_bytes(), once)
            command = once.decode("utf-8", errors="surrogateescape").splitlines()[-1]
            actual = subprocess.check_output(["bash", "-c", command + '\ncommand -p printf "%s" "$PATH"'])
            self.assertTrue(actual.startswith(str(target).encode() + b":"))

    @unittest.skipIf(os.name == "nt", "Symlink creation can require Windows privileges")
    def test_config_symlink_keeps_link_and_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = directory / "actual.jsonc"
            original.write_text('{"provider":{"fm":{}}}')
            original.chmod(0o640)
            link = directory / "opencode.jsonc"
            link.symlink_to(original)
            config = installer.prepare_config(directory)
            installer.install_files([], directory / "bin", config)
            self.assertTrue(link.is_symlink())
            self.assertEqual(original.stat().st_mode & 0o777, 0o640)
            self.assertIs(json.loads(original.read_text())["autoupdate"], False)

    def test_archives_and_checksum(self):
        for key in ("opencode-linux-x64", "opencode-darwin-arm64", "opencode-windows-x64"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                archive = self.archive(directory, key)
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                assets = [{"name": name, "browser_download_url": f"https://github.com/lihaokun/opencode/releases/download/v1.2.3-fmv2/{name}"}
                          for name in (archive.name, "sha256sums.txt")]

                def fetch(url, destination=None):
                    if destination:
                        # Fixture is already at the destination, as if downloaded.
                        self.assertEqual(destination, archive)
                        return
                    return f"{digest}  {archive.name}\n"

                with patch.object(installer, "fetch", side_effect=fetch):
                    files = installer.download_release({"assets": assets}, key, directory)
                    self.assertEqual([file.read_bytes() for file in files], [b"opencode binary", b"rg binary"])
                    digest = "0" * 64
                    with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
                        installer.download_release({"assets": assets}, key, directory)
                self.assertFalse((directory.parent / "escape").exists())

    def archive(self, directory, key, invalid=None):
        windows = "windows" in key
        archive = directory / (key + (".zip" if windows else ".tar.gz"))
        if windows:
            with zipfile.ZipFile(archive, "w") as bundle:
                for name in ("opencode", "rg"):
                    item = zipfile.ZipInfo(f"{key}/bin/{name}.exe")
                    if invalid == "link" and name == "opencode":
                        item.create_system = 3
                        item.external_attr = 0o120777 << 16
                    bundle.writestr(item, f"{name} binary")
                bundle.writestr("../../escape", "must not extract")
        else:
            with tarfile.open(archive, "w:gz") as bundle:
                for name in ("opencode", "rg"):
                    data = f"{name} binary".encode()
                    item = tarfile.TarInfo(f"{key}/bin/{name}")
                    item.size = len(data)
                    if invalid == "link" and name == "opencode":
                        item.type = tarfile.SYMTYPE
                        item.linkname = "../../escape"
                    bundle.addfile(item, io.BytesIO(data))
                item = tarfile.TarInfo("../../escape")
                bundle.addfile(item)
        return archive

    def test_reject_links_and_missing_members(self):
        for key in ("opencode-linux-x64", "opencode-windows-x64"):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                archive = self.archive(directory, key, "link")
                with self.assertRaises(ValueError):
                    installer.extract_binaries(archive, key, directory)
                with self.assertRaises(ValueError):
                    installer.extract_binaries(archive, key + "-wrong", directory)

    def test_install_and_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            binary = directory / "staging" / "opencode"
            binary.parent.mkdir()
            binary.write_bytes(b"new binary")
            target = directory / "install" / "opencode"
            target.parent.mkdir()
            target.write_bytes(b"old binary")
            config = directory / "config.json"
            config.write_bytes(b"old config")
            replace = os.replace

            def fail(source, destination):
                if destination == target:
                    raise PermissionError("binary locked")
                return replace(source, destination)

            with patch.object(installer.os, "replace", side_effect=fail), self.assertRaises(PermissionError):
                installer.install_files([binary], target.parent, (config, b"new config"))
            self.assertEqual(target.read_bytes(), b"old binary")
            self.assertEqual(config.read_bytes(), b"old config")
            self.assertEqual(list(directory.rglob(".fm-*")), [])
            installer.install_files([binary], target.parent, (config, b"new config"))
            self.assertEqual(target.read_bytes(), b"new binary")
            self.assertEqual(config.read_bytes(), b"new config")

    def test_build_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "checkout with spaces"
            source.mkdir()
            (source / "package.json").write_text('{"packageManager":"bun@1.4.4"}')
            binary = source / "packages/opencode/dist/opencode-linux-x64/bin/opencode"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"compiled fork")
            rg = directory / "existing-rg"
            rg.write_bytes(b"ripgrep")
            replies = ["1.4.4", "abc123", " M local-change", '{"os":"linux","arch":"x64"}']
            with patch.dict(os.environ, {"OPENCODE_RELEASE": "1", "OPENCODE_CHANNEL": "main", "OPENCODE_VERSION": "bad-version"}), \
                 patch.object(installer.shutil, "which", return_value=str(rg)), patch.object(installer, "run", side_effect=replies), \
                 patch.object(installer.subprocess, "run") as execute, patch.object(installer.platform, "libc_ver", return_value=("glibc", "2.39")):
                files, version = installer.build_source(source, None, directory)
                self.assertEqual(version, "0.0.0-source.gabc123.dirty")
                self.assertEqual([item.read_bytes() for item in files], [b"compiled fork", b"ripgrep"])
                self.assertEqual([call.args[0] for call in execute.call_args_list], [
                    ["bun", "install", "--frozen-lockfile"],
                    ["bun", "run", "script/build.ts", "--single", "--skip-install"],
                ])
                for call in execute.call_args_list:
                    self.assertEqual(call.kwargs["env"]["OPENCODE_CHANNEL"], "dev")
                    self.assertEqual(call.kwargs["env"]["OPENCODE_VERSION"], version)
                    self.assertEqual(call.kwargs["env"]["OPENCODE_RELEASE"], "")

    def test_both_modes_share_config_and_install(self):
        for mode in installer.MODES:
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                binaries = [directory / "opencode", directory / "rg"]
                for binary in binaries:
                    binary.write_bytes(b"staged")
                args = ["--mode", mode, "--install-dir", str(directory / "bin"),
                        "--config-dir", str(directory / "config"), "--no-modify-path"]
                with patch.object(installer, "build_source", return_value=(binaries, "1.2.3-fmv2")), \
                     patch.object(installer, "get_release", return_value={"tag_name": "v1.2.3-fmv2"}), \
                     patch.object(installer, "download_release", return_value=binaries), \
                     patch.object(installer, "platform_key", return_value="opencode-linux-x64"), \
                     patch.object(installer, "run", side_effect=["1.2.3-fmv2", "rg 15.1"]), \
                     patch.object(installer, "configure_path") as path, contextlib.redirect_stdout(io.StringIO()):
                    installer.main(args)
                    path.assert_not_called()
                config = json.loads((directory / "config/opencode.json").read_text())
                self.assertEqual(config, {"autoupdate": False, "disabled_providers": ["opencode", "opencode-go"]})
                self.assertEqual((directory / "bin/opencode").read_bytes(), b"staged")

    def test_preparation_and_version_failures_leave_install_unchanged(self):
        for failure in ("download", "build", "version"):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                binary = directory / "bin/opencode"
                binary.parent.mkdir()
                binary.write_bytes(b"old executable")
                config = directory / "config/opencode.json"
                config.parent.mkdir()
                config.write_bytes(b'{"autoupdate":true}')
                with patch.object(installer, "get_release", return_value={"tag_name": "v1.2.3-fmv2"}), \
                     patch.object(installer, "platform_key", return_value="opencode-linux-x64"), \
                     patch.object(installer, "build_source", side_effect=ValueError("build failed")), \
                     patch.object(installer, "download_release", side_effect=ValueError("download failed") if failure == "download" else None,
                                  return_value=[binary, binary]), \
                     patch.object(installer, "run", return_value="wrong-version"), contextlib.redirect_stdout(io.StringIO()), \
                     self.assertRaises(ValueError):
                    installer.main(["--mode", "build" if failure == "build" else "release", "--install-dir", str(binary.parent),
                                    "--config-dir", str(config.parent), "--no-modify-path"])
                self.assertEqual(binary.read_bytes(), b"old executable")
                self.assertEqual(config.read_bytes(), b'{"autoupdate":true}')


if __name__ == "__main__":
    if "--properties" in sys.argv:
        for line in sys.stdin:
            item = json.loads(line)
            if item["kind"] == "config":
                result = installer.update_config(item["text"], item["disabled"])
                value = installer.parse_jsonc(result)[0]
                print(json.dumps({"text": result, "value": value,
                                  "again": installer.update_config(result, value["disabled_providers"])}), flush=True)
            else:
                print(json.dumps(installer.select_release(item["releases"], item["channel"])), flush=True)
    else:
        unittest.main()
