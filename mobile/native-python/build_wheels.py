"""Build original upstream extensions for Chaquopy 17.1 / CPython 3.13.

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
import shlex
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
    "pillow": {
        "version": "11.2.1",
        "url": "https://files.pythonhosted.org/packages/af/cb/bb5c01fcd2a69335b86c22142b2bccfc3464087efb7fd382eee5ffc7fdf7/pillow-11.2.1.tar.gz",
        "sha256": "a64dd61998416367b7ef979b73d3a85853ba9bec4c2925f74e588879a58716b6",
    },
    "cryptography": {
        "version": "45.0.7",
        "url": "https://files.pythonhosted.org/packages/a7/35/c495bffc2056f2dadb32434f1feedd79abde2a7f8363e1974afa9c33c7e2/cryptography-45.0.7.tar.gz",
        "sha256": "4b1654dfc64ea479c242508eb8c724044f1e964a47d1d1cacc5132292d851971",
    },
    "jieba": {
        "version": "0.42.1",
        "url": "https://files.pythonhosted.org/packages/c6/cb/18eeb235f833b726522d7ebed54f2278ce28ba9438e3135ab0278d9792a2/jieba-0.42.1.tar.gz",
        "sha256": "055ca12f62674fafed09427f176506079bc135638a14e23e25be909131928db2",
    },
}
LIBRARIES = {
    "jpeg": {
        "version": "3.1.2",
        "url": "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.2/libjpeg-turbo-3.1.2.tar.gz",
        "sha256": "8f0012234b464ce50890c490f18194f913a7b1f4e6a03d6644179fa0f867d0cf",
    },
    "freetype": {
        "version": "2.13.3",
        "url": "https://downloads.sourceforge.net/project/freetype/freetype2/2.13.3/freetype-2.13.3.tar.xz",
        "sha256": "0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289",
    },
    "webp": {
        "version": "1.6.0",
        "url": "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz",
        "sha256": "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564",
    },
    "openssl": {
        "version": "3.5.9",
        "url": "https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz",
        "sha256": "603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a",
    },
}
PACKAGE_LIBRARIES = {
    "pillow": ("jpeg", "freetype", "webp"),
    "cryptography": ("openssl",),
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
        if package == "jieba":
            if (
                tag.platform != "any"
                or tag.abi != "none"
                or tag.interpreter not in {"py2", "py3"}
            ):
                raise ValueError(f"Incompatible pure Python wheel tag: {tag}")
            continue
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
        if package == "jieba":
            if native or any(
                name.endswith((".dll", ".pyd", ".dylib", ".a"))
                for name in archive.namelist()
            ):
                raise ValueError("Pure Python wheel contains native code")
            if (
                "py3-none-any" not in header_tags
                or "Root-Is-Purelib: true" not in archive.read(metadata[0]).decode()
            ):
                raise ValueError("Pure Python wheel must support Python 3 and purelib")
            return {
                "file": wheel.name,
                "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                "tags": sorted(str(tag) for tag in tags),
                "native_libraries": [],
            }
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
            symbols = subprocess.run(
                ["readelf", "--dyn-syms", "--wide", str(extracted)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            if re.search(r"\bUND\s+_?Py[A-Za-z0-9_]*", symbols) and not (
                set(needed) & {"libpython3.13.so", "libpython3.so"}
            ):
                raise ValueError(
                    f"Python extension does not explicitly link libpython: {name}"
                )
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


def download_source(recipe: dict, directory: Path) -> Path:
    """Download and verify one pinned upstream source archive.

    Args:
        recipe: Official source URL and SHA256.
        directory: New extraction directory.

    Returns:
        The single top-level upstream source directory.

    Raises:
        ValueError: The source checksum or layout is unexpected.
    """
    directory.mkdir(parents=True, exist_ok=False)
    archive_path = directory / "upstream.tar"
    with urllib.request.urlopen(recipe["url"], timeout=120) as response:
        with archive_path.open("wb") as destination:
            shutil.copyfileobj(response, destination)
    if hashlib.sha256(archive_path.read_bytes()).hexdigest() != recipe["sha256"]:
        raise ValueError("Upstream source SHA256 mismatch")
    source_root = directory / "source"
    source_root.mkdir()
    with tarfile.open(archive_path) as archive:
        archive.extractall(source_root, filter="data")
    roots = list(source_root.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError("Unexpected upstream source layout")
    return roots[0]


def build_libraries(package: str, abi: str, work: Path) -> None:
    """Build static PIC dependencies using cibuildwheel's Android compiler.

    Args:
        package: Selected extension recipe.
        abi: Target Android ABI.
        work: Prepared source workspace.

    Raises:
        RuntimeError: The compiler is not an Android NDK compiler.
    """
    compiler = Path(shutil.which(shlex.split(os.environ["CC"])[0]) or "").resolve()
    ndk = next(
        (
            parent
            for parent in compiler.parents
            if (parent / "build/cmake/android.toolchain.cmake").is_file()
        ),
        None,
    )
    if ndk is None:
        raise RuntimeError("An Android NDK compiler is required")
    prefix = work / "native-prefix"
    prefix.mkdir(exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = f"{compiler.parent}{os.pathsep}{env['PATH']}"
    env["ANDROID_NDK_ROOT"] = str(ndk)
    for name in PACKAGE_LIBRARIES[package]:
        source = next((work / name / "source").iterdir())
        if name == "openssl":
            # OpenSSL selects the Android target itself; do not inherit host CC.
            openssl_env = env | {"CC": "clang", "CXX": "clang++"}
            subprocess.run(
                [
                    "perl",
                    "Configure",
                    {"arm64_v8a": "android-arm64", "x86_64": "android-x86_64"}[abi],
                    "-D__ANDROID_API__=24",
                    "-fPIC",
                    "no-shared",
                    "no-tests",
                    "no-apps",
                    f"--prefix={prefix}",
                    "--libdir=lib",
                ],
                cwd=source,
                env=openssl_env,
                check=True,
            )
            subprocess.run(
                ["make", "-j2", "build_libs"], cwd=source, env=openssl_env, check=True
            )
            subprocess.run(
                ["make", "install_dev"], cwd=source, env=openssl_env, check=True
            )
            continue
        options = {
            "jpeg": [
                "-DENABLE_SHARED=OFF",
                "-DENABLE_STATIC=ON",
                "-DWITH_SIMD=OFF",
                "-DWITH_TURBOJPEG=OFF",
            ],
            "freetype": [
                f"-DFT_DISABLE_{feature}=ON"
                for feature in ("ZLIB", "BZIP2", "PNG", "HARFBUZZ", "BROTLI")
            ],
            "webp": [
                f"-DWEBP_BUILD_{feature}=OFF"
                for feature in (
                    "ANIM_UTILS",
                    "CWEBP",
                    "DWEBP",
                    "VWEBP",
                    "GIF2WEBP",
                    "IMG2WEBP",
                    "WEBPINFO",
                    "WEBPMUX",
                    "EXTRAS",
                )
            ],
        }[name]
        build = work / f"build-{name}"
        subprocess.run(
            [
                "cmake",
                "-S",
                str(source),
                "-B",
                str(build),
                f"-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake",
                f"-DANDROID_ABI={abi.replace('_v8a', '-v8a')}",
                "-DANDROID_PLATFORM=android-24",
                "-DCMAKE_BUILD_TYPE=Release",
                "-DBUILD_SHARED_LIBS=OFF",
                "-DBUILD_TESTING=OFF",
                "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
                f"-DCMAKE_INSTALL_PREFIX={prefix}",
                "-DCMAKE_INSTALL_LIBDIR=lib",
                *options,
            ],
            env=env,
            check=True,
        )
        subprocess.run(
            ["cmake", "--build", str(build), "--parallel", "2"], env=env, check=True
        )
        subprocess.run(["cmake", "--install", str(build)], env=env, check=True)
        if name == "webp":
            # Pillow links -lwebp without pkg-config's static dependencies.
            # Merge the real PIC archives; no upstream source is altered.
            combined = prefix / "lib/libwebp-combined.a"
            libraries = [
                prefix / "lib" / filename
                for filename in ("libwebp.a", "libsharpyuv.a", "libcpufeatures-webp.a")
            ]
            for library in libraries:
                if not library.is_file():
                    raise RuntimeError(
                        f"Missing compiled WebP dependency: {library.name}"
                    )
            script = (
                f"CREATE {combined}\n"
                + "".join(f"ADDLIB {library}\n" for library in libraries)
                + "SAVE\nEND\n"
            )
            subprocess.run(
                [str(compiler.parent / "llvm-ar"), "-M"],
                input=script,
                text=True,
                check=True,
            )
            combined.replace(prefix / "lib/libwebp.a")
    if package == "pillow":
        # Link Android's system zlib stub, never a Linux host library.
        sysroot = compiler.parent.parent / "sysroot/usr"
        triplet = {
            "arm64_v8a": "aarch64-linux-android",
            "x86_64": "x86_64-linux-android",
        }[abi]
        for filename in ("zlib.h", "zconf.h"):
            shutil.copyfile(
                sysroot / "include" / filename, prefix / "include" / filename
            )
        shutil.copyfile(
            sysroot / "lib" / triplet / "24/libz.so", prefix / "lib/libz.so"
        )
    elif package == "cryptography":
        # PyO3 0.25 suppresses libpython linkage for extension-module builds,
        # including Android. Expose the real target library to RUSTFLAGS.
        python_library = Path(os.environ["PYO3_CROSS_LIB_DIR"]) / "libpython3.13.so"
        if not python_library.is_file():
            raise RuntimeError("Missing target Android libpython3.13.so")
        (prefix / "lib/libpython3.13.so").symlink_to(python_library)


def main() -> None:
    """Download a pinned source, compile for Android, and audit the output."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", choices=PACKAGES, required=True)
    parser.add_argument("--abi", choices=("arm64_v8a", "x86_64"), required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument(
        "--build-dependencies", action="store_true", help=argparse.SUPPRESS
    )
    args = parser.parse_args()
    recipe = PACKAGES[args.package]
    work = args.work_dir.resolve()
    if args.build_dependencies:
        build_libraries(args.package, args.abi, work)
        return
    work.mkdir(parents=True, exist_ok=False)
    source = download_source(recipe, work / "package")
    if not any((source / name).is_file() for name in ("pyproject.toml", "setup.py")):
        raise ValueError("Unexpected upstream source layout")
    for library in PACKAGE_LIBRARIES.get(args.package, ()):
        download_source(LIBRARIES[library], work / library)
    shutil.copyfile(
        Path(__file__).with_name("wheel_smoke.py"), source / "tillith_wheel_smoke.py"
    )
    constraints = work / "build-constraints.txt"
    constraints.write_text(
        "maturin==1.15.0\ncffi==1.17.1\nsetuptools==80.9.0\n", encoding="utf-8"
    )
    configuration = work / "cibuildwheel.toml"
    configuration.write_text(
        '[tool.cibuildwheel]\nbuild = "cp313-android_*"\n'
        'build-frontend = "build"\n'
        f'test-command = "python -m tillith_wheel_smoke {args.package} {recipe["version"]}"\n'
        'test-sources = ["tillith_wheel_smoke.py"]\n'
        'test-requires = ["typing-extensions==4.15.0"]\n',
        encoding="utf-8",
    )
    if args.package in PACKAGE_LIBRARIES:
        before = shlex.join(
            [
                "python",
                str(Path(__file__).resolve()),
                "--build-dependencies",
                "--package",
                args.package,
                "--abi",
                args.abi,
                "--work-dir",
                str(work),
                "--output-dir",
                str(args.output_dir.resolve()),
            ]
        )
        with configuration.open("a", encoding="utf-8") as stream:
            stream.write(f"before-build = {json.dumps(before)}\n")
            if args.package == "pillow":
                stream.write(
                    '[tool.cibuildwheel.config-settings]\nplatform-guessing = "disable"\njpeg = "enable"\nzlib = "enable"\nfreetype = "enable"\nwebp = "enable"\n'
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
        "libraries": {
            name: LIBRARIES[name] for name in PACKAGE_LIBRARIES.get(args.package, ())
        },
    }
    if args.package == "pillow":
        manifest["image_features"] = ["jpeg", "png_system_zlib", "webp", "freetype"]
        manifest["optional_image_features_not_built"] = [
            "raqm",
            "libtiff",
            "lcms",
            "jpeg2000",
            "compressed_font_formats",
        ]
    (work / "source-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    if args.prepare_only:
        print(
            f"Verified upstream source and prepared build: {args.package} {recipe['version']}"
        )
        return
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    raw_wheels = work / "unverified-wheels"
    if args.package == "jieba":
        # --no-deps builds this one pure package; App installation still resolves
        # all dependencies normally. Never ship a host-native wheel from here.
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(raw_wheels),
                str(source),
            ],
            check=True,
            env=os.environ
            | {
                "PIP_CONSTRAINT": str(constraints),
                "PIP_BUILD_CONSTRAINT": str(constraints),
            },
        )
        wheels = list(raw_wheels.glob("*.whl"))
        if len(wheels) != 1:
            raise ValueError("Expected exactly one pure Python wheel")
        manifest["wheels"] = [audit_wheel(wheels[0], args.package, args.abi, work)]
        manifest["android_emulator_test"] = (
            "not_required_pure_python_host_tokenization_test"
        )
        # Exercise the actual built archive on the host without installing it.
        test_root = work / "pure-smoke"
        with zipfile.ZipFile(wheels[0]) as archive:
            archive.extractall(test_root)
        subprocess.run(
            [
                sys.executable,
                "-c",
                "import jieba; assert list(jieba.cut('Tillith')) == ['Tillith']",
            ],
            env=os.environ | {"PYTHONPATH": str(test_root)},
            cwd=work,
            check=True,
        )
        shutil.copyfile(wheels[0], output / wheels[0].name)
        (output / "manifest.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8"
        )
        print(f"Verified pure Python wheel written to {output}")
        return
    if sys.platform != "linux" or platform.machine() not in {"x86_64", "AMD64"}:
        raise RuntimeError(
            "This workflow requires Linux x86_64; use --prepare-only elsewhere"
        )
    import importlib.metadata

    if importlib.metadata.version("cibuildwheel") != "4.3.4":
        raise RuntimeError("Expected pinned cibuildwheel 4.3.4")
    env = os.environ.copy()
    prefix = work / "native-prefix"
    environment = {
        "PIP_CONSTRAINT": str(constraints),
        "PIP_BUILD_CONSTRAINT": str(constraints),
        "RUSTFLAGS": "-C link-arg=-Wl,-z,max-page-size=16384",
    }
    if args.package in PACKAGE_LIBRARIES:
        environment.update(
            {
                "PIP_EXTRA_INDEX_URL": "https://chaquo.com/pypi-13.1",
                "PIP_ONLY_BINARY": "cffi",
                "OPENSSL_DIR": str(prefix),
                "OPENSSL_STATIC": "1",
                "OPENSSL_NO_VENDOR": "1",
                "PKG_CONFIG_LIBDIR": str(prefix / "lib/pkgconfig"),
                "JPEG_ROOT": str(prefix),
                "FREETYPE_ROOT": str(prefix),
                "WEBP_ROOT": str(prefix),
                "ZLIB_ROOT": str(prefix),
                "LIBRARY_PATH": str(prefix / "lib"),
                "CPATH": str(prefix / "include")
                + ":"
                + str(prefix / "include/freetype2"),
            }
        )
    if args.package == "cryptography":
        environment["RUSTFLAGS"] += (
            f" -L native={prefix / 'lib'}"
            " -C link-arg=-Wl,--no-as-needed -C link-arg=-lpython3.13"
        )
    env.update(
        {
            "ANDROID_API_LEVEL": "24",
            "CIBW_TEST_SKIP": "",
            "CIBW_ENVIRONMENT_ANDROID": " ".join(
                f"{key}={shlex.quote(value)}" for key, value in environment.items()
            ),
        }
    )
    command = [
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
    ]
    smoke_marker = f"TILLITH_ANDROID_WHEEL_SMOKE_OK {args.package} {recipe['version']}"
    smoke_passed = False
    with subprocess.Popen(
        command,
        env=env,
        cwd=source,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    ) as process:
        for line in process.stdout:
            print(line, end="", flush=True)
            if smoke_marker in line:
                smoke_passed = True
        return_code = process.wait()
    if return_code:
        raise subprocess.CalledProcessError(return_code, command)
    # android.py can return zero after a transient ADB disconnect before it
    # observes the app. Require positive evidence from our actual smoke code.
    if args.abi == "x86_64" and not smoke_passed:
        raise RuntimeError(
            "Android test returned without the required functional success marker; wheel was not promoted"
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
