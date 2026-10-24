"""Build original upstream Rust extensions for Chaquopy 17.1 / CPython 3.13.

Run on Linux with Java, Android SDK, Rust Android targets, and cibuildwheel
4.3.4. --prepare-only verifies and extracts the small upstream source archive
without downloading an SDK or running a compiler. No wheel is fabricated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

PACKAGES = {
    "pydantic-core": {
        "version": "2.41.5",
        "url": "https://files.pythonhosted.org/packages/71/70/23b021c950c2addd24ec408e9ab05d59b035b39d97cdc1130e1bce647bb6/pydantic_core-2.41.5.tar.gz",
        "sha256": "08daa51ea16ad373ffd5e7606252cc32f07bc72b28284b6bc9c6df804816476e",
    },
    "jiter": {
        "version": "0.18.0",
        "url": "https://files.pythonhosted.org/packages/63/5b/f68319f4fe624311a744a33d10fdbcac4c971991e348223cba60d31780b2/jiter-0.18.0.tar.gz",
        "sha256": "a0ca63fd9450a212e4e658d4cfe0ab4977c4f9b0003c68828b843c65e27662ff",
    },
}
SYSTEM_LIBRARIES = {
    "libandroid.so",
    "libc.so",
    "libdl.so",
    "liblog.so",
    "libm.so",
    "libz.so",
    "libpython3.13.so",
    "libpython3.so",
}


def audit_wheel(wheel: Path, package: str, abi: str, scratch: Path) -> dict:
    """Reject wrong-platform wheels and incompatible native libraries.

    Args:
        wheel: Actual wheel produced by the compiler and Android wheel repair.
        package: Fixed package recipe name.
        abi: Android ABI, arm64_v8a or x86_64.
        scratch: Existing private directory for ELF inspection.

    Returns:
        Hash and verified ELF inventory suitable for a build manifest.

    Raises:
        ValueError: Wheel metadata or an ELF library violates the target ABI.
    """
    from packaging.utils import canonicalize_name, parse_wheel_filename

    name, version, _, tags = parse_wheel_filename(wheel.name)
    expected = PACKAGES[package]
    if canonicalize_name(name) != package or str(version) != expected["version"]:
        raise ValueError("Unexpected wheel distribution or version")
    for tag in tags:
        python_minor = (
            int(tag.interpreter.removeprefix("cp3"))
            if re.fullmatch(r"cp3\d+", tag.interpreter)
            else 999
        )
        if tag.platform != f"android_24_{abi}" or not (
            (tag.interpreter == "cp313" and tag.abi == "cp313")
            or (tag.abi == "abi3" and python_minor <= 13)
        ):
            raise ValueError(f"Incompatible wheel tag: {tag}")
    with zipfile.ZipFile(wheel) as archive:
        metadata = [
            name for name in archive.namelist() if name.endswith(".dist-info/WHEEL")
        ]
        if len(metadata) != 1:
            raise ValueError("Missing or ambiguous wheel metadata")
        header_tags = {
            line.removeprefix("Tag: ").strip()
            for line in archive.read(metadata[0]).decode().splitlines()
            if line.startswith("Tag: ")
        }
        if header_tags != {str(tag) for tag in tags}:
            raise ValueError("Wheel filename and WHEEL tags disagree")
        native = [
            name for name in archive.namelist() if re.search(r"\.so(?:\.|$)", name)
        ]
        if not native:
            raise ValueError("Native package contains no ELF libraries")
        bundled = {Path(name).name for name in native}
        inventory = []
        for index, name in enumerate(native):
            content = archive.read(name)
            if len(content) < 64 or content[:6] != b"\x7fELF\x02\x01":
                raise ValueError(f"Not a little-endian ELF64 library: {name}")
            machine = struct.unpack_from("<H", content, 18)[0]
            if machine != {"arm64_v8a": 183, "x86_64": 62}[abi]:
                raise ValueError(f"Wrong ELF machine: {name}")
            if b"GLIBC_" in content:
                raise ValueError(f"GNU libc linkage in Android wheel: {name}")
            offset = struct.unpack_from("<Q", content, 32)[0]
            size, count = struct.unpack_from("<HH", content, 54)
            alignments = []
            for number in range(count):
                position = offset + size * number
                if size < 56 or position + 56 > len(content):
                    raise ValueError("Invalid ELF program header")
                if struct.unpack_from("<I", content, position)[0] == 1:
                    alignment = struct.unpack_from("<Q", content, position + 48)[0]
                    if alignment < 16384 or alignment & (alignment - 1):
                        raise ValueError(f"Library is not 16 KiB page aligned: {name}")
                    alignments.append(alignment)
            if not alignments:
                raise ValueError("ELF library has no loadable segments")
            extracted = scratch / f"native-{index}.so"
            extracted.write_bytes(content)
            dynamic = subprocess.run(
                ["readelf", "--dynamic", "--wide", str(extracted)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            needed = re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic)
            unknown = set(needed) - SYSTEM_LIBRARIES - bundled
            if unknown:
                raise ValueError(
                    f"Unbundled dynamic dependencies in {name}: {sorted(unknown)}"
                )
            inventory.append(
                {
                    "path": name,
                    "machine": machine,
                    "needed": needed,
                    "load_alignments": alignments,
                }
            )
    return {
        "file": wheel.name,
        "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "tags": sorted(str(tag) for tag in tags),
        "native_libraries": inventory,
    }


def main() -> None:
    """Download a pinned source, compile for Android, and audit the output."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", choices=PACKAGES, required=True)
    parser.add_argument("--abi", choices=("arm64_v8a", "x86_64"), required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    recipe = PACKAGES[args.package]
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=False)
    archive_path = work / "source.tar.gz"
    with urllib.request.urlopen(recipe["url"], timeout=60) as response:
        with archive_path.open("wb") as destination:
            shutil.copyfileobj(response, destination)
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != recipe["sha256"]:
        raise ValueError("Upstream source SHA256 mismatch")
    source_root = work / "source"
    source_root.mkdir()
    with tarfile.open(archive_path) as archive:
        archive.extractall(source_root, filter="data")
    roots = list(source_root.iterdir())
    if len(roots) != 1 or not (roots[0] / "pyproject.toml").is_file():
        raise ValueError("Unexpected upstream source layout")
    source = roots[0]
    shutil.copyfile(
        Path(__file__).with_name("wheel_smoke.py"), source / "tillith_wheel_smoke.py"
    )
    constraints = work / "build-constraints.txt"
    constraints.write_text("maturin==1.15.0\n", encoding="utf-8")
    configuration = work / "cibuildwheel.toml"
    configuration.write_text(
        '[tool.cibuildwheel]\nbuild = "cp313-android_*"\n'
        'build-frontend = "build"\n'
        f'test-command = "python -m tillith_wheel_smoke {args.package} {recipe["version"]}"\n'
        'test-sources = ["tillith_wheel_smoke.py"]\n'
        'test-requires = ["typing-extensions==4.15.0"]\n',
        encoding="utf-8",
    )
    manifest = {
        "package": args.package,
        "version": recipe["version"],
        "source_url": recipe["url"],
        "source_sha256": recipe["sha256"],
        "python": "3.13",
        "android_api": 24,
        "abi": args.abi,
        "chaquopy": "17.1.0",
        "cibuildwheel": "4.3.4",
        "maturin": "1.15.0",
    }
    (work / "source-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    if args.prepare_only:
        print(
            f"Verified upstream source and prepared build: {args.package} {recipe['version']}"
        )
        return
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise RuntimeError(
            "This workflow requires Linux x86_64; use --prepare-only elsewhere"
        )
    import importlib.metadata

    if importlib.metadata.version("cibuildwheel") != "4.3.4":
        raise RuntimeError("Expected pinned cibuildwheel 4.3.4")
    env = os.environ.copy()
    env.update(
        {
            "ANDROID_API_LEVEL": "24",
            "CIBW_TEST_SKIP": "",
            "CIBW_ENVIRONMENT_ANDROID": f'PIP_CONSTRAINT="{constraints}" PIP_BUILD_CONSTRAINT="{constraints}" '
            'RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"',
        }
    )
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    raw_wheels = work / "unverified-wheels"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "cibuildwheel",
            str(source),
            "--platform",
            "android",
            "--archs",
            args.abi,
            "--config-file",
            str(configuration),
            "--output-dir",
            str(raw_wheels),
        ],
        check=True,
        env=env,
        cwd=source,
    )
    wheels = list(raw_wheels.glob("*.whl"))
    if len(wheels) != 1:
        raise ValueError("Expected exactly one wheel for this package and ABI")
    manifest["wheels"] = [audit_wheel(wheels[0], args.package, args.abi, work)]
    manifest["android_emulator_test"] = (
        "passed_cibuildwheel_x86_64"
        if args.abi == "x86_64"
        else "not_run_cross_architecture_requires_arm64_device"
    )
    shutil.copyfile(wheels[0], output / wheels[0].name)
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"Verified Android wheel written to {output}")


if __name__ == "__main__":
    main()
