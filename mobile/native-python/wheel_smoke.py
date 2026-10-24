"""Exercise the compiled extension inside cibuildwheel's Android testbed."""

import argparse
import importlib.metadata
import sys


def main() -> None:
    """Fail unless the selected native package works on actual Android."""
    parser = argparse.ArgumentParser()
    parser.add_argument("package", choices=("pydantic-core", "jiter"))
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
    else:
        import jiter

        assert jiter.from_json(b'{"message":"Tillith","ok":true}') == {
            "message": "Tillith",
            "ok": True,
        }
    print(f"TILLITH_ANDROID_WHEEL_SMOKE_OK {args.package} {args.version}")


if __name__ == "__main__":
    main()
