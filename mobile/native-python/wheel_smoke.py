"""Exercise the compiled extension inside cibuildwheel's Android testbed."""

import argparse
import importlib.metadata
import io
import sys


def main() -> None:
    """Fail unless the selected native package works on actual Android."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "package", choices=("pydantic-core", "jiter", "pillow", "cryptography")
    )
    parser.add_argument("version")
    args = parser.parse_args()
    assert hasattr(sys, "getandroidapilevel"), "This test must run on Android"
    assert sys.version_info[:2] == (3, 13), sys.version
    assert importlib.metadata.version(args.package) == args.version
    if args.package == "pydantic-core":
        from pydantic_core import SchemaValidator, from_json, to_json

        assert SchemaValidator({"type": "int"}).validate_python("42") == 42
        assert from_json(to_json({"message": "Tillith\u4f60\u597d"})) == {
            "message": "Tillith\u4f60\u597d"
        }
    elif args.package == "jiter":
        import jiter

        assert jiter.from_json(b'{"message":"Tillith","ok":true}') == {
            "message": "Tillith",
            "ok": True,
        }
    elif args.package == "pillow":
        from PIL import Image, ImageFont, features

        for feature in ("jpg", "zlib", "freetype2", "webp"):
            assert features.check(feature), feature
        for file_format in ("JPEG", "PNG", "WEBP"):
            buffer = io.BytesIO()
            Image.new("RGB", (16, 16), (60, 120, 180)).save(buffer, format=file_format)
            buffer.seek(0)
            with Image.open(buffer) as decoded:
                decoded.load()
                assert decoded.size == (16, 16)
        assert ImageFont.load_default(size=14).getbbox("Tillith")[2] > 0
    else:
        from cryptography.hazmat.backends.openssl.backend import backend
        from cryptography.hazmat.primitives.asymmetric import ed25519
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        assert backend.openssl_version_text().startswith("OpenSSL 3.5.9"), (
            backend.openssl_version_text()
        )
        cipher = AESGCM(AESGCM.generate_key(bit_length=256))
        ciphertext = cipher.encrypt(b"tillithnonce", b"Tillith", b"metadata")
        assert cipher.decrypt(b"tillithnonce", ciphertext, b"metadata") == b"Tillith"
        key = ed25519.Ed25519PrivateKey.generate()
        key.public_key().verify(key.sign(b"Tillith"), b"Tillith")
    print(f"TILLITH_ANDROID_WHEEL_SMOKE_OK {args.package} {args.version}")


if __name__ == "__main__":
    main()
