#!/usr/bin/env python3
"""Install lihaokun/opencode releases or build the fork using Python 3.9+."""

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

REPOSITORY = "lihaokun/opencode"
API = f"https://api.github.com/repos/{REPOSITORY}"
MODES = ("release", "build")
CHANNELS = ("stable", "beta")
OFFICIAL = ("opencode", "opencode-go")
NUMBER = r"(0|[1-9][0-9]*)"
TAG = re.compile(rf"v{NUMBER}\.{NUMBER}\.{NUMBER}-fmv{NUMBER}(?:\.{NUMBER})?(?:-beta\.{NUMBER})?")


def release_key(tag):
    match = TAG.fullmatch(tag)
    return tuple(int(x or 0) for x in match.groups()) if match else None


def select_release(releases, channel, version=None):
    candidates = [
        item for item in releases
        if release_key(item.get("tag_name", "")) is not None
        and not item.get("draft", False)
        and ("-beta." in item["tag_name"]) == (channel == "beta")
        and (channel == "beta" or not item.get("prerelease", False))
        and (version is None or item["tag_name"] == version)
    ]
    if not candidates:
        raise ValueError(f"No {channel} fork release found" + (f": {version}" if version else ""))
    return max(candidates, key=lambda item: release_key(item["tag_name"]))


def fetch(url, destination=None):
    headers = {"User-Agent": "opencode-fork-installer", "Accept": "application/vnd.github+json"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token and urlparse(url).hostname == "api.github.com":
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, headers=headers), timeout=60) as response:
        if destination is None:
            return response.read().decode("utf-8")
        with destination.open("wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)


def get_release(channel, version=None):
    if version:
        return select_release([json.loads(fetch(f"{API}/releases/tags/{quote(version, safe='')}"))], channel, version)
    releases = []
    page = 1
    while True:
        batch = json.loads(fetch(f"{API}/releases?per_page=100&page={page}"))
        if not isinstance(batch, list):
            raise ValueError("Invalid GitHub releases response")
        if not batch:
            return select_release(releases, channel)
        releases.extend(batch)
        page += 1


def platform_key():
    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}.get(platform.system())
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    if system == "darwin" and arch == "x64":
        translated = subprocess.run(["sysctl", "-in", "sysctl.proc_translated"], capture_output=True, text=True)
        if translated.stdout.strip() == "1":
            arch = "arm64"
    if not system or not arch or (system == "windows" and arch != "x64"):
        raise ValueError("No fork release for this platform; use a supported host or build from source")
    if system == "linux" and platform.libc_ver()[0] != "glibc":
        raise ValueError("Fork release packages require glibc; no musl release is published")
    return f"opencode-{system}-{arch}"


def download_release(release, key, directory):
    suffix = ".zip" if "-windows-" in key else ".tar.gz"
    name = key + suffix
    assets = release.get("assets", [])

    def asset(filename):
        matches = [item for item in assets if item["name"] == filename]
        if len(matches) != 1:
            raise ValueError(f"Release must contain one {filename}")
        url = matches[0]["browser_download_url"]
        if not url.startswith(f"https://github.com/{REPOSITORY}/releases/download/"):
            raise ValueError("Release asset is not hosted by the fork")
        return url

    sums = fetch(asset("sha256sums.txt"))
    digests = re.findall(rf"^([a-fA-F0-9]{{64}}) [ *]{re.escape(name)}\r?$", sums, re.MULTILINE)
    if len(digests) != 1:
        raise ValueError(f"Missing or ambiguous checksum for {name}")
    archive = directory / name
    fetch(asset(name), archive)
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != digests[0].lower():
        raise ValueError(f"Checksum mismatch: {name}")
    return extract_binaries(archive, key, directory)


def extract_binaries(archive, key, directory):
    names = [name + (".exe" if "-windows-" in key else "") for name in ("opencode", "rg")]
    result = []
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            for name in names:
                matches = [item for item in bundle.infolist() if item.filename == f"{key}/bin/{name}"]
                if len(matches) != 1 or matches[0].is_dir() or stat.S_IFMT(matches[0].external_attr >> 16) not in (0, stat.S_IFREG):
                    raise ValueError(f"Missing or invalid archive member: {name}")
                target = directory / name
                with bundle.open(matches[0]) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                result.append(target)
    else:
        with tarfile.open(archive, "r:gz") as bundle:
            for name in names:
                matches = [item for item in bundle.getmembers() if item.name == f"{key}/bin/{name}"]
                if len(matches) != 1 or not matches[0].isfile():
                    raise ValueError(f"Missing or invalid archive member: {name}")
                target = directory / name
                with bundle.extractfile(matches[0]) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                result.append(target)
    for target in result:
        target.chmod(0o755)
    return result


def run(command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


def build_source(source, ref, directory):
    for command in ("git", "bun", "rg"):
        if not shutil.which(command):
            raise ValueError(f"Source builds require {command} on PATH")
    if source is None:
        source = directory / "source"
        subprocess.run(["git", "clone", "--depth", "1", "--branch", ref or "dev", "--",
                        f"https://github.com/{REPOSITORY}.git", str(source)], check=True)
    source = source.resolve()
    required = json.loads((source / "package.json").read_text(encoding="utf-8"))["packageManager"]
    if required != "bun@" + run(["bun", "--version"]):
        raise ValueError(f"This checkout requires {required}; install that Bun version first")
    commit = run(["git", "rev-parse", "--short=12", "HEAD"], source)
    dirty = bool(run(["git", "status", "--porcelain"], source))
    version = f"0.0.0-source.g{commit}" + (".dirty" if dirty else "")
    host = run(["bun", "-e", "console.log(JSON.stringify({os:process.platform,arch:process.arch}))"], source)
    host = json.loads(host)
    system = "windows" if host["os"] == "win32" else host["os"]
    if system == "linux" and platform.libc_ver()[0] != "glibc":
        raise ValueError("The repository's --single build targets glibc, not musl")
    # The shared build script uploads releases when this flag is nonempty.
    # Keep an explicit empty value so a checkout's .env cannot re-enable it.
    env = dict(os.environ, OPENCODE_CHANNEL="dev", OPENCODE_VERSION=version,
               OPENCODE_RELEASE="", OPENCODE_DISABLE_AUTOUPDATE="1")
    subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=source, env=env, check=True)
    package = source / "packages" / "opencode"
    subprocess.run(["bun", "run", "script/build.ts", "--single", "--skip-install"], cwd=package, env=env, check=True)
    extension = ".exe" if system == "windows" else ""
    binary = package / "dist" / f"opencode-{system}-{host['arch']}" / "bin" / ("opencode" + extension)
    targets = [directory / (name + extension) for name in ("opencode", "rg")]
    shutil.copy2(binary, targets[0])
    shutil.copy2(shutil.which("rg"), targets[1])
    return targets, version


def parse_jsonc(text):
    # Mask, rather than remove, comments/trailing commas to preserve edit offsets.
    tokens = r'"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*[\s\S]*?\*/'
    masked = re.sub(tokens, lambda m: m[0] if m[0].startswith('"') else re.sub(r"[^\r\n]", " ", m[0]), text)
    if masked.startswith("\ufeff"):
        masked = " " + masked[1:]
    masked = re.sub(r'"(?:\\.|[^"\\])*"|,\s*(?=[}\]])',
                    lambda m: m[0] if m[0].startswith('"') else " " + m[0][1:], masked)
    def invalid_constant(_):
        raise ValueError("JSON constants must be null, true or false")

    decoder = json.JSONDecoder(parse_constant=invalid_constant)
    value = decoder.decode(masked)
    if not isinstance(value, dict):
        raise ValueError("Config must be a JSON object")
    cursor = masked.index("{") + 1
    start = cursor
    spans = {}
    last = start
    while True:
        cursor += len(masked[cursor:]) - len(masked[cursor:].lstrip())
        if masked[cursor] == "}":
            return value, spans, last
        key, cursor = decoder.raw_decode(masked, cursor)
        cursor = masked.index(":", cursor) + 1
        cursor += len(masked[cursor:]) - len(masked[cursor:].lstrip())
        begin = cursor
        _, cursor = decoder.raw_decode(masked, cursor)
        spans[key] = (begin, cursor)
        last = cursor
        cursor += len(masked[cursor:]) - len(masked[cursor:].lstrip())
        if masked[cursor] == ",":
            cursor += 1


def update_config(text, disabled):
    value, spans, last = parse_jsonc(text)
    changes = {"autoupdate": False, "disabled_providers": list(dict.fromkeys([*disabled, *OFFICIAL]))}
    edits = []
    additions = []
    for key, item in changes.items():
        encoded = json.dumps(item)
        if key in spans:
            edits.append((*spans[key], encoded))
        else:
            additions.append(f'  "{key}": {encoded}')
    if additions:
        newline = "\r\n" if "\r\n" in text else "\n"
        edits.append((last, last, ("," if value else "") + newline + ("," + newline).join(additions)))
    for begin, end, replacement in sorted(edits, reverse=True):
        text = text[:begin] + replacement + text[end:]
    return text


def prepare_config(directory):
    # Runtime imports this legacy TOML file after JSONC and can override our defaults.
    if (directory / "config").exists():
        raise ValueError(f"Migrate legacy TOML {directory / 'config'} to JSON/JSONC first, then rerun the installer")
    target = directory / "opencode.json"
    text = "{\n}\n"
    disabled = []
    for name in ("config.json", "opencode.json", "opencode.jsonc"):
        candidate = directory / name
        if not candidate.exists() and not candidate.is_symlink():
            continue
        target = candidate.resolve(strict=True)
        text = target.read_bytes().decode("utf-8")
        try:
            value, _, _ = parse_jsonc(text)
        except (ValueError, IndexError) as error:
            raise ValueError(f"Invalid JSONC config: {candidate}; repair it before installing") from error
        if "disabled_providers" in value:
            disabled = value["disabled_providers"]
            if not isinstance(disabled, list) or not all(isinstance(item, str) for item in disabled):
                raise ValueError(f"disabled_providers must be a string array: {candidate}")
    return target, update_config(text, disabled).encode("utf-8")


def install_files(binaries, install_dir, config):
    # Stage beside each destination so os.replace never crosses filesystems.
    staged = []
    applied = []
    backups = []
    keep_backups = False
    try:
        for destination, source in [(config[0], config[1]), *[(install_dir / item.name, item) for item in binaries]]:
            destination.parent.mkdir(parents=True, exist_ok=True)
            mode = 0o600 if isinstance(source, bytes) else 0o755
            backup = None
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_file():
                    raise ValueError(f"Installation target must be a regular file: {destination}")
                mode = stat.S_IMODE(destination.stat().st_mode) if isinstance(source, bytes) else mode
                descriptor, name = tempfile.mkstemp(prefix=".fm-backup-", dir=destination.parent)
                os.close(descriptor)
                backup = Path(name)
                backups.append(backup)
                shutil.copy2(destination, backup)
            descriptor, name = tempfile.mkstemp(prefix=".fm-install-", dir=destination.parent)
            os.close(descriptor)
            temporary = Path(name)
            staged.append((destination, temporary, backup))
            if isinstance(source, bytes):
                temporary.write_bytes(source)
            else:
                shutil.copyfile(source, temporary)
            temporary.chmod(mode)
        for destination, temporary, backup in staged:
            os.replace(temporary, destination)
            applied.append((destination, backup))
    except BaseException:
        for destination, backup in reversed(applied):
            try:
                if backup:
                    os.replace(backup, destination)
                else:
                    destination.unlink()
            except OSError:
                keep_backups = True
                print(f"Rollback failed for {destination}; saved copies: {backups}", file=sys.stderr)
        raise
    finally:
        for _, temporary, _ in staged:
            temporary.unlink(missing_ok=True)
        if not keep_backups:
            for backup in backups:
                backup.unlink(missing_ok=True)


def configure_path(directory):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            try:
                current, kind = winreg.QueryValueEx(key, "Path")
            except FileNotFoundError:
                current, kind = "", winreg.REG_EXPAND_SZ
            if str(directory).lower() not in [item.rstrip("\\").lower() for item in current.split(";")]:
                winreg.SetValueEx(key, "Path", 0, kind, str(directory) + ";" + current)
                broadcast = ctypes.windll.user32.SendMessageTimeoutW
                broadcast.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPCWSTR,
                                      wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
                broadcast.restype = wintypes.LPARAM
                if not broadcast(0xFFFF, 0x1A, 0, "Environment", 2, 5000, None):
                    raise OSError("PATH saved, but environment broadcast failed; sign out and back in")
        return
    shell = Path(os.environ.get("SHELL", "sh")).name
    if shell == "fish":
        profile = Path(os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")) / "fish" / "config.fish"
        command = f"fish_add_path --prepend {shlex.quote(str(directory))}"
    else:
        profile = Path.home() / {"bash": ".bashrc", "zsh": ".zshrc"}.get(shell, ".profile")
        command = f'export PATH={shlex.quote(str(directory))}:"$PATH"'
    text = profile.read_bytes() if profile.exists() else b""
    if command.encode("utf-8") in text.splitlines():
        return
    profile.parent.mkdir(parents=True, exist_ok=True)
    with profile.open("ab") as output:
        output.write(f"\n# lihaokun/opencode\n{command}\n".encode("utf-8"))


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=MODES, default="release")
    parser.add_argument("--channel", choices=CHANNELS, help="release channel (default: stable)")
    parser.add_argument("--version", help="exact fork release tag, with or without v")
    parser.add_argument("--ref", help="fork branch/tag to clone for build (default: dev)")
    parser.add_argument("--source", type=Path, help="build a local checkout without switching branches")
    parser.add_argument("--install-dir", type=Path, default=Path.home() / ".opencode" / "bin")
    parser.add_argument("--config-dir", type=Path,
                        default=Path(os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")) / "opencode")
    parser.add_argument("--no-modify-path", action="store_true")
    args = parser.parse_args(argv)
    if args.mode == "build" and (args.channel or args.version):
        parser.error("--channel and --version are release-only; use --ref for builds")
    if args.mode == "release" and (args.source or args.ref):
        parser.error("--source and --ref require --mode build")
    if args.source and args.ref:
        parser.error("--source and --ref cannot be combined")
    if args.version:
        args.version = args.version if args.version.startswith("v") else "v" + args.version
        if release_key(args.version) is None:
            parser.error("--version must be a fork release tag (v<upstream>-fmv<N>[.<M>][-beta.<k>])")
        channel = "beta" if "-beta." in args.version else "stable"
        if args.channel and args.channel != channel:
            parser.error("--channel conflicts with --version")
        args.channel = channel
    args.channel = args.channel or "stable"
    args.install_dir = args.install_dir.expanduser().absolute()
    args.config_dir = args.config_dir.expanduser().absolute()
    if args.source:
        args.source = args.source.expanduser().absolute()
    return args


def main(argv=None):
    # Step P1: validate arguments and existing configuration before downloading/building.
    args = arguments(argv)
    config = prepare_config(args.config_dir)
    with tempfile.TemporaryDirectory(prefix="opencode-fm-install-") as temporary:
        directory = Path(temporary)
        # Step P2: prepare the fork program; never fall back to an upstream installer.
        if args.mode == "build":
            binaries, version = build_source(args.source, args.ref, directory)
        else:
            key = platform_key()
            release = get_release(args.channel, args.version)
            version = release["tag_name"][1:]
            print(f"Downloading {release['tag_name']} ({key})", flush=True)
            binaries = download_release(release, key, directory)
        # Step P3: reject incompatible/corrupt executables before replacing an installation.
        actual = run([str(binaries[0]), "--version"], directory,
                     dict(os.environ, OPENCODE_DISABLE_AUTOUPDATE="1"))
        if actual != version:
            raise ValueError(f"Binary version mismatch: expected {version}, got {actual}")
        run([str(binaries[1]), "--version"], directory)
        # Step P4: both modes share the same global defaults and installation path.
        install_files(binaries, args.install_dir, config)
    # Step P5: user PATH and installation report.
    if not args.no_modify_path:
        try:
            configure_path(args.install_dir)
        except OSError as error:
            print(f"Installed, but could not update PATH ({error}). Add {args.install_dir} to your user PATH.", file=sys.stderr)
    print(f"Installed {version} to {args.install_dir}")
    print(f"Config: {config[0]} (official auto-update and opencode/opencode-go disabled)")
    print(f"Open a new terminal with {args.install_dir} first on PATH; run opencode --version.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        sys.exit(1)
