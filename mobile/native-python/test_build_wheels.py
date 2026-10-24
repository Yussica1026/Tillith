"""Reject common invalid cross-compilation artifacts before publishing them."""

import importlib.util
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location(
    "tillith_wheels", Path(__file__).with_name("build_wheels.py")
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class WheelRejectionTests(unittest.TestCase):
    """Use temporary malformed fixtures, never distributable wheel artifacts."""

    def test_invalid_artifacts_cannot_be_promoted(self):
        elf = bytearray(120)
        elf[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", elf, 18, 62)
        struct.pack_into("<Q", elf, 32, 64)
        struct.pack_into("<HH", elf, 54, 56, 1)
        struct.pack_into("<I", elf, 64, 1)
        struct.pack_into("<Q", elf, 112, 4096)
        cases = [
            ("cp313-cp313-win_amd64", b"MZ", "Incompatible wheel tag"),
            ("cp312-cp312-android_24_x86_64", bytes(elf), "Incompatible wheel tag"),
            ("cp313-cp313-android_28_x86_64", bytes(elf), "Incompatible wheel tag"),
            ("cp313-cp313-android_24_x86_64", b"MZ", "Not a little-endian ELF64"),
            ("cp313-cp313-android_24_arm64_v8a", bytes(elf), "Incompatible wheel tag"),
            ("cp313-cp313-android_24_x86_64", bytes(elf) + b"GLIBC_2.17", "GNU libc"),
            ("cp313-cp313-android_24_x86_64", bytes(elf), "not 16 KiB"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (tag, content, error) in enumerate(cases):
                with self.subTest(case=index):
                    wheel = root / f"jiter-0.18.0-{tag}.whl"
                    with zipfile.ZipFile(wheel, "w") as archive:
                        archive.writestr(
                            "jiter-0.18.0.dist-info/WHEEL", f"Tag: {tag}\n"
                        )
                        archive.writestr("jiter/jiter.so", content)
                    with self.assertRaisesRegex(ValueError, error):
                        BUILDER.audit_wheel(wheel, "jiter", "x86_64", root)

    def test_metadata_cannot_disguise_a_different_abi(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wheel = root / "jiter-0.18.0-cp313-cp313-android_24_x86_64.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(
                    "jiter-0.18.0.dist-info/WHEEL", "Tag: cp313-cp313-win_amd64\n"
                )
            with self.assertRaisesRegex(ValueError, "tags disagree"):
                BUILDER.audit_wheel(wheel, "jiter", "x86_64", root)

    def test_pure_wheel_rejects_native_payload_and_host_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for tag, filename, expected in (
                (
                    "py3-none-linux_x86_64",
                    "jieba/__init__.py",
                    "Incompatible pure Python",
                ),
                ("py3-none-any", "jieba/native.so", "contains native code"),
                ("py3-none-any", "jieba/native.pyd", "contains native code"),
            ):
                with self.subTest(tag=tag, filename=filename):
                    wheel = root / f"jieba-0.42.1-{tag}.whl"
                    with zipfile.ZipFile(wheel, "w") as archive:
                        archive.writestr(
                            "jieba-0.42.1.dist-info/WHEEL",
                            f"Root-Is-Purelib: true\nTag: {tag}\n",
                        )
                        archive.writestr(filename, b"malformed test fixture")
                    with self.assertRaisesRegex(ValueError, expected):
                        BUILDER.audit_wheel(wheel, "jieba", "arm64_v8a", root)

    def test_zero_exit_without_matching_android_smoke_is_not_published(self):
        # Reproduce android.py returning zero after ADB disconnects before the
        # actual app test starts. A different package's marker is insufficient.
        for output in (
            "error: closed\n",
            "TILLITH_ANDROID_WHEEL_SMOKE_OK pillow 11.2.1\n",
        ):
            with (
                self.subTest(output=output),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                source = root / "source"
                source.mkdir()
                (source / "pyproject.toml").write_text("")
                process = MagicMock()
                process.__enter__.return_value = process
                process.stdout = iter([output])
                process.wait.return_value = 0
                args = [
                    "build_wheels.py",
                    "--package",
                    "jiter",
                    "--abi",
                    "x86_64",
                    "--work-dir",
                    str(root / "work"),
                    "--output-dir",
                    str(root / "output"),
                ]
                with (
                    patch.object(BUILDER.sys, "argv", args),
                    patch.object(BUILDER.sys, "platform", "linux"),
                    patch.object(BUILDER.platform, "machine", return_value="x86_64"),
                    patch.object(BUILDER, "download_source", return_value=source),
                    patch("importlib.metadata.version", return_value="4.3.4"),
                    patch.object(BUILDER.subprocess, "Popen", return_value=process),
                ):
                    with self.assertRaisesRegex(
                        RuntimeError, "required functional success marker"
                    ):
                        BUILDER.main()
                self.assertFalse((root / "output/manifest.json").exists())
                self.assertFalse(list((root / "output").glob("*.whl")))

    def test_android_python_symbols_require_explicit_libpython_link(self):
        elf = bytearray(120)
        elf[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", elf, 18, 62)
        struct.pack_into("<Q", elf, 32, 64)
        struct.pack_into("<HH", elf, 54, 56, 1)
        struct.pack_into("<I", elf, 64, 1)
        struct.pack_into("<Q", elf, 112, 16384)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wheel = root / "cryptography-45.0.7-cp313-abi3-android_24_x86_64.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(
                    "cryptography-45.0.7.dist-info/WHEEL",
                    "Tag: cp313-abi3-android_24_x86_64\n",
                )
                archive.writestr("cryptography/hazmat/bindings/_rust.abi3.so", elf)
            results = [
                MagicMock(stdout="(NEEDED) Shared library: [libc.so]"),
                MagicMock(
                    stdout="1: 00000000 0 NOTYPE GLOBAL DEFAULT UND PyObject_IsInstance"
                ),
            ]
            with patch.object(BUILDER.subprocess, "run", side_effect=results):
                with self.assertRaisesRegex(ValueError, "explicitly link libpython"):
                    BUILDER.audit_wheel(wheel, "cryptography", "x86_64", root)


if __name__ == "__main__":
    unittest.main()
