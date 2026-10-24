"""Reject common invalid cross-compilation artifacts before publishing them."""

import importlib.util
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
